# Story 18.4: Stripe Webhook Handler with Idempotent Event Processing

Status: backlog

## Story

As a SaaS platform operator,
I want a `POST /v1/billing/webhook` endpoint that verifies Stripe signatures, processes lifecycle events idempotently, and updates customer state accordingly,
So that subscription activations, payment confirmations, and failures sync reliably from Stripe to our database with zero double-processing on replay. (NFR40)

## Acceptance Criteria

**Given** Stripe is configured with a webhook endpoint pointing at `https://api.<our-domain>/v1/billing/webhook`
**When** a Stripe event POSTs to this endpoint
**Then** the handler verifies the `Stripe-Signature` header against the configured webhook secret using `stripe.webhooks.constructEvent(rawBody, signature, secret)` — invalid signatures return HTTP 400 with no body change
**And** the handler checks `processed_stripe_events` table for the incoming `event.id`; if present, returns HTTP 200 immediately (idempotent replay) without re-running side effects (NFR40)
**And** new events are inserted into `processed_stripe_events` (event_id, event_type, processed_at) **inside the same transaction** as their side-effect SQL writes
**And** the handler dispatches to per-event-type processors:
- `customer.subscription.created` → set `customers.tier` from Stripe metadata, populate `subscription_items` rows for both subscription + metered Price IDs
- `customer.subscription.updated` → update `customers.tier` if Price changed (upgrade/downgrade)
- `customer.subscription.deleted` → set `customers.tier='none'`, set `customers.unpaid=false`
- `invoice.paid` → set `customers.unpaid=false`, call `billingAccountant.resetMonthlyCounter(customerId)` (Story 18.3)
- `invoice.payment_failed` → increment `customers.payment_retry_count`; if `>= 3`, set `customers.unpaid=true` (Story 18.5 blocks new drops on this flag)
**And** unknown event types are logged at INFO level and returned 200 (Stripe expects 200 to stop retries)
**And** the endpoint is registered with raw body parser (NOT JSON parser) because Stripe signature verification requires the unparsed body
**And** integration tests verify all 5 event types, signature rejection, idempotent replay, and unknown-event 200 path

## Tasks / Subtasks

### Task 1: Migration for `processed_stripe_events` table (AC: idempotency tracking)

- **File:** `packages/api/src/db/migrations/021_stripe_events.sql` (new)
- DDL:
  ```sql
  CREATE TABLE processed_stripe_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload_snapshot JSONB
  );
  CREATE INDEX idx_stripe_events_type ON processed_stripe_events(event_type, processed_at);
  ```
- `payload_snapshot` (optional, can be NULL for high-volume events) stores the event JSON for forensic debugging
- Also add columns to customers:
  ```sql
  ALTER TABLE customers
    ADD COLUMN payment_retry_count SMALLINT NOT NULL DEFAULT 0;
  ```

### Task 2: Webhook route with raw body parser (AC: signature verification)

- **File:** `packages/api/src/routes/billingWebhook.ts` (new)
- Register endpoint with raw body:
  ```ts
  fastify.post('/v1/billing/webhook', {
    config: { rawBody: true },
    bodyLimit: 1_048_576,
  }, async (req, reply) => {
    const sig = req.headers['stripe-signature']
    if (!sig) return reply.code(400).send({ error: 'missing signature' })
    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(req.rawBody!, sig, env.STRIPE_WEBHOOK_SECRET)
    } catch (err) {
      logger.warn({ err }, 'webhook.signature_invalid')
      return reply.code(400).send({ error: 'invalid signature' })
    }
    await processEvent(event)
    return reply.code(200).send({ received: true })
  })
  ```
- Configure Fastify rawBody plugin or use `@fastify/raw-body`

### Task 3: `processEvent` dispatcher with idempotency check (AC: dedupe on event.id)

- **File:** `packages/api/src/billing/webhookProcessor.ts` (new)
- Function:
  ```ts
  export async function processEvent(event: Stripe.Event): Promise<void> {
    const exists = await db.query(
      'SELECT 1 FROM processed_stripe_events WHERE event_id = $1',
      [event.id],
    )
    if (exists.rowCount > 0) {
      logger.info({ eventId: event.id, eventType: event.type }, 'webhook.replay_ignored')
      return
    }
    await db.transaction(async (tx) => {
      switch (event.type) {
        case 'customer.subscription.created': await handleSubscriptionCreated(event, tx); break
        case 'customer.subscription.updated': await handleSubscriptionUpdated(event, tx); break
        case 'customer.subscription.deleted': await handleSubscriptionDeleted(event, tx); break
        case 'invoice.paid': await handleInvoicePaid(event, tx); break
        case 'invoice.payment_failed': await handleInvoicePaymentFailed(event, tx); break
        default:
          logger.info({ eventType: event.type }, 'webhook.unknown_event')
      }
      await tx.query(
        'INSERT INTO processed_stripe_events (event_id, event_type, payload_snapshot) VALUES ($1,$2,$3)',
        [event.id, event.type, JSON.stringify(event.data.object)],
      )
    })
  }
  ```

### Task 4: `customer.subscription.created` handler (AC: tier activation, subscription items populated)

- **File:** `packages/api/src/billing/webhookProcessor.ts` (continue)
- Handler:
  ```ts
  async function handleSubscriptionCreated(event: Stripe.Event, tx: PoolClient) {
    const sub = event.data.object as Stripe.Subscription
    const customerId = sub.metadata.customer_id ?? await lookupByStripeCustomerId(sub.customer as string, tx)
    const tier = sub.metadata.tier as TierId  // set in Story 18.2 Checkout metadata

    await tx.query(
      'UPDATE customers SET tier = $1, payment_retry_count = 0 WHERE id = $2',
      [tier, customerId],
    )
    for (const item of sub.items.data) {
      const itemType = isMeteredPrice(item.price.id) ? 'metered_per_cop' : 'subscription'
      await tx.query(
        `INSERT INTO subscription_items (customer_id, stripe_subscription_id, stripe_item_id, item_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (stripe_item_id) DO NOTHING`,
        [customerId, sub.id, item.id, itemType],
      )
    }
  }
  ```

### Task 5: `customer.subscription.updated|deleted` handlers (AC: tier change, cancellation)

- **File:** `packages/api/src/billing/webhookProcessor.ts` (continue)
- `updated`: re-derive tier from current Price; if changed, `UPDATE customers SET tier = ...`
- `deleted`: `UPDATE customers SET tier = 'none', unpaid = false`; remove rows from `subscription_items` for that subscription_id

### Task 6: `invoice.paid` and `invoice.payment_failed` handlers (AC: counter reset, suspension)

- **File:** `packages/api/src/billing/webhookProcessor.ts` (continue)
- `invoice.paid`:
  ```ts
  const invoice = event.data.object as Stripe.Invoice
  const customerId = await lookupByStripeCustomerId(invoice.customer as string, tx)
  await tx.query(
    'UPDATE customers SET unpaid = false, payment_retry_count = 0 WHERE id = $1',
    [customerId],
  )
  await billingAccountant.resetMonthlyCounter(customerId, tx)  // Story 18.3
  ```
- `invoice.payment_failed`:
  ```ts
  await tx.query(
    `UPDATE customers SET payment_retry_count = payment_retry_count + 1,
     unpaid = (payment_retry_count + 1 >= 3) WHERE id = $1`,
    [customerId],
  )
  ```

### Task 7: Tests (AC: all 5 events + replay + signature + unknown)

- **File:** `packages/api/src/billing/webhookProcessor.test.ts` (new, integration)
  - Use `stripe.webhooks.generateTestHeaderString` to forge valid signatures for fixtures
  - Test 1: `customer.subscription.created` for Solo tier → assert `customers.tier='solo'`, two `subscription_items` rows
  - Test 2: Replay same event → assert second call is no-op (table state unchanged after first)
  - Test 3: `invoice.paid` after some cops → assert `cop_count_mtd=0`, `unpaid=false`, `billing_periods` row written
  - Test 4: `invoice.payment_failed` thrice → assert `unpaid=true` after the third
  - Test 5: Invalid signature → assert HTTP 400, no DB writes
  - Test 6: Unknown event type → assert HTTP 200, no DB writes (other than no-op)

## Dev Notes

### Why Idempotency Tracking AND Stripe Idempotency

Stripe's *outbound* idempotency (Story 18.1, 18.3) prevents us from creating duplicate Stripe-side resources. Stripe's *inbound* webhook delivery is at-least-once: the same event can arrive multiple times (network retries, our 5xx responses).

Two layers handle this:
1. **`processed_stripe_events` table** — application-level dedupe on `event.id`. Mandatory per NFR40.
2. **Transactional insert** — the dedupe row and the side-effect writes are in the same transaction. Either both happen or neither. No half-applied state.

Reference: https://docs.stripe.com/webhooks#handle-duplicate-events

### Signature Verification — Why Raw Body

`stripe.webhooks.constructEvent(rawBody, signature, secret)` computes HMAC-SHA256 over the raw body bytes. JSON parsing changes whitespace and key order — even semantically identical JSON produces different bytes and breaks the HMAC. Fastify must be configured with raw body access for this route only (`config: { rawBody: true }`).

If using `@fastify/raw-body`:
```ts
fastify.register(rawBody, { field: 'rawBody', encoding: 'utf8', runFirst: true })
```

Reference: https://docs.stripe.com/webhooks#verify-signature

### Webhook Endpoint Configuration in Stripe Dashboard

Operator-side setup (one-time per environment):
1. Stripe Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://api.<our-domain>/v1/billing/webhook`
3. Events to listen: `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`
4. Copy signing secret → set as `STRIPE_WEBHOOK_SECRET` env var

### Why Always Return 200 (Even on Unknown Event)

Stripe retries webhooks with exponential backoff for any non-2xx response, for up to 3 days. Returning 200 even for events we don't handle prevents endless retry storms. The INFO log captures unknown event types so we can add handlers as needed.

Returning 4xx is reserved for **invalid** events (bad signature, malformed body) — these should not retry because retrying won't fix them.

### `stripe.webhooks.constructEvent` Reference

- SDK: `stripe.webhooks.constructEvent(payload, signature, secret, tolerance?)`
- Tolerance default: 5 minutes between event creation and verification (clock skew tolerance)
- Throws `Stripe.errors.StripeSignatureVerificationError` on failure
- Reference: https://docs.stripe.com/api/webhook_endpoints

### Customer Lookup Strategy

Subscription events carry `customer.id` (Stripe customer ID). We resolve to internal `customer_id` via `subscription.metadata.customer_id` (set when we created the Checkout Session in Story 18.2) OR fallback to `customers.stripe_customer_id` lookup. Two paths because metadata can be missing on legacy subscriptions imported manually.

### Suspension Threshold (3 retries)

Stripe automatically retries failed invoice payments per the dunning settings (configured in Stripe Dashboard, default is 4 retries over a week). After our 3rd `invoice.payment_failed` event, we flip `unpaid=true` which Story 18.5 uses to block new drops. The customer can clear it by updating their card and triggering an `invoice.paid` event.

### Project Structure Notes

New files:
```
packages/api/src/db/migrations/021_stripe_events.sql
packages/api/src/routes/billingWebhook.ts
packages/api/src/billing/webhookProcessor.ts
packages/api/src/billing/webhookProcessor.test.ts
```

Modified:
- `packages/api/src/server.ts` — register raw-body plugin, register webhook route

### References

- Epics: Story 18.4 (formerly skeleton 18.3)
- PRD: NFR40 (idempotent webhook reception)
- V3_MIGRATION_PLAN.md Phase 5: Stripe webhook receiver with idempotent processing
- Stripe Webhooks Guide: https://docs.stripe.com/webhooks
- Stripe Signature Verification: https://docs.stripe.com/webhooks#verify-signature
- Stripe Idempotent Events: https://docs.stripe.com/webhooks#handle-duplicate-events
- Depends on: Story 18.1 (StripeClient, customers.stripe_customer_id), Story 18.2 (Checkout metadata sets tier), Story 18.3 (resetMonthlyCounter, subscription_items)
- Enables: Story 18.5 (consumes `unpaid` flag and `tier` for limit enforcement)

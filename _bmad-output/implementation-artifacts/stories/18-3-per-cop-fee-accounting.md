# Story 18.3: Per-Cop Usage Fee Accounting via Stripe Metered Billing

Status: backlog

## Story

As a SaaS platform operator,
I want every successful cop (drop_run reaching `COP` state) to increment the customer's MTD count and emit a Stripe metered usage event with idempotency anchored on the internal order number,
So that customers are billed accurately for their cops at end of month with zero risk of double-charging on retries or webhook replays. (NFR40)

## Acceptance Criteria

**Given** a `drop_run` transitions to `COP` (Story 17.3 finalize) with an `order_number` from Nike
**When** the cop event is processed by the billing accounting service
**Then** the service increments `customers.cop_count_mtd` by 1 atomically (`UPDATE ... SET cop_count_mtd = cop_count_mtd + 1`)
**And** emits a Stripe metered usage event via `stripe.subscriptionItems.createUsageRecord(subscriptionItemId, { quantity: 1, timestamp, action: 'increment' }, { idempotencyKey: 'usage:<order_number>' })`
**And** the idempotency key `usage:<order_number>` ensures a replayed cop event (worker crash + reaped run + new worker reports same `order_number`) does not double-charge — Stripe returns the original response (NFR40)
**And** the per-cop fee amount is **not** sent in the usage event (Stripe computes it from the metered Price tier configured in Story 18.2 bootstrap); usage events only carry the quantity
**And** if the customer's tier is `enterprise` (no per-cop fee), the usage record call is skipped (`feePerCopCents === 0` short-circuit)
**And** end-of-month, Stripe automatically closes the billing period and generates an invoice line item `<cop_count> × <feePerCopCents>` — no additional API call from us required
**And** integration tests verify: cop increments counter, replay safety via idempotency key, enterprise skip path, monthly counter reset on `invoice.paid` webhook

## Tasks / Subtasks

### Task 1: Bootstrap metered Price for per-cop fees (AC: Stripe Price configured for metered billing)

- **File:** `packages/api/scripts/bootstrap-billing.ts` (edit — Story 18.2 file)
- For each self-serve tier, create a second Price tied to the same Product but with `recurring.usage_type='metered'`:
  ```ts
  await stripe.prices.create({
    product: tier.productId,
    unit_amount: tier.feePerCopCents,
    currency: 'usd',
    recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum' },
    nickname: `${tier.id}-per-cop`,
  }, { idempotencyKey: `bootstrap-price:${tier.productId}:metered` })
  ```
- Update `.priceIds.json` to include both `monthly` and `metered_per_cop` Price IDs per tier
- Story 18.2's Checkout Session must add **both** line items: subscription Price + metered Price (so Stripe creates the subscription with both items attached)

### Task 2: `BillingAccountant` module — increment + emit (AC: counter + usage event in single function)

- **File:** `packages/api/src/billing/billingAccountant.ts` (new)
- Public API:
  ```ts
  export interface BillingAccountant {
    recordCop(args: {
      customerId: string
      orderNumber: string
      copTimestamp: Date
    }): Promise<void>
  }
  ```
- Implementation:
  ```ts
  async recordCop({ customerId, orderNumber, copTimestamp }) {
    const customer = await this.customerRepo.findById(customerId)
    if (!customer.tier || customer.tier === 'none') {
      logger.warn({ customerId, orderNumber }, 'cop.recorded.no_tier')
      return  // edge case — customer cancelled mid-drop
    }
    const tierDef = TIERS[customer.tier]

    // Always increment local counter for analytics + 18.5 limit enforcement
    await this.db.query(
      'UPDATE customers SET cop_count_mtd = cop_count_mtd + 1 WHERE id = $1',
      [customerId],
    )

    // Skip Stripe usage record for enterprise (free tier on per-cop)
    if (tierDef.feePerCopCents === 0) return

    const subItemId = await this.subscriptionItemRepo.findMeteredItemId(customerId)
    if (!subItemId) {
      logger.error({ customerId, orderNumber }, 'cop.recorded.no_subscription_item')
      return  // alert — billing reconciliation will catch this
    }

    await this.stripe.createUsageRecord({
      subscriptionItemId: subItemId,
      quantity: 1,
      timestamp: Math.floor(copTimestamp.getTime() / 1000),
      idempotencyKey: `usage:${orderNumber}`,
    })
  }
  ```

### Task 3: `subscriptionItemRepo` — track metered subscription items per customer (AC: lookup by customer)

- **File:** `packages/api/src/billing/subscriptionItemRepo.ts` (new)
- Migration `020_subscription_items.sql`:
  ```sql
  CREATE TABLE subscription_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id),
    stripe_subscription_id TEXT NOT NULL,
    stripe_item_id TEXT NOT NULL UNIQUE,
    item_type TEXT NOT NULL CHECK (item_type IN ('subscription','metered_per_cop')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_sub_items_customer_type ON subscription_items(customer_id, item_type);
  ```
- Populated by Story 18.4's webhook handler when `customer.subscription.created` fires (the webhook payload has the subscription item IDs)
- Repo method: `findMeteredItemId(customerId): Promise<string | null>` — returns the `stripe_item_id` where `item_type = 'metered_per_cop'`

### Task 4: Wire into drop run finalize (AC: COP transition triggers accounting)

- **File:** `packages/api/src/drops/dropRunRepository.ts` (edit — Story 17.3 file)
- In `finalize`, after the SQL UPDATE and event emission, if `outcome === 'COP'`:
  ```ts
  await this.billingAccountant.recordCop({
    customerId: run.customerId,
    orderNumber: meta.orderNumber!,
    copTimestamp: new Date(),
  })
  ```
- Wrap in try/catch — billing failure must **not** roll back the drop_run finalize (cop already happened, customer got the shoes; billing reconciliation handles the gap)
- Failure logs to `billing.cop.record_failed` with full context for ops alerting

### Task 5: Extend StripeClient with `createUsageRecord` (AC: idempotency key passthrough)

- **File:** `packages/api/src/billing/stripeClient.ts` (edit — Story 18.1 file)
- Add method:
  ```ts
  createUsageRecord(args: {
    subscriptionItemId: string
    quantity: number
    timestamp: number
    idempotencyKey: string
  }): Promise<Stripe.UsageRecord> {
    return this.stripe.subscriptionItems.createUsageRecord(
      args.subscriptionItemId,
      { quantity: args.quantity, timestamp: args.timestamp, action: 'increment' },
      { idempotencyKey: args.idempotencyKey },
    )
  }
  ```
- Reference: `stripe.subscriptionItems.createUsageRecord` — https://docs.stripe.com/api/usage_records/create

### Task 6: Monthly counter reset (AC: cop_count_mtd resets on invoice.paid)

- **File:** `packages/api/src/billing/billingAccountant.ts` (continue)
- Method `resetMonthlyCounter(customerId: string)` called from Story 18.4's `invoice.paid` handler
- SQL: `UPDATE customers SET cop_count_mtd = 0 WHERE id = $1`
- Also writes a row to `billing_periods` (new table in same migration) capturing the closed period for historical reporting:
  ```sql
  INSERT INTO billing_periods (customer_id, period_end, cop_count, invoice_id)
  VALUES ($1, now(), $2, $3);
  ```

### Task 7: Tests (AC: happy path, replay, enterprise skip, reset)

- **File:** `packages/api/src/billing/billingAccountant.test.ts` (new)
  - Mock StripeClient + customerRepo + subscriptionItemRepo
  - Test 1: Solo customer with tier set, valid metered item → `recordCop` called → assert `cop_count_mtd += 1`, assert `createUsageRecord` called with `idempotencyKey: 'usage:NK12345'`
  - Test 2: Same `recordCop` called twice with same orderNumber → first call increments + emits, second call increments + emits (Stripe replay-safe via idempotency key); local counter is non-idempotent (caller must dedupe — see dev notes)
  - Test 3: Enterprise tier → assert NO Stripe call, NO counter increment? **Decision: enterprise still increments counter for analytics, just skips Stripe usage** — write the test for that exact behavior
  - Test 4: Customer with `tier='none'` → assert no-op + warning logged
  - Test 5: `resetMonthlyCounter` → assert counter goes to 0, billing_periods row inserted

## Dev Notes

### Stripe Metered Billing Model

Stripe Metered Billing (https://docs.stripe.com/billing/subscriptions/usage-based) is the canonical pattern for usage-based pricing:

1. Create a Price with `recurring.usage_type='metered'`
2. Add this Price as a Subscription Item when the customer subscribes
3. Throughout the billing period, emit `UsageRecord`s incrementing the quantity
4. At period end, Stripe sums the quantities × Price unit_amount → invoice line item
5. Customer is charged automatically via the configured payment method

We do NOT compute the dollar amount on our side. Stripe handles `cop_count × feePerCopCents` arithmetic at invoice time. Our job is only to:
- Emit the right quantity (1 per cop)
- Use idempotency keys to prevent double-emission

### Why Counter AND Usage Record (Not Just One)

- **Local counter (`cop_count_mtd`)**: needed for Story 18.5 limit enforcement (Pro tier 25-account check), for analytics dashboards, and as a billing-reconciliation source of truth
- **Stripe Usage Record**: the actual billing trigger; what the customer is charged for

These two should always agree. A nightly reconciliation job (out of scope for this story but tracked in V3_MIGRATION_PLAN Phase 5 risks) compares local counter to Stripe-reported quantity and alerts on drift.

### Idempotency Key — Why Order Number

The Nike order number is the natural anchor for cop idempotency:
- Returned by Nike on successful checkout — globally unique
- A retried run that succeeds will yield a *different* order number (Nike processes a fresh order)
- Stripe replay-safety means even if our worker reports the same order number twice (worker crash + recovery), only one usage record is created

If Nike returned the same order number for two distinct cops (impossible by definition but defensive coding), the second usage record is silently deduped — slight over-recording on local counter, slight under-billing on Stripe. Reconciliation catches it.

### Local Counter Non-Idempotency

The SQL `cop_count_mtd = cop_count_mtd + 1` is **not** idempotent. If `recordCop` is called twice for the same cop, the counter goes up by 2. This is a bug we accept because:
- The caller (`dropRunRepository.finalize`) is itself idempotent — `finalize` is called exactly once per run via the state machine guard
- The reaped-run scenario (worker crash mid-finalize) inserts a NEW drop_run with `attempt+1`; if that retry cops, it gets a NEW order_number, so it's a legitimate +2 on the counter (two cops, not one cop counted twice)

If we ever want true counter idempotency, we'd need a `cop_idempotency` table keyed on order_number. Defer until measured drift > 1%.

### Stripe API Reference

- Create UsageRecord: https://docs.stripe.com/api/usage_records/create
- Endpoint: `POST /v1/subscription_items/{subscription_item}/usage_records`
- Required: `quantity`, `timestamp` (or `action: 'set'` for absolute), `action: 'increment'` for delta
- Idempotency key: standard `Idempotency-Key` HTTP header (24 h TTL)

### Subscription Item ID Resolution

Subscription items are created when the Checkout completes and `customer.subscription.created` fires (Story 18.4). The webhook payload contains:
```json
{
  "items": {
    "data": [
      { "id": "si_subscription_...", "price": { "id": "price_solo_monthly" } },
      { "id": "si_metered_...", "price": { "id": "price_solo_metered_per_cop" } }
    ]
  }
}
```

Story 18.4 inserts both rows into `subscription_items`; this story's `findMeteredItemId` reads the `metered_per_cop` row.

### Project Structure Notes

New files:
```
packages/api/src/db/migrations/020_subscription_items.sql
packages/api/src/billing/billingAccountant.ts
packages/api/src/billing/billingAccountant.test.ts
packages/api/src/billing/subscriptionItemRepo.ts
```

Modified:
- `packages/api/scripts/bootstrap-billing.ts` — add metered Price per tier
- `packages/api/src/billing/stripeClient.ts` — add `createUsageRecord`
- `packages/api/src/drops/dropRunRepository.ts` — call accountant on COP

### References

- Epics: Story 18.3 (formerly skeleton 18.2)
- PRD: Per-cop fee business model section, NFR40 (Stripe idempotency)
- V3_MIGRATION_PLAN.md Phase 5: Per-cop usage event emission with idempotency key
- Stripe Metered Billing: https://docs.stripe.com/billing/subscriptions/usage-based
- Stripe API: `stripe.subscriptionItems.createUsageRecord` — https://docs.stripe.com/api/usage_records/create
- Depends on: Story 17.3 (drop_run COP transition), Story 18.1 (StripeClient), Story 18.2 (tiers + bootstrap)
- Enables: Story 18.4 (webhook handler populates subscription_items), Story 18.5 (counter consumed by limit enforcement)

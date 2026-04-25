# Story 15.5: Webhook Delivery (Outbox Pattern + Background Worker)

Status: done

## Story

As a B2B customer,
I want to register webhook URLs and receive signed POSTs for every drop and order event (`drop.scheduled|started|cop|fail|completed`, `order.refunded`),
so that I can react in my own systems (Slack alerts, internal CRM, downstream automation) without polling the REST API.

## Acceptance Criteria

**Given** a customer has registered `webhooks` row `{ url: "https://example.com/hook", secret: "whsec_...", events_subscribed: ["drop.cop","drop.fail"], active: true }`
**When** a worker emits a `drop.cop` event for a drop owned by this customer
**Then** the emitting code writes a `webhook_deliveries` outbox row (same database transaction as the cop) with `attempt_count=0`, `next_retry_at=now()`, `delivered_at=null`
**And** within 30 s (NFR37), a delivery worker picks up the row, sends `POST <url>` with body `{ id, type, created_at, data: {...} }` and headers `X-NikeBot-Signature: sha256=<hmac>`, `X-NikeBot-Event: drop.cop`, `X-NikeBot-Delivery: <delivery_id>`, `Content-Type: application/json`, where `<hmac> = HMAC-SHA256(secret, raw_body)`
**And** on HTTP 2xx response, `delivered_at = now()` and the row is no longer retried
**And** on 4xx (except 408/429) the row is marked `delivered_at = now(), http_status = <code>` and not retried (customer error — not our problem)
**And** on 5xx, 408, 429, network error, or timeout (10 s), the row is rescheduled with exponential backoff `next_retry_at = now() + min(2^attempt * 30s, 1h) + jitter`, up to 24 h total elapsed; after 24 h the row moves to a dead-letter state (`http_status=-1`, `delivered_at` stays null, surfaces in `GET /v1/account/webhooks/dlq`)
**And** the delivery worker is at-least-once; the customer is responsible for idempotency via `X-NikeBot-Delivery` ID

## Tasks / Subtasks

### Task 1: Outbox table schema (AC: durable queue)

Confirm in Story 16.1 migration:

```sql
CREATE TABLE webhooks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  url                 TEXT NOT NULL,
  secret_encrypted    BYTEA NOT NULL,
  events_subscribed   TEXT[] NOT NULL,
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL,            -- denormalized for tenant isolation
  event_type      TEXT NOT NULL,
  payload_json    JSONB NOT NULL,
  http_status     INTEGER,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_pending_idx
  ON webhook_deliveries (next_retry_at)
  WHERE delivered_at IS NULL AND http_status IS DISTINCT FROM -1;
```

### Task 2: Outbox writer `src/services/webhooks/emit.ts` (AC: same-tx insert)

```typescript
export async function emit(tx: Tx, customerId: string, eventType: string, data: object) {
  const subs = await tx.webhooks.findActiveSubscribed(customerId, eventType)
  for (const w of subs) {
    await tx.webhookDeliveries.insert({
      webhook_id: w.id,
      customer_id: customerId,
      event_type: eventType,
      payload_json: { id: randomUUID(), type: eventType, created_at: new Date().toISOString(), data },
    })
  }
}
```

Caller pattern (e.g., from Story 17.x worker on cop): `await db.tx(async (tx) => { await orders.insert(tx, ...); await webhooks.emit(tx, customerId, 'drop.cop', {...}) })`.

### Task 3: Delivery worker `src/workers/webhookDispatcher.ts` (AC: backoff, signing, DLQ)

```typescript
const TIMEOUT_MS = 10_000
const MAX_BACKOFF_MS = 60 * 60 * 1000
const TOTAL_RETRY_BUDGET_MS = 24 * 60 * 60 * 1000

async function tick() {
  const batch = await db.webhookDeliveries.claimDue(50) // SELECT ... FOR UPDATE SKIP LOCKED
  await Promise.all(batch.map(deliver))
}

async function deliver(row: DeliveryRow) {
  const w = await db.webhooks.findById(row.webhook_id)
  const secret = await decryptCustomerSecret(row.customer_id, w.secret_encrypted) // Story 16.2
  const body = JSON.stringify(row.payload_json)
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  let status = -1
  try {
    const res = await fetch(w.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NikeBot-Signature': sig,
        'X-NikeBot-Event': row.event_type,
        'X-NikeBot-Delivery': row.id,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    status = res.status
  } catch (err) { /* network error → status stays -1 (treated as 5xx) */ }

  const success = status >= 200 && status < 300
  const dontRetry = status >= 400 && status < 500 && status !== 408 && status !== 429
  if (success || dontRetry) {
    await db.webhookDeliveries.markDone(row.id, status)
    return
  }
  const elapsed = Date.now() - row.created_at.getTime()
  if (elapsed >= TOTAL_RETRY_BUDGET_MS) {
    await db.webhookDeliveries.markDeadLetter(row.id)
    return
  }
  const backoff = Math.min(2 ** row.attempt_count * 30_000, MAX_BACKOFF_MS) + Math.floor(Math.random() * 5000)
  await db.webhookDeliveries.reschedule(row.id, new Date(Date.now() + backoff))
}

setInterval(tick, 1000)
```

Worker process is a separate entrypoint `packages/api/src/workers/index.ts` so the API process and the dispatcher can scale independently.

### Task 4: `claimDue` SQL with row-locking (AC: at-most-one-claim)

```sql
WITH claimed AS (
  SELECT id FROM webhook_deliveries
  WHERE delivered_at IS NULL
    AND http_status IS DISTINCT FROM -1
    AND next_retry_at <= now()
  ORDER BY next_retry_at
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
UPDATE webhook_deliveries d
   SET attempt_count = d.attempt_count + 1
  FROM claimed
 WHERE d.id = claimed.id
RETURNING d.*;
```

`SKIP LOCKED` lets multiple worker replicas run safely.

### Task 5: Webhook registration endpoints (AC: customer self-service)

`POST /v1/webhooks` `{ url, events_subscribed }` → server generates `secret = whsec_<32b base32>`, encrypts via per-customer DEK (Story 16.2), returns the plaintext secret ONCE. `GET /v1/webhooks` lists (no secrets). `DELETE /v1/webhooks/{id}` deactivates.

### Task 6: Tests `src/workers/webhookDispatcher.test.ts` (AC: backoff & signing)

Use a mock HTTP server (`undici` `MockAgent`):

- 200 response → row marked delivered, no retry.
- 500 response → `attempt_count` increments, `next_retry_at` advances by ~30 s + jitter.
- 502 then 200 → retried once, then delivered.
- 404 response (4xx not retryable) → marked delivered with status=404.
- 429 response → retried.
- After 24 h elapsed, row → DLQ.
- Signature header equals `sha256=<HMAC-SHA256(secret, raw body)>` — verified by recomputing.
- Two parallel worker instances on the same row → only one claims it (`SKIP LOCKED` semantics).

## Dev Notes

### Why outbox pattern

The cop event is recorded inside the same DB transaction as the order row. If we instead `await fetch(webhookUrl)` in the request path, a slow/dead customer URL stalls our worker pool. The outbox decouples emission from delivery and gives us durable retry semantics across crashes — exactly the NFR37 contract ("99 % delivered within 30 s").

### Signature scheme

`X-NikeBot-Signature: sha256=<hex>` matches the Stripe / GitHub convention so customers can re-use existing verification snippets. Customers verify via:

```javascript
const sig = req.headers['x-nikebot-signature'].split('=')[1]
const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
```

### Backoff schedule

Attempts at 0 s, 30 s, 60 s, 120 s, 240 s, …, capped at 1 h, total budget 24 h ≈ 25 attempts. Aligns with FR74 ("retry with exponential backoff up to 24 h").

### Project Structure Notes

Files created:

- `packages/api/src/services/webhooks/emit.ts`
- `packages/api/src/workers/webhookDispatcher.ts`
- `packages/api/src/workers/webhookDispatcher.test.ts`
- `packages/api/src/workers/index.ts` — worker process bootstrap
- `packages/api/src/routes/webhooks/index.ts`
- `packages/api/src/db/webhooks.ts`, `packages/api/src/db/webhookDeliveries.ts`

Files modified:

- `packages/api/src/app.ts` — register `webhooksRoutes`
- `packages/api/package.json` — add worker entry script `"worker": "node dist/workers/index.js"`

### References

- PRD: `_bmad-output/planning-artifacts/prd.md` — FR74 (webhook events + HMAC + retry), NFR37 (99 %/30 s), NFR39 (audit)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — v3 §"System Topology" (Webhook Outbox), §"Component Responsibilities" (Webhook Outbox row)
- Migration: `docs/V3_MIGRATION_PLAN.md` — Phase 5 ("Webhook outbox + delivery worker — HMAC-SHA256, exp-backoff, DLQ")
- Epics: `_bmad-output/planning-artifacts/epics.md` — Story 15.5

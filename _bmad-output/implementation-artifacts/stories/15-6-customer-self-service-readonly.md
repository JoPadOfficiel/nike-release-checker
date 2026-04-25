# Story 15.6: Customer Self-Service Read-API (`/v1/account/*`)

Status: done

## Story

As a B2B customer,
I want read-only endpoints to inspect my own customer record, my month-to-date usage and cost, and my list of API keys,
so that I can build internal dashboards and reconcile billing without waiting for a UI (the v4 dashboard is months away).

## Acceptance Criteria

**Given** an authenticated customer (Story 15.2)
**When** they call `GET /v1/account`
**Then** the response is HTTP 200 `{ id, email, tier, created_at, stripe_customer_id?, deleted_at: null }` — only the requesting customer's row, never any other customer's data
**And** `GET /v1/account/usage` returns `{ period: { start, end }, cops_count, cops_cost_cents, currency, breakdown: [{ date: "YYYY-MM-DD", cops, cost_cents }] }` for the current calendar month (UTC), aggregated from `orders` joined to `drop_runs` with `customer_id = req.customerId`
**And** `GET /v1/account/api-keys` returns `{ data: [{ key_id, label, created_at, last_used_at, revoked_at }] }` — `secret_hash` and the original secret are NEVER returned (the secret is only displayed once at creation by a future endpoint)
**And** the three endpoints are auth-required, rate-limited, and tenant-isolated; an unrelated customer cannot read this customer's row even with a valid token
**And** every endpoint emits OpenAPI schemas (`AccountResponse`, `UsageResponse`, `ApiKeyListResponse`) auto-published at `/docs/openapi.json`
**And** all monetary values are integers in the smallest currency unit (cents); `currency` is ISO 4217

## Tasks / Subtasks

### Task 1: JSON schemas `src/routes/account/schemas.ts` (AC: auto-doc)

```typescript
export const AccountResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  email: Type.String({ format: 'email' }),
  tier: Type.Union([Type.Literal('solo'), Type.Literal('pro'), Type.Literal('enterprise')]),
  created_at: Type.String({ format: 'date-time' }),
  stripe_customer_id: Type.Optional(Type.String()),
  deleted_at: Type.Union([Type.Null(), Type.String({ format: 'date-time' })]),
})

export const UsageResponse = Type.Object({
  period: Type.Object({ start: Type.String({ format: 'date-time' }), end: Type.String({ format: 'date-time' }) }),
  cops_count: Type.Integer({ minimum: 0 }),
  cops_cost_cents: Type.Integer({ minimum: 0 }),
  currency: Type.String({ pattern: '^[A-Z]{3}$' }),
  breakdown: Type.Array(Type.Object({
    date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    cops: Type.Integer(),
    cost_cents: Type.Integer(),
  })),
})

export const ApiKeyListResponse = Type.Object({
  data: Type.Array(Type.Object({
    key_id: Type.String(),
    label: Type.Union([Type.Null(), Type.String()]),
    created_at: Type.String({ format: 'date-time' }),
    last_used_at: Type.Union([Type.Null(), Type.String({ format: 'date-time' })]),
    revoked_at: Type.Union([Type.Null(), Type.String({ format: 'date-time' })]),
  })),
})
```

### Task 2: Repositories (AC: tenant-scoped reads)

- `src/db/customers.ts` — `findById(id): Customer | null`.
- `src/db/usage.ts` — aggregate query:

```sql
SELECT date_trunc('day', o.created_at) AS day,
       COUNT(*) AS cops,
       COALESCE(SUM(o.total_amount_cents), 0) AS cost_cents,
       MIN(o.currency) AS currency
  FROM orders o
 WHERE o.customer_id = $1
   AND o.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
   AND o.status IN ('confirmed', 'shipped', 'delivered')
 GROUP BY day
 ORDER BY day;
```

If the customer has no orders MTD, return `cops_count=0`, `cost_cents=0`, `currency=customers.default_currency` (fall back to `'USD'`).

- `src/db/apiKeys.ts` — extend with `listByCustomer(customerId): ApiKeyMetaRow[]` selecting only `key_id, label, created_at, last_used_at, revoked_at` (NEVER `secret_hash`).

### Task 3: Route handlers `src/routes/account/index.ts` (AC: 3 endpoints)

```typescript
app.get('/v1/account', { schema: { response: { 200: AccountResponse } } }, async (req) => {
  const c = await customers.findById(req.customerId!)
  if (!c) throw notFound()
  return c
})

app.get('/v1/account/usage', { schema: { response: { 200: UsageResponse } } }, async (req) => {
  const start = startOfUtcMonth(new Date())
  const end   = new Date()
  const rows  = await usage.aggregate(req.customerId!, start, end)
  return {
    period: { start: start.toISOString(), end: end.toISOString() },
    cops_count: rows.reduce((a, r) => a + r.cops, 0),
    cops_cost_cents: rows.reduce((a, r) => a + r.cost_cents, 0),
    currency: rows[0]?.currency ?? 'USD',
    breakdown: rows.map((r) => ({ date: r.day.toISOString().slice(0, 10), cops: r.cops, cost_cents: r.cost_cents })),
  }
})

app.get('/v1/account/api-keys', { schema: { response: { 200: ApiKeyListResponse } } }, async (req) => {
  return { data: await apiKeys.listByCustomer(req.customerId!) }
})
```

### Task 4: Tests `src/routes/account/account.test.ts` (AC: matrix)

- `GET /v1/account` happy path returns the right customer.
- `GET /v1/account` with token from customer A returns A's row (never B's, even when B's id is guessed in path — but path is implicit so no leak vector here).
- `GET /v1/account/usage` with no orders → `cops_count: 0`, `breakdown: []`.
- `GET /v1/account/usage` with 3 orders across 2 days → `cops_count: 3`, `breakdown.length: 2`.
- `GET /v1/account/usage` ignores orders with `status='refunded'` or `status='cancelled'`.
- `GET /v1/account/api-keys` returns rows; assert no field named `secret_hash` or `secret` appears in the JSON output (string-search the response body).
- All three endpoints with no auth → 401.

### Task 5: OpenAPI snapshot test (AC: schemas published)

Add `src/routes/account/openapi.test.ts`: hit `GET /docs/openapi.json` and assert the document has paths `/v1/account`, `/v1/account/usage`, `/v1/account/api-keys` each with a `200` response referencing the registered schemas.

## Dev Notes

### Foundation, not full self-service

This story ships READ-ONLY for v3.0. Mutations (rotate API key, change tier, update billing email) are deferred to v3.1+ once the customer base is non-zero and the dashboard frontend (v4) takes shape. Read-only is enough to unblock customer-side billing reconciliation and integration debugging.

### Why `breakdown` per day

Customers want to spot anomalies (e.g., a runaway drop on Apr 17 doubled their cost). A daily roll-up keeps response size bounded (max 31 entries) while giving enough resolution to investigate.

### Status filter

`status IN ('confirmed', 'shipped', 'delivered')` excludes refunded and cancelled orders from billed cops — matches the Stripe metered-usage convention from Story 18.2.

### Project Structure Notes

Files created:

- `packages/api/src/routes/account/index.ts`
- `packages/api/src/routes/account/schemas.ts`
- `packages/api/src/routes/account/account.test.ts`
- `packages/api/src/routes/account/openapi.test.ts`
- `packages/api/src/db/customers.ts`
- `packages/api/src/db/usage.ts`

Files modified:

- `packages/api/src/db/apiKeys.ts` — add `listByCustomer`
- `packages/api/src/app.ts` — register `accountRoutes`

### References

- PRD: `_bmad-output/planning-artifacts/prd.md` — FR72 (REST surface), NFR32 (tenant isolation), NFR38 (rate-limit headers)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — v3 §"Multi-Tenant Data Model" (`customers`, `orders`), §"Component Responsibilities" (Billing Engine — usage aggregation source)
- Migration: `docs/V3_MIGRATION_PLAN.md` — Phase 5 ("Customer self-serve API key generation"); v4 owns the frontend dashboard
- Epics: `_bmad-output/planning-artifacts/epics.md` — Story 18.4 (read-API) — overlaps; this story carves out the non-billing read endpoints

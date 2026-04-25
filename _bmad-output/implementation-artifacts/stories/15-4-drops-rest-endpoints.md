# Story 15.4: Drop REST Endpoints (`/v1/drops`)

Status: done

## Story

As a B2B customer,
I want to create, read, schedule/run, list orders for, and delete drops via REST,
so that I can drive the bot programmatically from my own systems without using the CLI or TUI.

## Acceptance Criteria

**Given** an authenticated customer (Story 15.2) and an existing Nike account they own (Story 16.4)
**When** they call `POST /v1/drops` with body `{country: "FR", sku: "DV3854-100", sizes: ["42","42.5"], maxAccounts: 5, paymentMethodId: "card_xyz", scheduledAt: "2026-05-01T08:00:00Z"}`
**Then** the gateway validates the payload against a JSON schema, inserts a row into `drops` with `state="DRAFT"` and `customer_id = req.customerId`, and returns HTTP 201 `{ id: "drp_...", state: "DRAFT", ...echo }` with `Location: /v1/drops/drp_...`
**And** `GET /v1/drops/{id}` returns the drop record with `state`, `created_at`, `scheduled_at`, `completed_at`, plus an aggregated `runs: { total, completed, failed, in_progress }` summary; 404 if `id` not found OR `customer_id` mismatch (no leak)
**And** `POST /v1/drops/{id}/run` transitions `DRAFT → SCHEDULED` (if `scheduledAt` future) or `DRAFT → ACTIVE` (if absent/past), enqueues the drop in the scheduler (Epic 17), and returns HTTP 202 with `Location` echoing the drop URL
**And** `DELETE /v1/drops/{id}` only succeeds while `state IN ('DRAFT','SCHEDULED')`; transitions to `state="CANCELLED"` (soft delete, audit-logged); returns 409 if state is `ACTIVE` or `COMPLETED`
**And** `GET /v1/drops/{id}/orders` returns paginated `{ data: [{ id, nike_order_number, total_amount_cents, currency, status, created_at, drop_run_id }], cursor }` for orders that belong to this drop AND this customer; uses keyset pagination on `created_at, id`; default page size 50, max 200
**And** all five endpoints are auth-required, rate-limited, and emit audit-log entries (NFR39); cross-tenant access (correct id, wrong customer) consistently returns 404 — never 403 — to prevent existence leaks

## Tasks / Subtasks

### Task 1: JSON schemas `src/routes/drops/schemas.ts` (AC: validation)

Define `CreateDropBody`, `Drop`, `Order` JSON Schemas (TypeBox or `@sinclair/typebox`):

```typescript
const CreateDropBody = Type.Object({
  country:         Type.String({ pattern: '^[A-Z]{2}$' }),
  sku:             Type.String({ pattern: '^[A-Z0-9-]{6,20}$' }),
  sizes:           Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
  maxAccounts:     Type.Integer({ minimum: 1, maximum: 500 }),
  paymentMethodId: Type.String(),
  scheduledAt:     Type.Optional(Type.String({ format: 'date-time' })),
})
```

Fastify auto-validates and auto-publishes to OpenAPI (Story 15.1).

### Task 2: Repository `src/db/drops.ts` (AC: tenant-scoped queries)

Every method takes `customerId` and includes it in the WHERE clause. Methods: `create`, `findById(id, customerId)`, `updateState(id, customerId, fromStates, toState)` (atomic via `UPDATE ... WHERE id=$1 AND customer_id=$2 AND state = ANY($3)` returning row count), `listOrders(dropId, customerId, cursor, limit)`.

### Task 3: Route handlers `src/routes/drops/index.ts` (AC: 5 endpoints)

```typescript
app.post('/v1/drops', { schema: { body: CreateDropBody, response: { 201: DropSchema } } }, async (req, reply) => {
  const drop = await drops.create({ ...req.body, customerId: req.customerId! })
  await audit.log(req, 'drop.create', drop.id)
  reply.code(201).header('Location', `/v1/drops/${drop.id}`).send(drop)
})

app.get('/v1/drops/:id', async (req, reply) => {
  const drop = await drops.findById(req.params.id, req.customerId!)
  if (!drop) return reply.code(404).send(problem('not-found', 404))
  reply.send(drop)
})

app.post('/v1/drops/:id/run', async (req, reply) => {
  const drop = await drops.findById(req.params.id, req.customerId!)
  if (!drop) return reply.code(404).send(problem('not-found', 404))
  const target = drop.scheduled_at && new Date(drop.scheduled_at) > new Date() ? 'SCHEDULED' : 'ACTIVE'
  const updated = await drops.updateState(drop.id, req.customerId!, ['DRAFT'], target)
  if (!updated) return reply.code(409).send(problem('invalid-state', 409))
  await scheduler.enqueue(drop) // Epic 17
  await audit.log(req, 'drop.run', drop.id)
  reply.code(202).header('Location', `/v1/drops/${drop.id}`).send()
})

app.delete('/v1/drops/:id', async (req, reply) => {
  const updated = await drops.updateState(req.params.id, req.customerId!, ['DRAFT', 'SCHEDULED'], 'CANCELLED')
  if (!updated) return reply.code(409).send(problem('invalid-state', 409))
  await audit.log(req, 'drop.delete', req.params.id)
  reply.code(204).send()
})

app.get('/v1/drops/:id/orders', async (req, reply) => {
  const drop = await drops.findById(req.params.id, req.customerId!)
  if (!drop) return reply.code(404).send(problem('not-found', 404))
  const page = await drops.listOrders(drop.id, req.customerId!, req.query.cursor, req.query.limit ?? 50)
  reply.send(page)
})
```

### Task 4: Audit logger stub `src/services/audit.ts` (AC: NFR39)

`audit.log(req, action, resourceId)` inserts into `audit_log` (table from Story 16.1) with `customer_id`, `actor=req.apiKeyId`, `action`, `resource_type='drop'`, `resource_id`, `payload_redacted_json` (request body with PII fields stripped). Failure to write audit must NOT fail the request (log warn).

### Task 5: Scheduler binding (AC: 202 enqueues, Epic 17 boundary)

`scheduler.enqueue(drop)` is a thin interface — Epic 17 owns the implementation. For Phase 4, an in-memory queue is acceptable; Phase 5 promotes to durable. This story stubs the interface with a console-log implementation; Epic 17 stories replace it.

### Task 6: Tests `src/routes/drops/drops.test.ts` (AC: matrix)

Use `inject()` against an app with stub repositories:

- POST 201 happy path; response has `Location` header; row inserted with correct `customer_id`.
- POST validation errors: bad country (`"france"`), bad sku, empty sizes, `maxAccounts > 500` → 400 with field-level details.
- GET 200 happy path; `runs` summary matches DB.
- GET cross-tenant: customer B with customer A's drop id → 404 (not 403).
- POST run: `DRAFT` → 202; `ACTIVE` → 409.
- DELETE: `DRAFT` → 204; `COMPLETED` → 409; cross-tenant → 409 (no leak).
- GET orders: returns paginated; `cursor` round-trips; `limit > 200` → 400.

## Dev Notes

### Tenant isolation pattern

Every query includes `customer_id = $X`. Cross-tenant access returns 404 (not 403) to prevent attackers from probing for existence of resources owned by other customers. NFR32 demands this is verified by an automated cross-tenant integration test (Story 16.4 owns that test).

### State machine boundary

This story creates the REST surface; Story 17.1 (Epic 17) owns the lifecycle state machine itself. We expose only the transitions reachable via the REST API:

- `POST /v1/drops` → write `DRAFT`
- `POST /v1/drops/{id}/run` → `DRAFT → SCHEDULED | ACTIVE`
- `DELETE /v1/drops/{id}` → `DRAFT|SCHEDULED → CANCELLED`

`ACTIVE → COMPLETED|FAILED` is owned by the scheduler/worker and is not REST-triggered.

### Pagination

Keyset on `(created_at DESC, id DESC)` so a customer with 100k orders pages reliably. Cursor encoded as base64 of `${created_at}|${id}`.

### Project Structure Notes

Files created:

- `packages/api/src/routes/drops/index.ts`
- `packages/api/src/routes/drops/schemas.ts`
- `packages/api/src/routes/drops/drops.test.ts`
- `packages/api/src/db/drops.ts`
- `packages/api/src/services/audit.ts` (stub; Story 16.5 hardens)
- `packages/api/src/services/scheduler.ts` (interface; Epic 17 implements)

Files modified:

- `packages/api/src/app.ts` — register `dropsRoutes`

### References

- PRD: `_bmad-output/planning-artifacts/prd.md` — FR72 (drop endpoints), NFR32 (tenant isolation), NFR39 (audit log)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — v3 §"Multi-Tenant Data Model" (`drops`, `drop_runs`, `orders`), §"Component Responsibilities" (Drop Scheduler)
- Epics: `_bmad-output/planning-artifacts/epics.md` — Story 15.2 (consolidated into this story), Epic 17 (scheduler boundary)
- Migration: `docs/V3_MIGRATION_PLAN.md` — Phase 4 deliverables

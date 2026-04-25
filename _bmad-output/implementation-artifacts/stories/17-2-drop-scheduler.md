# Story 17.2: Drop Scheduler with Per-Customer Concurrency Caps

Status: backlog

## Story

As a SaaS platform operator,
I want a cron-like scheduler that promotes `SCHEDULED` drops to `ARMED` at T-5 and `ACTIVE` at T-0 with per-customer concurrency caps enforced,
So that drops fire reliably at their configured time and no single customer can monopolise the worker pool. (FR72, NFR31)

## Acceptance Criteria

**Given** drops exist in the `drops` table with `state='SCHEDULED'` and `fire_at` timestamps
**When** the scheduler tick runs (every second)
**Then** drops with `fire_at <= now() + interval '5 minutes' AND state='SCHEDULED'` are transitioned to `ARMED` via `DropStateMachine.transitionState(..., actor='scheduler:tick')`
**And** drops with `fire_at <= now() AND state='ARMED'` are transitioned to `ACTIVE` and dispatched to the worker pool
**And** before promotion to `ACTIVE`, the scheduler enforces per-customer concurrency caps: Solo tier max 1 active drop, Pro tier max 5, Enterprise unlimited — over-quota drops stay `ARMED` and the next tick retries
**And** the scheduler is **leader-elected** via Postgres advisory lock (`pg_try_advisory_lock(SCHEDULER_LOCK_KEY)`) so multiple API instances do not double-fire drops
**And** if a tick takes > 5 s, a warning is logged (`scheduler.tick.slow`) and concurrency is investigated
**And** unit tests cover the SQL polling query, the per-tier quota enforcement, and the leader-election fallback (non-leader instances skip the tick)

## Tasks / Subtasks

### Task 1: `DropScheduler` module (AC: tick loop, leader election)

- **File:** `packages/api/src/scheduler/dropScheduler.ts` (new)
- Public API:
  ```ts
  export interface DropScheduler {
    start(): Promise<void>
    stop(): Promise<void>
  }
  export function createDropScheduler(deps: {
    db: Pool
    workerPool: WorkerPoolClient
    repo: DropRepository
    intervalMs?: number
    leaderLockKey?: bigint
  }): DropScheduler
  ```
- Implementation: `setInterval` every 1000 ms (configurable) → call `tick()`
- `tick()` opens a connection → `SELECT pg_try_advisory_lock($1)` with `leaderLockKey` (default `0xD0EDEDED1`) → if not leader, release and return → else run promotion queries

### Task 2: Promotion queries (AC: SCHEDULED → ARMED, ARMED → ACTIVE)

- **File:** `packages/api/src/scheduler/dropScheduler.ts` (continue)
- T-5 promotion:
  ```sql
  SELECT id, customer_id FROM drops
   WHERE state = 'SCHEDULED' AND fire_at <= now() + interval '5 minutes'
   ORDER BY fire_at ASC
   FOR UPDATE SKIP LOCKED;
  ```
- T-0 promotion + dispatch:
  ```sql
  SELECT id, customer_id FROM drops
   WHERE state = 'ARMED' AND fire_at <= now()
   ORDER BY fire_at ASC
   FOR UPDATE SKIP LOCKED;
  ```
- Each row → `repo.transitionState(id, 'ARMED'|'ACTIVE', actor)` then for ACTIVE → `workerPool.dispatchDrop(id)`

### Task 3: Per-customer concurrency cap enforcement (AC: Solo 1 / Pro 5 / Enterprise unlimited)

- **File:** `packages/api/src/scheduler/concurrencyCap.ts` (new)
- Function:
  ```ts
  export async function canPromoteToActive(
    db: Pool,
    customerId: string,
  ): Promise<{ allowed: boolean; current: number; max: number | null }>
  ```
- Query:
  ```sql
  SELECT
    (SELECT tier FROM customers WHERE id = $1) AS tier,
    (SELECT count(*) FROM drops WHERE customer_id = $1 AND state = 'ACTIVE') AS active_count;
  ```
- Tier → cap: `solo: 1`, `pro: 5`, `enterprise: null` (unlimited)
- Returns `{ allowed: active_count < max, current: active_count, max }`
- In the T-0 promotion loop, skip rows where `!allowed` and log `scheduler.quota.exceeded` with customer_id + current + max

### Task 4: WorkerPoolClient interface (AC: dispatch hook)

- **File:** `packages/api/src/scheduler/workerPoolClient.ts` (new)
- Interface only — implementation lives in worker pool package (out of scope for this story):
  ```ts
  export interface WorkerPoolClient {
    dispatchDrop(dropId: string): Promise<void>
  }
  ```
- Provide a `NoopWorkerPoolClient` for local dev / tests that just logs `worker.dispatch.received`
- Future: replaced by Redis-backed `BullMQWorkerPoolClient` in v3.2

### Task 5: Tick instrumentation + slow-tick warning (AC: > 5 s warning)

- **File:** `packages/api/src/scheduler/dropScheduler.ts` (continue)
- Wrap each `tick()` body in `performance.now()` start/end
- If duration > 5000 ms → `logger.warn({ durationMs }, 'scheduler.tick.slow')`
- Emit metrics: `scheduler.tick.duration_ms` histogram, `scheduler.promotions.armed` counter, `scheduler.promotions.active` counter

### Task 6: Tests (AC: polling query, quota, leader election)

- **File:** `packages/api/src/scheduler/dropScheduler.test.ts` (new, integration)
  - Insert 3 drops with `fire_at = now() - 10s, state='SCHEDULED'` → tick once → assert all 3 transitioned to `ACTIVE` (via 2 promotions: SCHEDULED→ARMED then ARMED→ACTIVE within the same tick)
  - Insert 2 drops for a Solo customer with same fire_at → tick → assert only 1 reached `ACTIVE`, the other stayed `ARMED`
  - Two scheduler instances on the same DB → start both → assert only one acquired the advisory lock and ran the tick
- **File:** `packages/api/src/scheduler/concurrencyCap.test.ts` (new)
  - Mock DB → assert Solo with 1 active returns `allowed=false`, Pro with 4 active returns `allowed=true`, Enterprise always returns `allowed=true`

### Task 7: Bootstrap wire-up

- **File:** `packages/api/src/server.ts` (edit)
- On Fastify startup → `const scheduler = createDropScheduler({...}); await scheduler.start()`
- On `SIGTERM` / `SIGINT` → `await scheduler.stop()` before closing the HTTP server

## Dev Notes

### Why Two-Phase Promotion (SCHEDULED → ARMED → ACTIVE)

Single-step `SCHEDULED → ACTIVE` would skip the warmup window. The ARMED state is the trigger for Story 17.5 warmup pipeline (slug pre-resolution, session validation, context pre-launch). Without ARMED, every drop would lose 30-60 s of cop time.

### Postgres Advisory Lock for Leader Election

`pg_try_advisory_lock(key)` returns `true` exactly once per session per key. As long as the leader holds the connection open, no other instance can acquire it. On leader crash / connection drop, Postgres releases the lock and the next tick from any instance acquires it. This is a poor-man's leader election — sufficient for v3.1 with single-region deployment. v3.2 may switch to a dedicated coordinator (etcd/Consul) for multi-region.

### Concurrency Cap Tier Mapping

Hard-coded constants for v3.1:

```ts
const TIER_CAPS = { solo: 1, pro: 5, enterprise: null } as const
```

In v3.2, this moves into the `subscription_tiers` Stripe metadata. For now, the Stripe product IDs map deterministically onto these names (Story 18.2).

### `FOR UPDATE SKIP LOCKED` Rationale

If two scheduler ticks overlap (rare but possible if a tick takes > 1 s), `SKIP LOCKED` ensures the second tick doesn't block on the first — it just sees fewer rows. Combined with leader election above, this is overkill in normal operation but provides safety under degraded conditions.

### Tick Interval Tuning

1 s default is aggressive — most drops fire on the minute boundary, so a 1 s window means at most 1 s drift. If the worker pool back-pressure becomes a problem, increase to 5 s. The slow-tick warning at 5 s is calibrated against this — a 5 s tick at 1 s interval means ticks are queueing up.

### Project Structure Notes

New files:
```
packages/api/src/scheduler/
├── dropScheduler.ts
├── dropScheduler.test.ts
├── concurrencyCap.ts
├── concurrencyCap.test.ts
└── workerPoolClient.ts
```

Modified:
- `packages/api/src/server.ts` — start/stop scheduler in Fastify lifecycle hooks

### References

- Epics: Story 17.2 acceptance criteria (formerly skeleton 17.3 + 17.4 merged)
- PRD: FR72 (drop primitive in REST API), NFR31 (50 parallel checkouts/worker)
- Architecture: Worker pool topology
- V3_MIGRATION_PLAN.md Phase 4: scheduler dispatches drops to worker pool
- Depends on: Story 17.1 (Drop entity + state machine), Epic 16 Story 16.1 (customers.tier column)
- Enables: Story 17.3 (drop_runs leasing), Story 17.5 (warmup port)

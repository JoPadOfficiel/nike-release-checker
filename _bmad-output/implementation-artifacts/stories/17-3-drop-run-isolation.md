# Story 17.3: Per-Account Drop Run Rows with Worker Lease + Retry

Status: backlog

## Story

As a SaaS platform operator,
I want each (drop, nike_account) tuple recorded as its own `drop_runs` row that workers lease via `SELECT ... FOR UPDATE SKIP LOCKED`,
So that the worker pool can scale horizontally without double-running an account and failed runs are retried up to 3 times automatically. (FR72, NFR12, NFR31)

## Acceptance Criteria

**Given** a drop has been promoted to `ACTIVE` (Story 17.2)
**When** the scheduler dispatches it to the worker pool
**Then** the dispatch handler resolves `accounts_filter` against the customer's `nike_accounts` and inserts one `drop_runs` row per account with `state='WAITING'`, `attempt=1`, `drop_id`, `nike_account_id`, `customer_id`, `created_at`
**And** workers claim a run with `SELECT ... FROM drop_runs WHERE state='WAITING' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1` inside a transaction, immediately `UPDATE` to `state='COPPING'` + `worker_id` + `leased_at`
**And** when the worker finishes, it transitions the run to `COP` (with `order_number`), `FAIL` (with `error_reason` + `error_classification`), or `SKIPPED` (with reason)
**And** runs that end in `FAIL` with classification ∈ {`blocked`, `3ds_timeout`, `error`} are re-inserted as a new row with `attempt = previous + 1` until `attempt > 3` (max 3 attempts total — same semantics as v2 Story 11.5)
**And** runs in `COPPING` state with `leased_at < now() - interval '5 minutes'` are reaped (worker crashed) and re-queued as `WAITING` with same attempt count
**And** integration test asserts no two workers can claim the same run simultaneously even with 50 concurrent claim attempts

## Tasks / Subtasks

### Task 1: Postgres migration for `drop_runs` (AC: schema)

- **File:** `packages/api/src/db/migrations/018_drop_runs.sql` (new)
- DDL:
  ```sql
  CREATE TYPE drop_run_state AS ENUM (
    'WAITING', 'COPPING', 'COP', 'FAIL', 'SKIPPED'
  );
  CREATE TABLE drop_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    drop_id UUID NOT NULL REFERENCES drops(id),
    nike_account_id UUID NOT NULL REFERENCES nike_accounts(id),
    customer_id UUID NOT NULL REFERENCES customers(id),
    state drop_run_state NOT NULL DEFAULT 'WAITING',
    attempt SMALLINT NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 3),
    worker_id TEXT,
    leased_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    order_number TEXT,
    error_reason TEXT,
    error_classification TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_drop_runs_lease ON drop_runs(state, created_at) WHERE state = 'WAITING';
  CREATE INDEX idx_drop_runs_reap ON drop_runs(state, leased_at) WHERE state = 'COPPING';
  CREATE INDEX idx_drop_runs_drop ON drop_runs(drop_id);
  CREATE UNIQUE INDEX idx_drop_runs_unique_attempt
    ON drop_runs(drop_id, nike_account_id, attempt);
  ```

### Task 2: `DropRunRepository` (AC: insert, lease, finalize, reap)

- **File:** `packages/api/src/drops/dropRunRepository.ts` (new)
- Public API:
  ```ts
  export interface DropRunRepository {
    insertWaiting(args: { dropId: string; nikeAccountId: string; customerId: string; attempt: number }): Promise<DropRun>
    leaseNext(workerId: string): Promise<DropRun | null>
    finalize(runId: string, outcome: 'COP' | 'FAIL' | 'SKIPPED', meta: FinalizeMeta): Promise<void>
    reapStale(staleThresholdMs?: number): Promise<number>
    listByDrop(dropId: string): Promise<DropRun[]>
  }
  ```
- `leaseNext` SQL:
  ```sql
  WITH leased AS (
    SELECT id FROM drop_runs
     WHERE state = 'WAITING'
     ORDER BY created_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE drop_runs SET
    state = 'COPPING', worker_id = $1, leased_at = now(), started_at = now()
  WHERE id IN (SELECT id FROM leased)
  RETURNING *;
  ```

### Task 3: Drop dispatch handler — resolves accounts_filter (AC: insert WAITING rows)

- **File:** `packages/api/src/drops/dispatchDrop.ts` (new)
- Function: `dispatchDrop(dropId: string): Promise<void>`
- Loads the drop → resolves `accounts_filter`:
  - `'all'` → all `nike_accounts` for `customer_id` with `session_state='valid'`
  - explicit list → `WHERE id = ANY(...)`
- For each account → `repo.insertWaiting({ dropId, nikeAccountId, customerId, attempt: 1 })`
- Emits `drop.dispatched` event (Story 17.4 WS stream consumes this)

### Task 4: Retry logic on FAIL (AC: re-insert with attempt+1, max 3)

- **File:** `packages/api/src/drops/dropRunRepository.ts` (continue)
- In `finalize`, after writing the terminal state, if outcome === `FAIL` and classification ∈ retryable set and `attempt < 3`:
  ```ts
  await this.insertWaiting({
    dropId: run.dropId,
    nikeAccountId: run.nikeAccountId,
    customerId: run.customerId,
    attempt: run.attempt + 1,
  })
  ```
- Retryable classifications: `blocked`, `3ds_timeout`, `error` (matches v2 Story 11.5 logic)
- Non-retryable: `sold_out`, `no_session`, `total_mismatch` — terminal, no re-queue
- Reuses logic from `packages/bot/src/checkout/retryController.ts` ported to the API package as `packages/api/src/drops/retryPolicy.ts` (port — do **not** import from `packages/bot/`)

### Task 5: Stale-lease reaper (AC: COPPING > 5 min → re-queue)

- **File:** `packages/api/src/drops/leaseReaper.ts` (new)
- Runs every 30 s as a background job alongside the scheduler
- SQL:
  ```sql
  UPDATE drop_runs
     SET state = 'WAITING', worker_id = NULL, leased_at = NULL
   WHERE state = 'COPPING' AND leased_at < now() - interval '5 minutes'
   RETURNING id, worker_id;
  ```
- Logs each reaped run (`drop_run.reaped` with run_id + previous worker_id) — surfaces silent worker crashes
- Reaped runs do **not** increment `attempt` (the previous attempt didn't truly run to completion)

### Task 6: Drop completion detection (AC: drop → COMPLETED when all runs terminal)

- **File:** `packages/api/src/drops/dispatchDrop.ts` (continue)
- After `finalize` of any run, query:
  ```sql
  SELECT bool_and(state IN ('COP','FAIL','SKIPPED')) AS all_done
    FROM drop_runs WHERE drop_id = $1;
  ```
- If `all_done` → `dropRepo.transitionState(dropId, 'COMPLETED', actor='worker:'+workerId)`

### Task 7: Tests (AC: lease isolation, retry chain, reap)

- **File:** `packages/api/src/drops/dropRunRepository.test.ts` (new, integration)
  - Insert 1 WAITING run → spawn 50 concurrent `leaseNext` calls → assert exactly 1 returned the row, 49 returned `null`
  - Insert 1 WAITING run → lease → finalize as `FAIL` with classification `blocked` → assert new row inserted with `attempt=2`
  - Repeat finalize chain to `attempt=3` → finalize as FAIL → assert no `attempt=4` row inserted
  - Insert COPPING run with `leased_at = now() - 10 min` → call `reapStale` → assert state back to WAITING, attempt unchanged
- **File:** `packages/api/src/drops/dispatchDrop.test.ts` (new)
  - Drop with `accounts_filter='all'` and 5 valid accounts → dispatch → assert 5 WAITING rows, all with `attempt=1`
  - Drop with explicit filter `[acc_1, acc_2]` → dispatch → assert exactly 2 rows

## Dev Notes

### Why `SELECT ... FOR UPDATE SKIP LOCKED`

The canonical Postgres pattern for distributed work queues. `FOR UPDATE` locks the row, `SKIP LOCKED` lets other concurrent transactions skip past it instead of blocking. Combined with `LIMIT 1`, each call returns at most one row, and concurrent callers each get a different row (or null). No race conditions, no double-leasing, fully ACID.

Reference: https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE — see "SKIP LOCKED" section.

### Retry Policy Reuse from v2

Story 11.5 in v2 implemented retry semantics in `packages/bot/src/checkout/retryController.ts`:
- Max 3 attempts total (initial + 2 retries)
- Retryable classifications: `blocked`, `3ds_timeout`, `error`
- Non-retryable: `sold_out`, `no_session`

Port (don't import) the policy logic into `packages/api/src/drops/retryPolicy.ts`. Keeping the policy logic colocated with the API package avoids cross-package coupling and lets the SaaS tier evolve independently of the v2 self-hosted bot.

### Stale Lease Reaper — Why 5 Minutes

A normal cop run takes 20-35 s (NFR2 SLA). 5 minutes is a 10x safety margin. Lower would risk reaping legitimate slow runs (3DS waits, KPSDK retries). Higher would let a crashed worker monopolise a slot for too long. 5 min is the same threshold used by BullMQ stalled-job detection.

Reaped runs do **not** consume an attempt — the previous attempt is treated as if it never happened. This is fair to the customer: a worker crash is not the customer's fault.

### Unique Index Rationale

`UNIQUE (drop_id, nike_account_id, attempt)` prevents the retry insert from racing and creating two rows for the same retry attempt. If a race somehow occurs, the second insert fails with a constraint violation — caller catches and treats as success (the row already exists).

### Drop Completion vs. Manual COMPLETED

`COMPLETED` transition fires automatically when all runs reach terminal state. Customer cannot manually mark a drop COMPLETED — only via the worker pool's natural completion. CANCELLED is the manual termination path (Epic 17.1 lifecycle).

### Project Structure Notes

New files:
```
packages/api/src/db/migrations/018_drop_runs.sql
packages/api/src/drops/dropRunRepository.ts
packages/api/src/drops/dropRunRepository.test.ts
packages/api/src/drops/dispatchDrop.ts
packages/api/src/drops/dispatchDrop.test.ts
packages/api/src/drops/leaseReaper.ts
packages/api/src/drops/retryPolicy.ts
```

### References

- Epics: Story 17.3 acceptance criteria (formerly skeleton 17.2)
- PRD: FR72 (drop primitive surface), NFR12 (fault isolation), NFR31 (50 parallel checkouts/worker)
- Architecture: Worker pool topology section
- v2 Story 11.5: `packages/bot/src/checkout/retryController.ts` — retry policy reference
- Depends on: Story 17.1 (drops table), Story 17.2 (scheduler dispatches), Epic 16 Story 16.1 (nike_accounts table)
- Enables: Story 17.4 (WS event stream), Epic 18 Story 18.3 (per-cop billing on COP transition)

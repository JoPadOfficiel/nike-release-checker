# Story 17.5: Port v2 Warmup Mode into SaaS Worker Pool

Status: backlog

## Story

As a SaaS platform operator,
I want the v2 `warmupMode.ts` (Story 11.3) ported into the worker pool so the ARMED → ACTIVE window pre-resolves slugs, validates sessions, and pre-launches contexts per drop,
So that SaaS customers get the same sub-30 s cop performance the v2 self-hosted users enjoy, with WS events streamed in real time. (FR54, NFR2, NFR31)

## Acceptance Criteria

**Given** a drop has been transitioned to `ARMED` by the scheduler (Story 17.2)
**When** the worker pool warmup coordinator picks up the ARMED drop
**Then** it runs the same phased timeline as v2 `warmupMode.ts`: T-5 polling start → T-3 session validation → T-1 context pre-launch → T=0 ready
**And** each phase emits a corresponding WS event via `DropEventBus.publish` (Story 17.4): `warmup.polling`, `warmup.slug_resolved`, `warmup.sessions_validated`, `warmup.contexts_launched`, `warmup.ready`
**And** at T=0, the warmup coordinator transitions the drop to `ACTIVE` (transition guarded by Story 17.1) and the pre-launched contexts are handed off to the dispatcher (Story 17.3) without re-creating contexts
**And** if the SKU is already in stock at ARMED time, warmup collapses (parallel polling+validation+launch) and ACTIVE fires immediately — same as v2 behavior
**And** session validation failures are surfaced as `warmup.session_failed` events per account but do not block the drop — those accounts are SKIPPED at dispatch
**And** integration test verifies the timeline against fake timers, the collapse path, and the WS event sequence

## Tasks / Subtasks

### Task 1: `WarmupCoordinator` in worker pool package (AC: orchestration entrypoint)

- **File:** `packages/api/src/warmup/warmupCoordinator.ts` (new — port of v2 `packages/bot/src/monitor/warmupMode.ts`)
- Public API:
  ```ts
  export interface WarmupCoordinator {
    arm(dropId: string): Promise<WarmupResult>
    cancel(dropId: string): void
  }
  export interface WarmupResult {
    dropId: string
    slug: string | null
    validRunIds: string[]            // drop_run ids ready to dispatch
    skippedRunIds: string[]          // drop_run ids that failed validation
    preLaunchedContexts: Map<string, BrowserContextHandle>
    collapsed: boolean
  }
  ```
- Subscribes to scheduler-emitted `drop.armed` events (from Story 17.2 `transitionState(..., 'ARMED', ...)`) and calls `arm(dropId)` for each

### Task 2: Phased timeline implementation (AC: T-5/T-3/T-1/T=0 phases)

- **File:** `packages/api/src/warmup/warmupCoordinator.ts` (continue)
- Load drop → compute `msToFire = drop.fire_at - now()` (will be ≤ 5 min since ARMED triggers at T-5)
- Schedule phases:
  - Immediately (≈ T-5) → start polling via `kpsdkPoller.pollSku(drop.sku, drop.country, { intervalMs: 2000 })`; on first stock detection, cache slug
  - T-3 → resolve `accounts_filter` against vault, validate each session via `sessionValidator.validate(account)` (Epic 16); collect valid + skipped lists
  - T-1 → for each valid account, allocate a worker slot and create a Playwright context with cookies injected, headless. Store handle in `preLaunchedContexts` map
  - T=0 → `dropRepo.transitionState(dropId, 'ACTIVE', actor='warmup')` → resolve the `arm()` promise → caller dispatches via Story 17.3
- Emit a WS event at every phase boundary via `bus.publish(dropId, ...)`

### Task 3: Collapse path (AC: SKU already live at ARMED)

- **File:** `packages/api/src/warmup/warmupCoordinator.ts` (continue)
- First poll inside `arm()` is synchronous-ish: `await kpsdkPoller.pollOnce(sku, country)`
- If stock present immediately → run T-3 + T-1 phases in parallel via `Promise.all` instead of waiting for the timeline → resolve with `collapsed: true`
- WS event `warmup.collapsed` emitted before phases start so the client knows to expect the fast path

### Task 4: Per-account WS events for warmup (AC: granular progress)

- **File:** `packages/api/src/warmup/warmupCoordinator.ts` (continue)
- Inside the validation phase, per-account events:
  - `warmup.account_validating` (start)
  - `warmup.account_validated` (success) OR `warmup.session_failed` (failure with reason)
- Inside the launch phase:
  - `warmup.account_launching`
  - `warmup.account_ready` OR `warmup.account_launch_failed` (Playwright crashed)
- These feed directly into the WS event stream so the customer dashboard mirrors v2 TUI live progress

### Task 5: Hand-off to dispatcher (AC: contexts reused, not re-created)

- **File:** `packages/api/src/drops/dispatchDrop.ts` (edit — Story 17.3 file)
- Extend signature:
  ```ts
  dispatchDrop(dropId: string, opts?: { preLaunchedContexts?: Map<string, BrowserContextHandle> }): Promise<void>
  ```
- When `preLaunchedContexts` present, the worker that leases a run looks up the context for `nikeAccountId` and uses it (no new context creation)
- Lifecycle ownership: warmup creates contexts; dispatcher closes them when the run finalizes (success or failure). Ensures no leaked Playwright processes on a worker node.

### Task 6: Cancel path (AC: drop CANCELLED during warmup)

- **File:** `packages/api/src/warmup/warmupCoordinator.ts` (continue)
- `cancel(dropId)` → clear all scheduled timers, close all pre-launched contexts, emit `warmup.cancelled` event
- Subscribe to `drop.cancelled` events from `DropEventBus`; auto-call `cancel()` if drop transitions to CANCELLED mid-warmup

### Task 7: Tests (AC: timeline, collapse, WS events)

- **File:** `packages/api/src/warmup/warmupCoordinator.test.ts` (new)
- Use `node:test` with `mock.timers.enable()` for fake timers (same pattern as v2 Story 11.3 tests)
- Test 1: `fire_at = now + 5 min` → arm → assert phases fire at T-5, T-3, T-1, T=0 exactly; assert WS events emitted in order
- Test 2: SKU already live at arm → assert `collapsed: true`, assert all phases run in parallel via `Promise.all`
- Test 3: 3 of 10 sessions invalid → assert `validRunIds.length === 7`, `skippedRunIds.length === 3`, 3 `warmup.session_failed` events
- Test 4: Drop CANCELLED at T-2 → assert all contexts closed, no further events emitted
- Test 5: Dispatcher receives `preLaunchedContexts` map → asserts no new context created during dispatch (mock `createCheckoutContext` to throw)

## Dev Notes

### Why Port and Not Import from `packages/bot/`

The v2 `packages/bot/src/monitor/warmupMode.ts` was designed for single-tenant local execution (one operator, one drop, in-process). The SaaS worker pool needs:
- Multi-tenant context isolation (one DEK per customer — Story 16.1)
- Cross-process context handles (warmup on one worker, dispatch on the same worker — but coordinator is on the API node)
- WS event emission (vs. v2 Ink TUI render)
- DB-backed state (vs. v2 in-memory)

Porting (rather than importing) keeps the SaaS package free of v2 self-hosted assumptions. The phased timeline (T-5/T-3/T-1/T=0) and the collapse logic are the reusable IP — copy + adapt, do not import.

### Reference Implementation

Read these v2 files for the exact phase logic to mirror:
- `packages/bot/src/monitor/warmupMode.ts` — `WarmupController`, `startWarmup`, phase scheduling
- `packages/bot/src/monitor/warmupMode.test.ts` — fake timer pattern, collapse test

### Worker Pool Topology Note

In v3.1, the worker pool is a single node (NFR31: 50 parallel checkouts/worker). The warmup coordinator runs on the API node, but Playwright contexts are created on the worker node via a thin RPC layer. For v3.1 simplicity, the coordinator can co-locate with the worker (single node) — the RPC layer is a no-op. v3.2 splits them and adds gRPC.

### Event Naming Convention

`warmup.*` events distinguish from `drop.*` (lifecycle) and `account.*` (cop/fail). Customers can filter their dashboard subscription by event prefix:
- Operations dashboard → `drop.*` only
- Detailed live view → `drop.*` + `warmup.*` + `account.*`

### Hand-off Lifecycle

```
warmupCoordinator.arm(dropId)
  ├─ T-5: poll (cache slug)
  ├─ T-3: validate sessions (skip invalid)
  ├─ T-1: pre-launch contexts (per valid account)
  └─ T=0: transition ACTIVE
       ↓ resolves arm() with WarmupResult
       ↓
dispatchDrop(dropId, { preLaunchedContexts })
  ├─ insert WAITING runs (one per validRunId)
  └─ workers lease + use the pre-launched context
       ↓ on finalize, worker closes its context
```

### Project Structure Notes

New files:
```
packages/api/src/warmup/
├── warmupCoordinator.ts
├── warmupCoordinator.test.ts
└── index.ts
```

Modified:
- `packages/api/src/drops/dispatchDrop.ts` — accept `preLaunchedContexts` option
- `packages/api/src/server.ts` — start warmup coordinator alongside scheduler

### References

- Epics: Story 17.5 derived from need to port v2 warmup
- PRD: FR54 (warmup mode), NFR2 (35 s parallel SLA), NFR31 (50 parallel/worker)
- v2 Reference: `packages/bot/src/monitor/warmupMode.ts` (Story 11.3 implementation)
- Depends on: Story 17.1 (state machine), Story 17.2 (scheduler ARMED transition), Story 17.4 (event bus)
- Enables: Story 17.3 dispatcher consumes `preLaunchedContexts`

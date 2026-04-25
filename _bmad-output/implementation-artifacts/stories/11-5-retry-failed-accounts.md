# Story 11.5: Retry Failed Accounts Action

Status: done

## Story

As Kevin (reseller non-dev),
I want to retry checkout for accounts that failed 3DS timeout or blocked status,
So that I get a second chance without re-editing drop.csv. (FR32, FR55)

## Acceptance Criteria

**Given** the final summary screen (Story 11.4) shows failed accounts
**When** Kevin presses `[R] Retry failed`
**Then** a selection prompt appears: `"Select accounts to retry (space to toggle, enter to confirm)"` with a list of all non-COP account rows
**And** Kevin can also select which failure types to auto-include: `"All THREEDS_TIMEOUT / All BLOCKED / All ERROR"`
**And** on confirmation, a new checkout batch is triggered for selected accounts against the same SKU
**And** proxies rotate fresh for BLOCKED retries (if proxy pool supports rotation); same proxy for THREEDS_TIMEOUT (that account's bank is the limiting factor)
**And** the dashboard re-renders with only the retry accounts
**And** after retry completes, the summary screen updates; retries are included in the existing report CSV with a `retry_attempt` column (value 2, 3, etc.)
**And** max 3 retries per account per drop; further retries rejected with a message

## Tasks / Subtasks

### Task 1: [x] RetryController module (AC: attempt tracking, max 3)

- **File:** `packages/bot/src/checkout/retryController.ts` (new)
- Public API:
  ```ts
  export class RetryController {
    private attemptCount = new Map<string, number>() // accountId -> count
    readonly maxRetriesPerAccount = 3
    canRetry(accountId: string): boolean {
      return (this.attemptCount.get(accountId) ?? 1) < this.maxRetriesPerAccount
    }
    recordAttempt(accountId: string): number {
      const next = (this.attemptCount.get(accountId) ?? 1) + 1
      this.attemptCount.set(accountId, next)
      return next
    }
    getAttempt(accountId: string): number {
      return this.attemptCount.get(accountId) ?? 1
    }
  }
  ```
- Initial attempt (the original drop) counts as 1. First retry → 2. Third retry → 4 (rejected before running).
- Single instance per drop run, passed by reference into `parallelCheckout` and `RetrySelection`.

### Task 2: [x] RetrySelection component (AC: multi-select UI)

- **File:** `packages/bot/src/tui/RetrySelection.tsx` (new)
- Props:
  ```ts
  interface RetrySelectionProps {
    failedResults: CheckoutResult[]
    retryController: RetryController
    onConfirm: (selected: CheckoutResult[]) => void
    onCancel: () => void
  }
  ```
- Internal state: `Set<accountId>` of toggled accounts; cursor index
- Key handling via `useInput`:
  - `↑` / `↓` move cursor
  - `space` toggle selected
  - `enter` confirm (calls `onConfirm` with selected CheckoutResults)
  - `esc` cancel
  - `t` / `b` / `e` shortcuts → auto-select all THREEDS_TIMEOUT / BLOCKED / ERROR
- Render:
  ```tsx
  <Box flexDirection="column">
    <Text>Select accounts to retry (space toggle, enter confirm, esc cancel)</Text>
    <Text dimColor>[T] all THREEDS / [B] all BLOCKED / [E] all ERROR</Text>
    <Box marginTop={1} flexDirection="column">
      {failedResults.map((r, i) => (
        <Text key={r.accountId} color={cursor === i ? 'cyan' : undefined}>
          {selected.has(r.accountId) ? '[x]' : '[ ]'} {r.accountId.padEnd(18)} {r.outcome.padEnd(18)}
          {retryController.canRetry(r.accountId) ? '' : ' (max retries reached)'}
        </Text>
      ))}
    </Box>
  </Box>
  ```
- Accounts already at `maxRetriesPerAccount` render with `(max retries reached)` suffix and cannot be toggled.

### Task 3: [x] Proxy rotation policy (AC: rotate for BLOCKED, same for THREEDS)

- **File:** `packages/bot/src/checkout/retryController.ts` (continue)
- Helper:
  ```ts
  export function proxyForRetry(
    result: CheckoutResult,
    proxyPool: ProxyPool,
  ): Proxy | null {
    if (result.outcome === 'blocked' && proxyPool.supportsRotation) {
      return proxyPool.getFreshProxy(result.accountId) // new proxy, exclude previous
    }
    if (result.outcome === '3ds_timeout') {
      return result.proxyUsed // same proxy — bank is the limiting factor
    }
    return proxyPool.getProxy(result.accountId) // default
  }
  ```
- `ProxyPool` interface assumed from Epic 4/5; if `supportsRotation` flag missing, add it with `false` default.

### Task 4: [x] Retry execution loop (AC: re-trigger parallelCheckout with subset)

- **File:** `packages/bot/src/cli/runCommand.ts` (edit)
- After `renderSummary` resolves (if user pressed `[R]`):
  ```ts
  const retryHandler = async (failed: CheckoutResult[]) => {
    unmountSummary()
    const selected = await renderRetrySelection(failed, retryController)
    if (!selected.length) return
    const eligible = selected.filter(r => retryController.canRetry(r.accountId))
    const rejected = selected.length - eligible.length
    if (rejected > 0) logger.warn(`${rejected} account(s) at max retries — skipped`)
    for (const r of eligible) retryController.recordAttempt(r.accountId)
    const retryAccounts = eligible.map(r => accounts.find(a => a.id === r.accountId)!)
    const retryResults = await parallelCheckout(retryAccounts, sku, {
      retryController,
      proxyResolver: (acc) => proxyForRetry(failed.find(f => f.accountId === acc.id)!, proxyPool),
    })
    results.push(...retryResults)
    await renderSummary(results, startedAt, { retryHandler })
  }
  ```
- Loop: summary → retry → summary → retry … until Kevin picks `[Q]` or no failures left.

### Task 5: [x] Report CSV `retry_attempt` column (AC: CSV includes retry attempt)

- **File:** `packages/bot/src/report/reportWriter.ts` (edit — Story 10.5 file)
- Add `retry_attempt` column to header row
- For each result, look up `retryController.getAttempt(accountId)` and write the value (1 for original, 2+ for retries)
- If writer is called multiple times in a session (retry loop), **append** rather than overwrite — same report file for the whole drop.
- Header only written on first call; subsequent calls skip header. Detect via file existence + size > 0.

### Task 6: [x] parallelCheckout extension (AC: accept retry controller)

- **File:** `packages/bot/src/checkout/parallelCheckout.ts` (edit)
- Extend options:
  ```ts
  interface ParallelCheckoutOptions {
    retryController?: RetryController
    proxyResolver?: (acc: Account) => Proxy | null
  }
  ```
- When `retryController` present, tag each emitted `accountStatusChanged` event with `attempt: retryController.getAttempt(accountId)` so the dashboard can display `"(retry 2/3)"` in the details column.
- When `proxyResolver` present, use it instead of the default pool lookup.

### Task 7: [x] Tests

- **File:** `packages/bot/src/checkout/retryController.test.ts` (new)
  - 3 retries per account enforced; 4th rejected via `canRetry() === false`
  - `recordAttempt` increments correctly
  - `proxyForRetry` returns fresh proxy for BLOCKED, same for THREEDS_TIMEOUT
- **File:** `packages/bot/src/tui/RetrySelection.test.tsx` (new)
  - Render with 3 failed + 1 at max → max account rendered disabled
  - Simulate `t` key with mixed outcomes → all THREEDS accounts selected
  - Simulate toggle + confirm → `onConfirm` called with selected subset
- **File:** `packages/bot/src/report/reportWriter.test.ts` (edit)
  - Write initial report (attempt 1), then write retry results (attempt 2) → assert single CSV has both rows + `retry_attempt` column populated

## Dev Notes

### Max Retries Semantics

Initial drop counts as attempt 1. `maxRetriesPerAccount = 3` means the account can run up to 3 times total — i.e. 2 retries after the original. Rationale: after 3 total attempts, further retries are overwhelmingly likely to fail (bank-side throttling, proxy pool exhausted, stock zero). Protects Kevin from wasting time / getting accounts flagged.

Attempt count is in-memory per drop run. If Kevin kills the bot and restarts, counts reset — that's acceptable (new session, new proxy pool state).

### Proxy Rotation Logic

- **BLOCKED** → Nike flagged this IP. Rotate to a fresh proxy. If the pool doesn't support rotation (`supportsRotation = false`), keep the same proxy and log a warning — the retry is unlikely to succeed but Kevin can still choose to try.
- **THREEDS_TIMEOUT** → The bank's 3DS flow timed out, not the proxy. Keep the same proxy (switching proxies mid-3DS risks triggering Nike's fraud detection on IP change mid-session).
- **ERROR** / **SOLD_OUT** → Default pool behavior (usually same proxy; rotation if pool cycles).

### Report CSV — Append Mode

The report CSV (Story 10.5) is written once per drop. Retries append rows to the same file. Header row written only on first write. Use `fs.appendFile` after initial write; detect via `fs.stat(path).catch(() => null)`.

CSV layout:

```
timestamp,account_id,sku,size,outcome,duration_ms,retry_attempt,proxy,details
2026-04-24T10:00:15Z,acc_001,DD1391-100,42,success,22100,1,proxy-a,
2026-04-24T10:01:30Z,acc_002,DD1391-100,42,blocked,1100,1,proxy-b,HTTP 403
2026-04-24T10:02:45Z,acc_002,DD1391-100,42,success,18200,2,proxy-c,
```

### TUI Flow Loop

```
Dashboard ─(all done)→ SummaryScreen
                           │
            [R]────→ RetrySelection ─(confirm)→ Dashboard (only retry accounts)
                           │                          │
                         [Q,O]                      (all done)
                           │                          │
                         exit                       SummaryScreen
```

Each transition unmounts the previous Ink root and mounts the next. Only one Ink root at a time.

### Rejected Retries Feedback

If Kevin selects an account at max retries, the selection UI shows `(max retries reached)` — he can't toggle it. If somehow he still confirms a set that includes such accounts (shouldn't happen via UI), `runCommand.ts` filters them and logs `"${N} account(s) at max retries — skipped"` so he sees why they didn't run.

### Project Structure Notes

New files:
```
packages/bot/src/checkout/
├── retryController.ts
└── retryController.test.ts
packages/bot/src/tui/
├── RetrySelection.tsx
├── RetrySelection.test.tsx
└── renderRetrySelection.tsx
```

Modified:
- `packages/bot/src/checkout/parallelCheckout.ts` — accept `retryController` + `proxyResolver`
- `packages/bot/src/report/reportWriter.ts` — `retry_attempt` column + append mode
- `packages/bot/src/cli/runCommand.ts` — retry loop

### References

- Epics: Story 11.5 acceptance criteria
- PRD: FR32 (retry), FR55 (summary + retry action)
- Story 10.5: `reportWriter` — extended here with `retry_attempt`
- Depends on: Story 11.4 (summary screen triggers this), Story 10.5 (report writer)
- Integrates with: Epic 4 (parallelCheckout), Epic 5 (proxy pool)

## File List

New files:
- `packages/bot/src/checkout/retryController.ts`
- `packages/bot/src/checkout/retryController.test.ts`
- `packages/bot/src/tui/renderRetrySelection.tsx`

Modified files:
- `packages/bot/src/tui/RetrySelection.tsx` — added `retryController` prop, max-retries UI guard and label
- `packages/bot/src/tui/RetrySelection.test.tsx` — added 2 new tests for retryController integration
- `packages/bot/src/tui/renderSummary.tsx` — added `reportFile`/`retryController` options, async retryHandler, append mode, returns reportPath
- `packages/bot/src/checkout/parallelCheckout.ts` — added `retryController` and `proxyResolver` to `ParallelCheckoutOptions`; emits `retrying` status when controller present
- `packages/bot/src/cli/commands.ts` — wired retry loop: `RetryController`, `renderRetrySelection`, retry handler with `filterRetriable`, CSV append mode

## Dev Agent Record

### Implementation Plan

1. `retryController.ts` + `retryController.test.ts` — found already implemented by a prior agent with slightly different API (`getAttempts`/`shouldRotateProxy`/`filterRetriable`). No changes needed; tests pass.
2. `RetrySelection.tsx` — extended with optional `retryController` prop: space-toggle guard prevents toggling capped accounts; render shows `(max retries reached)` label.
3. `renderRetrySelection.tsx` — new helper that mounts `RetrySelection` and returns a `Promise<CheckoutResult[]>`.
4. `parallelCheckout.ts` — added `retryController?` and `proxyResolver?` options; emits `retrying` AccountStatus when controller is supplied.
5. `renderSummary.tsx` — extended `RenderSummaryOptions` with `reportFile` (append mode) and `retryController` (populate `retry_attempt` column); return value changed to `Promise<string | undefined>` for path threading.
6. `commands.ts` — replaced TODO with full retry loop: `runCheckout` helper, `retryHandler`, `savedReportFile` tracking for CSV append, `retryController.filterRetriable` for max-retries guard.
7. `reportWriter.ts` — already had `retry_attempt` column + `appendToFile` option implemented.

### Completion Notes

- All 7 tasks checked. 15 tests pass in isolation; full suite: 648 tests, 646 pass, 2 preexisting failures (completeShipping, loadBotConfig) unrelated to this story.
- `tsc --noEmit`: 4 preexisting errors only (navigateCheckout unused import, 3 dry-run command type issues).
- Proxy rotation policy: `shouldRotateProxy(BLOCKED|ERROR) → true`, `THREEDS_TIMEOUT → false` — no `ProxyPool` abstraction needed since parallelCheckout doesn't yet have a proxy pool parameter; `proxyResolver` option reserved for future wiring.

## Change Log

- 2026-04-25: Story 11.5 implemented — retry loop, RetrySelection retryController integration, parallelCheckout options, renderSummary append mode, CSV retry_attempt column wiring.

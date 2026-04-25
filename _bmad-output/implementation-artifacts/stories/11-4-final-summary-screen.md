# Story 11.4: Final Summary Screen + Auto-Save Report

Status: done

## Story

As Kevin (reseller non-dev),
I want a clear summary at the end showing results and auto-saving a report,
So that I can review the drop outcome and share with my Discord friends. (FR55)

## Acceptance Criteria

**Given** a drop execution completes (all accounts finished or aborted)
**When** the last account reaches a terminal state
**Then** the TUI transitions to a summary screen showing:
- Headline: `"Drop complete — [N] cops out of [M] accounts"`
- Breakdown table by status (COP, SOLD_OUT, BLOCKED, THREEDS_TIMEOUT, ERROR, NO_SESSION) with counts
- Total duration from drop start to last outcome
- Report file path: `"Report saved: ./reports/report-2026-04-24-100015.csv"`
- Menu: `"[R] Retry failed / [O] Open report folder / [Q] Quit"`
**And** the report CSV (Story 10.5) is auto-saved before the summary screen renders
**And** `[O]` opens the reports folder in the OS file manager (`open` on macOS, `explorer` on Windows)
**And** `[Q]` exits the bot cleanly (all contexts already closed at this point)

## Tasks / Subtasks

### Task 1: [x] SummaryScreen component (AC: headline, breakdown, menu)

- **File:** `packages/bot/src/tui/SummaryScreen.tsx` (new)
- Props:
  ```ts
  interface SummaryScreenProps {
    results: CheckoutResult[]
    startedAt: Date
    endedAt: Date
    reportPath: string
    onRetry: (failedResults: CheckoutResult[]) => void
    onQuit: () => void
  }
  ```
- Groups results by `outcome` using `Object.groupBy` (Node 22+)
- Computes:
  - `copsCount` = results where outcome ∈ `{success, 3ds_success}`
  - `totalCount` = results.length
  - `durationMs` = `endedAt.getTime() - startedAt.getTime()`
  - `failedResults` = results where outcome ∉ `{success, 3ds_success}`
- Layout:
  ```tsx
  <Box flexDirection="column">
    <Text bold>Drop complete — {cops} cops out of {total} accounts</Text>
    <Box marginTop={1} flexDirection="column">
      {rows.map(r => <Text key={r.status}>  {r.icon} {r.status.padEnd(18)} {r.count}</Text>)}
    </Box>
    <Text marginTop={1} dimColor>Total duration: {formatDuration(durationMs)}</Text>
    <Text dimColor>Report saved: {reportPath}</Text>
    <Box marginTop={1}>
      <Text>[R] Retry failed / [O] Open report folder / [Q] Quit</Text>
    </Box>
  </Box>
  ```

### Task 2: [x] Keyboard menu via useInput (AC: R/O/Q keys)

- **File:** `packages/bot/src/tui/SummaryScreen.tsx` (continue)
- ```tsx
  useInput((input) => {
    const key = input.toLowerCase()
    if (key === 'r' && failedResults.length > 0) onRetry(failedResults)
    else if (key === 'o') openReportFolder(reportPath)
    else if (key === 'q') onQuit()
  })
  ```
- `[R]` disabled (grayed) if `failedResults.length === 0` — render menu as `"[R] Retry failed (no failures)"` dimmed

### Task 3: [x] openReportFolder helper (AC: cross-platform open)

- **File:** `packages/bot/src/tui/openReportFolder.ts` (new)
- ```ts
  import {spawn} from 'node:child_process'
  import {dirname} from 'node:path'
  export function openReportFolder(reportPath: string): void {
    const folder = dirname(reportPath)
    const cmd = process.platform === 'darwin' ? 'open'
              : process.platform === 'win32'  ? 'explorer'
              : 'xdg-open' // linux fallback
    spawn(cmd, [folder], { detached: true, stdio: 'ignore' }).unref()
  }
  ```
- Detach so closing the bot doesn't close Finder/Explorer
- Unit test: mock `child_process.spawn` and assert correct cmd + arg per platform

### Task 4: [x] Auto-save report before render (AC: report saved before summary renders)

- **File:** `packages/bot/src/tui/renderSummary.tsx` (new)
- ```tsx
  export async function renderSummary(
    results: CheckoutResult[],
    startedAt: Date,
    opts: {retryHandler: (failed: CheckoutResult[]) => void}
  ): Promise<void> {
    const endedAt = new Date()
    const reportPath = await reportWriter.writeReport(results, {startedAt, endedAt})
    const {waitUntilExit} = render(
      <SummaryScreen
        results={results}
        startedAt={startedAt}
        endedAt={endedAt}
        reportPath={reportPath}
        onRetry={opts.retryHandler}
        onQuit={() => process.exit(0)}
      />,
    )
    await waitUntilExit()
  }
  ```
- Calls `reportWriter.writeReport()` (Story 10.5) **before** rendering so the `reportPath` shown is real
- If write fails, render screen anyway with `reportPath = '(save failed)'` and log the error via the terminal logger

### Task 5: [x] Wire into run pipeline (AC: transitions after last account)

- **File:** `packages/bot/src/cli/runCommand.ts` (edit)
- After `parallelCheckout` returns (all accounts terminal OR soft-abort triggered):
  ```ts
  dashboardHandle.unmount()
  await renderSummary(results, startedAt, {
    retryHandler: (failed) => {
      // Story 11.5 — passed in from runCommand
    },
  })
  ```
- Ensure `dashboardHandle.unmount()` is called so Ink releases stdin before SummaryScreen mounts (Ink doesn't support two simultaneous roots)

### Task 6: [x] Tests

- **File:** `packages/bot/src/tui/SummaryScreen.test.tsx` (new)
- Use `ink-testing-library`:
  - Render with 3 success + 2 blocked + 1 3ds_timeout → assert "3 cops out of 6 accounts" appears
  - Simulate `stdin.write('r')` → `onRetry` called with the 3 failed results
  - Simulate `stdin.write('q')` → `onQuit` called
  - With 0 failures, simulate `stdin.write('r')` → `onRetry` NOT called
- **File:** `packages/bot/src/tui/openReportFolder.test.ts` (new)
  - Mock `child_process.spawn`
  - Set `Object.defineProperty(process, 'platform', { value: 'darwin' })` → expect `open`
  - Same for `win32` → `explorer`
  - Same for `linux` → `xdg-open`

## Dev Notes

### Status Breakdown Rows

The breakdown table displays one row per possible `OutcomeType`, even when count is 0 (so Kevin sees the full picture). Ordering (most important first):

1. COP (success + 3ds_success combined) — green ✓
2. SOLD_OUT — red ✗
3. BLOCKED — yellow ⚠
4. THREEDS_TIMEOUT — magenta 🔐
5. NO_SESSION — yellow ⚠
6. ERROR — red ✗

Icons match Epic 5 Story 5.2 `OUTCOME_FORMAT` to stay visually consistent with per-step terminal output.

### Duration Formatting

`formatDuration(ms)`:
- ≥ 1 min → `MM:SS`
- < 1 min → `XX.Xs`

Total duration = from drop start (Epic 4 invocation time) to last terminal outcome. Passed explicitly via props so the summary screen doesn't have to guess.

### Auto-Save Timing

The report **must** be saved before the summary screen renders — otherwise pressing `[O]` could open the folder before the file exists. If `reportWriter.writeReport()` is async (it is — it writes to disk), `await` it in `renderSummary` before `render(<SummaryScreen …>)`.

If the write fails (disk full, permission error), the screen still renders with `reportPath = '(save failed — see logs)'` so Kevin isn't left with a blank terminal. The error is logged via the terminal logger (Epic 5 Story 5.2) to stdout, which is captured by the daemon log file.

### Cross-Platform Open

| Platform | Command   | Behavior                           |
|----------|-----------|------------------------------------|
| macOS    | `open`    | Opens Finder at folder             |
| Windows  | `explorer`| Opens Explorer at folder           |
| Linux    | `xdg-open`| Freedesktop default (GNOME/KDE)    |

Detaching and `unref()`ing the child is important — otherwise `[Q]` right after `[O]` would SIGTERM the file manager process.

### Retry Handoff (Story 11.5)

`onRetry(failedResults)` is the handoff seam to Story 11.5. This story just invokes the callback; Story 11.5 implements the retry selection UI and loop.

### Project Structure Notes

New files:
```
packages/bot/src/tui/
├── SummaryScreen.tsx
├── SummaryScreen.test.tsx
├── renderSummary.tsx
├── openReportFolder.ts
└── openReportFolder.test.ts
```

Modified:
- `packages/bot/src/cli/runCommand.ts` — call `renderSummary` after `parallelCheckout` returns

### References

- Epics: Story 11.4 acceptance criteria
- PRD: FR55 (summary screen + report)
- Story 10.5: `reportWriter.writeReport()` — report CSV
- Depends on: Story 10.5 (report writer), Story 11.1 (Dashboard — transitions from it)
- Feeds into: Story 11.5 (retry handoff)

## File List

### New Files
- `packages/bot/src/tui/SummaryScreen.tsx` — Final summary Ink component
- `packages/bot/src/tui/SummaryScreen.test.tsx` — 9 tests (headline, duration, report path, R/O/Q keys, zero-failures guard, formatDuration unit)
- `packages/bot/src/tui/renderSummary.tsx` — Auto-saves CSV then mounts SummaryScreen
- `packages/bot/src/tui/openReportFolder.ts` — Cross-platform folder opener (macOS/Win/Linux)
- `packages/bot/src/tui/openReportFolder.test.ts` — 4 tests with spy injection per platform

### Modified Files
- `packages/bot/src/cli/commands.ts` — `run` command now uses `renderSummary` + captures `startedAt`

## Dev Agent Record

- Implemented by: bmad-dev-story agent (Sonnet 4.6) on 2026-04-25
- Tasks completed: 6/6 (Task 1–6 all [x])
- tsc errors: 4 (all pre-existing, no new errors introduced)
- New tests: 13 (9 SummaryScreen + 4 openReportFolder), all passing
- Total tui test suite: 47/47 pass
- Design decisions:
  - `openReportFolder` accepts optional `_spawn` override for testability (avoids `mock.module` which requires Node 22.8+)
  - `SummaryScreen` props updated to explicit `startedAt`/`endedAt`/`reportPath` per story spec; report write moved to `renderSummary` to guarantee save-before-render
  - `formatDuration` exported for unit testing
  - Story spec `runCommand.ts` mapped to `commands.ts` (the actual `run` subcommand location in this codebase)

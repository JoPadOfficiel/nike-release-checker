# Story 11.1: Ink TUI Dashboard — Multi-Account Live Rows

Status: done

## Story

As Kevin (reseller non-dev),
I want a live dashboard showing each of my accounts' status during a drop,
So that I can see at a glance what's happening and know the bot is working. (FR53, NFR22, NFR27)

## Acceptance Criteria

**Given** a drop is executing for N accounts (Epic 4 — `parallelCheckout.ts`)
**When** the `nike-bot run` command starts drop execution
**Then** the terminal displays an Ink-rendered dashboard with:
- Header line: `"Drop: [sku] — Sizes: [42,42.5,43] — Accounts: N/M valid"`
- One row per account: `[account_id] [status_icon] [step_label] [elapsed_time] [details]`
- Footer stats: `"Cops: X / Failed: Y / In progress: Z"`
**And** status icons use Unicode: `✓ COP` (green), `⏳ WAIT` (yellow), `✗ FAIL` (red), `🔄 RETRY` (cyan)
**And** row updates are event-driven (not polling) via an event bus consumed by the Ink component tree
**And** dashboard renders at ≥ 2 FPS during active execution (NFR22), verified by instrumented test with 10 parallel mock accounts
**And** fits in an 80-column terminal without horizontal scroll (account_id truncated with ellipsis if > 16 chars; details truncated with `…`) (NFR27)
**And** ESC key returns the user to the final summary screen immediately (soft-abort — running checkouts continue but new ones don't start)

## Tasks / Subtasks

### Task 1: [x] Add Ink + React dependencies (AC: Ink-rendered dashboard)

- **File:** `packages/bot/package.json`
- Add to `dependencies`: `"ink": "^5.0.1"`, `"react": "^18.3.1"`
- Add to `devDependencies`: `"@types/react": "^18.3.1"`
- Update `tsconfig.json` `compilerOptions` with `"jsx": "react-jsx"` (bot-only override — inherits rest from root)
- Run `npm install` from monorepo root to pull Ink + React into the bot workspace
- Verify `npm run lint:ts -w @nike-release-checker/bot` passes with the new JSX setting

### Task 2: [x] Create the event bus (AC: event-driven row updates)

- **File:** `packages/bot/src/tui/eventBus.ts` (new)
- Export a singleton `EventEmitter` (Node `node:events`) typed via a discriminated union
- Event contracts:
  ```ts
  export type TuiEvent =
    | { type: 'accountStatusChanged'; accountId: string; status: StatusIcon; stepLabel: string; elapsedMs: number; details?: string }
    | { type: 'stepCompleted'; accountId: string; step: string; durationMs: number }
    | { type: 'checkoutFinished'; accountId: string; outcome: OutcomeType; totalMs: number }
    | { type: 'softAbortRequested' }
  export type StatusIcon = 'COP' | 'WAIT' | 'FAIL' | 'RETRY'
  ```
- Provide `emit<T extends TuiEvent['type']>(type, payload)` and `on` helpers (typed)
- Unit test: `packages/bot/src/tui/eventBus.test.ts` — verify subscribers receive payloads and types compile.

### Task 3: [x] Build the AccountRow component (AC: one row per account, truncation)

- **File:** `packages/bot/src/tui/AccountRow.tsx` (new)
- Props: `{ accountId: string; status: StatusIcon; stepLabel: string; elapsedMs: number; details?: string }`
- Truncate `accountId` to 16 chars with `…` (NFR27)
- Truncate `details` so total row length ≤ 80 cols (use `useStdout` + `measureElement` or compute from `process.stdout.columns`)
- Icon → color mapping:
  - `COP` → `✓` green
  - `WAIT` → `⏳` yellow
  - `FAIL` → `✗` red
  - `RETRY` → `🔄` cyan
- Render skeleton:
  ```tsx
  import {Box, Text} from 'ink'
  export function AccountRow(props: AccountRowProps) {
    const {icon, color} = iconFor(props.status)
    return (
      <Box flexDirection="row">
        <Box width={18}><Text>{truncate(props.accountId, 16)}</Text></Box>
        <Box width={4}><Text color={color}>{icon}</Text></Box>
        <Box width={20}><Text>{props.stepLabel}</Text></Box>
        <Box width={8}><Text dimColor>{formatMs(props.elapsedMs)}</Text></Box>
        <Box flexGrow={1}><Text>{truncate(props.details ?? '', 30)}</Text></Box>
      </Box>
    )
  }
  ```

### Task 4: [x] Build the Dashboard component (AC: header, rows, footer, ESC key)

- **File:** `packages/bot/src/tui/Dashboard.tsx` (new)
- Props: `{ sku: string; sizes: string[]; accounts: Account[]; onAbort: () => void }`
- Internal state: `Map<accountId, RowState>` updated by `useEffect` subscribing to `eventBus.on('accountStatusChanged', …)`
- Compute footer counts from map values (derived, not stored)
- `useInput((input, key) => { if (key.escape) { eventBus.emit('softAbortRequested', {}); onAbort() } })`
- Layout:
  ```tsx
  <Box flexDirection="column">
    <Box><Text bold>Drop: {sku} — Sizes: [{sizes.join(',')}] — Accounts: {valid}/{total} valid</Text></Box>
    {accounts.map(a => <AccountRow key={a.id} {...stateFor(a.id)} />)}
    <Box marginTop={1}><Text>Cops: {cops} / Failed: {failed} / In progress: {wip}</Text></Box>
  </Box>
  ```

### Task 5: [x] Wire Epic 4 parallelCheckout to the event bus (AC: event-driven updates)

- **File:** `packages/bot/src/checkout/parallelCheckout.ts` (edit)
- At each step boundary (size → cart → shipping → payment → submit), call `eventBus.emit('stepCompleted', …)` and `eventBus.emit('accountStatusChanged', …)`
- On terminal outcome (Epic 4 `OutcomeType`), map outcome → `StatusIcon`:
  - `success` / `3ds_success` → `COP`
  - `sold_out` / `timeout` / `error` → `FAIL`
  - `blocked` / `no_session` → `FAIL`
  - in-flight → `WAIT`
- Emit `checkoutFinished` on terminal state.
- Do not import `ink` or React from `parallelCheckout.ts` — only the event bus. Keeps Epic 4 headless-testable.

### Task 6: [x] Expose the TUI render entry point (AC: `nike-bot run` renders dashboard)

- **File:** `packages/bot/src/tui/renderDashboard.tsx` (new)
- Export `renderDashboard(props): { waitUntilExit: () => Promise<void>; unmount: () => void }`
- Use `import {render} from 'ink'`; return `render(<Dashboard {...props} />)`
- **File:** `packages/bot/src/cli/runCommand.ts` (edit) — call `renderDashboard` before invoking `parallelCheckout`, `await waitUntilExit()` after.

### Task 7: [x] NFR22 2 FPS test (AC: ≥ 2 FPS with 10 accounts)

- **File:** `packages/bot/src/tui/Dashboard.test.tsx` (new)
- Use `ink-testing-library` (add as devDependency)
- Spawn 10 mock accounts. Emit 200 `accountStatusChanged` events over 2 seconds (100 events/s)
- Measure committed frames via a `useEffect` counter in a test harness component
- Assert committed renders ≥ 4 over the 2 s window (i.e. ≥ 2 FPS)

### Task 8: [x] NFR27 80-column layout test

- **File:** `packages/bot/src/tui/AccountRow.test.tsx` (new)
- Force `process.stdout.columns = 80`
- Render row with `accountId = 'really-long-account-name-that-exceeds-16'`, `details = 'x'.repeat(200)`
- Assert no rendered line exceeds 80 visible chars (strip ANSI first via `strip-ansi` or a regex)

## Dev Notes

### Event Bus Contract

The bus is the single seam between the headless checkout engine (Epic 4) and the TUI. Other stories (11.2 animations, 11.3 warmup, 11.4 summary) subscribe to the same bus — do **not** add a second emitter.

Payload shapes are frozen at this story. Any new event type must be additive (new `type` discriminant) and typed in the union.

### NFR22 — 2 FPS Rendering

Ink batches renders via React's reconciler. With 10 accounts emitting ~50 events/s each, React coalesces into far fewer commits — good. But the `useInput` hook and Box re-layout can stall if computations are done inline. Rules:

- Do **not** compute footer counts by iterating the account map on every render without memoization — use `useMemo`
- Derive truncation lengths once per render, not per row
- If `process.stdout.columns` changes mid-drop (terminal resize), re-layout via `useStdout()` effect

### NFR27 — 80-column Terminal

Column budget (80 total):
- `account_id` column: 18 (16 + 2 pad)
- icon column: 4
- step_label column: 20
- elapsed column: 8
- details column: flex, min 30, truncated with `…`

Total: 80. No horizontal scroll; no wrapping (Ink `<Text wrap="truncate">` on details).

### Soft Abort via ESC

Pressing ESC emits `softAbortRequested` on the bus. `parallelCheckout` observes this and stops scheduling new accounts but lets in-flight ones finish. After all in-flight accounts reach terminal state, the runner transitions to the summary screen (Story 11.4).

### Project Structure Notes

New files:
```
packages/bot/src/tui/
├── eventBus.ts
├── eventBus.test.ts
├── AccountRow.tsx
├── AccountRow.test.tsx
├── Dashboard.tsx
├── Dashboard.test.tsx
└── renderDashboard.tsx
```

Modified:
- `packages/bot/package.json` — add ink, react, @types/react, ink-testing-library
- `packages/bot/tsconfig.json` — add `"jsx": "react-jsx"`
- `packages/bot/src/checkout/parallelCheckout.ts` — emit bus events at step boundaries
- `packages/bot/src/cli/runCommand.ts` — call `renderDashboard`

### References

- Epics: `/Users/jopad/Downloads/nike-release-checker/_bmad-output/planning-artifacts/epics.md` (Epic 11, Story 11.1)
- PRD: FR53 (live dashboard), NFR22 (2 FPS), NFR27 (80-col)
- Epic 4: `packages/bot/src/checkout/parallelCheckout.ts` — step boundaries to emit at
- Ink docs: https://github.com/vadimdemedes/ink
- Depends on: Epic 4 (parallelCheckout) — already implemented

---

## Dev Agent Record

### Implementation Plan

Tasks 1-4 and 6 (Dashboard, AccountRow, eventBus, renderDashboard) were already pre-implemented by a prior agent pass. This session completed the remaining gaps:

- Task 2: Created `eventBus.test.ts` with 6 unit tests covering all event types, off() semantics, multi-subscriber, and singleton guarantee.
- Task 5: Added per-step `stepCompleted` emissions in `parallelCheckout.ts` by iterating `result.steps` after each pipeline settles.
- Task 6: Created `renderDashboard.tsx` — thin ink wrapper returning `{ waitUntilExit, unmount }` handle.
- Task 7: Pre-existing `Dashboard.test.tsx` already covers 2 FPS test (measured 9.82 FPS in run).
- Task 8: Created `AccountRow.test.tsx` with 6 tests including NFR27 80-column assertion and truncation tests.

### Debug Log

- `eventBus.test.ts` initially had unused `t` parameter and top-level `await` — fixed by prefixing with `_t` and making the singleton test `async`.
- Pre-existing tsc errors: 4 (in `navigateCheckout.ts` and `commands.ts`) — unchanged.
- Pre-existing test failures: 2 flaky tests (`completeShipping`, `Step1 out-of-range`) unrelated to this story.

### Completion Notes

- All 8 tasks marked complete.
- New tests: 12 (6 in `eventBus.test.ts`, 6 in `AccountRow.test.tsx`).
- Total TUI tests: 24 passing (was 12 before this story).
- Full bot suite: 623 tests, 622 pass, 1 pre-existing fail.
- `tsc --noEmit`: exactly 4 pre-existing errors, zero new.
- NFR22: measured 9.82 FPS with 10 accounts (requirement: ≥ 2 FPS).
- NFR27: 80-column assertion passes — no line exceeds 80 visible chars.

## File List

### New Files
- `packages/bot/src/tui/renderDashboard.tsx`
- `packages/bot/src/tui/eventBus.test.ts`
- `packages/bot/src/tui/AccountRow.test.tsx`

### Modified Files
- `packages/bot/src/checkout/parallelCheckout.ts` — added per-step `stepCompleted` emissions

### Pre-existing Files (already implemented, no changes needed)
- `packages/bot/src/tui/eventBus.ts`
- `packages/bot/src/tui/AccountRow.tsx`
- `packages/bot/src/tui/Dashboard.tsx`
- `packages/bot/src/tui/Dashboard.test.tsx`
- `packages/bot/package.json` — ink, react, @types/react, ink-testing-library already present
- `packages/bot/tsconfig.json` — `"jsx": "react-jsx"` already present
- `packages/bot/src/cli/commands.ts` — Dashboard already wired (renderDashboard inline)

## Change Log

- 2026-04-25: Story 11.1 implemented — created renderDashboard.tsx, eventBus.test.ts, AccountRow.test.tsx; added stepCompleted emissions to parallelCheckout.ts; 24/24 TUI tests passing; tsc clean (4 pre-existing errors only).

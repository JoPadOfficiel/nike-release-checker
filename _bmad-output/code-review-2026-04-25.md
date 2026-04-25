# Code Review — 2026-04-25 (epic 9, 10, 11 + consolidation)

Scope: 16 commits between `4780dfe..HEAD` on `epic/bot-package`. Focus on
stories 9-1..9-6, 10-1..10-5, 11-1..11-5, plus consolidation commits
`72dd464` and `246e96c`.

## Summary

- Tier-1 fixes applied: **1** (typo rename `sluResolved` -> `slugResolved`,
  3 files touched, ~7 lines).
- Tier-2 issues reported: **9**.
- TypeScript `tsc --noEmit`: clean.
- Spot-tested: `warmupMode.test.ts` (4/4 pass after rename).

## Tier-1 fixes (committed)

1. **Typo: `sluResolved` -> `slugResolved`**
   Files: `packages/bot/src/monitor/warmupMode.ts`,
   `packages/bot/src/tui/WarmupWidget.tsx`.
   Affects the `WarmupProgress` interface field plus 3 emit sites and 2
   read sites in the widget. No test references the old name, so the
   rename is safe and self-contained.

## Tier-2 issues (NOT auto-fixed)

### High

(none)

### Medium

1. **`config/cardsStore.ts` — DB file is not chmod'd to 0o600**
   `dbPath()` creates the directory with `mode: 0o700`, but the SQLite
   file itself is created by better-sqlite3 with the process umask
   (typically `0o644`). On a multi-user machine, the encrypted blob is
   readable by other users — defense-in-depth fails (encryption is still
   sound but the security checklist for story 10-4 calls for owner-only).
   *Fix:* `chmod` the file to `0o600` after first create / on every open
   on POSIX.
   File:line: `packages/bot/src/config/cardsStore.ts:25-39`.

2. **`config/csvRead.ts` — comment-stripping breaks row-number provenance**
   Comments are filtered BEFORE papaparse runs, so `parseErrors[i].row`
   from papaparse is the row index in the *filtered* stream, not the
   user's original CSV. The user gets misleading line numbers when the
   file contains `#` comments above an erroring row.
   *Fix:* keep an index map from "filtered line" -> "source line" and
   translate parseErrors after parsing.
   File:line: `packages/bot/src/config/csvRead.ts:35-52`.

3. **`tui/Dashboard.tsx` — side effect inside `setRows` reducer**
   The `checkoutFinished` handler calls `onFinished` from inside
   `setRows((prev) => { onFinished(...); return prev })`. Reducers must be
   pure; under StrictMode / concurrent rendering React may call the fn
   twice, double-firing `onFinished` (which writes a report and unmounts).
   *Fix:* keep `rows` in a ref and call `onFinished` outside of any
   setState callback.
   File:line: `packages/bot/src/tui/Dashboard.tsx:52-57`.

4. **`tui/SummaryScreen.tsx` — `useEffect` depends on `[]` but reads `results`**
   The auto-save effect uses `results` from the closure but has an empty
   dep array. If a parent re-renders with a different `results` prop, the
   first list is the only one written. Combined with `process.chdir` in
   tests, behaviour becomes order-dependent.
   *Fix:* either add `[results]` (and guard against double-write with a
   ref) or accept the eslint-disable + document the mount-only intent.
   File:line: `packages/bot/src/tui/SummaryScreen.tsx:64-75`.

5. **`cli/wizard/Step3SessionCapture.tsx` — `cancelled` flag not propagated**
   Two cascaded `useEffect`s each declare their own `cancelled`. If the
   first effect's parse resolves AFTER unmount, `setAccountIds` still
   fires, which kicks off effect 2 from a stale render. Workers can hit
   real auth code on an unmounted component.
   *Fix:* lift `cancelled` to a `useRef`, or chain via a shared
   AbortController.
   File:line: `packages/bot/src/cli/wizard/Step3SessionCapture.tsx:54-78`.

### Low

6. **`logger/reportWriter.ts` — credential mask regex over-matches**
   `([a-zA-Z0-9+/_-]+):([^@\s]+)@` collapses *any* `foo:bar@baz` pair to
   `***:***@`. Strings like `localhost:8080@something` (uncommon but
   legal in URL fragments) are masked too. Acceptable defensive bias, but
   document or anchor on `://`.
   File:line: `packages/bot/src/logger/reportWriter.ts:43-48`.

7. **`checkout/parallelCheckout.ts` — COP status reports `targetSizes[0]`**
   `finalOutcomeToStatus` builds the COP status with `targetSizes[0]`
   instead of the actually-picked size that lives in
   `select-size` step `details: "size:42"`. Display only — does not
   affect the report writer (adapter extracts the right size).
   File:line: `packages/bot/src/checkout/parallelCheckout.ts:158-164`.

8. **`installer/chromiumInstaller.ts` — `phase` always reported as `'download'`**
   The Playwright installer prints `Downloading`, `Extracting`,
   `Validating`. We forward every `\d+%` match as `phase: 'download'`.
   The TUI never sees `'extract'` or `'verify'`, so the user thinks the
   download stalls at 100% during extract.
   *Fix:* sniff `Extracting`/`Validating` substrings and switch
   `phase` accordingly.
   File:line: `packages/bot/src/installer/chromiumInstaller.ts:69-83`.

9. **`cli/commands.ts` (run command) — sessions are trusted, not validated**
   `validSessionIds = new Set(allIds)` short-circuits the session check
   before resolving the drop's account filter. A drop will hand
   pipelines an account whose session has expired — wasting the
   `no_session` short-circuit. TODO is documented in the file but
   should be tracked.
   File:line: `packages/bot/src/cli/commands.ts:690-695`.

## Confidence

Production-readiness: **medium**. The cryptographic, atomic-write, and
event-bus core looks solid. The TUI and wizard have minor reactivity
hazards that will surface as flaky behaviour under StrictMode or fast
re-renders, but they are not blockers. Item #1 (DB file mode) is the only
true security concern — fix before shipping multi-user binaries.

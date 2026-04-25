# Story 11.2: Emojis, Animations, Progress Bars (Polish)

Status: done

## Story

As Kevin (reseller non-dev),
I want the dashboard to feel alive with animations and emojis,
So that I don't panic and kill the process thinking it's frozen.

## Acceptance Criteria

**Given** the base dashboard (Story 11.1) is functional
**When** an account is in an `⏳ WAIT` state
**Then** an animated spinner (braille or dots) is displayed next to the row, cycling every 100ms
**And** each step label transition (size → cart → shipping → payment → submit) briefly highlights the row with a fade-in effect
**And** a COP outcome briefly flashes the row green (one-shot 500ms)
**And** a FAIL outcome briefly flashes the row red (one-shot 500ms)
**And** the footer stats animate counts with a brief highlight when they change
**And** all animations are disabled when `NIKE_BOT_NO_ANIMATIONS=1` env var is set (for CI and accessibility)

## Tasks / Subtasks

### Task 1: Animations context provider (AC: env-gated disabling)

- **File:** `packages/bot/src/tui/AnimationsContext.tsx` (new)
- Create a React context `AnimationsContext` with shape `{ enabled: boolean }`
- Provider reads `process.env.NIKE_BOT_NO_ANIMATIONS` once at mount; `enabled = process.env.NIKE_BOT_NO_ANIMATIONS !== '1'`
- Also disabled when `process.env.NODE_ENV === 'test'` (node --test sets this pattern via the runner)
- Export `useAnimations()` hook returning `{ enabled }`
- Wrap `<Dashboard>` render in the provider inside `renderDashboard.tsx`

### Task 2: Spinner component (AC: cycling spinner every 100ms on WAIT)

- **File:** `packages/bot/src/tui/Spinner.tsx` (new)
- Braille frames: `['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']`
- Skeleton:
  ```tsx
  import {useEffect, useState} from 'react'
  import {Text} from 'ink'
  import {useAnimations} from './AnimationsContext.tsx'
  const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
  export function Spinner({color = 'yellow'}: {color?: string}) {
    const {enabled} = useAnimations()
    const [i, setI] = useState(0)
    useEffect(() => {
      if (!enabled) return
      const id = setInterval(() => setI(n => (n + 1) % FRAMES.length), 100)
      return () => clearInterval(id)
    }, [enabled])
    return <Text color={color}>{enabled ? FRAMES[i] : '⠿'}</Text>
  }
  ```
- When disabled, renders a single static frame `⠿` (no interval, no re-render churn).

### Task 3: FadeHighlight component (AC: row highlight on transition, COP/FAIL flash)

- **File:** `packages/bot/src/tui/FadeHighlight.tsx` (new)
- Props: `{ color: 'green' | 'red' | 'cyan'; durationMs?: number; children: ReactNode; triggerKey: string }`
- When `triggerKey` changes, set `active=true` then `setTimeout(() => setActive(false), durationMs ?? 500)`
- When active, wrap children in `<Text backgroundColor={color}>...</Text>`
- When `useAnimations().enabled === false`, never activate — render children unwrapped
- In `AccountRow.tsx` (Story 11.1), wrap the row content:
  ```tsx
  <FadeHighlight color={color} triggerKey={props.stepLabel}>
    {/* existing row content */}
  </FadeHighlight>
  ```
- Also wrap with a separate `FadeHighlight` on `props.status` change (green for COP, red for FAIL)

### Task 4: CountAnimation component (AC: footer counts animate on change)

- **File:** `packages/bot/src/tui/CountAnimation.tsx` (new)
- Props: `{ value: number; label: string; color?: string }`
- Tracks previous value with a ref; if changed, briefly (300 ms) wrap in inverse video
- When disabled, render `<Text>{label}: {value}</Text>` plainly
- Replace the three footer counts in `Dashboard.tsx` with `<CountAnimation label="Cops" value={cops} color="green" />` etc.

### Task 5: Integrate Spinner into AccountRow (AC: spinner on WAIT)

- **File:** `packages/bot/src/tui/AccountRow.tsx` (edit)
- When `props.status === 'WAIT'`, render `<Spinner color="yellow" />` in place of the static `⏳`
- Keep the static `⏳` as the disabled-fallback rendered by Spinner itself when `NIKE_BOT_NO_ANIMATIONS=1`

### Task 6: Visual smoke test (AC: animations don't break rendering)

- **File:** `packages/bot/src/tui/animations.test.tsx` (new)
- Using `ink-testing-library`:
  - Render `<Dashboard>` with one account in `WAIT` status, `NIKE_BOT_NO_ANIMATIONS=1` → assert no spinner frames cycling (snapshot stable after 250 ms)
  - Render again without the env var → assert spinner frame differs between two samples taken 150 ms apart
- **File:** `packages/bot/src/tui/FadeHighlight.test.tsx` (new)
  - Render with `triggerKey="step-1"`, then rerender with `triggerKey="step-2"`
  - Assert background color appears in the rendered frame, then disappears after 500 ms

### Task 7: Disable in node --test by default (AC: CI accessibility)

- **File:** `packages/bot/src/tui/AnimationsContext.tsx` (edit)
- Detection: `const isNodeTest = typeof process.env.NODE_TEST_CONTEXT !== 'undefined' || process.env.NIKE_BOT_NO_ANIMATIONS === '1'`
- Document this in the file header comment so future test authors know how to opt in if they actually want animations in a test.

## Dev Notes

### Animation Budget

Animations must not violate NFR22 (2 FPS minimum). The spinner at 100 ms is 10 FPS — well above floor, but with 10 accounts all spinning simultaneously we get 100 React commits/sec. React batches these, but to stay safe:

- Each `<Spinner>` uses its own local state — no global clock
- Use `setInterval` in `useEffect` with a stable deps array (`[enabled]`); clean up on unmount
- Do **not** lift spinner frame to a shared context — per-row local state is cheaper

### FadeHighlight Mechanics

The `triggerKey` prop is the trigger. When it changes, `useEffect([triggerKey])` fires:

```tsx
useEffect(() => {
  if (!enabled) return
  setActive(true)
  const id = setTimeout(() => setActive(false), durationMs)
  return () => clearTimeout(id)
}, [triggerKey, enabled, durationMs])
```

Ink supports `<Text backgroundColor="green">` — use this (not inverse video) for the green/red flash. Kevin's terminal is dark-themed (per architecture notes); green/red backgrounds read well.

### Env Var Semantics

`NIKE_BOT_NO_ANIMATIONS=1` is a **hard off-switch**:
- Spinner → static `⠿`
- FadeHighlight → children rendered unwrapped
- CountAnimation → plain text

This is required for CI (NO_COLOR-style accessibility) and for users on slow SSH terminals where the redraw cost matters.

Also auto-disabled when `NODE_TEST_CONTEXT` is set (Node's --test harness sets this internally), so `node --test` runs don't interval-poll forever.

### NFR22 Impact

With animations enabled + 10 accounts in WAIT:
- 10 spinners × 10 commits/s = 100 commits/s ≈ Ink throttles to screen refresh (~30 FPS)
- Still well above 2 FPS floor
- Test: see `Dashboard.test.tsx` in Story 11.1 — extend there if needed to verify that animations don't drop us below 2 FPS.

### Project Structure Notes

New files:
```
packages/bot/src/tui/
├── AnimationsContext.tsx
├── Spinner.tsx
├── FadeHighlight.tsx
├── CountAnimation.tsx
├── animations.test.tsx
└── FadeHighlight.test.tsx
```

Modified:
- `packages/bot/src/tui/AccountRow.tsx` — use Spinner + FadeHighlight
- `packages/bot/src/tui/Dashboard.tsx` — use CountAnimation for footer counts
- `packages/bot/src/tui/renderDashboard.tsx` — wrap with AnimationsProvider

### References

- Epics: Story 11.2 acceptance criteria
- PRD: NFR22 (2 FPS minimum)
- Depends on: Story 11.1 (Dashboard + AccountRow)
- Ink docs: animations via `useEffect` + `setInterval` (community pattern)

## File List

### New files
- `packages/bot/src/tui/primitives/AnimationsContext.tsx` — already present from 11.1
- `packages/bot/src/tui/primitives/Spinner.tsx` — already present from 11.1
- `packages/bot/src/tui/primitives/FadeHighlight.tsx` — already present from 11.1
- `packages/bot/src/tui/primitives/CountAnimation.tsx` — already present from 11.1
- `packages/bot/src/tui/animations.test.tsx` — smoke tests for spinner, CountAnimation, AccountRow integration
- `packages/bot/src/tui/FadeHighlight.test.tsx` — unit tests for FadeHighlight disabled/live modes

### Modified files
- `packages/bot/src/tui/AccountRow.tsx` — integrated `<Spinner>` for `waiting` status; refactored icon helpers; truncated detail column

## Dev Agent Record

### Tasks completed
- [x] Task 1: AnimationsContext provider (pre-existing from 11.1, verified)
- [x] Task 2: Spinner component (pre-existing from 11.1, verified)
- [x] Task 3: FadeHighlight component (pre-existing from 11.1, verified)
- [x] Task 4: CountAnimation component (pre-existing from 11.1, verified)
- [x] Task 5: Integrated Spinner into AccountRow for `waiting` status
- [x] Task 6: Visual smoke tests — animations.test.tsx (8 tests) + FadeHighlight.test.tsx (5 tests)
- [x] Task 7: NODE_TEST_CONTEXT auto-disable verified in AnimationsContext

### Agent notes
- Primitives (AnimationsContext, Spinner, FadeHighlight, CountAnimation) were already fully implemented from 11.1 in `packages/bot/src/tui/primitives/`. Story re-used them directly.
- `AccountRow.tsx` refactored: static `⏳` for `waiting` replaced with `<Spinner />` (animated braille, falls back to `·` when disabled).
- `renderDashboard.tsx` does NOT wrap with AnimationsProvider (Dashboard.tsx already does so internally).
- Pre-existing race condition in `RetrySelection.test.tsx` ("pressing 'b' selects all BLOCKED…") fails only when running the full suite concurrently — passes in isolation. Not caused by Story 11.2 changes.
- `tsc --noEmit`: 4 pre-existing errors in `commands.ts` and `navigateCheckout.ts` — none introduced by this story.

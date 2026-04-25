---
status: archived
archivedDate: 2026-04-25
archivedReason: |
  Concept superseded by v3 SaaS worker pool architecture (Epic 17
  drop-runs + Epic 15 REST API). Daemon mode no longer needed since
  workers are managed by the orchestrator, not by users.
replacedBy: _bmad-output/implementation-artifacts/stories/17-2-drop-scheduler.md
v3PrdRef: _bmad-output/planning-artifacts/prd.md (FR60-FR75)
v3EpicRef: _bmad-output/planning-artifacts/epics.md (Epic 17)
---

# DEPRECATED — v2 story archived 2026-04-25

This story is preserved for historical reference. The v3 implementation
lives at `17-2-drop-scheduler.md` and should be used for all new work.

---

# Story 7.3: Graceful Shutdown Handling

Status: ready-for-dev

## Story

As an operator, I want the daemon to shut down gracefully on SIGTERM/SIGINT, so that browser contexts are properly closed and no resources leak.

## Acceptance Criteria

**Given** a bot daemon is running with active monitoring or checkout in progress
**When** the process receives SIGTERM or SIGINT (kill command or Ctrl+C in foreground mode)
**Then** the polling loop stops accepting new cycles
**And** any active Playwright browser contexts are closed gracefully (not force-killed)
**And** the PID file is removed
**And** the log file records: "Bot shutting down gracefully. [N] browser contexts closed."
**And** the process exits with code 0

## Tasks / Subtasks

### Task 1: Create signal handler (AC: SIGTERM, SIGINT handling)
- Create `packages/bot/src/daemon/signalHandler.ts`
- Implement `createSignalHandler(options: SignalHandlerOptions): SignalHandler`
- `SignalHandlerOptions`: `{ pidFile: string, onShutdown: () => Promise<void> }`
- `SignalHandler` exposes `register(): void` and `isShuttingDown(): boolean`
- On `register()`, attach listeners for both `SIGTERM` and `SIGINT` via `process.on('SIGTERM', ...)`
- When signal received:
  1. Set internal `shuttingDown = true` flag to prevent re-entrant shutdown
  2. If already shutting down (second signal), force exit: `process.exit(1)`
  3. Log: "Received [signal]. Shutting down gracefully..."
  4. Call `await options.onShutdown()` to execute cleanup
  5. Remove PID file via `removePidFile(options.pidFile)` (AC: PID file removed)
  6. Log: "Bot shutting down gracefully. [N] browser contexts closed."
  7. Exit with `process.exit(0)` (AC: exit code 0)

### Task 2: Implement resource cleanup callback (AC: stop polling, close browser contexts)
- Create a `shutdown()` function that the signal handler calls as `onShutdown`:
  1. Stop the poller: call `monitorHandle.stop()` to halt the polling interval (AC: stop polling loop)
  2. Close all active Playwright browser contexts: maintain a registry of open contexts in the checkout module, iterate and call `context.close()` on each (AC: close contexts gracefully)
  3. Count closed contexts for the log message
- The checkout module's parallel executor should expose a `getActiveContexts()` or use a shared `Set<BrowserContext>` that contexts register/deregister from

### Task 3: Create browser context registry (AC: track open contexts for cleanup)
- In `packages/bot/src/stealth/contextFactory.ts` (or a new `contextRegistry.ts`), add:
  - `registerContext(context: BrowserContext): void`
  - `unregisterContext(context: BrowserContext): void`
  - `closeAllContexts(): Promise<number>` -- closes all registered contexts, returns count
- The existing resource cleanup pattern (`try/finally { await context.close() }`) already handles normal flow; the registry handles abnormal shutdown

### Task 4: Wire signal handler into start command (AC: integration)
- In `packages/bot/src/cli/commands.ts`, after starting monitoring:
  1. Create `SignalHandler` with the PID file path and shutdown callback
  2. Call `signalHandler.register()`
  3. The shutdown callback should: stop monitor, close all contexts via registry, log summary
- Works in both foreground (Ctrl+C) and daemon (kill PID) modes

### Task 5: Expose `isShuttingDown()` to the polling loop (AC: stop new cycles)
- The poller should check `signalHandler.isShuttingDown()` before each poll cycle
- If shutting down, skip the poll and do not invoke callbacks
- This prevents new checkout triggers from firing during shutdown

### Task 6: Update daemon module index (AC: module boundary)
- Update `packages/bot/src/daemon/index.ts` to re-export `createSignalHandler`, `SignalHandler`, `SignalHandlerOptions`

### Task 7: Unit tests (AC: signal handling, cleanup)
- Create `packages/bot/src/daemon/signalHandler.test.ts`
- Test: signal handler calls `onShutdown` when signal emitted (use `process.emit('SIGTERM')`)
- Test: second signal during shutdown forces exit
- Test: `isShuttingDown()` returns true after signal received
- Test: PID file is removed during shutdown
- Test: browser context registry tracks and closes contexts correctly
- Test: `closeAllContexts()` returns correct count

## Dev Notes

### SIGTERM/SIGINT Handling Pattern

```typescript
import { removePidFile } from './daemonize.ts'

function createSignalHandler(options: SignalHandlerOptions): SignalHandler {
  let shuttingDown = false

  const handler = async (signal: string) => {
    if (shuttingDown) {
      logger.warn('Forced exit on second signal.')
      process.exit(1)
    }
    shuttingDown = true
    logger.info(`Received ${signal}. Shutting down gracefully...`)

    try {
      await options.onShutdown()
      removePidFile(options.pidFile)
      logger.info(`Bot shutting down gracefully.`)
      process.exit(0)
    } catch (error) {
      logger.error(`Error during shutdown: ${error}`)
      process.exit(1)
    }
  }

  return {
    register() {
      process.on('SIGTERM', () => handler('SIGTERM'))
      process.on('SIGINT', () => handler('SIGINT'))
    },
    isShuttingDown() {
      return shuttingDown
    },
  }
}
```

### Browser Context Registry Pattern

```typescript
const activeContexts = new Set<BrowserContext>()

export function registerContext(ctx: BrowserContext): void {
  activeContexts.add(ctx)
}

export function unregisterContext(ctx: BrowserContext): void {
  activeContexts.delete(ctx)
}

export async function closeAllContexts(): Promise<number> {
  const count = activeContexts.size
  await Promise.allSettled(
    [...activeContexts].map(ctx => ctx.close())
  )
  activeContexts.clear()
  return count
}
```

This integrates with the existing resource cleanup pattern from the architecture:
```typescript
const context = await stealthFactory.create(account)
registerContext(context)
try {
  // checkout logic
} finally {
  await context.close()
  unregisterContext(context)
}
```

### PID File Path

Default: `daemon.pidFile: "./bot.pid"`. Removed on graceful shutdown, left behind on crash (enabling status command to detect stale PIDs).

### Project Structure Notes
```
packages/bot/src/
  daemon/
    index.ts              # Public exports (updated)
    signalHandler.ts      # SIGTERM/SIGINT handling
    signalHandler.test.ts # Unit tests
  stealth/
    contextFactory.ts     # Wire signal handler into start command (updated)
  cli/
    commands.ts           # Wire signal handler into start command (updated)
```

### References
- NFR11: Daemon runs 24+ hours without memory leaks or crashes
- NFR15: Playwright context crashes do not terminate daemon
- Architecture: Graceful Resource Management, Resource Cleanup Pattern, daemon/signalHandler.ts
- Story 7.1: PID file management (removePidFile)

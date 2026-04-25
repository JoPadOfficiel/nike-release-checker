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

# Story 7.1: Headless Daemon Mode

Status: ready-for-dev

## Story

As an operator, I want to start the bot as a background daemon process, so that it runs unattended after I close the terminal or SSH session.

## Acceptance Criteria

**Given** accounts are imported, authenticated, and a target slug is specified
**When** I run `nike-bot start --slug "air-jordan-1-royal" --sizes 42,42.5 --auto-checkout --daemon`
**Then** the process detaches from the terminal and runs in the background
**And** a PID file is written to the path configured in `bot.config.yaml` (`daemon.pidFile`, default `./bot.pid`)
**And** the terminal outputs: "Bot started in daemon mode. PID: [pid]. Log: [logFile]"
**And** all output is redirected to the configured log file instead of terminal
**And** the process continues running after the terminal session is closed
**And** the daemon runs continuously for 24+ hours without memory leaks or crashes (NFR11)
**And** Playwright browser context crashes are caught and do not terminate the daemon process (NFR15)

## Tasks / Subtasks

### Task 1: Implement daemonize function (AC: detach, PID file, log redirect)
- Create `packages/bot/src/daemon/daemonize.ts`
- Implement `daemonize(options: DaemonOptions): void`
- `DaemonOptions`: `{ pidFile: string, logFile: string, script: string, args: string[] }`
- Use `child_process.spawn()` with `{ detached: true, stdio: 'ignore' }` to fork the bot process as a detached child
- The spawned child re-runs the same `start` command but without `--daemon` (to avoid infinite recursion), with stdout/stderr redirected to the log file
- Write the child PID to `options.pidFile` (default `./bot.pid` from `daemon.pidFile` in config)
- Call `process.unref()` on the child so the parent can exit
- Parent process outputs: "Bot started in daemon mode. PID: [pid]. Log: [logFile]" then exits with code 0

### Task 2: Implement PID file management (AC: PID file write/read/cleanup)
- In `packages/bot/src/daemon/daemonize.ts`, add:
  - `writePidFile(pidFile: string, pid: number): void` -- write PID as plain text, permissions 644
  - `readPidFile(pidFile: string): number | null` -- read PID, return null if file missing or invalid
  - `removePidFile(pidFile: string): void` -- delete PID file
  - `isProcessAlive(pid: number): boolean` -- use `process.kill(pid, 0)` in try/catch to check if process exists

### Task 3: Wire `--daemon` flag in CLI start command (AC: CLI integration)
- In `packages/bot/src/cli/commands.ts`, update the `start` command handler:
  - If `--daemon` is true, call `daemonize()` with the current command args (minus `--daemon`) and exit
  - If `--daemon` is false, run monitoring in foreground as normal (Story 6.4)
- Check for existing PID file before daemonizing: if a process is already running at that PID, display error "Bot already running (PID: [pid]). Stop it first or remove [pidFile]." and exit with code 1
- Redirect stdout/stderr to log file via `fs.openSync(logFile, 'a')` for the child's stdio

### Task 4: Create daemon types (AC: type definitions)
- Create `packages/bot/src/daemon/daemon.types.ts`
- Define `DaemonOptions`: `{ pidFile: string, logFile: string, script: string, args: string[] }`
- Define `DaemonStatus`: `{ running: boolean, pid: number | null, uptime: number | null, logFile: string, pidFile: string }`

### Task 5: Create daemon module index (AC: module boundary)
- Create `packages/bot/src/daemon/index.ts`
- Re-export `daemonize`, `writePidFile`, `readPidFile`, `removePidFile`, `isProcessAlive`, `DaemonOptions`, `DaemonStatus`

### Task 6: Unit tests (AC: PID file management, process check)
- Create `packages/bot/src/daemon/daemonize.test.ts`
- Test: `writePidFile` creates file with correct PID content
- Test: `readPidFile` returns PID from valid file, null from missing file
- Test: `removePidFile` deletes the file
- Test: `isProcessAlive` returns true for current process PID, false for non-existent PID
- Test: daemonize refuses to start if PID file exists and process is alive

## Dev Notes

### child_process.spawn Detached Pattern

From architecture document:
```typescript
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'

function daemonize(options: DaemonOptions): void {
  const logFd = openSync(options.logFile, 'a')

  const child = spawn(process.execPath, [options.script, ...options.args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })

  writePidFile(options.pidFile, child.pid!)
  child.unref()

  console.log(`Bot started in daemon mode. PID: ${child.pid}. Log: ${options.logFile}`)
  process.exit(0)
}
```

### PID File Path from Config

Default in `bot.config.yaml`:
```yaml
daemon:
  pidFile: "./bot.pid"
  logFile: "./logs/bot.log"
```

The PID file contains only the numeric PID as plain text (e.g., `12345`).

### Daemon Recursion Prevention

When the parent spawns the child, it passes all original args except `--daemon`. The child runs in foreground mode (logging to the redirected file descriptor), while the parent exits. This avoids infinite fork loops.

### Browser Context Crash Resilience (NFR15)

The monitoring/checkout pipeline already uses try/catch and `Promise.allSettled` (from Epic 4/5). In daemon mode, the same error boundaries apply. A Playwright context crash is caught at the per-account level and does not propagate to the daemon process. The poller continues running after checkout failures.

### Project Structure Notes
```
packages/bot/src/
  daemon/
    index.ts              # Public exports
    daemonize.ts          # Detach, PID file, log redirect
    daemon.types.ts       # DaemonOptions, DaemonStatus
    daemonize.test.ts     # Unit tests
  cli/
    commands.ts           # --daemon flag wiring (updated)
```

### References
- FR36: Headless daemon mode as background process
- FR37: PID file when running as daemon
- NFR11: Daemon runs 24+ hours without memory leaks or crashes
- NFR15: Playwright context crashes do not terminate daemon
- Architecture: `child_process.spawn({ detached: true, stdio: 'ignore' })` with PID file, daemon/daemonize.ts

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

# Story 7.2: Bot Status Command

Status: ready-for-dev

## Story

As an operator, I want to check the status of running bot instances and account session health, so that I can verify the bot is alive and accounts are ready without inspecting log files.

## Acceptance Criteria

**Given** a bot daemon is running (or not)
**When** I run `nike-bot status`
**Then** the system checks for an active PID file and verifies the process is alive
**And** if running, displays: PID, uptime, target slug, monitoring status (polling/idle/checkout in progress), last poll timestamp
**And** if not running, displays: "No active bot instance found."
**And** account session health is displayed: count of valid/expired/missing sessions
**And** `--json` flag outputs the status as structured JSON for scripting

## Tasks / Subtasks

### Task 1: Create status checker (AC: PID check, process alive, uptime)
- Create `packages/bot/src/daemon/statusChecker.ts`
- Implement `getBotStatus(pidFile: string): DaemonStatus`
- Read PID from PID file using `readPidFile()` (from Story 7.1)
- If PID file missing, return `{ running: false, pid: null, uptime: null, ... }`
- If PID file exists, check if process is alive using `isProcessAlive(pid)` (from Story 7.1)
- If process alive, calculate uptime from PID file modification time (`fs.stat(pidFile).mtime`)
- Return `DaemonStatus` with `running`, `pid`, `uptime` (in seconds)

### Task 2: Create session health checker (AC: valid/expired/missing counts)
- In `packages/bot/src/daemon/statusChecker.ts`, add:
- Implement `getSessionHealth(accounts: AccountConfig[]): SessionHealth`
- `SessionHealth`: `{ valid: number, expired: number, missing: number, total: number, details: { accountId: string, status: 'valid' | 'expired' | 'missing' }[] }`
- For each account, check if session file exists at `.bot-data/sessions/<account_id>.json`
- If exists, check cookie expiration timestamps using session validator from auth module (Story 5.8)
- Tally counts by status

### Task 3: Wire CLI `status` command (AC: CLI output, --json flag)
- In `packages/bot/src/cli/commands.ts`, replace the `status` placeholder with real implementation
- Accept `--json` boolean flag (default false)
- Call `getBotStatus(config.daemon.pidFile)` and `getSessionHealth(accounts)`
- If not `--json`, display formatted output:
  ```
  Bot Status: Running
  PID: 12345
  Uptime: 2h 34m

  Sessions: 4 valid, 1 expired, 0 missing (5 total)
  ```
  Or:
  ```
  No active bot instance found.

  Sessions: 3 valid, 2 expired, 0 missing (5 total)
  ```
- If `--json`, output structured JSON to stdout:
  ```json
  { "bot": { "running": true, "pid": 12345, "uptimeSeconds": 9240 }, "sessions": { "valid": 4, "expired": 1, "missing": 0, "total": 5 } }
  ```
- Exit with code 0 regardless of running state

### Task 4: Add types (AC: type definitions)
- In `packages/bot/src/daemon/daemon.types.ts`, add `SessionHealth` type
- Update `DaemonStatus` if needed to include optional monitoring metadata

### Task 5: Unit tests (AC: all status scenarios)
- In `packages/bot/src/daemon/statusChecker.test.ts` (new file)
- Test: no PID file returns `running: false`
- Test: PID file with dead process returns `running: false`
- Test: PID file with alive process returns `running: true` with uptime
- Test: session health correctly counts valid/expired/missing
- Test: `--json` output is valid parseable JSON

## Dev Notes

### PID File Path from Config

Default: `daemon.pidFile: "./bot.pid"` in `bot.config.yaml`. The status command reads from the same path.

### Uptime Calculation

Since the daemon process does not write metadata beyond the PID, uptime is approximated from the PID file's `mtime` (modification timestamp set when the daemon was started):

```typescript
import { stat } from 'node:fs/promises'

const pidStat = await stat(pidFile)
const uptimeMs = Date.now() - pidStat.mtimeMs
```

### Session Validator Reuse

Session freshness is checked by the same logic used in Story 5.8 (pre-checkout validation). Import `validateSession` from `packages/bot/src/auth/sessionValidator.ts` to check cookie expiration.

### JSON Output for Scripting

The `--json` flag enables machine-readable output for integration with monitoring scripts:
```bash
nike-bot status --json | jq '.sessions.valid'
```

### Project Structure Notes
```
packages/bot/src/
  daemon/
    index.ts              # Public exports (updated)
    statusChecker.ts      # Bot status + session health
    statusChecker.test.ts # Unit tests
    daemon.types.ts       # SessionHealth type (updated)
  cli/
    commands.ts           # status command implementation (updated)
```

### References
- FR40: Check status of running bot instances and account session health
- Architecture: daemon/statusChecker.ts, PID file management
- Story 7.1: PID file management (readPidFile, isProcessAlive)
- Story 5.8: Pre-checkout session validation (session freshness check)

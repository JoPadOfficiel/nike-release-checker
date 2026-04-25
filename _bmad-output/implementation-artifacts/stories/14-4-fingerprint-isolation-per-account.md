# Story 14.4: Per-Account Fingerprint Isolation (Chrome userDataDir + KPSDK Token)

Status: backlog

## Story

As a SaaS operator,
I want each Nike account to run inside its own isolated Chrome `userDataDir` with its own dedicated KPSDK token (no cross-account sharing),
so that Kasada cannot correlate accounts via shared fingerprints — preserving the per-account proxy + UA + KPSDK trio as the unit of identity. (FR67, NFR32)

## Acceptance Criteria

**Given** Story 14.1 (extractor), 14.2 (cache), 14.3 (retry) are in place
**When** the bot launches a Chrome context for `account.id = 'kev_001'`
**Then** the context uses a dedicated `userDataDir` at `~/.nike-bot/profiles/<accountId>/` (Windows: `%APPDATA%\nike-bot\profiles\<accountId>\`) — never shared across accounts
**And** the KPSDK cache key is `accountId:country` (Story 14.2) — two accounts in the same country produce two distinct cache entries
**And** an explicit code-level guard prevents cross-account token reuse: a `KpsdkToken` carries an `accountId` field; `kpsdkCache.set(accountId, country, token)` rejects with an error if `token.accountId !== accountId`
**And** the per-account trio is documented in `docs/PER_ACCOUNT_FINGERPRINT.md`: proxy URL (from `accounts.csv`), User-Agent (stable per `accountId`, derived from a seed), userDataDir path, and KPSDK token (extracted live, never copied)
**And** the User-Agent for an account is deterministic (same UA on every launch) so Kasada sees consistent fingerprint per identity, but rotates across accounts so two accounts never share a UA
**And** an integration test asserts: launch context for account A and account B in parallel, capture both KPSDK tokens, assert they differ; assert their `userDataDir` paths differ; assert their UAs differ; assert `kpsdkCache.get('A', 'FR')` returns A's token and `kpsdkCache.get('B', 'FR')` returns B's token (no cross-talk)
**And** unit tests cover: cache rejection on `accountId` mismatch, deterministic UA per accountId (same input → same UA), UA uniqueness across 100 generated accountIds (no collisions in test fixture), userDataDir path normalization (no traversal via crafted accountId)

## Tasks / Subtasks

### Task 1: Add `accountId` to `KpsdkToken` + cache guard (AC: code-level cross-account guard)

- **File:** `packages/bot/src/stealth/kpsdk/types.ts` (modify — created in Story 14.1)

```typescript
export type KpsdkToken = {
  accountId: string      // NEW — origin account, set at extraction time
  ct: string
  v: string
  capturedAt: Date
  source: 'request' | 'forced'
}
```

- **File:** `packages/bot/src/stealth/kpsdk/extractor.ts` (modify)
- Constructor accepts `accountId` and stamps every captured token with it
- **File:** `packages/bot/src/stealth/kpsdk/cache.ts` (modify)
- `set(accountId, country, token)` adds guard:

```typescript
set(accountId: string, country: string, token: KpsdkToken): void {
  if (token.accountId !== accountId) {
    throw new Error(
      `KPSDK token cross-account violation: token.accountId=${token.accountId} but cache key accountId=${accountId}`,
    )
  }
  // ...existing impl
}
```

### Task 2: Per-account userDataDir factory (AC: dedicated profile path)

- **File:** `packages/bot/src/stealth/profilePath.ts` (new)

```typescript
import { homedir, platform } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

const ROOT = platform() === 'win32'
  ? join(process.env.APPDATA ?? homedir(), 'nike-bot', 'profiles')
  : join(homedir(), '.nike-bot', 'profiles')

export function profilePathFor(accountId: string): string {
  // Normalize and reject path traversal attempts
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) {
    throw new Error(`Invalid accountId for profile path: ${accountId}`)
  }
  const path = normalize(join(ROOT, accountId))
  if (!resolve(path).startsWith(resolve(ROOT))) {
    throw new Error(`Profile path escapes root: ${accountId}`)
  }
  return path
}

export async function ensureProfileDir(accountId: string): Promise<string> {
  const path = profilePathFor(accountId)
  await mkdir(path, { recursive: true, mode: 0o700 })
  return path
}
```

### Task 3: Deterministic per-account User-Agent (AC: stable UA per identity, unique across accounts)

- **File:** `packages/bot/src/stealth/userAgent.ts` (new)

```typescript
import { createHash } from 'node:crypto'

const CHROME_VERSIONS = ['131.0.0.0', '130.0.0.0', '129.0.0.0']
const PLATFORMS = [
  ['Windows NT 10.0; Win64; x64', 'Windows'],
  ['Macintosh; Intel Mac OS X 10_15_7', 'macOS'],
] as const

export function userAgentFor(accountId: string): string {
  const hash = createHash('sha256').update(accountId).digest()
  const versionIdx = hash[0] % CHROME_VERSIONS.length
  const platformIdx = hash[1] % PLATFORMS.length
  const [platform] = PLATFORMS[platformIdx]
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSIONS[versionIdx]} Safari/537.36`
}
```

Deterministic via SHA-256(accountId) — same input always returns same UA. Uniqueness across 100+ accounts: 3 versions × 2 platforms = 6 buckets, expect collisions but they're collisions of public Chrome versions, not bot-identifying signals.

### Task 4: Wire profile + UA into context factory (AC: trio applied at launch)

- **File:** `packages/bot/src/stealth/contextFactory.ts` (modify)

```typescript
import { ensureProfileDir } from './profilePath.js'
import { userAgentFor } from './userAgent.js'
import { getKpsdkExtractor } from './kpsdk/extractor.js'

export async function createCheckoutContext(account: Account): Promise<BrowserContext> {
  const userDataDir = await ensureProfileDir(account.id)
  const userAgent = userAgentFor(account.id)

  const context = await chromium.launchPersistentContext(userDataDir, {
    proxy: parseProxy(account.proxy),
    userAgent,
    locale: countryRegistry.get(account.country).locale,
    // ...other stealth options
  })

  const page = context.pages()[0] ?? await context.newPage()
  getKpsdkExtractor(page, account.country, account.id) // attach extractor with accountId
  return context
}
```

### Task 5: Documentation `docs/PER_ACCOUNT_FINGERPRINT.md` (AC: trio documented)

- **File:** `docs/PER_ACCOUNT_FINGERPRINT.md` (new)
- Sections:
  1. **The Identity Trio** — proxy + UA + KPSDK token + userDataDir; why each exists; why they must never cross-pollinate
  2. **Storage Layout** — `~/.nike-bot/profiles/<accountId>/` per-account Chrome profile (cookies, localStorage, _abck, KPSDK runtime cache); `~/.nike-bot/sessions/<accountId>.json` per-account exported cookie snapshot (Epic 2)
  3. **Cross-Account Guards** — code-level `accountId` field on `KpsdkToken`, cache key includes `accountId`, profile path validated against traversal, UA deterministic+unique per `accountId`
  4. **Operator Checklist** — how to verify isolation in production: launch 2 accounts, run `ls -la ~/.nike-bot/profiles/`, confirm 2 directories; tail KPSDK logs to confirm 2 distinct tokens; confirm `accounts.csv` row's proxy URL is what shows up in Chrome network panel
  5. **Why Sharing Is Catastrophic** — Kasada flags shared tokens within seconds; one cross-account bug → all accounts on that token blocked simultaneously

### Task 6: Integration + unit tests (AC: parallel two-account isolation)

- **File:** `packages/bot/src/stealth/kpsdk/isolation.test.ts` (new)
- Unit tests:
  - `profilePathFor('kev_001')` returns expected absolute path
  - `profilePathFor('../etc/passwd')` throws (traversal)
  - `profilePathFor('a/b')` throws (slash banned)
  - `userAgentFor('kev_001') === userAgentFor('kev_001')` (determinism)
  - `userAgentFor('kev_001') !== userAgentFor('kev_002')` (likely — assert across 100 accountIds in a fixture, expect at most 30% collision rate given 6 buckets)
  - `cache.set('A', 'FR', tokenWithAccountIdB)` throws cross-account violation
- Integration test (gated `--live`):
  - Launch contexts for `account_a` + `account_b` (mock accounts with valid sessions)
  - Capture both tokens via extractor
  - Assert `tokenA.ct !== tokenB.ct`
  - Assert `tokenA.v !== tokenB.v` (or both — Kasada always rotates both)
  - Assert profiles directories exist and differ
  - Assert UAs differ (or document if collision allowed for this fixture pair)

## Dev Notes

### Why `launchPersistentContext` Instead of `launch + newContext`

Persistent context = one Chrome process per account with its own profile dir. Kasada and Akamai both fingerprint the persistent state (TLS session resumption, HTTP/2 frame ordering, cached `_abck` values). A persistent profile preserves this state across runs, making each account look like a returning real user instead of a fresh browser every time.

Trade-off: more disk + more RAM (each Chrome process is ~200-400 MB). For 50-account drops on the SaaS worker pool that's 10-20 GB RAM. Architecture spec budgets 16 GB / 8 vCPU per node — comfortable for 30 accounts/node, autoscale at 70% load.

### Why UA is Deterministic Per Account, Not Random

If UA changed every launch, Kasada's longitudinal fingerprint diverges from the cookie + IP + KPSDK trail — looks like a hijacked session. Stable UA per account = stable identity across launches. Different UA per account = no cross-account UA correlation. Both properties simultaneously satisfied by `SHA256(accountId)` indexing into a small Chrome-version pool.

### KPSDK Token Sharing is the #1 Risk

Field reports from competitor bots: shared KPSDK tokens get all consuming accounts banned within minutes. The cache `accountId` guard is a defense-in-depth — even if a future refactor accidentally calls `cache.set('A', 'FR', tokenFromB)`, the throw makes the bug fail loud at dev time, not silently in production where it would burn dozens of accounts before detection.

### Profile Dir Permissions

Mode `0o700` (owner read/write/exec only) on POSIX. On Windows `mkdir` doesn't honor mode but the `%APPDATA%\nike-bot\profiles\` parent already lives in a per-user space.

### Future: SaaS Multi-Tenant Profile Isolation

For v3.1+ multi-customer worker pool, the profile path becomes `<workerNodeRoot>/<customerId>/<accountId>/`. The existing `profilePathFor` helper extends to a 2-arg variant. Out of scope for this story but flagged so the abstraction stays portable.

### Project Structure Notes

New files:
- `packages/bot/src/stealth/profilePath.ts`
- `packages/bot/src/stealth/userAgent.ts`
- `packages/bot/src/stealth/kpsdk/isolation.test.ts`
- `docs/PER_ACCOUNT_FINGERPRINT.md`

Modified files:
- `packages/bot/src/stealth/kpsdk/types.ts`
- `packages/bot/src/stealth/kpsdk/extractor.ts`
- `packages/bot/src/stealth/kpsdk/cache.ts`
- `packages/bot/src/stealth/contextFactory.ts`

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` Story 14.4
- PRD: FR67 (per-context bootstrap), NFR32 (per-customer isolation)
- NIKE API: `docs/NIKE_API_REFERENCE.md` "Anti-bot — KPSDK (Kasada)" — token bound to page context fingerprint
- Architecture: "Sticky session per Nike account" (line 196), "KPSDK Token Cache" (per-account)
- Depends on: Story 14.1 (extractor), Story 14.2 (cache), Story 8.1 (real Chrome CDP)
- Related: Story 3.2 (proxy isolation), Story 3.3 (cookie isolation)

# Story 14.2: KPSDK Token In-Memory Cache

Status: backlog

## Story

As a SaaS operator,
I want captured KPSDK tokens cached in memory keyed by accountId + country with a 10-minute TTL,
so that repeated API calls in the same checkout flow don't re-trigger the extraction force-fire and parallel drops avoid hammering Nike with redundant warm-up requests. (FR67, NFR29)

## Acceptance Criteria

**Given** the KPSDK extractor from Story 14.1 captures live tokens
**When** `kpsdkCache.get(accountId, country)` is called
**Then** if a non-expired token exists for the key, return it without invoking the extractor
**And** if the cached token's `capturedAt + 10min < now`, evict it and return null
**And** `kpsdkCache.set(accountId, country, token)` stores a token with derived expiry timestamp
**And** `kpsdkCache.refresh(accountId, country, page)` forces re-extraction by calling `kpsdkExtractor.getToken()` on the supplied page (which itself force-fires a protected request) and overwrites the cache entry — used by Story 14.3 retry path
**And** TTL is configurable via `bot.config.yaml` `kpsdk.tokenTtlMs` (default 600000 = 10 min); if set to 0 caching is disabled (every call re-extracts)
**And** cache stats are exposed: `kpsdkCache.stats(): { size: number; hits: number; misses: number; evictions: number }` for observability
**And** `kpsdkCache.clear()` purges all entries (used at daemon shutdown / between integration tests)
**And** unit tests cover: hit before TTL, miss after TTL eviction, set overwrites, refresh re-extracts, stats counters increment correctly, TTL=0 disables caching, clear empties everything

## Tasks / Subtasks

### Task 1: Cache implementation (AC: TTL + key shape)

- **File:** `packages/bot/src/stealth/kpsdk/cache.ts` (new)

```typescript
import type { KpsdkToken } from './types.js'

type CacheKey = string // `${accountId}:${country}`

type Entry = {
  token: KpsdkToken
  expiresAt: number  // Date.now() + ttl
}

export class KpsdkCache {
  private entries = new Map<CacheKey, Entry>()
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(private ttlMs: number = 600_000) {}

  private key(accountId: string, country: string): CacheKey {
    return `${accountId}:${country}`
  }

  get(accountId: string, country: string): KpsdkToken | null {
    if (this.ttlMs === 0) {
      this.misses++
      return null
    }
    const k = this.key(accountId, country)
    const entry = this.entries.get(k)
    if (!entry) {
      this.misses++
      return null
    }
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(k)
      this.evictions++
      this.misses++
      return null
    }
    this.hits++
    return entry.token
  }

  set(accountId: string, country: string, token: KpsdkToken): void {
    if (this.ttlMs === 0) return
    this.entries.set(this.key(accountId, country), {
      token,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  invalidate(accountId: string, country: string): void {
    if (this.entries.delete(this.key(accountId, country))) this.evictions++
  }

  stats(): { size: number; hits: number; misses: number; evictions: number } {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    }
  }

  clear(): void {
    this.evictions += this.entries.size
    this.entries.clear()
  }
}

export const kpsdkCache = new KpsdkCache()
```

### Task 2: Refresh helper integrating extractor (AC: refresh re-extracts and updates)

- **File:** `packages/bot/src/stealth/kpsdk/cache.ts` (continue)

```typescript
import type { Page } from 'playwright'
import { getKpsdkExtractor } from './extractor.js'

export async function refreshKpsdkToken(
  cache: KpsdkCache,
  accountId: string,
  country: string,
  page: Page,
): Promise<KpsdkToken | null> {
  cache.invalidate(accountId, country)
  const extractor = getKpsdkExtractor(page, country)
  const token = await extractor.getToken()
  if (token) cache.set(accountId, country, token)
  return token
}
```

### Task 3: Config wiring (AC: configurable TTL)

- **File:** `packages/bot/src/config/botConfigSchema.ts` (modify)
- Extend the YAML schema with:

```typescript
kpsdk: v.optional(
  v.object({
    tokenTtlMs: v.optional(v.pipe(v.number(), v.minValue(0)), 600_000),
  }),
  { tokenTtlMs: 600_000 },
),
```

- **File:** `packages/bot/src/stealth/kpsdk/cache.ts` (continue)
- Replace the singleton `new KpsdkCache()` with a factory called from CLI bootstrap that reads config: `export function createKpsdkCache(config: BotConfig): KpsdkCache`
- Singleton pattern: cache instance attached to a module-level holder set at app boot; tests reset it via `clear()` and a `__resetForTest()` helper

### Task 4: Cache lookup at API call entry (AC: hit before extractor force-fire)

- **File:** `packages/bot/src/checkout/cartApi.ts` (modify)
- Before any `page.request.fetch()` to a protected endpoint, the wrapper checks `kpsdkCache.get(accountId, country)` first; if hit, the token is already inside `page.request` (cookies + KPSDK live in the page context) — the cache check is purely an observability + skip-the-force-fire signal
- If miss, call `refreshKpsdkToken(cache, accountId, country, page)` to force-fire and warm
- This means the cache primarily serves as a "do I need to force-fire a synthetic request before my real request?" signal, not as a header-injection layer (the page context still owns the header injection)

### Task 5: Stats exposure for observability (AC: stats counters)

- **File:** `packages/bot/src/cli/commands.ts` (modify)
- Add a `nike-bot kpsdk-stats` subcommand that prints `kpsdkCache.stats()` as a table — useful during a drop to verify the cache is doing its job (high hit rate expected after warmup)
- Document in the command's `--help` text

### Task 6: Unit tests (AC: scenarios listed)

- **File:** `packages/bot/src/stealth/kpsdk/cache.test.ts` (new)
- Test 1: `get` before any `set` → null + miss++
- Test 2: `set` then `get` within TTL → returns token + hit++
- Test 3: `set` then advance fake timer past TTL → null + eviction++ + miss++ (use `node:test`'s `mock.timers.enable()`)
- Test 4: TTL = 0 → `set` is no-op, `get` always returns null
- Test 5: `set` twice with same key → second overwrites, size remains 1
- Test 6: `invalidate` on non-existent key → no-op, no eviction increment
- Test 7: `clear` → size=0, eviction count includes all cleared entries
- Test 8: `refreshKpsdkToken` mock — extractor returns token, cache populated post-call
- Test 9: Concurrent `get` from two accounts → independent entries, no key collision

## Dev Notes

### Why In-Memory Not Redis

Architecture spec mentions Redis for the SaaS multi-worker pool. v3.0 (this story) ships single-worker first; in-memory is sufficient. The cache interface (`get`/`set`/`invalidate`/`refresh`) is designed to be backend-swappable — Redis impl in v3.1 can be a drop-in `KpsdkCache` subclass.

### Why 10-Minute TTL

Kasada token lifetime observed at ~30 min in field. We cache for 10 min as a safety margin: token still works at minute 10-30, but we re-extract early to avoid the 10-30 boundary being mid-checkout. NFR35 ("retry-with-fresh-KPSDK") handles the unlucky case where we cached a token that just rotated.

### Cache Key Design

`accountId:country` because the same Nike account can have separate page contexts per country (rare but possible — operator runs FR + JP drops with same account). Cross-country token sharing is forbidden by Story 14.4 (fingerprint isolation).

### Cache Doesn't Inject Headers — Why?

The headers ride inside `page.request.fetch()` via the page's own runtime, not via our wrapper. The cache is an **observability + synthetic-request-skipping** signal: if we have a recent token, we know the page is "warm" and don't need to force-fire. We don't manually attach `x-kpsdk-ct` headers because Kasada also fingerprints the request shape, TLS handshake, and other channel signals — only the page can produce a valid composite. Manual injection would fail.

### Project Structure Notes

New files:
- `packages/bot/src/stealth/kpsdk/cache.ts`
- `packages/bot/src/stealth/kpsdk/cache.test.ts`

Modified files:
- `packages/bot/src/config/botConfigSchema.ts`
- `packages/bot/src/checkout/cartApi.ts`
- `packages/bot/src/cli/commands.ts`

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` Story 14.2
- PRD: FR67, NFR29
- NIKE API: `docs/NIKE_API_REFERENCE.md` "Anti-bot — KPSDK (Kasada)" — token bootstrapping
- Architecture: "KPSDK Token Cache" component (Redis in SaaS, in-memory locally)
- Depends on: Story 14.1 (extractor)
- Consumed by: Story 14.3 (retry path uses `refreshKpsdkToken`)

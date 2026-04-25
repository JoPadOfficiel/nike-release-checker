# Story 14.3: Retry-Once on 403/429 with Fresh KPSDK Token

Status: backlog

## Story

As a SaaS operator,
I want every protected `page.request.fetch()` call to detect Kasada blocks (HTTP 403/429), refresh the KPSDK token via a silent page reload, and retry exactly once,
so that a stale-token false positive doesn't cost a drop — escalating to `BLOCKED` only after the second failure. (FR68, NFR35)

## Acceptance Criteria

**Given** Story 14.1 (extractor) and Story 14.2 (cache + `refreshKpsdkToken`) are wired
**When** `protectedFetch(page, account, country, url, init)` wraps every `page.request.fetch()` call to a protected endpoint
**Then** on a 200-2xx response, the wrapper returns the response unchanged
**And** on HTTP 403 or 429:
  1. The cache entry for `(accountId, country)` is invalidated
  2. The page is silently reloaded via `page.reload({ waitUntil: 'domcontentloaded' })` to re-bootstrap `p.js` and re-emit a fresh KPSDK token
  3. After reload, `kpsdkExtractor.getToken()` is called to confirm a new token is captured
  4. The original request is retried exactly once with the same `init` payload
**And** if the retry returns 200-2xx → return the retry response
**And** if the retry also returns 403/429 → throw `KpsdkBlockedError` with `{ accountId, country, url, attempts: 2, lastStatus }` — caller maps this to outcome classification `blocked`
**And** total checkout latency including one retry stays ≤ 35 s (NFR35) — measured by instrumented test
**And** non-403/429 errors (4xx other, 5xx) are NOT retried with KPSDK refresh (those are not Kasada blocks); they propagate directly to the caller
**And** unit tests cover: 200 passes through, 403→reload→200 returns success, 403→reload→403 throws `KpsdkBlockedError`, 429→reload→429 throws, 500 propagates without retry, retry uses same body/method/headers, latency budget respected (mock timers verify retry adds ≤ 5 s overhead)

## Tasks / Subtasks

### Task 1: Define `KpsdkBlockedError` + wrapper signature (AC: error shape)

- **File:** `packages/bot/src/stealth/kpsdk/protectedFetch.ts` (new)

```typescript
import type { Page, APIResponse } from 'playwright'
import { KpsdkCache } from './cache.js'
import { refreshKpsdkToken } from './cache.js'

export class KpsdkBlockedError extends Error {
  constructor(
    public readonly accountId: string,
    public readonly country: string,
    public readonly url: string,
    public readonly attempts: number,
    public readonly lastStatus: number,
  ) {
    super(`KPSDK blocked after ${attempts} attempts: ${lastStatus} ${url}`)
  }
}

export type ProtectedFetchInit = Parameters<Page['request']['fetch']>[1]
```

### Task 2: Implement wrapper with retry-once (AC: refresh + retry exactly once)

- **File:** `packages/bot/src/stealth/kpsdk/protectedFetch.ts` (continue)

```typescript
const BLOCK_STATUSES = new Set([403, 429])

export async function protectedFetch(
  page: Page,
  cache: KpsdkCache,
  accountId: string,
  country: string,
  url: string,
  init: ProtectedFetchInit,
): Promise<APIResponse> {
  const first = await page.request.fetch(url, init)
  if (!BLOCK_STATUSES.has(first.status())) return first

  // Kasada block — refresh and retry once
  cache.invalidate(accountId, country)
  await page.reload({ waitUntil: 'domcontentloaded' })
  const refreshed = await refreshKpsdkToken(cache, accountId, country, page)
  if (!refreshed) {
    throw new KpsdkBlockedError(accountId, country, url, 1, first.status())
  }

  const second = await page.request.fetch(url, init)
  if (!BLOCK_STATUSES.has(second.status())) return second

  throw new KpsdkBlockedError(accountId, country, url, 2, second.status())
}
```

### Task 3: Wire wrapper into all Epic 12 API modules (AC: every protected call uses wrapper)

- **Files:** `packages/bot/src/checkout/{cartApi,cartViewsApi,fulfillmentApi,paymentApi,reviewApi,checkoutsApi}.ts` (modify)
- Replace direct `this.page.request.fetch(...)` calls with `protectedFetch(this.page, kpsdkCache, this.accountId, this.country.code, url, init)` for endpoints listed in `PROTECTED_PATTERNS` (Story 14.1)
- Non-protected endpoints (`fulfillment_offerings/v1` GET, `payment/options/v3` POST — depends on KPSDK list) keep using direct `page.request.fetch`
- Each API module's constructor gains an `accountId: string` argument to thread into `protectedFetch`

### Task 4: Outcome classification mapping (AC: KpsdkBlockedError → BLOCKED)

- **File:** `packages/bot/src/checkout/outcomeClassifier.ts` (modify — created in Story 5.7)
- Add a `catch` branch that maps `KpsdkBlockedError` to outcome `blocked` with `errorReason: 'kasada_blocked_after_retry'` and includes `attempts` + `lastStatus` in the structured log entry
- This is the same `blocked` classification as Story 5.4 (Akamai/Cloudflare) but with a distinct `errorReason` for triage

### Task 5: Latency instrumentation (AC: NFR35 ≤ 35s with retry)

- **File:** `packages/bot/src/stealth/kpsdk/protectedFetch.ts` (continue)
- Add timing logs around the retry path:

```typescript
const reloadStart = Date.now()
await page.reload({ waitUntil: 'domcontentloaded' })
const reloadMs = Date.now() - reloadStart
log.info({ accountId, country, reloadMs, event: 'kpsdk_refresh' })
```

- Document in story Dev Notes: page reload + new KPSDK bootstrap typically ~2-4 s; retry adds < 5 s to total checkout. NFR35 budget allows this comfortably (30 s base + 5 s retry = 35 s).

### Task 6: Unit + integration tests (AC: full retry matrix)

- **File:** `packages/bot/src/stealth/kpsdk/protectedFetch.test.ts` (new)
- Mock `Page` with stubbed `request.fetch` and `reload`; mock `KpsdkCache.invalidate` + `refreshKpsdkToken`
- Test 1: First call returns 200 → no reload, no retry, response passes through
- Test 2: First 403, reload, second 200 → returns second response, reload called exactly once, fetch called twice with identical args
- Test 3: First 403, reload, second 403 → throws `KpsdkBlockedError` with `attempts: 2`, `lastStatus: 403`
- Test 4: First 429 → same as Test 3 path but lastStatus 429
- Test 5: First 500 → propagates as-is, no reload, no retry, no error wrap
- Test 6: First 403, reload, refreshKpsdkToken returns null (capture failed) → throws `KpsdkBlockedError` with `attempts: 1`, `lastStatus: 403` (cannot retry without fresh token)
- Test 7: Latency assertion — using fake timers, retry path completes within 5 s budget when reload mock takes 3 s

## Dev Notes

### Why Reload Instead of Re-Visit PDP

`page.reload()` keeps the same URL + cookies + storage but re-runs `p.js` from scratch. A `page.goto(originalUrl)` would do the same but with extra navigation overhead and risk of redirect chains. `reload({ waitUntil: 'domcontentloaded' })` is the lightest path that still triggers `p.js` re-execution.

### Why Retry Exactly Once (Not Twice or Three Times)

Kasada false positives correlate with single-token rotation events (token expired or invalidated server-side mid-request). Retrying twice typically means the page itself is fingerprinted — more retries don't help, they only burn time and worsen NFR35. After one retry fails, escalate to `blocked` and let the operator triage (rotate proxy, refresh session).

### Distinguishing `blocked` Reasons

Story 5.4 already has `blocked` for Akamai/Cloudflare DOM challenges. Story 14.3 adds `blocked` with `errorReason: 'kasada_blocked_after_retry'`. Operators reading the report.csv see the same status but the `error_reason` column tells them which subsystem blocked. This avoids proliferation of outcome enum values.

### Latency Budget Math

- Base checkout: ~25-28 s (cart init + size click + cart_view shipping + fulfillment + payment + checkout submit)
- KPSDK refresh: ~2-4 s (reload + p.js re-exec + token capture)
- Retry of the failing request: ~0.5-1 s
- Total worst case: ~30 s + 4 s + 1 s = 35 s — exactly NFR35 budget

If a drop consistently approaches 35 s, that's a signal to investigate — either the retry path is firing too often (KPSDK rotation aggressive) or the base flow has crept up.

### Idempotency of Retried Requests

`PATCH /buy/carts/v2/...` and `PUT /buy/checkouts/...` are operationally idempotent on the Nike side for our use case (cart-init merges by visitorId, checkout submit is keyed on cart UUID). Retrying after a 403 (which means the request was rejected pre-execution by Kasada) is safe — Nike's checkout engine never saw the request.

### Project Structure Notes

New files:
- `packages/bot/src/stealth/kpsdk/protectedFetch.ts`
- `packages/bot/src/stealth/kpsdk/protectedFetch.test.ts`

Modified files:
- `packages/bot/src/checkout/cartApi.ts`
- `packages/bot/src/checkout/cartViewsApi.ts`
- `packages/bot/src/checkout/fulfillmentApi.ts`
- `packages/bot/src/checkout/paymentApi.ts`
- `packages/bot/src/checkout/reviewApi.ts`
- `packages/bot/src/checkout/checkoutsApi.ts`
- `packages/bot/src/checkout/outcomeClassifier.ts`

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` Story 14.3
- PRD: FR68, NFR35
- NIKE API: `docs/NIKE_API_REFERENCE.md` "Anti-bot — KPSDK (Kasada)" — protected endpoint list, `page.request.fetch` strategy
- Architecture: "KPSDK token refresh strategy" — silent page reload triggered by the worker
- Depends on: Story 14.1 (extractor), Story 14.2 (cache + refresh helper)
- Related: Story 5.4 (block detection — DOM-level), Story 5.7 (outcome classification)

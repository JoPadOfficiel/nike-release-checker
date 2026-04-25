# Story 14.1: KPSDK Token Extractor from Page Context

Status: backlog

## Story

As a SaaS operator,
I want the bot to capture the live `x-kpsdk-ct` and `x-kpsdk-v` Kasada tokens from a real Chrome page context,
so that subsequent API calls via `page.request.fetch()` can be inspected, cached, and re-used outside the page lifecycle for the duration of the token's validity. (FR67)

## Acceptance Criteria

**Given** a real Chrome browser context (Story 8.1 / Story 3.1) with a Nike PDP loaded and `p.js` executed
**When** `kpsdkExtractor.attach(page)` is invoked before any protected request fires
**Then** a `page.on('request', ...)` listener captures every outgoing request whose URL matches a protected endpoint pattern (`/buy/carts/v2/*/NIKE/NIKECOM`, `/buy/checkouts/*`, `/buy/cart_reviews/*`, `/launch/entries/v*`, `/buy/checkout_previews/*`, `/buy/partner_cart_preorder/*`, `/cic/grand/*`, `/idn/phone/*`)
**And** the listener reads `request.headers()` and extracts `x-kpsdk-ct` and `x-kpsdk-v` when both are present
**And** captured tokens are exposed via `kpsdkExtractor.getToken(): KpsdkToken | null` returning the most recent successful capture with `{ ct: string, v: string, capturedAt: Date, source: 'request' }`
**And** if no protected request has fired by the time `getToken()` is called, the extractor proactively triggers a known-protected request inside the page (e.g. visitor cart-init `PATCH /buy/carts/v2/<country>/NIKE/NIKECOM` with a synthetic visitorId) to force token emission, then returns the captured token
**And** capture is non-blocking — the listener never throws into the page event loop; failures log and continue
**And** the extractor is per-Chrome-context (one instance per `BrowserContext`); two parallel accounts get two independent extractors with no shared state
**And** unit tests cover: token captured from a mocked request event, `getToken()` returns null when nothing captured yet, force-fire path when no token cached, token freshness timestamp updated on every capture, listener detached cleanly on `kpsdkExtractor.detach()`

## Tasks / Subtasks

### Task 1: Define `KpsdkToken` type + protected URL matcher (AC: type shape + endpoint list)

- **File:** `packages/bot/src/stealth/kpsdk/types.ts` (new)

```typescript
export type KpsdkToken = {
  ct: string             // x-kpsdk-ct header value
  v: string              // x-kpsdk-v header value
  capturedAt: Date
  source: 'request' | 'forced'
}

export const PROTECTED_PATTERNS: RegExp[] = [
  /\/buy\/carts\/v2\/[A-Z]{2}\/NIKE\/NIKECOM/,
  /\/buy\/checkouts\//,
  /\/buy\/cart_reviews\//,
  /\/buy\/checkout_previews\//,
  /\/buy\/partner_cart_preorder\//,
  /\/launch\/entries\/v\d/,
  /\/cic\/grand\//,
  /\/idn\/phone\//,
]

export function isProtectedUrl(url: string): boolean {
  return PROTECTED_PATTERNS.some((re) => re.test(url))
}
```

### Task 2: Implement extractor (AC: page.on('request') listener)

- **File:** `packages/bot/src/stealth/kpsdk/extractor.ts` (new)

```typescript
import type { BrowserContext, Page, Request } from 'playwright'
import { isProtectedUrl, type KpsdkToken } from './types.js'

export class KpsdkExtractor {
  private current: KpsdkToken | null = null
  private listener: ((req: Request) => void) | null = null

  constructor(private page: Page, private country: string) {}

  attach(): void {
    if (this.listener) return
    this.listener = (request) => {
      try {
        if (!isProtectedUrl(request.url())) return
        const headers = request.headers()
        const ct = headers['x-kpsdk-ct']
        const v = headers['x-kpsdk-v']
        if (!ct || !v) return
        this.current = { ct, v, capturedAt: new Date(), source: 'request' }
      } catch (e) {
        // Never throw into Playwright event loop
        console.error('kpsdk extractor capture failed:', (e as Error).message)
      }
    }
    this.page.on('request', this.listener)
  }

  detach(): void {
    if (this.listener) {
      this.page.off('request', this.listener)
      this.listener = null
    }
  }

  async getToken(): Promise<KpsdkToken | null> {
    if (this.current) return this.current
    await this.forceFireProtectedRequest()
    return this.current
  }

  private async forceFireProtectedRequest(): Promise<void> {
    const url = `https://api.nike.com/buy/carts/v2/${this.country}/NIKE/NIKECOM?modifiers=VALIDATELIMITS,VALIDATEAVAILABILITY`
    try {
      await this.page.request.fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json-patch+json' },
        data: JSON.stringify([
          { op: 'merge', path: '/', value: { visitorId: crypto.randomUUID() } },
        ]),
      })
    } catch {
      // Even on failure, the request fired and the listener captured the token
    }
  }
}
```

### Task 3: Per-context factory (AC: one instance per browser context)

- **File:** `packages/bot/src/stealth/kpsdk/extractor.ts` (continue)

```typescript
const extractors = new WeakMap<Page, KpsdkExtractor>()

export function getKpsdkExtractor(page: Page, country: string): KpsdkExtractor {
  let extractor = extractors.get(page)
  if (!extractor) {
    extractor = new KpsdkExtractor(page, country)
    extractor.attach()
    extractors.set(page, extractor)
  }
  return extractor
}
```

`WeakMap<Page>` ensures GC when the page closes; no manual cleanup required by callers.

### Task 4: Wire into context factory (AC: extractor attached before any request)

- **File:** `packages/bot/src/stealth/contextFactory.ts` (modify)
- After `createCheckoutContext(account)` returns the page, immediately call `getKpsdkExtractor(page, account.country)` so the listener is attached before the PDP loads
- Document in code comment: "extractor attached before page.goto so the very first protected request fires the listener"

### Task 5: Unit tests (AC: scenarios listed)

- **File:** `packages/bot/src/stealth/kpsdk/extractor.test.ts` (new)
- Mock Playwright `Page` with a fake `EventEmitter`-shaped `on/off` and a fake `request` object that returns headers
- Test 1: Emit a protected request with both headers → `getToken()` returns the captured `{ ct, v }`
- Test 2: Emit a protected request missing `x-kpsdk-ct` → `current` stays null
- Test 3: Emit a non-protected request (e.g. `/styles.css`) with KPSDK headers → ignored (URL filter rejects)
- Test 4: `getToken()` with no captured token triggers `forceFireProtectedRequest()` → mock fetch records the call with the correct URL
- Test 5: `detach()` removes the listener (assert `page.off` called); subsequent emits do not update state
- Test 6: Listener exception (mock throws inside header read) does not propagate

### Task 6: Integration smoke (AC: live capture sanity)

- **File:** `packages/bot/scripts/test-kpsdk-extract-live.ts` (new, gated by `--live`)
- Bootstraps a real Chrome context, loads a PDP slug, attaches the extractor, calls `getToken()` after 5 s, prints the captured `ct`/`v` (truncated to first/last 4 chars). For manual operator verification only — not run in CI

## Dev Notes

### Why `request.headers()` Instead of `response.headers()`

The `x-kpsdk-ct` / `x-kpsdk-v` headers are sent **by the browser** on outgoing requests, generated by the in-page `p.js` script. They are not part of any response. Listening on `request` event is the only way to see them.

### Why a Force-Fire Path

If the operator constructs the cart API and immediately calls `getToken()` before the PDP has loaded any protected resource, the extractor has nothing yet. Rather than block on a timer or expose async race conditions, the extractor synthetically fires a low-cost cart-init request (which is itself protected). The token is captured by the same listener within milliseconds. The synthetic request's response is discarded.

### KPSDK Tokens are Per-Page-Context, Not Per-Site

A single browser context with multiple pages will have potentially different KPSDK fingerprints per page (each page runs its own `p.js`). The extractor is keyed on `Page` (not `BrowserContext`) so multi-page workflows get correct per-page tokens. Most v3 flows use one page per context, so this is mostly defensive.

### Token Lifetime

Empirically Kasada tokens are valid ~30 min but rotate any time. This story does NOT implement TTL — it only captures. TTL + cache invalidation is Story 14.2; refresh on 4xx is Story 14.3.

### Project Structure Notes

New files:
- `packages/bot/src/stealth/kpsdk/types.ts`
- `packages/bot/src/stealth/kpsdk/extractor.ts`
- `packages/bot/src/stealth/kpsdk/extractor.test.ts`
- `packages/bot/scripts/test-kpsdk-extract-live.ts`

Modified files:
- `packages/bot/src/stealth/contextFactory.ts`

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` Story 14.1
- PRD: FR67
- NIKE API: `docs/NIKE_API_REFERENCE.md` "Anti-bot — KPSDK (Kasada)" section (lines 7-27) — protected endpoint list, `x-kpsdk-ct/-v` header pair, `page.request.fetch` strategy
- Architecture: "KPSDK Token Cache" component (Redis, per-account, TTL ≈ token lifetime)
- Depends on: Story 8.1 (real Chrome CDP), Story 3.1 (context factory)
- Consumed by: Story 14.2 (cache), Story 14.3 (retry on 403/429)

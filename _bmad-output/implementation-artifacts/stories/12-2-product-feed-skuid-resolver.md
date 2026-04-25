# Story 12.2: Resolve `(styleColor, EU size) → skuId` via Product Feed

Status: backlog

## Story

As the API-first checkout pipeline,
I want to resolve a Nike `skuId` UUID from a `(styleColor, EU size)` pair via `GET /product_feed/threads/v3?filter=marketplace(FR)&filter=productCode(<sc>)`,
So that `cartApi.addItem(skuId, ...)` can be called without scraping the size grid HTML for a hidden UUID. (FR61)

## Acceptance Criteria

**Given** a styleColor `CW2288-111` and an EU size `'46'`
**When** `resolveSkuId({styleColor:'CW2288-111', euSize:'46', country:'FR'})` is called for the first time
**Then** the bot issues `GET https://api.nike.com/product_feed/threads/v3/?filter=marketplace(FR)&filter=productCode(CW2288-111)`
**And** parses the response, locating the `productInfo[].skus[]` entry whose `localizedSize === '46'` (or `nikeSize === '46'`)
**And** returns its `skuId` UUID

**Given** the same triplet is requested again within the cache TTL (default 10 min)
**When** `resolveSkuId(...)` is called
**Then** the network request is NOT re-issued and the cached `skuId` is returned

**Given** the styleColor exists but the requested EU size is unavailable for that styleColor
**When** the resolver runs
**Then** it throws `SkuNotFoundError({styleColor, euSize, availableSizes: string[]})` with the list of sizes that ARE available

**Given** the Product Feed call returns 404 or empty `objects[]`
**When** the resolver runs
**Then** it throws `StyleColorNotFoundError({styleColor, country})` with no retry

**Given** a US account requests styleColor `'AQ7491-001'` size `'10'` (US sizing)
**When** `resolveSkuId({styleColor, usSize:'10', country:'US'})` is called
**Then** the marketplace filter is `marketplace(US)` and matching falls back to `nikeSize` then `localizedSize` (handling US/UK numeric/letter shoe sizing)

**Given** the SDK already exposes a Product Feed client
**When** the resolver is wired in
**Then** the implementation reuses `@nike-release-checker/sdk` (`getProductFeed`, `formatProductFeedResponse`) rather than duplicating the HTTP call

## Tasks / Subtasks

### Task 1: SDK reuse audit (AC: SDK reuse)

Read `packages/sdk/src/productFeed/*` to confirm the existing public API surface (`getProductFeed`, `formatProductFeedResponse`, `availableCountries`). Document which response field carries the size-to-skuId mapping. If the SDK does not expose the raw `skus[]` array, file a follow-up but DO NOT modify SDK in this story — wrap and parse downstream.

### Task 2: Implement resolver (AC: lookup + size matching)

Create `packages/bot/src/checkout/api/skuResolver.ts`:

```ts
import { getProductFeed } from '@nike-release-checker/sdk'

export interface ResolveArgs {
	styleColor: string
	euSize?: string
	usSize?: string
	ukSize?: string
	country?: string
}

export class StyleColorNotFoundError extends Error {
	constructor(public styleColor: string, public country: string) {
		super(`styleColor ${styleColor} not found in marketplace ${country}`)
	}
}

export class SkuNotFoundError extends Error {
	constructor(public styleColor: string, public size: string, public availableSizes: string[]) {
		super(`size ${size} not available for ${styleColor}; have: ${availableSizes.join(',')}`)
	}
}

export const resolveSkuId = async (args: ResolveArgs): Promise<string> => {
	const country = args.country ?? 'FR'
	const size = args.euSize ?? args.usSize ?? args.ukSize
	if (!size) throw new Error('one of euSize/usSize/ukSize required')
	// hit cache first; otherwise call SDK
}
```

The matching function must compare against both `localizedSize` and `nikeSize` (Nike returns both in `skus[]`). Match is case-insensitive, trim whitespace.

### Task 3: In-memory LRU cache (AC: cache TTL)

Add a `SkuCache` class with a 10-minute TTL keyed on `${country}:${styleColor}:${size}`. Use a `Map<string, {skuId: string, expiresAt: number}>` capped at 1000 entries (LRU eviction by insertion order).

Cache invalidation is not needed in this story — the cache is per-process and short-lived; Story 12-9 (error handling) will add invalidation on a `404 from /buy/carts` hint that the skuId went stale.

### Task 4: Multi-country size matcher (AC: US/UK sizing)

Create a helper `matchSizeInSkus(skus, size, country)` that:
- For `country === 'FR'` or `'DE'` or `'IT'`: match `localizedSize === size` (EU sizing).
- For `country === 'US'`: match `nikeSize === size` then fall back to `localizedSize`.
- For `country === 'UK'`: match `localizedSize` first, then `nikeSize`.

Exposed as a separate exported function so Story 13.x (Multi-Country) can extend it for JP / AU later.

### Task 5: Error taxonomy (AC: SkuNotFoundError, StyleColorNotFoundError)

Wire both errors into the existing `BlockReason` taxonomy from Epic 5. Add two new outcome reasons:
- `style_color_not_found` (terminal, no retry, indicates bad CSV input or Nike delisted product)
- `sku_not_available` (terminal for that size; orchestrator may try fallback sizes per FR15)

### Task 6: Unit tests (AC: all matching paths)

Create `packages/bot/src/checkout/api/skuResolver.test.ts` with mocked SDK responses. Cover:
- Happy path FR EU size → skuId
- Happy path US numeric size → skuId
- Size present in `nikeSize` but not `localizedSize` → resolves
- Size missing → `SkuNotFoundError` with `availableSizes` populated
- 404 from SDK → `StyleColorNotFoundError`
- Cache hit on second call within TTL → no second SDK invocation
- Cache miss after TTL expiry → re-fetches

### Task 7: Live test script (AC: real Nike feed)

Add `packages/bot/scripts/live-test-sku-resolver.ts` that calls the SDK against a known stable styleColor (e.g., `CW2288-111` Air Force 1) for sizes 38..46 and prints the skuId map. Used during dev to verify no SDK-side regression.

## Dev Notes

### Implementation guidance

- Endpoint shape per `docs/NIKE_API_REFERENCE.md`: `GET https://api.nike.com/product_feed/threads/v3/?filter=marketplace(FR)&filter=productCode(<styleColor>)`. The filter syntax is parenthesized, NOT `=` — do not URL-encode the parens.
- Product Feed is NOT KPSDK-protected. Plain HTTPS request via the SDK works without a real-Chrome context. This is the only API call in Epic 12 that does not need `page.request.fetch()`.
- `productInfo[]` typically has 1 entry per styleColor; iterate defensively if more.
- Tests must mock at the SDK boundary (`getProductFeed`), not at `fetch`, to keep the resolver decoupled from transport choice.

### Pitfalls to avoid

- Do not assume `localizedSize === '46'` for FR EU sizing — Nike sometimes returns `'46 EU'` or `'EUR 46'`. Normalize: strip trailing units and trim before compare.
- Do not cache `null`/`undefined` skuId. A miss must throw, not poison the cache.
- Cache is per-process; do not promote to Redis here. Phase 5 (Story 16.x) handles distributed caching with tenant scoping.

### Project Structure Notes

Files created by this story:
```
packages/bot/src/checkout/api/skuResolver.ts
packages/bot/src/checkout/api/skuResolver.test.ts
packages/bot/src/checkout/api/skuCache.ts
packages/bot/scripts/live-test-sku-resolver.ts
```

Files modified:
- `packages/bot/src/checkout/api/index.ts` (export `resolveSkuId`, `SkuNotFoundError`, `StyleColorNotFoundError`)
- `packages/bot/src/outcomes/blockReason.ts` (add `style_color_not_found`, `sku_not_available`)

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` (Epic 12, FR61)
- PRD: `_bmad-output/planning-artifacts/prd.md` (FR61)
- API Reference: `docs/NIKE_API_REFERENCE.md` (line 55 — Product Feed endpoint)
- SDK: `packages/sdk/src/productFeed/` (existing `getProductFeed`)
- Story 12.1 (consumer of returned skuId)

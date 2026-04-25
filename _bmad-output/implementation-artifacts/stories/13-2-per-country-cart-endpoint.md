# Story 13.2: Per-Country Cart Endpoint Parameterization

Status: done

## Review Findings (2026-04-25)

No findings. `endpoints.ts` cleanly centralises all URL builders, parameterised by `Country`. No hardcoded country strings found in downstream modules.

## Patches Applied (2026-04-25)

None required.

## Story

As a SaaS operator running drops in multiple markets,
I want every cart/checkout API call to accept the country as a parameter and substitute it into the endpoint path,
so that one code path serves all 10 supported countries without per-market forks. (FR57)

## Acceptance Criteria

**Given** Story 12.1 (`cartApi.ts`) and the country registry from Story 13.1 are in place
**When** `cartApi.ts` and the rest of the v3 API client modules (`cart_views`, `fulfillment`, `payment`, `reviews`, `checkouts`) are reviewed
**Then** every endpoint that contains a market segment (`/buy/carts/v2/{COUNTRY}/NIKE/NIKECOM`, `?marketplace=...`, `language=...`) reads the country from a single `country: string` constructor / call argument resolved through `countryRegistry.get(code)`
**And** the resolved `Country` object provides both `code` (path substitution) and `languageCode` (language query string)
**And** `NikeCartApi` constructor signature becomes `constructor(page: Page, country: string)`; the constructor calls `countryRegistry.get(country)` and stores the resulting `Country`
**And** an attempt to construct `new NikeCartApi(page, 'XX')` throws `UnknownCountryError` immediately (fail-fast at construction, not at first request)
**And** SDK Product Feed calls used by the bot (e.g. inside `monitor/poller.ts`) also forward the country as `marketplace` / `country` / `language` parameters from the same registry
**And** unit tests assert: endpoint path for FR resolves to `/buy/carts/v2/FR/NIKE/NIKECOM?...`, for US resolves to `/buy/carts/v2/US/NIKE/NIKECOM?...`, and that `language=fr` vs `language=en` is correctly substituted from the registry
**And** an integration test mock-fetches `cartApi.initVisitor()` against country `FR` and asserts the URL matches the expected pattern exactly

## Tasks / Subtasks

### Task 1: Refactor `NikeCartApi` constructor (AC: country argument)

- **File:** `packages/bot/src/checkout/cartApi.ts` (modify — created in Story 12.1)
- Replace the existing `private market = 'FR'` default with required `country: string` argument
- In the constructor body: `this.country = countryRegistry.get(country)` — throws on unknown code
- Store as `private readonly country: Country`
- All internal `${this.market}` template substitutions become `${this.country.code}`
- Where the language query string is needed, use `this.country.languageCode`

### Task 2: Endpoint path helper (AC: single source of substitution)

- **File:** `packages/bot/src/checkout/endpoints.ts` (new)
- Centralize endpoint URL builders to avoid scattered string-template substitutions:

```typescript
import type { Country } from '../country/types.js'

const BASE = 'https://api.nike.com'

export const cartEndpoints = {
  cart: (c: Country) =>
    `${BASE}/buy/carts/v2/${c.code}/NIKE/NIKECOM?modifiers=VALIDATELIMITS,VALIDATEAVAILABILITY`,
  cartView: (c: Country, viewId: string) => `${BASE}/buy/cart_views/v1/${viewId}`,
  fulfillmentOfferings: (c: Country) =>
    `${BASE}/buy/fulfillment_offerings/v1?marketplace=${c.code}&language=${c.languageCode}`,
  fulfillmentJob: (c: Country, jobId: string) =>
    `${BASE}/buy/fulfillment_offerings_jobs/v2/${jobId}`,
  paymentOptions: (c: Country) => `${BASE}/payment/options/v3?marketplace=${c.code}`,
  cartReview: (c: Country, reviewId: string) => `${BASE}/buy/cart_reviews/v2/${reviewId}`,
  checkout: (c: Country, cartId: string) => `${BASE}/buy/checkouts/${cartId}`,
}
```

All Epic 12 API modules import these builders instead of constructing strings inline.

### Task 3: Forward country to SDK Product Feed (AC: SDK marketplace param)

- **File:** `packages/bot/src/monitor/poller.ts` (modify)
- Replace any hard-coded `'FR'` `marketplace` / `country` / `language` argument passed to `getProductFeed()` with values pulled from `countryRegistry.get(country)`
- Caller (drop runner) passes `country` per-drop (Story 13.5)
- Add a default fallback to `bot.config.yaml` `checkout.market` when no per-drop country is set

### Task 4: Update Epic 12 API modules to use builders (AC: per-country path substitution everywhere)

- **Files:** `packages/bot/src/checkout/cartViewsApi.ts`, `fulfillmentApi.ts`, `paymentApi.ts`, `reviewApi.ts`, `checkoutsApi.ts` (modify — created in Stories 12.3-12.6)
- Each API module accepts `country: Country` (already-resolved object) in its constructor
- Each request URL is composed via the `endpoints.ts` builder
- Remove every literal `FR` / `marketplace=FR` / `language=fr` from these files

### Task 5: Unit tests (AC: path resolution + fail-fast)

- **File:** `packages/bot/src/checkout/cartApi.test.ts` (extend)
- `new NikeCartApi(mockPage, 'FR')` succeeds; `cartEndpoints.cart(api.country)` equals `https://api.nike.com/buy/carts/v2/FR/NIKE/NIKECOM?modifiers=...`
- Same for US (artificially flip `enabled: true` for the test or use `list({ enabledOnly: false })`-aware code path)
- `new NikeCartApi(mockPage, 'XX')` throws `UnknownCountryError`
- `cartEndpoints.fulfillmentOfferings(US)` ends with `?marketplace=US&language=en`
- Mock `page.request.fetch` and assert `cartApi.initVisitor('uuid')` invokes fetch with the FR URL exactly

### Task 6: Integration smoke (AC: end-to-end one-country sanity)

- **File:** `packages/bot/scripts/test-cart-init-fr.ts` (new test script, follow pattern of existing `test-product-feed-poll.ts`)
- Bootstraps a Chrome context, constructs `NikeCartApi(page, 'FR')`, calls `initVisitor()`, asserts a 200 response and a parsed cart with `country: 'FR'`
- Smoke script is gated behind `--live` flag and not run in CI by default; documented in story Dev Notes for manual operator verification

## Dev Notes

### Why Centralize URL Construction in `endpoints.ts`

Five distinct API modules (cart, cart_views, fulfillment, payment, reviews/checkouts) each substitute country into URLs. Without a central helper, country-renaming risks (e.g. `UK`→`GB` normalization) require touching five files. The `endpoints.ts` module is the only place that knows about path shapes; downstream modules just pass `Country` objects through.

### Country Object vs Country Code Argument

API modules accept a fully-resolved `Country` object, not a string code. Resolution happens once at the entry point (drop runner / CLI) via `countryRegistry.get(code)`. This way the `UnknownCountryError` surfaces at the operator boundary (clear error message with the bad code), not deep inside an API call where the stack trace is opaque.

### KPSDK Token Per-Country

Out of scope for this story (handled by Epic 14). Note: the KPSDK token is bound to the page context, not to the country, so per-country endpoint changes do NOT invalidate the cached token. The same browser context can service multiple country requests if a customer wants cross-market checkouts (rare).

### Project Structure Notes

Modified files:
- `packages/bot/src/checkout/cartApi.ts`
- `packages/bot/src/checkout/cartViewsApi.ts` (Story 12.3)
- `packages/bot/src/checkout/fulfillmentApi.ts` (Story 12.4)
- `packages/bot/src/checkout/paymentApi.ts` (Story 12.5)
- `packages/bot/src/checkout/reviewApi.ts` (Story 12.6)
- `packages/bot/src/checkout/checkoutsApi.ts` (Story 12.6)
- `packages/bot/src/monitor/poller.ts`

New files:
- `packages/bot/src/checkout/endpoints.ts`
- `packages/bot/scripts/test-cart-init-fr.ts`

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` Story 13.2
- PRD: FR57
- NIKE API: `docs/NIKE_API_REFERENCE.md` "Cart APIs", "Implementation outline — `cartApi.ts`"
- Depends on: Story 13.1 (registry), Story 12.1 (`cartApi.ts` skeleton), Story 14.1 (KPSDK token bootstrap — orthogonal)

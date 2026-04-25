# Story 12.1: NikeCartApi base class with KPSDK-inheriting fetch

Status: backlog

## Story

As a v3 SaaS bot operator,
I want a `NikeCartApi` class that calls `api.nike.com/buy/carts/v2/*` via Playwright's `page.request.fetch()` so the request inherits the browser's KPSDK token, cookies and TLS fingerprint,
So that the bot can replace the brittle DOM ATC click with a deterministic JSON Patch call without tripping Kasada. (FR60)

## Acceptance Criteria

**Given** a Playwright `Page` that has been bootstrapped via real Chrome on a Nike PDP (KPSDK token resident, `sid` cookie present)
**When** `cartApi.initVisitor(visitorId)` is invoked with a freshly generated UUID
**Then** the bot issues `PATCH https://api.nike.com/buy/carts/v2/FR/NIKE/NIKECOM?modifiers=VALIDATELIMITS,VALIDATEAVAILABILITY` with body `[{op:'merge', path:'/', value:{visitorId}}]` and `content-type: application/json-patch+json`
**And** the response status is 2xx
**And** the parsed body contains a `Cart` with `id`, `country='FR'`, `currency='EUR'`, empty `items[]`

**Given** an initialized cart and a known `(skuId, slug, styleColor)` triplet
**When** `cartApi.addItem(skuId, slug, styleColor, 1)` is invoked
**Then** the same endpoint is called with body `[{op:'add', path:'/items', value:{itemData:{url:`/fr/t/${slug}/${styleColor}`}, skuId, quantity:1}}]`
**And** the returned cart contains exactly one item whose `skuId` matches and whose `quantity===1`

**Given** a cart with at least one item
**When** `cartApi.getCart()`, `cartApi.removeItem(itemId)`, and `cartApi.setQuantity(itemId, 2)` are called
**Then** each returns the up-to-date cart shape and the underlying HTTP verbs are `GET`, `PATCH (op:remove)` and `PATCH (op:replace, path:/items/{id}/quantity)` respectively

**Given** any API call returns non-2xx
**When** the response is inspected
**Then** the method throws `NikeCartApiError` carrying `{status, method, path, bodyPreview, headers: { 'x-akamai-request-id', 'x-kpsdk-st' }}` (no PII, no sid, no full body)

**Given** unit tests run with a mocked `page.request`
**When** the suite executes
**Then** JSON Patch body construction has 100 % branch coverage (initVisitor, addItem, removeItem, setQuantity, edge cases for `qty=0`, missing `slug`)

## Tasks / Subtasks

### Task 1: Define `cartApi.types.ts` (AC: type contract)

Create `packages/bot/src/checkout/api/cartApi.types.ts` with the JSON shapes observed in `docs/NIKE_API_REFERENCE.md`:

```ts
export interface CartItem {
	id: string
	skuId: string
	productId: string
	quantity: number
	priceInfo: { total: number, currency: string }
	itemData?: { url: string }
}

export interface Cart {
	id: string
	country: string
	currency: string
	visitorId?: string
	items: CartItem[]
	totals: { subtotal: number, total: number, currency: string }
}

export type JsonPatchOp =
	| { op: 'add', path: string, value: unknown }
	| { op: 'remove', path: string }
	| { op: 'replace', path: string, value: unknown }
	| { op: 'merge', path: string, value: unknown } // Nike-specific
```

### Task 2: Implement `NikeCartApi` (AC: initVisitor, addItem, getCart, removeItem, setQuantity)

Create `packages/bot/src/checkout/api/cartApi.ts`. Use `page.request.fetch()` (NOT global `fetch`) so cookies + KPSDK headers are inherited.

```ts
import type { Page } from 'playwright'
import type { Cart, JsonPatchOp } from './cartApi.types'

const CART_PATH = (country: string) =>
	`/buy/carts/v2/${country}/NIKE/NIKECOM?modifiers=VALIDATELIMITS,VALIDATEAVAILABILITY`

export class NikeCartApi {
	constructor(private page: Page, private market = 'FR') {}

	private async patch(ops: JsonPatchOp[]): Promise<Cart> {
		return this.request<Cart>(CART_PATH(this.market), {
			method: 'PATCH',
			headers: { 'content-type': 'application/json-patch+json' },
			data: JSON.stringify(ops),
		})
	}

	initVisitor(visitorId: string) {
		return this.patch([{ op: 'merge', path: '/', value: { visitorId } }])
	}

	addItem(skuId: string, slug: string, styleColor: string, quantity = 1) {
		return this.patch([{
			op: 'add',
			path: '/items',
			value: { itemData: { url: `/fr/t/${slug}/${styleColor}` }, skuId, quantity },
		}])
	}

	getCart() {
		return this.request<Cart>(`/buy/carts/v2/${this.market}/NIKE/NIKECOM`, { method: 'GET' })
	}

	removeItem(itemId: string) {
		return this.patch([{ op: 'remove', path: `/items/${itemId}` }])
	}

	setQuantity(itemId: string, quantity: number) {
		return this.patch([{ op: 'replace', path: `/items/${itemId}/quantity`, value: quantity }])
	}

	private async request<T>(path: string, init: { method: string, headers?: Record<string, string>, data?: string }): Promise<T> {
		const res = await this.page.request.fetch(`https://api.nike.com${path}`, init)
		if (!res.ok()) throw new NikeCartApiError(init.method, path, res.status(), await res.text(), res.headers())
		return (await res.json()) as T
	}
}
```

### Task 3: Define `NikeCartApiError` (AC: error contract)

In the same file, export a typed error with redaction-safe fields. Truncate `bodyPreview` to 256 chars, never include `sid`, `Authorization`, or `set-cookie` from headers.

### Task 4: Wire visitorId generator (AC: initVisitor)

Add `packages/bot/src/checkout/api/visitorId.ts` exporting `generateVisitorId(): string` using `crypto.randomUUID()`. Cart visitor IDs are client-generated UUIDs per Nike API ref.

### Task 5: Mock-based unit tests (AC: 100% branch coverage)

Create `packages/bot/src/checkout/api/cartApi.test.ts` using Node test runner. Mock `page.request.fetch` to return canned responses. Assert:
- correct URL, method, headers, body for each method
- error path throws `NikeCartApiError` with status code on 403/404/500
- `setQuantity(itemId, 0)` still issues `replace` (no implicit conversion to remove)
- redaction: error `bodyPreview` truncated, no `sid`/`set-cookie` in `headers`

### Task 6: Live integration test gate (AC: real KPSDK inheritance)

Create `packages/bot/test/integration/cartApi.live.test.ts` gated behind `RUN_LIVE_TESTS=1`:
1. Launch real Chrome via Story 8.1 factory with a known authenticated session.
2. Navigate to known in-stock PDP to bootstrap KPSDK.
3. Call `initVisitor` then `addItem` for known `(skuId, slug, styleColor)`.
4. Call `getCart` and assert the item is present.

Document the run command in `packages/bot/scripts/live-test-cart-api.ts` (excluded from default `npm test`).

### Task 7: Export from index (AC: consumer surface)

Add `packages/bot/src/checkout/api/index.ts` re-exporting `NikeCartApi`, `NikeCartApiError`, `Cart`, `CartItem`, `JsonPatchOp`, `generateVisitorId`. Downstream stories (12.3 cart_views, 12.7 hybrid pipeline) consume from this barrel.

## Dev Notes

### Implementation guidance

- The single most load-bearing decision: USE `page.request.fetch()`, NOT global `fetch()`. The former inherits the page's cookie jar AND its KPSDK token automatically; the latter is blocked by Kasada within seconds. See `docs/NIKE_API_REFERENCE.md` section "Anti-bot — KPSDK (Kasada)".
- Do NOT compute `x-kpsdk-ct/-v` headers manually in this story. Story 12-9 (or Epic 14 KPSDK) handles refresh-on-403; here we only assume the page is already KPSDK-bootstrapped.
- `CART_PATH` always includes `?modifiers=VALIDATELIMITS,VALIDATEAVAILABILITY` per the live trace — omitting it returns a different cart shape.
- Country defaults to `FR` for v3.0 but the constructor accepts any code so Epic 13 (Multi-Country) can pass `US`, `UK`, `DE` later.
- The `merge` op is Nike-specific (not in RFC 6902). Treat it as a string in the union; do not attempt to validate against a generic JSON Patch schema.

### Pitfalls to avoid

- `res.ok()` vs `res.status() < 400`: Playwright's `APIResponse.ok()` already returns true for 2xx only — use it.
- Do not log the full response body. Nike's cart payload contains user-identifiable shipping address fragments once a view is bound.
- The `sid` cookie lives on `.accounts.nike.com`, NOT `www.nike.com`. Do not try to read it from `page.context().cookies('https://www.nike.com')`.

### Project Structure Notes

Files created by this story:
```
packages/bot/src/checkout/api/cartApi.ts
packages/bot/src/checkout/api/cartApi.types.ts
packages/bot/src/checkout/api/cartApi.test.ts
packages/bot/src/checkout/api/visitorId.ts
packages/bot/src/checkout/api/index.ts
packages/bot/test/integration/cartApi.live.test.ts
packages/bot/scripts/live-test-cart-api.ts
```

Files modified:
- none (no existing checkout files touched in this story; Story 12.7 is the integration story)

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` (Epic 12, FR60)
- PRD: `_bmad-output/planning-artifacts/prd.md` (FR60, NFR30)
- API Reference: `docs/NIKE_API_REFERENCE.md` (sections "Cart APIs", "Implementation outline — `cartApi.ts`")
- Migration plan: `docs/V3_MIGRATION_PLAN.md` (Phase 1 deliverables)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` (Migration Plan — DOM → API table, row "Story 4.2 Add to Cart")

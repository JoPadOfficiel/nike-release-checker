# Story 12.3: Cart Views state machine — open shipping view, write address, poll until ready

Status: backlog

## Story

As the API-first checkout pipeline,
I want a `cart_views` state machine that opens a shipping view, writes the customer's address, and polls until Nike marks the view `READY`,
So that the bot can replace the v2 DOM `navigateCheckout` + `completeShipping` steps with a single deterministic API conversation. (FR62)

## Acceptance Criteria

**Given** a cart UUID returned by `cartApi.initVisitor()` (Story 12.1)
**When** `cartViewsApi.openShippingView(cartId, address)` is called
**Then** the bot generates a fresh `viewUuid = crypto.randomUUID()`
**And** issues `PUT https://api.nike.com/buy/cart_views/v1/<viewUuid>` with body `{type:'SHIPPING', cartId, address:{...}}`
**And** the response status is 2xx and the parsed body carries `{viewId, status: 'PENDING' | 'READY'}`

**Given** the view is created in `PENDING` state
**When** `cartViewsApi.waitForView(viewId, {timeoutMs: 10_000, intervalMs: 250})` is called
**Then** the bot polls `GET /buy/cart_views/v1/<viewId>` at the given interval
**And** resolves with the view payload as soon as `status === 'READY'`
**And** rejects with `CartViewTimeoutError({viewId, lastStatus, elapsedMs})` if the timeout fires before READY

**Given** an FR address with `{firstName, lastName, line1, city, postalCode='75001', phone='+33612345678', country='FR'}`
**When** the shipping payload is assembled
**Then** the address is mapped to Nike's expected shape (`recipient`, `addressLines[]`, `postalCode`, `locality`, `country`, `phoneNumber`)
**And** the country code is the ISO-3166 alpha-2 string from `country.code` (FR by default; pluggable per Epic 13)

**Given** the view PUT returns `4xx` with body `{errors:[{code:'INVALID_POSTAL_CODE'}]}`
**When** the error handler runs
**Then** it maps to `BlockReason.invalid_address` with `field: 'postalCode'` and does not retry

**Given** unit tests run with mocked `page.request`
**When** the suite executes
**Then** view-UUID generation is asserted to use `crypto.randomUUID` (mocked + verified)
**And** address mapping is asserted byte-for-byte against a captured live payload fixture

## Tasks / Subtasks

### Task 1: Define `cartViewsApi.types.ts` (AC: type contract)

Create `packages/bot/src/checkout/api/cartViewsApi.types.ts`:

```ts
export type CartViewType = 'SHIPPING' | 'PAYMENT' | 'REVIEW'
export type CartViewStatus = 'PENDING' | 'READY' | 'ERROR'

export interface NikeAddress {
	recipient: { firstName: string, lastName: string }
	addressLines: string[]
	locality: string
	postalCode: string
	country: string
	phoneNumber: string
}

export interface CartView {
	viewId: string
	type: CartViewType
	status: CartViewStatus
	cartId: string
	address?: NikeAddress
	errors?: Array<{ code: string, field?: string, message?: string }>
}
```

### Task 2: Implement `NikeCartViewsApi` (AC: openShippingView, waitForView)

Create `packages/bot/src/checkout/api/cartViewsApi.ts`:

```ts
import type { Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import type { CartView, NikeAddress } from './cartViewsApi.types'

export class NikeCartViewsApi {
	constructor(private page: Page) {}

	async openShippingView(cartId: string, address: NikeAddress): Promise<CartView> {
		const viewUuid = randomUUID()
		return this.put(viewUuid, { type: 'SHIPPING', cartId, address })
	}

	async waitForView(viewId: string, opts: { timeoutMs?: number, intervalMs?: number } = {}): Promise<CartView> {
		const timeoutMs = opts.timeoutMs ?? 10_000
		const intervalMs = opts.intervalMs ?? 250
		const start = Date.now()
		let last: CartView | undefined
		while (Date.now() - start < timeoutMs) {
			last = await this.get(viewId)
			if (last.status === 'READY') return last
			if (last.status === 'ERROR') throw new CartViewError(last)
			await new Promise(r => setTimeout(r, intervalMs))
		}
		throw new CartViewTimeoutError(viewId, last?.status, Date.now() - start)
	}

	private put(viewUuid: string, body: unknown) { /* page.request.fetch PUT */ }
	private get(viewId: string) { /* page.request.fetch GET */ }
}
```

### Task 3: Address mapper (AC: FR address → Nike shape)

Create `packages/bot/src/checkout/api/addressMapper.ts`:

```ts
import type { Address } from '../../config/csv/addressesCsv' // from Epic 10
import type { NikeAddress } from './cartViewsApi.types'

export const toNikeAddress = (a: Address): NikeAddress => ({
	recipient: { firstName: a.firstName, lastName: a.lastName },
	addressLines: [a.line1, ...(a.line2 ? [a.line2] : [])],
	locality: a.city,
	postalCode: a.postalCode,
	country: a.country,
	phoneNumber: a.phone,
})
```

This mapping is FR-correct out of the box. Epic 13 will add country-conditional fields (e.g., US `state`, UK `county`).

### Task 4: View UUID strategy (AC: client-generated)

Use `crypto.randomUUID()` per call. Per `docs/NIKE_API_REFERENCE.md`, view UUIDs are client-generated and the server allocates the resource on first PUT. Inject the generator behind a small interface so tests can stub it deterministically:

```ts
export type UuidGen = () => string
export const defaultUuidGen: UuidGen = () => randomUUID()
```

### Task 5: Error classes (AC: timeout + view-error mapping)

In `cartViewsApi.ts`, export:

```ts
export class CartViewTimeoutError extends Error {
	constructor(public viewId: string, public lastStatus: string | undefined, public elapsedMs: number) {
		super(`view ${viewId} timed out after ${elapsedMs}ms (last=${lastStatus})`)
	}
}

export class CartViewError extends Error {
	constructor(public view: CartView) {
		super(`view ${view.viewId} entered ERROR: ${JSON.stringify(view.errors)}`)
	}
}
```

Map known error `code` values:
- `INVALID_POSTAL_CODE` → `BlockReason.invalid_address` (field: postalCode)
- `INVALID_PHONE_NUMBER` → `BlockReason.invalid_address` (field: phone)
- `ADDRESS_NOT_DELIVERABLE` → `BlockReason.address_not_deliverable`

### Task 6: Mock-based unit tests (AC: address mapping + polling)

Create `packages/bot/src/checkout/api/cartViewsApi.test.ts`. Cover:
- `openShippingView` issues PUT with correct path, body, headers
- `waitForView` polls until READY (mocked sequence: PENDING, PENDING, READY → resolves on 3rd call)
- `waitForView` rejects with `CartViewTimeoutError` if all polls return PENDING
- `waitForView` rejects with `CartViewError` if a poll returns ERROR
- Address mapper produces the captured-live payload byte-for-byte (use a fixture from `packages/bot/test/fixtures/cart-view-shipping-fr.json`)

### Task 7: Live integration script (AC: real polling cycle)

Create `packages/bot/scripts/live-test-cart-views.ts` that:
1. Bootstraps a real Chrome session.
2. initVisitor → addItem (Story 12.1).
3. openShippingView with a known good FR address.
4. waitForView and prints elapsed time + final status.

Used during Phase 1 to characterize observed PENDING→READY latency for tuning the default `intervalMs`.

## Dev Notes

### Implementation guidance

- The view is the canonical state container for everything between cart and submit (shipping, payment, review). Subsequent stories (12.4 fulfillment, 12.5 payment, 12.6 review) all go through additional cart_views or jobs that *reference* this view by `viewId`.
- A single shipping view is reusable across the rest of the checkout — do NOT create a new viewId per step. Pass the viewId returned here into Stories 12.4 and 12.5.
- Polling: `intervalMs: 250` is a starting point. The live test script in Task 7 will inform the production default. NFR30 (cart-init p95 < 2s) constrains the loop.
- Use `setTimeout` not `page.waitForTimeout` — the polling loop is logical, not browser-bound.

### Pitfalls to avoid

- Do not set `Content-Type: application/json-patch+json` here. Cart views use plain `application/json`.
- Do not retry on `ERROR` status — those are address validation failures the user must fix.
- View UUIDs must NOT be reused across customers in a multi-tenant context (Phase 5). For v3.0 single-tenant the in-process `randomUUID` is sufficient.

### Project Structure Notes

Files created by this story:
```
packages/bot/src/checkout/api/cartViewsApi.ts
packages/bot/src/checkout/api/cartViewsApi.types.ts
packages/bot/src/checkout/api/cartViewsApi.test.ts
packages/bot/src/checkout/api/addressMapper.ts
packages/bot/src/checkout/api/addressMapper.test.ts
packages/bot/test/fixtures/cart-view-shipping-fr.json
packages/bot/scripts/live-test-cart-views.ts
```

Files modified:
- `packages/bot/src/checkout/api/index.ts` (export `NikeCartViewsApi`, `CartViewTimeoutError`, `CartViewError`, `toNikeAddress`)
- `packages/bot/src/outcomes/blockReason.ts` (add `invalid_address`, `address_not_deliverable`)

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` (Epic 12, FR62)
- PRD: `_bmad-output/planning-artifacts/prd.md` (FR62, NFR30)
- API Reference: `docs/NIKE_API_REFERENCE.md` (section "Cart views (state machine for shipping/payment/review)")
- Migration plan: `docs/V3_MIGRATION_PLAN.md` (Phase 2 deliverables, replaces v2 Story 4.4)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` (Migration Plan table, row "Story 4.4 Complete Shipping")
- Story 12.1 (provides cartId)
- Story 12.4 (consumes viewId for fulfillment binding)

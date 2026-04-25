# Story 12.5: Payment options API — list methods, choose default, bind to cart view

Status: review

## Story

As the API-first checkout pipeline,
I want to enumerate available payment methods via `POST /payment/options/v3` and bind a chosen method to the active cart view,
So that the bot can replace the v2 DOM payment-selection step (Adyen card entry stays DOM, see Story 12-7). (FR64)

## Acceptance Criteria

**Given** an active cart with a READY shipping view (Stories 12.1, 12.3)
**When** `paymentApi.listOptions({cartId, country:'FR'})` is called
**Then** the bot issues `POST https://api.nike.com/payment/options/v3` with body `{cartId, country, currency:'EUR'}`
**And** parses the response into an array of `PaymentMethod` objects, each carrying `{methodId, type:'CARD'|'PAYPAL'|'KLARNA'|...,  displayLabel, last4?, brand?, isDefault?}`

**Given** the listed methods include at least one stored `CARD` and one `PAYPAL`
**When** `pickDefaultPaymentMethod(methods, {prefer:'CARD'})` is called
**Then** the function returns the first method matching the preferred type
**And** falls back to `methods.find(m => m.isDefault)` if no match
**And** throws `NoPaymentMethodError` if the array is empty

**Given** a chosen `methodId` and the active `viewId`
**When** `paymentApi.bindPaymentMethod({viewId, methodId})` is called
**Then** the bot issues `PUT /buy/cart_views/v1/<viewId>` with patch body merging `{selectedPaymentMethod: methodId}` into the existing view
**And** the returned view contains `selectedPaymentMethod === methodId`

**Given** the cart has no stored payment methods (e.g., a brand-new account)
**When** `listOptions` returns `methods: []`
**Then** the orchestrator surfaces `BlockReason.no_payment_method` and instructs the caller to fall back to the DOM Adyen flow (Story 12-7) for first-card capture

**Given** the request returns 401 (session lapsed mid-checkout)
**When** the error handler runs
**Then** it propagates a typed `PaymentApiAuthError` to allow Story 12-9 to trigger session refresh once

## Tasks / Subtasks

### Task 1: Type definitions (AC: type contract)

Create `packages/bot/src/checkout/api/paymentApi.types.ts`:

```ts
export type PaymentMethodType = 'CARD' | 'PAYPAL' | 'KLARNA' | 'APPLE_PAY' | 'GOOGLE_PAY' | 'GIFT_CARD'

export interface PaymentMethod {
	methodId: string
	type: PaymentMethodType
	displayLabel: string
	last4?: string
	brand?: 'VISA' | 'MASTERCARD' | 'AMEX' | string
	isDefault?: boolean
	expiresAt?: string
}

export interface ListOptionsArgs {
	cartId: string
	country: string
	currency?: string
}
```

### Task 2: Implement `NikePaymentApi` (AC: list, bind)

Create `packages/bot/src/checkout/api/paymentApi.ts`:

```ts
import type { Page } from 'playwright'
import type { PaymentMethod, ListOptionsArgs } from './paymentApi.types'

export class NikePaymentApi {
	constructor(private page: Page) {}

	async listOptions(args: ListOptionsArgs): Promise<PaymentMethod[]> {
		const body = JSON.stringify({
			cartId: args.cartId,
			country: args.country,
			currency: args.currency ?? 'EUR',
		})
		const res = await this.page.request.fetch('https://api.nike.com/payment/options/v3', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			data: body,
		})
		if (res.status() === 401) throw new PaymentApiAuthError()
		if (!res.ok()) throw new Error(`POST /payment/options/v3: ${res.status()}`)
		const json = await res.json()
		return (json.methods ?? []) as PaymentMethod[]
	}

	async bindPaymentMethod(args: { viewId: string, methodId: string }) {
		// PUT /buy/cart_views/v1/<viewId> with merged selectedPaymentMethod
		// Reuses the cart_views transport via NikeCartViewsApi (Story 12.3) once it exposes a generic put().
	}
}
```

### Task 3: Default-method picker (AC: pickDefaultPaymentMethod)

In the same file:

```ts
export const pickDefaultPaymentMethod = (
	methods: PaymentMethod[],
	opts: { prefer?: PaymentMethodType } = {},
): PaymentMethod => {
	if (methods.length === 0) throw new NoPaymentMethodError()
	if (opts.prefer) {
		const match = methods.find(m => m.type === opts.prefer)
		if (match) return match
	}
	const fallback = methods.find(m => m.isDefault) ?? methods[0]
	return fallback
}
```

Document that production callers should always pass `prefer: 'CARD'` for v3.0 (PayPal/Klarna integrations are out of scope until v3.2).

### Task 4: Error classes (AC: empty list, auth)

Export from `paymentApi.ts`:

```ts
export class NoPaymentMethodError extends Error {
	constructor() { super('no payment methods available — use Adyen DOM fallback') }
}
export class PaymentApiAuthError extends Error {
	constructor() { super('payment/options/v3 returned 401 — session refresh required') }
}
```

Map to BlockReason:
- `NoPaymentMethodError` → `no_payment_method` (recoverable: triggers Story 12-7 DOM Adyen path)
- `PaymentApiAuthError` → `session_expired` (Story 12-9 retries once after refresh)

### Task 5: Bind helper integration (AC: cart_views write)

The bind operation reuses Story 12.3's `NikeCartViewsApi` transport. Two design options:

A) Add a `mergeView(viewId, patch)` method to `NikeCartViewsApi` and call it from here.
B) Duplicate the PUT call here.

Choose A. Add a single `mergeView` method to `cartViewsApi.ts` (Story 12.3) that performs `PUT /buy/cart_views/v1/<viewId>` with the merged body. Document the cross-story coupling in the file header.

### Task 6: Unit tests (AC: list, picker, bind, errors)

Create `packages/bot/src/checkout/api/paymentApi.test.ts`. Cover:
- `listOptions` issues correct POST with `application/json` body
- `listOptions` returns `[]` when API returns `{methods: []}` → caller throws via picker
- `pickDefaultPaymentMethod`: prefer=CARD beats `isDefault`; falls back to isDefault; falls back to methods[0]; throws on empty
- `pickDefaultPaymentMethod` with `prefer:'PAYPAL'` returns first PayPal even if CARD is default
- `listOptions` 401 → `PaymentApiAuthError`
- `bindPaymentMethod` issues `PUT /buy/cart_views/v1/<viewId>` with `{selectedPaymentMethod}` body

### Task 7: Live integration script (AC: real account method enumeration)

Create `packages/bot/scripts/live-test-payment-options.ts`:
1. Bootstrap real Chrome with an account that has at least one stored card.
2. initVisitor → addItem → openShippingView (Stories 12.1, 12.3).
3. listOptions; print all enumerated methods (redact `last4` to `****<last4>`).
4. pickDefault and bind; assert view returns `selectedPaymentMethod`.

Used to validate that test accounts have the expected card vault state before running full-checkout integration tests.

## Dev Notes

### Implementation guidance

- `POST /payment/options/v3` is NOT KPSDK-protected per the captured list, but it IS session-bound (requires `sid` cookie). Always call via `page.request.fetch()`.
- Adyen card collection is OUT OF SCOPE here. This story handles SELECTION of stored methods. First-card capture (typing into the Adyen iframe to add a NEW card to the vault) is Story 12-7 DOM territory.
- The `selectedPaymentMethod` field on the cart view is what Story 12.6 (cart_reviews) reads to compute the final review payload. Bind must complete before review.
- Currency defaults to EUR for FR; Story 13.x parameterizes from country registry.

### Pitfalls to avoid

- The response shape may use `paymentMethods` or `methods` depending on Nike's iteration. Defensive parse: try `methods` then `paymentMethods` then `objects`.
- Do not log `last4` in plain text unless explicitly redacted to `****1234` form. NFR6 (no PII in logs) extends to card tail.
- Do not store `methodId` durably — it is per-session at Nike's side and may rotate.

### Project Structure Notes

Files created by this story:
```
packages/bot/src/checkout/api/paymentApi.ts
packages/bot/src/checkout/api/paymentApi.types.ts
packages/bot/src/checkout/api/paymentApi.test.ts
packages/bot/scripts/live-test-payment-options.ts
```

Files modified:
- `packages/bot/src/checkout/api/cartViewsApi.ts` (add `mergeView(viewId, patch)` helper)
- `packages/bot/src/checkout/api/index.ts` (export `NikePaymentApi`, `pickDefaultPaymentMethod`, error classes)
- `packages/bot/src/outcomes/blockReason.ts` (add `no_payment_method`, `session_expired`)

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` (Epic 12, FR64)
- PRD: `_bmad-output/planning-artifacts/prd.md` (FR64, FR70 — Adyen DOM stays separate)
- API Reference: `docs/NIKE_API_REFERENCE.md` (section "Payment options")
- Migration plan: `docs/V3_MIGRATION_PLAN.md` (Phase 2, payment-selection portion)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` (Migration Plan table, row "Story 4.5 Complete Payment — selection")
- Story 12.3 (provides viewId), Story 12.7 (DOM Adyen fallback)

## Dev Agent Record

- Agent: Claude Sonnet 4.6 (bmad-dev-story)
- Implementation date: 2026-04-25
- Tasks completed: 1, 2, 3, 4, 5, 6, 7

### Implementation notes

- Transport pattern follows `page.evaluate(() => fetch(...))` + Bearer OIDC, identical to cartViewsApi.ts (Story 12.3).
- `erasableSyntaxOnly: true` constraint respected — all error classes use explicit property declaration + body assignment (no constructor param properties).
- `mergeView(viewId, patch)` added to `NikeCartViewsApi` — delegates the bind operation cleanly without duplicating transport.
- `blockReason.ts` already contained `no_payment_method` and `session_expired` — no modification required.
- Defensive parse: tries `methods` → `paymentMethods` → `objects` per dev notes pitfall.
- Story 12.6 was running concurrently; its test for `NikePaymentApi.bindPaymentMethod` was unblocked by this story's `mergeView` addition.

### Test results

- New tests: 22 pass / 0 fail (paymentApi.test.ts)
- Full suite: 353 pass / 1 fail (1 pre-existing failure: `completeShipping` unrelated to this story)
- `tsc --noEmit`: 4 errors (all pre-existing, none introduced)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-25 | Initial implementation — Tasks 1–7 complete | Claude Sonnet 4.6 |

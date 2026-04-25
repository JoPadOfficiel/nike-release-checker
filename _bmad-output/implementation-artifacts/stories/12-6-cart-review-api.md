# Story 12.6: Pre-submit cart review with total-mismatch detection

Status: backlog

## Story

As the API-first checkout pipeline,
I want a pre-submit review step that asks Nike to compute final totals (subtotal + shipping + tax) and asserts the result matches my expected total before I commit,
So that the bot never submits an order whose price drifted between PDP and checkout (a sign of stale cache, currency mismatch, or wrong promo). (FR66)

## Acceptance Criteria

**Given** an active cart with shipping address bound, fulfillment offering priced (Story 12.4), and payment method bound (Story 12.5)
**When** `reviewApi.openReview({cartId, expectedTotal})` is called
**Then** the bot generates a fresh `reviewUuid = crypto.randomUUID()`
**And** issues `PUT https://api.nike.com/buy/cart_reviews/v2/<reviewUuid>` with body `{cartId}` (KPSDK-protected — see Dev Notes)
**And** the response contains `{reviewId, status: 'PENDING' | 'READY'}`

**Given** a review in PENDING state
**When** `reviewApi.fetchReview(reviewId)` is polled until READY
**Then** the returned payload carries `{computedTotal: {subtotal, shipping, tax, total, currency}, lineItems, address, paymentMethod, etaWindow}`

**Given** the bot has an `expectedTotal` (sum of PDP price + selected fulfillment offering price)
**When** the review's `computedTotal.total` is compared to `expectedTotal` with tolerance `±0.01 EUR`
**Then** matching → returns the review payload to the orchestrator
**And** mismatch → throws `TotalMismatchError({expected, computed, delta, breakdown})` and aborts the checkout BEFORE submit

**Given** a `TotalMismatchError` is thrown
**When** the orchestrator handles it
**Then** the outcome is classified `BlockReason.total_mismatch` (terminal, no retry, manual review)
**And** the structured log records `{expected, computed, delta, lineItemSnapshot}` for forensic inspection

**Given** the review request returns 403 (KPSDK)
**When** the error handler runs
**Then** Story 12-9's KPSDK refresh-and-retry-once path is invoked

## Tasks / Subtasks

### Task 1: Type definitions (AC: type contract)

Create `packages/bot/src/checkout/api/reviewApi.types.ts`:

```ts
export type ReviewStatus = 'PENDING' | 'READY' | 'ERROR'

export interface ComputedTotal {
	subtotal: number
	shipping: number
	tax: number
	total: number
	currency: string
}

export interface ReviewLineItem {
	skuId: string
	displayName: string
	size: string
	quantity: number
	unitPrice: number
}

export interface CartReview {
	reviewId: string
	status: ReviewStatus
	cartId: string
	computedTotal?: ComputedTotal
	lineItems?: ReviewLineItem[]
	address?: { city: string, postalCode: string, country: string } // redacted shape
	paymentMethod?: { type: string, last4?: string, brand?: string }
	etaWindow?: { earliest: string, latest: string }
}
```

### Task 2: Implement `NikeReviewApi` (AC: openReview, fetchReview, validateTotals)

Create `packages/bot/src/checkout/api/reviewApi.ts`:

```ts
import type { Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import type { CartReview, ComputedTotal } from './reviewApi.types'

export class NikeReviewApi {
	constructor(private page: Page) {}

	async openReview(args: { cartId: string }): Promise<CartReview> {
		const reviewUuid = randomUUID()
		const res = await this.page.request.fetch(`https://api.nike.com/buy/cart_reviews/v2/${reviewUuid}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			data: JSON.stringify({ cartId: args.cartId }),
		})
		if (!res.ok()) throw new Error(`PUT /buy/cart_reviews/v2: ${res.status()}`)
		return { reviewId: reviewUuid, ...(await res.json()) }
	}

	async waitForReview(reviewId: string, opts: { timeoutMs?: number, intervalMs?: number } = {}): Promise<CartReview> {
		const timeoutMs = opts.timeoutMs ?? 8_000
		const intervalMs = opts.intervalMs ?? 250
		const start = Date.now()
		let last: CartReview | undefined
		while (Date.now() - start < timeoutMs) {
			last = await this.fetchReview(reviewId)
			if (last.status === 'READY') return last
			if (last.status === 'ERROR') throw new ReviewError(last)
			await new Promise(r => setTimeout(r, intervalMs))
		}
		throw new ReviewTimeoutError(reviewId, last?.status, Date.now() - start)
	}

	async fetchReview(reviewId: string): Promise<CartReview> {
		const res = await this.page.request.fetch(`https://api.nike.com/buy/cart_reviews/v2/${reviewId}`, {
			method: 'GET',
		})
		if (!res.ok()) throw new Error(`GET /buy/cart_reviews/v2/${reviewId}: ${res.status()}`)
		return await res.json()
	}
}
```

### Task 3: Total-mismatch validator (AC: ±0.01 tolerance)

In the same file:

```ts
const PRICE_TOLERANCE_EUR = 0.01

export class TotalMismatchError extends Error {
	constructor(
		public expected: number,
		public computed: ComputedTotal,
		public delta: number,
	) {
		super(`total mismatch: expected ${expected} ${computed.currency}, computed ${computed.total} (delta ${delta})`)
	}
}

export const assertTotalMatches = (expected: number, computed: ComputedTotal): void => {
	const delta = Math.abs(computed.total - expected)
	if (delta > PRICE_TOLERANCE_EUR) {
		throw new TotalMismatchError(expected, computed, delta)
	}
}
```

The 0.01 tolerance covers float-arithmetic noise. Currency conversion or promo drift produces deltas measured in euros, well above tolerance.

### Task 4: Expected-total computation helper (AC: expectedTotal contract)

Create `packages/bot/src/checkout/api/expectedTotal.ts`:

```ts
export const computeExpectedTotal = (args: {
	pdpPrice: number,
	fulfillmentCost: number,
	currency: string,
}): number => Number((args.pdpPrice + args.fulfillmentCost).toFixed(2))
```

This is the value the orchestrator (Story 12.7) computes BEFORE review and passes into `assertTotalMatches`. Tax is NOT in the expected total because Nike computes tax server-side based on shipping address; the bot trusts Nike's tax computation but rejects unexpected non-tax variance.

Refinement (documented for v3.1): if a country shows large legal tax variance per address (e.g., US states), the validator can be relaxed via a country-keyed multiplier. v3.0 FR is fine with the strict check.

### Task 5: Error classes (AC: total mismatch + timeout)

Already shown above. Also add:

```ts
export class ReviewTimeoutError extends Error {
	constructor(public reviewId: string, public lastStatus: string | undefined, public elapsedMs: number) {
		super(`review ${reviewId} timed out after ${elapsedMs}ms (last=${lastStatus})`)
	}
}
export class ReviewError extends Error {
	constructor(public review: CartReview) { super(`review ${review.reviewId} entered ERROR`) }
}
```

Map to BlockReason:
- `TotalMismatchError` → `total_mismatch`
- `ReviewTimeoutError` → `review_timeout`
- `ReviewError` → `review_failed`

### Task 6: Unit tests (AC: validator + polling + mismatch logging)

Create `packages/bot/src/checkout/api/reviewApi.test.ts`. Cover:
- `assertTotalMatches`: ε=0.005 within tolerance → ok
- `assertTotalMatches`: ε=0.02 above tolerance → throws with correct delta
- `assertTotalMatches`: 5 EUR drift → throws (the canonical "promo expired" case)
- `waitForReview`: PENDING → READY → resolves
- `waitForReview`: PENDING → ERROR → throws `ReviewError`
- `waitForReview`: timeout → throws `ReviewTimeoutError`
- `computeExpectedTotal`: rounding (e.g., 110.205 → 110.21)
- `openReview` issues PUT with `application/json` (NOT json-patch)

### Task 7: Forensic logging on mismatch (AC: structured log)

When `TotalMismatchError` is thrown, the orchestrator must log a structured record (extends Epic 5 logger):

```json
{
  "level": "error",
  "event": "total_mismatch",
  "expected": 110.00,
  "computed": { "subtotal": 100.00, "shipping": 10.00, "tax": 8.50, "total": 118.50 },
  "delta": 8.50,
  "lineItems": [{ "skuId": "...", "size": "46", "unitPrice": 100.00 }],
  "reviewId": "...",
  "cartId": "...",
  "accountId": "***@***"
}
```

Wire via the existing `logger.error('total_mismatch', { ... })` call. PII is redacted at the logger transport (Story 5.x).

## Dev Notes

### Implementation guidance

- `PUT /buy/cart_reviews/v2/*` IS KPSDK-protected (per `docs/NIKE_API_REFERENCE.md` line 22). Story 12-9's retry path applies.
- The review is the LAST checkpoint before `PUT /buy/checkouts/<cartId>` (Story 12.8). It is also the cheapest signal the user is about to be charged the "wrong" amount.
- Tolerance of 0.01 EUR is intentionally tight for FR. For US (Story 13.x), expect to relax to a country-keyed value due to per-state sales tax that the bot cannot compute client-side.
- `etaWindow` returned by review can be surfaced in the receipt (Story 12.8) without further calls.

### Pitfalls to avoid

- Do NOT submit (`PUT /buy/checkouts/`) without first running review. Some accounts will succeed without it but the order may be cancelled hours later for "validation failure".
- Do not catch `TotalMismatchError` inside this story. It MUST bubble up to the orchestrator and abort. Catching it here would risk silently approving a 5x price spike.
- The review payload may carry the cart's full address — strip to `{city, postalCode, country}` before logging or persisting per NFR6.

### Project Structure Notes

Files created by this story:
```
packages/bot/src/checkout/api/reviewApi.ts
packages/bot/src/checkout/api/reviewApi.types.ts
packages/bot/src/checkout/api/reviewApi.test.ts
packages/bot/src/checkout/api/expectedTotal.ts
packages/bot/src/checkout/api/expectedTotal.test.ts
```

Files modified:
- `packages/bot/src/checkout/api/index.ts` (export `NikeReviewApi`, `assertTotalMatches`, `computeExpectedTotal`, error classes)
- `packages/bot/src/outcomes/blockReason.ts` (add `total_mismatch`, `review_timeout`, `review_failed`)

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` (Epic 12, FR66)
- PRD: `_bmad-output/planning-artifacts/prd.md` (FR66 — total mismatch detection mandate)
- API Reference: `docs/NIKE_API_REFERENCE.md` (section "Pre-submit review")
- Migration plan: `docs/V3_MIGRATION_PLAN.md` (Phase 2, review interleave)
- Story 12.4 (provides fulfillment cost), Story 12.5 (provides bound payment method), Story 12.8 (consumes review payload before submit), Story 12.9 (handles 403 retry)

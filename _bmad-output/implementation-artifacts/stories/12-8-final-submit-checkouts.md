# Story 12.8: Final submit `PUT /buy/checkouts/<cartId>` with dry-run gate and receipt logging

Status: backlog

## Story

As the v3 SaaS bot operator,
I want a final submit step that issues `PUT /buy/checkouts/<cartId>`, captures the returned `orderNumber`, persists the full response for the receipt log, and is gated by dry-run mode,
So that the bot deterministically commits the order through the API path (replacing the v2 DOM "Passer la commande" click) while never accidentally submitting during dry-runs. (FR65)

## Acceptance Criteria

**Given** an active cart with a READY review (Story 12.6) and a non-dry-run context
**When** `checkoutsApi.submit(cartId)` is called
**Then** the bot issues `PUT https://api.nike.com/buy/checkouts/<cartId>` with body `{}` (KPSDK-protected)
**And** the response status is 2xx
**And** the parsed response carries `{orderNumber: string, status: 'CONFIRMED' | 'PENDING_3DS' | 'DECLINED', orderId: string}`

**Given** the response carries `status: 'CONFIRMED'`
**When** the orchestrator handles the result
**Then** the per-account outcome is `cop` (success) with `orderNumber` recorded
**And** the full response (with PII redaction) is written to `.bot-data/receipts/<accountId>-<orderNumber>.json`
**And** the structured log emits `{event: 'cop', orderNumber, totalAmount, currency, etaWindow}`

**Given** the response carries `status: 'PENDING_3DS'`
**When** the orchestrator handles the result
**Then** control transfers to the existing v2 3DS challenge handler (FR71)
**And** the orderNumber is held until 3DS resolution, then re-classified as `cop` or `3ds_failed`

**Given** `ctx.dryRun === true`
**When** the orchestrator reaches Story 12.7 Step 9
**Then** `checkoutsApi.submit` is NOT called
**And** the outcome is `dry-run-success` with `{ skipped: 'submit', would-submit-cartId: <id>, would-submit-total: <eur> }` recorded

**Given** the submit returns 403 (KPSDK)
**When** the error handler runs
**Then** Story 12-9's KPSDK refresh-and-retry-once path is invoked
**And** if the second attempt also returns 403, outcome is `blocked` (terminal)

**Given** the submit returns 5xx
**When** the error handler runs
**Then** an idempotent retry is attempted ONCE with the same `cartId` (Nike's checkout endpoint is idempotent on cartId per docs)
**And** if the retry also fails, outcome is `submit_failed` with status code recorded

## Tasks / Subtasks

### Task 1: Type definitions (AC: response shape)

Create `packages/bot/src/checkout/api/checkoutsApi.types.ts`:

```ts
export type CheckoutStatus = 'CONFIRMED' | 'PENDING_3DS' | 'DECLINED' | 'PENDING'

export interface CheckoutResponse {
	orderNumber: string
	orderId: string
	status: CheckoutStatus
	totalAmount?: number
	currency?: string
	etaWindow?: { earliest: string, latest: string }
	receiptUrl?: string
}
```

### Task 2: Implement `NikeCheckoutsApi` (AC: submit + retry envelope)

Create `packages/bot/src/checkout/api/checkoutsApi.ts`:

```ts
import type { Page } from 'playwright'
import type { CheckoutResponse } from './checkoutsApi.types'

export class NikeCheckoutsApi {
	constructor(private page: Page) {}

	async submit(cartId: string): Promise<CheckoutResponse> {
		const res = await this.page.request.fetch(`https://api.nike.com/buy/checkouts/${cartId}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			data: '{}',
		})
		if (res.status() === 403) throw new CheckoutKpsdkBlockedError(cartId)
		if (res.status() >= 500) throw new CheckoutServerError(cartId, res.status())
		if (res.status() === 402) throw new CheckoutDeclinedError(cartId)
		if (!res.ok()) throw new Error(`PUT /buy/checkouts/${cartId}: ${res.status()}`)
		return (await res.json()) as CheckoutResponse
	}
}
```

Story 12-9 wraps this with the retry envelope. This story exposes the typed errors so the wrapper can handle them.

### Task 3: Error classes (AC: 403, 5xx, 402)

In the same file:

```ts
export class CheckoutKpsdkBlockedError extends Error {
	constructor(public cartId: string) { super(`PUT /buy/checkouts/${cartId} blocked by KPSDK (403)`) }
}
export class CheckoutServerError extends Error {
	constructor(public cartId: string, public status: number) { super(`PUT /buy/checkouts/${cartId} returned ${status}`) }
}
export class CheckoutDeclinedError extends Error {
	constructor(public cartId: string) { super(`PUT /buy/checkouts/${cartId} declined (402) — payment refused`) }
}
```

Map to BlockReason:
- `CheckoutKpsdkBlockedError` → `blocked` (after Story 12-9 retry exhausts)
- `CheckoutServerError` → `submit_failed`
- `CheckoutDeclinedError` → `payment_declined`

### Task 4: Dry-run gate (AC: skip submit)

The dry-run guard lives in Story 12-7's hybrid pipeline (Step 9). This story only enforces that `submit()` itself does NOT consult `dryRun` — that decision belongs to the orchestrator. Add a defensive comment:

```ts
// NOTE: this method UNCONDITIONALLY calls Nike. Caller is responsible for
// the dry-run gate. See packages/bot/src/checkout/pipelines/hybridPipeline.ts.
```

### Task 5: Receipt persister (AC: receipt write + redaction)

Create `packages/bot/src/checkout/api/receiptStore.ts`:

```ts
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CheckoutResponse } from './checkoutsApi.types'

export interface Receipt {
	accountId: string
	cartId: string
	orderNumber: string
	orderId: string
	status: string
	totalAmount?: number
	currency?: string
	etaWindow?: { earliest: string, latest: string }
	receiptUrl?: string
	capturedAt: string
}

export const persistReceipt = async (
	root: string,
	accountId: string,
	cartId: string,
	resp: CheckoutResponse,
): Promise<string> => {
	const path = join(root, '.bot-data', 'receipts', `${accountId}-${resp.orderNumber}.json`)
	await mkdir(dirname(path), { recursive: true })
	const receipt: Receipt = {
		accountId,
		cartId,
		orderNumber: resp.orderNumber,
		orderId: resp.orderId,
		status: resp.status,
		totalAmount: resp.totalAmount,
		currency: resp.currency,
		etaWindow: resp.etaWindow,
		receiptUrl: resp.receiptUrl,
		capturedAt: new Date().toISOString(),
	}
	await writeFile(path, JSON.stringify(receipt, null, 2), { mode: 0o600 })
	return path
}
```

File mode `0o600` per NFR7. Receipt strips PII fields (no address, no card last4) — only the auditable transaction signal.

### Task 6: Submit invocation in hybrid pipeline (AC: pipeline integration)

In Story 12.7's `hybridPipeline.ts` Step 9, replace the placeholder with:

```ts
if (ctx.dryRun) {
	steps.push(ok('submit', { skipped: 'dry-run', wouldSubmitCartId: cart.id, wouldSubmitTotal: review.computedTotal?.total }))
	return { outcome: 'dry-run-success', steps, accountId: ctx.accountId }
}
const checkouts = new NikeCheckoutsApi(ctx.page)
const resp = await withCheckoutRetry(() => checkouts.submit(cart.id), ctx) // wrapper from Story 12-9
const receiptPath = await persistReceipt(ctx.config.dataDir, ctx.accountId, cart.id, resp)
logger.info('cop', { accountId: ctx.accountId, orderNumber: resp.orderNumber, totalAmount: resp.totalAmount, currency: resp.currency, receiptPath })
if (resp.status === 'PENDING_3DS') {
	return await handle3dsChallenge(ctx, resp) // existing v2 helper
}
return { outcome: 'cop', orderNumber: resp.orderNumber, steps, accountId: ctx.accountId }
```

### Task 7: Unit tests (AC: submit, errors, receipt)

Create `packages/bot/src/checkout/api/checkoutsApi.test.ts`. Cover:
- Happy path: 200 → returns parsed `CheckoutResponse`
- 403 → throws `CheckoutKpsdkBlockedError`
- 500 → throws `CheckoutServerError(status:500)`
- 402 → throws `CheckoutDeclinedError`
- 200 with `status: 'PENDING_3DS'` → resolves (3DS handling is downstream concern)

Create `packages/bot/src/checkout/api/receiptStore.test.ts`. Cover:
- Receipt written to expected path with mode 600
- PII fields (address, card last4) NOT present in serialized JSON
- Filename collision (same accountId + orderNumber) overwrites cleanly

### Task 8: Live integration test gate (AC: real submit, OPT-IN)

Create `packages/bot/test/integration/checkoutsApi.live.test.ts` gated behind `RUN_LIVE_SUBMIT_TEST=1` (DOUBLE-gated — `RUN_LIVE_TESTS=1` is not enough to authorize a real submit because real money is involved).

The test:
1. Bootstraps real Chrome.
2. Runs the full hybrid pipeline through review.
3. Calls `checkouts.submit(cart.id)`.
4. Asserts a Nike `orderNumber` is returned.
5. The test author is responsible for cancelling the order manually.

Add a giant warning banner in the test file header.

## Dev Notes

### Implementation guidance

- `PUT /buy/checkouts/<cartId>` with empty body `{}` is the documented invocation. Nike derives all submission state from the cart + bound views.
- This endpoint is KPSDK-protected (per `docs/NIKE_API_REFERENCE.md` line 20). Story 12-9 owns the retry-on-403.
- The endpoint is idempotent on `cartId` per Nike's behavior (verified during sniff). 5xx retry is safe.
- `PENDING_3DS` is the bridge back to the residual DOM surface (FR71) — handler exists from v2.
- Receipts are local-only in v3.0. Phase 5 (Story 16.x) promotes them to the multi-tenant Postgres `orders` table.

### Pitfalls to avoid

- DO NOT add a non-empty body to the PUT. Adding a body changes the semantics and Nike returns 400.
- DO NOT log the full Nike response — it may contain a transient `customerToken` or `paymentReference` we don't want in NDJSON logs. Log only the `Receipt` projection.
- DO NOT implement the retry envelope in this story. Story 12-9 owns it. This story exposes typed errors so the envelope can react.
- The dry-run gate is the single most consequential safety property of this entire epic. Code review checklist: any change to Step 9 in the hybrid pipeline MUST preserve `if (ctx.dryRun)` first.
- Filename pattern `<accountId>-<orderNumber>.json` — accountId may contain `@`/`.`; sanitize with a simple `replace(/[^a-zA-Z0-9_-]/g, '_')` before joining the path.

### Project Structure Notes

Files created by this story:
```
packages/bot/src/checkout/api/checkoutsApi.ts
packages/bot/src/checkout/api/checkoutsApi.types.ts
packages/bot/src/checkout/api/checkoutsApi.test.ts
packages/bot/src/checkout/api/receiptStore.ts
packages/bot/src/checkout/api/receiptStore.test.ts
packages/bot/test/integration/checkoutsApi.live.test.ts
```

Files modified:
- `packages/bot/src/checkout/api/index.ts` (export `NikeCheckoutsApi`, `persistReceipt`, `Receipt`, error classes)
- `packages/bot/src/checkout/pipelines/hybridPipeline.ts` (Step 9 invocation)
- `packages/bot/src/outcomes/blockReason.ts` (add `submit_failed`, `payment_declined`)
- `.gitignore` (add `.bot-data/receipts/`)

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` (Epic 12, FR65)
- PRD: `_bmad-output/planning-artifacts/prd.md` (FR65)
- API Reference: `docs/NIKE_API_REFERENCE.md` (section "Submit order")
- Migration plan: `docs/V3_MIGRATION_PLAN.md` (Phase 4 ACs reference real-cop submit)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` (Migration Plan table, row "Story 4.6 Submit Order")
- Story 12.6 (review precondition), Story 12.7 (orchestration + dry-run gate), Story 12.9 (retry envelope)

# Story 12.4: Fulfillment offerings — list shipping methods, run pricing job, poll to terminal state

Status: backlog

## Story

As the API-first checkout pipeline,
I want to enumerate available shipping carriers, kick off Nike's async price-calculation job, and poll until it reaches a terminal state,
So that the bot can attach a priced shipping method to the cart view before review without waiting on DOM scaffolding. (FR63)

## Acceptance Criteria

**Given** a cart with a known `skuId` and a shipping view in READY state (Story 12.3)
**When** `fulfillmentApi.listOfferings({country:'FR', currency:'EUR', skuId})` is called
**Then** the bot issues `GET https://api.nike.com/buy/fulfillment_offerings/v1?filter=countryCode(FR)&filter=currency(EUR)&filter=skuId(<sku>)`
**And** parses the response into an array of `FulfillmentOffering` objects, each carrying `{offeringId, carrier, serviceLevel, estimatedDays, type:'SHIP'|'PICKUP'}`

**Given** an FR-only context
**When** `fulfillmentApi.listFulfillmentTypes('FR')` is called
**Then** the bot issues `GET /buy/fulfillment_types/v1?filter=countryCode(FR)`
**And** returns the list `['SHIP', 'PICKUP']` (ordering preserved from Nike response)

**Given** a chosen `offeringId` and the active `cartId`
**When** `fulfillmentApi.startPricingJob({cartId, offeringId})` is called
**Then** a fresh `jobUuid = crypto.randomUUID()` is generated
**And** the bot issues `PUT /buy/fulfillment_offerings_jobs/v2/<jobUuid>` with body `{cartId, offeringId}`
**And** returns `{jobId: jobUuid, status: 'PENDING'|'COMPLETED'|'FAILED'}`

**Given** a pricing job in PENDING state
**When** `fulfillmentApi.waitForJob(jobId, {timeoutMs:8_000, intervalMs:200})` is called
**Then** the bot polls `GET /buy/fulfillment_offerings_jobs/v2/<jobId>` until status is `COMPLETED` or `FAILED`
**And** resolves with the job payload (including `pricedOffering: {totalCost, taxBreakdown, etaWindow}`) on COMPLETED
**And** rejects with `FulfillmentJobFailedError` on FAILED with the job's `failureReason`
**And** rejects with `FulfillmentJobTimeoutError` if the timeout fires

**Given** the live test script runs against a real account
**When** a happy-path FR Air Force 1 SKU is exercised
**Then** the full sequence (list → start → poll → ready) completes in under 4 seconds p95

## Tasks / Subtasks

### Task 1: Type definitions (AC: type contract)

Create `packages/bot/src/checkout/api/fulfillmentApi.types.ts`:

```ts
export type FulfillmentType = 'SHIP' | 'PICKUP'
export type JobStatus = 'PENDING' | 'COMPLETED' | 'FAILED'

export interface FulfillmentOffering {
	offeringId: string
	carrier: string
	serviceLevel: string
	estimatedDays?: { min: number, max: number }
	type: FulfillmentType
	cost?: { amount: number, currency: string }
}

export interface PricingJob {
	jobId: string
	status: JobStatus
	pricedOffering?: {
		offeringId: string
		totalCost: { amount: number, currency: string }
		taxBreakdown?: Array<{ label: string, amount: number }>
		etaWindow?: { earliest: string, latest: string }
	}
	failureReason?: string
}
```

### Task 2: Implement `NikeFulfillmentApi` (AC: list, types, start, wait)

Create `packages/bot/src/checkout/api/fulfillmentApi.ts`:

```ts
import type { Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import type { FulfillmentOffering, FulfillmentType, PricingJob } from './fulfillmentApi.types'

export class NikeFulfillmentApi {
	constructor(private page: Page) {}

	async listOfferings(args: { country: string, currency: string, skuId: string }): Promise<FulfillmentOffering[]> {
		const qs = new URLSearchParams()
		qs.append('filter', `countryCode(${args.country})`)
		qs.append('filter', `currency(${args.currency})`)
		qs.append('filter', `skuId(${args.skuId})`)
		const res = await this.get(`/buy/fulfillment_offerings/v1?${qs.toString()}`)
		return res.objects ?? []
	}

	async listFulfillmentTypes(country: string): Promise<FulfillmentType[]> {
		const res = await this.get(`/buy/fulfillment_types/v1?filter=countryCode(${country})`)
		return res.types ?? []
	}

	async startPricingJob(args: { cartId: string, offeringId: string }): Promise<PricingJob> {
		const jobUuid = randomUUID()
		const res = await this.put(`/buy/fulfillment_offerings_jobs/v2/${jobUuid}`, args)
		return { jobId: jobUuid, ...res }
	}

	async waitForJob(jobId: string, opts: { timeoutMs?: number, intervalMs?: number } = {}): Promise<PricingJob> {
		const timeoutMs = opts.timeoutMs ?? 8_000
		const intervalMs = opts.intervalMs ?? 200
		const start = Date.now()
		let last: PricingJob | undefined
		while (Date.now() - start < timeoutMs) {
			last = await this.get(`/buy/fulfillment_offerings_jobs/v2/${jobId}`)
			if (last.status === 'COMPLETED') return last
			if (last.status === 'FAILED') throw new FulfillmentJobFailedError(last)
			await new Promise(r => setTimeout(r, intervalMs))
		}
		throw new FulfillmentJobTimeoutError(jobId, last?.status, Date.now() - start)
	}
}
```

### Task 3: Filter encoding helper (AC: parenthesized filter syntax)

Nike's filter syntax is `filter=key(value)` (parens NOT URL-encoded by their server). Verify with a unit test that `URLSearchParams.toString()` doesn't double-encode parens; if it does, hand-roll the query-string assembly.

```ts
const buildFilterQuery = (filters: Record<string, string>): string =>
	Object.entries(filters).map(([k, v]) => `filter=${k}(${v})`).join('&')
```

### Task 4: Default offering picker (AC: chosen offering for next step)

Create `pickDefaultOffering(offerings: FulfillmentOffering[]): FulfillmentOffering` exported from the same file. Heuristic:
1. Prefer `type === 'SHIP'`.
2. Among SHIP, prefer the cheapest by `cost.amount` if present.
3. If no `cost` info (typical pre-pricing-job), prefer first carrier alphabetically for determinism.
4. Throw `NoFulfillmentOfferingError` if list is empty.

This default is what Story 12.7 (hybrid pipeline) uses to auto-select. Power users may override via config.

### Task 5: Error classes (AC: failed + timeout + empty list)

Export from `fulfillmentApi.ts`:

```ts
export class FulfillmentJobFailedError extends Error {
	constructor(public job: PricingJob) {
		super(`pricing job ${job.jobId} failed: ${job.failureReason}`)
	}
}
export class FulfillmentJobTimeoutError extends Error {
	constructor(public jobId: string, public lastStatus: string | undefined, public elapsedMs: number) {
		super(`pricing job ${jobId} timed out after ${elapsedMs}ms (last=${lastStatus})`)
	}
}
export class NoFulfillmentOfferingError extends Error {
	constructor(public country: string, public skuId: string) {
		super(`no fulfillment offering for sku ${skuId} in ${country}`)
	}
}
```

Map to BlockReason taxonomy:
- `FulfillmentJobTimeoutError` → `fulfillment_timeout`
- `FulfillmentJobFailedError` → `fulfillment_unavailable`
- `NoFulfillmentOfferingError` → `no_shipping_method`

### Task 6: Unit tests (AC: list, picker, polling, errors)

Create `packages/bot/src/checkout/api/fulfillmentApi.test.ts`. Cover:
- `listOfferings` builds correct multi-filter URL (asserts `?filter=countryCode(FR)&filter=currency(EUR)&filter=skuId(...)` exact)
- `pickDefaultOffering` picks cheapest SHIP; falls back to alphabetical when no cost; throws on empty
- `waitForJob` polling sequence PENDING → PENDING → COMPLETED resolves
- `waitForJob` PENDING → FAILED rejects with `FulfillmentJobFailedError`
- `waitForJob` all-PENDING rejects with `FulfillmentJobTimeoutError`
- Filter helper: parens stay literal in query string

### Task 7: Live integration script (AC: real timing)

Create `packages/bot/scripts/live-test-fulfillment.ts`:
1. Bootstrap real Chrome.
2. initVisitor → addItem → openShippingView (Stories 12.1 + 12.3).
3. listOfferings; print all offerings.
4. pickDefaultOffering → startPricingJob → waitForJob.
5. Print priced offering and elapsed wall time per step.

Used to characterize FR shipping-method latency for NFR30 budget validation.

## Dev Notes

### Implementation guidance

- The Nike `filter=` syntax is unique — `filter=key(value)`, multiple `filter=` params allowed. Many HTTP clients URL-encode parens; verify yours does not.
- Polling intervals: 200 ms is aggressive. Live test in Task 7 should confirm it does not get rate-limited. If 429 observed, fall back to 500 ms and document.
- The `pricedOffering.totalCost` returned here feeds Story 12.6 (cart_reviews) total-mismatch detection — the bot stores the expected total before review.
- The `jobUuid` is client-generated (per Nike API ref); same pattern as Story 12.3 view UUIDs.

### Pitfalls to avoid

- Do not bind a fulfillment offering to the cart view in this story. Binding happens via a `PUT /buy/cart_views/v1/<viewId>` patch with the `selectedFulfillment` field — that's Story 12.5/12.6 territory because it interleaves with payment selection.
- The `objects[]` field in `listOfferings` may contain mixed `SHIP` and `PICKUP` entries even when only `SHIP` was requested. Filter client-side.
- Do not store the `jobId` in any persistent store. It's transient and tied to a single cart pricing cycle.

### Project Structure Notes

Files created by this story:
```
packages/bot/src/checkout/api/fulfillmentApi.ts
packages/bot/src/checkout/api/fulfillmentApi.types.ts
packages/bot/src/checkout/api/fulfillmentApi.test.ts
packages/bot/scripts/live-test-fulfillment.ts
```

Files modified:
- `packages/bot/src/checkout/api/index.ts` (export `NikeFulfillmentApi`, `pickDefaultOffering`, error classes)
- `packages/bot/src/outcomes/blockReason.ts` (add `fulfillment_timeout`, `fulfillment_unavailable`, `no_shipping_method`)

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` (Epic 12, FR63)
- PRD: `_bmad-output/planning-artifacts/prd.md` (FR63)
- API Reference: `docs/NIKE_API_REFERENCE.md` (section "Fulfillment options (shipping methods)")
- Migration plan: `docs/V3_MIGRATION_PLAN.md` (Phase 2 deliverables, fulfillment wiring)
- Story 12.1 (provides cartId), Story 12.2 (provides skuId), Story 12.3 (provides viewId)
- Story 12.6 (consumes priced offering for review)

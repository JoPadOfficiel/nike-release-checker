# Story 12.7: Hybrid DOM/API checkout pipeline orchestrator

Status: backlog

## Story

As the v3 SaaS bot operator,
I want the existing `checkoutPipeline.ts` refactored to call the new API modules (cart, cart_views, fulfillment, payment, review, submit) for everything except the three irreducible DOM surfaces (PDP size click, Adyen iframe, 3DS challenge),
So that the SaaS tier runs the deterministic API path while the self-hosted tier keeps the v2 DOM fallback behind a feature flag. (FR60-FR66, FR69-FR71)

## Acceptance Criteria

**Given** `CHECKOUT_PIPELINE=hybrid` (default for SaaS) is set in the bot config
**When** the orchestrator runs a checkout for a single account against a known in-stock SKU
**Then** the step sequence is exactly:
1. DOM: navigate to PDP, click size grid item (`[data-testid="pdp-grid-selector-item"]`) — FR69
2. DOM: harvest `skuId` from the page hydration state (or fall back to Story 12.2 SDK resolver)
3. API: `cartApi.initVisitor()` then `cartApi.addItem()` — Story 12.1
4. API: `cartViewsApi.openShippingView()` + `waitForView()` — Story 12.3
5. API: `fulfillmentApi.listOfferings()` → `pickDefaultOffering()` → `startPricingJob()` → `waitForJob()` — Story 12.4
6. API: `paymentApi.listOptions()` → `pickDefaultPaymentMethod()` → `bindPaymentMethod()` — Story 12.5
7. DOM IF first-time card capture: open Adyen iframe, type card data — FR70 (gated)
8. API: `reviewApi.openReview()` → `waitForReview()` → `assertTotalMatches()` — Story 12.6
9. API: `checkoutsApi.submit(cartId)` — Story 12.8
10. DOM IF triggered: 3DS challenge handler — FR71 (existing v2 code)

**Given** `CHECKOUT_PIPELINE=dom` (default for self-hosted) is set
**When** the orchestrator runs
**Then** the v2 DOM steps (Story 4.2 addToCart, 4.3 navigateCheckout, 4.4 completeShipping, 4.5 completePayment, 4.6 submitOrder) are used unchanged
**And** none of the new API modules are imported at runtime (lazy imports gated on the flag)

**Given** the hybrid pipeline runs end-to-end in dry-run mode
**When** completion is reached
**Then** total wall time from `addItem` API call to `assertTotalMatches` resolves is < 8 s p95 on FR (NFR30 sub-budget)
**And** the dry-run gate skips the final submit (Story 12.8)

**Given** ANY step in the API path throws a typed error (`NikeCartApiError`, `CartViewTimeoutError`, etc.)
**When** the orchestrator's catch handler runs
**Then** the error is mapped to a `BlockReason` per the per-story taxonomy
**And** the per-account outcome row is updated and the loop continues with the next account (NFR12 fault isolation preserved)

**Given** the v2 self-hosted CI matrix runs
**When** all v2 unit tests execute under `CHECKOUT_PIPELINE=dom`
**Then** all green — no v2 regression introduced

**Given** the bot config does not set `CHECKOUT_PIPELINE`
**When** the orchestrator initializes
**Then** the default is `dom` for self-hosted contexts and `hybrid` for SaaS contexts (detected by presence of `bot.tier === 'saas'` config flag — falls back to `dom` if unset)

## Tasks / Subtasks

### Task 1: Document hybrid step ownership (AC: step sequence)

Create `packages/bot/src/checkout/HYBRID_PIPELINE.md` containing the canonical 10-step table:

| Step | Owner | Source | Story |
|---|---|---|---|
| 1. PDP navigate + size click | DOM | existing `selectSize.ts` | 4.1 / FR69 |
| 2. skuId harvest | DOM/SDK | new `harvestSkuId.ts` | 12.2 (fallback) |
| 3. initVisitor + addItem | API | `NikeCartApi` | 12.1 |
| 4. openShippingView + wait | API | `NikeCartViewsApi` | 12.3 |
| 5. listOfferings + price job | API | `NikeFulfillmentApi` | 12.4 |
| 6. listOptions + bind | API | `NikePaymentApi` | 12.5 |
| 7. Adyen card entry (first-time only) | DOM | existing `completePayment.ts` | 4.5b / FR70 |
| 8. openReview + assertTotalMatches | API | `NikeReviewApi` | 12.6 |
| 9. submit `PUT /buy/checkouts/` | API | `NikeCheckoutsApi` | 12.8 |
| 10. 3DS challenge | DOM | existing handler | FR71 |

Document the dry-run cut-line: dry-run aborts AFTER Step 8 (review validated, no submit).

### Task 2: Add `CHECKOUT_PIPELINE` config flag (AC: feature flag)

Modify `packages/bot/src/config/loader.ts`:

```ts
checkout: {
	pipeline: 'dom' | 'hybrid'   // default depends on tier
	tier?: 'self-hosted' | 'saas'
	// existing fields...
}
```

Default resolution: explicit `pipeline` wins; else if `tier === 'saas'` use `hybrid`; else `dom`. Add validator + sample to `bot.config.example.yaml`.

### Task 3: Implement `harvestSkuId.ts` (AC: skuId harvest)

Create `packages/bot/src/checkout/dom/harvestSkuId.ts`:

```ts
import type { Page } from 'playwright'
import { resolveSkuId } from '../api/skuResolver' // Story 12.2

export const harvestSkuId = async (page: Page, args: {
	styleColor: string,
	euSize: string,
	country: string,
}): Promise<string> => {
	// Strategy 1: extract from window.__NEXT_DATA__ hydration
	const fromHydration = await page.evaluate(({ size }) => {
		const data = (window as any).__NEXT_DATA__?.props?.pageProps
		const skus: any[] = data?.product?.skus ?? []
		return skus.find((s) => s.localizedSize === size || s.nikeSize === size)?.skuId
	}, { size: args.euSize }).catch(() => undefined)

	if (fromHydration) return fromHydration

	// Strategy 2: fall back to Product Feed SDK call (Story 12.2)
	return resolveSkuId(args)
}
```

Two-tier strategy because hydration extraction is faster (no HTTP) but more fragile; SDK is slower but stable.

### Task 4: Refactor `checkoutPipeline.ts` (AC: hybrid orchestration + flag dispatch)

Modify `packages/bot/src/checkout/checkoutPipeline.ts` to dispatch on the flag:

```ts
import { runDomPipeline } from './pipelines/domPipeline' // existing v2 path
import { runHybridPipeline } from './pipelines/hybridPipeline' // new

export const runCheckoutPipeline = async (ctx: CheckoutContext) => {
	const mode = ctx.config.checkout.pipeline
	if (mode === 'hybrid') return runHybridPipeline(ctx)
	return runDomPipeline(ctx)
}
```

Move the existing pipeline body into `pipelines/domPipeline.ts` UNCHANGED.

### Task 5: Implement `hybridPipeline.ts` (AC: 10-step sequence)

Create `packages/bot/src/checkout/pipelines/hybridPipeline.ts`. Each step is a `try/catch` that maps caught typed errors to `BlockReason` and returns the per-step outcome record. The structure mirrors `domPipeline.ts` for parity.

```ts
export const runHybridPipeline = async (ctx: CheckoutContext): Promise<CheckoutOutcome> => {
	const steps: StepResult[] = []
	try {
		// Step 1: DOM size click
		await selectSize(ctx) ; steps.push(ok('select-size'))
		// Step 2: harvest skuId
		const skuId = await harvestSkuId(ctx.page, { ... }) ; steps.push(ok('harvest-sku'))
		// Step 3: cart API
		const cartApi = new NikeCartApi(ctx.page, ctx.country)
		await cartApi.initVisitor(generateVisitorId())
		const cart = await cartApi.addItem(skuId, ctx.slug, ctx.styleColor)
		steps.push(ok('add-to-cart-api'))
		// Step 4: shipping view ...
		// Step 5: fulfillment ...
		// Step 6: payment options + bind ...
		// Step 7: DOM Adyen IF first-card-capture flag
		// Step 8: review + total assertion
		// Step 9: submit (skipped in dry-run)
		// Step 10: 3DS handler (deferred to v2 helper)
	} catch (e) {
		return mapErrorToOutcome(e, steps)
	}
}
```

### Task 6: First-card capture detection (AC: Step 7 gating)

If `paymentApi.listOptions()` returns `[]` (account has no stored card), the orchestrator falls back to the DOM Adyen flow ONCE to capture a card, then re-calls `listOptions` to bind the newly stored method.

Add `packages/bot/src/checkout/dom/captureAdyenCard.ts` that wraps the existing `completePayment.ts` Adyen typing logic, returning success once the card lands in the vault. For v3.0 we accept that this re-uses the v2 selectors per FR70.

### Task 7: Dry-run gate (AC: skip submit)

In Step 9, check `ctx.dryRun`:

```ts
if (ctx.dryRun) {
	logger.info('dry-run: skipping PUT /buy/checkouts/<cartId>')
	steps.push(ok('submit', { skipped: 'dry-run' }))
	return { outcome: 'dry-run-success', steps }
}
const checkouts = new NikeCheckoutsApi(ctx.page) // Story 12.8
const order = await checkouts.submit(cart.id)
```

### Task 8: Integration test (AC: parity + fault isolation)

Create `packages/bot/test/integration/hybridPipeline.test.ts`. Use a mocked `Page` and mocked API class instances. Assert:
- All 10 step calls made in order under happy path
- Failure in Step 4 (cart_views timeout) → outcome `view_timeout`, subsequent steps NOT called
- `dryRun: true` → Step 9 marked `skipped: 'dry-run'`, no submit invoked
- `pipeline: 'dom'` → falls through to existing `runDomPipeline` (one shallow assertion)
- Three parallel accounts where account 2 fails at Step 5 → accounts 1 and 3 still complete (NFR12)

### Task 9: Live end-to-end script (AC: < 8 s p95)

Create `packages/bot/scripts/live-test-hybrid-checkout.ts`:
1. Bootstrap real Chrome with known authenticated account.
2. Run `runHybridPipeline` in dry-run mode against a stable in-stock SKU.
3. Print per-step timings and total wall time.

Run 5 consecutive iterations and compute p50/p95 — must satisfy NFR30.

## Dev Notes

### Implementation guidance

- The pipeline split (`domPipeline.ts` vs `hybridPipeline.ts`) is deliberate. Do NOT try to interleave conditionals inside one mega-function; that path was tried in spike branches and produced unmaintainable code. Two clean orchestrators, one dispatcher.
- `harvestSkuId` first tries `window.__NEXT_DATA__` because it's free (already loaded in DOM) and avoids the Product Feed round-trip. The SDK fallback covers the case where Nike changes hydration shape.
- The Adyen DOM step (Step 7) runs only when the account has no stored card. This is a one-time onboarding cost; subsequent runs hit the API path entirely.
- 3DS (Step 10) is reactive — only runs when the issuer requires it. The handler is the existing v2 code; this story does not modify it.

### Pitfalls to avoid

- Do not eagerly import API modules at the top of `checkoutPipeline.ts`. Use dynamic `await import('./pipelines/hybridPipeline')` inside the dispatcher so `CHECKOUT_PIPELINE=dom` deployments don't pay the parse cost.
- The dry-run cut MUST occur AFTER review (Step 8) so the total-mismatch validator still runs. Skipping review in dry-run defeats the purpose of dry-run.
- Each typed error class from Stories 12.1–12.6 has a documented BlockReason mapping. Use `mapErrorToOutcome(e, steps)` from a shared helper, not ad-hoc `instanceof` chains in the catch.
- Default-flag resolution: do NOT default to `hybrid` for self-hosted users; their accounts may not have stored cards or may use proxies that the API path hasn't been tested against. Self-hosted stays `dom` until explicitly opted in.

### Project Structure Notes

Files created by this story:
```
packages/bot/src/checkout/HYBRID_PIPELINE.md
packages/bot/src/checkout/pipelines/hybridPipeline.ts
packages/bot/src/checkout/pipelines/hybridPipeline.test.ts
packages/bot/src/checkout/pipelines/domPipeline.ts        (extraction of v2 body)
packages/bot/src/checkout/dom/harvestSkuId.ts
packages/bot/src/checkout/dom/harvestSkuId.test.ts
packages/bot/src/checkout/dom/captureAdyenCard.ts
packages/bot/src/checkout/mapErrorToOutcome.ts
packages/bot/test/integration/hybridPipeline.test.ts
packages/bot/scripts/live-test-hybrid-checkout.ts
```

Files modified:
- `packages/bot/src/checkout/checkoutPipeline.ts` (becomes dispatcher; existing body moves to `domPipeline.ts`)
- `packages/bot/src/config/loader.ts` (add `checkout.pipeline`, `checkout.tier`)
- `packages/bot/bot.config.example.yaml` (sample `pipeline: dom|hybrid`)
- `packages/bot/src/outcomes/blockReason.ts` (no new reasons; this story aggregates Stories 12.1-12.6 reasons)

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` (Epic 12, FR60-FR66, FR69-FR71)
- PRD: `_bmad-output/planning-artifacts/prd.md` (FR60-FR71, NFR30)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` (Migration Plan — DOM → API table; full table is the spec for this story)
- Migration plan: `docs/V3_MIGRATION_PLAN.md` (Phase 2 — Hybrid pipeline goal + acceptance gates)
- API Reference: `docs/NIKE_API_REFERENCE.md` (whole document — this story integrates all sections)
- Stories 12.1–12.6 + 12.8 (consumed); Story 12.9 (error retry envelope)

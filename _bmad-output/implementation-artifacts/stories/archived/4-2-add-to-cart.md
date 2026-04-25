---
status: archived
archivedDate: 2026-04-25
archivedReason: |
  Replaced by v3 Epic 12 (API-First Cart & Checkout). The DOM-based step
  is preserved in the self-hosted tier code path but not the canonical
  implementation for the SaaS worker pool.
replacedBy: _bmad-output/implementation-artifacts/stories/12-1-cart-api-base.md
v3PrdRef: _bmad-output/planning-artifacts/prd.md (FR60-FR75)
v3EpicRef: _bmad-output/planning-artifacts/epics.md (Epic 12)
---

# DEPRECATED — v2 story archived 2026-04-25

This story is preserved for historical reference. The v3 implementation
lives at `12-1-cart-api-base.md` and should be used for all new work.

---

# Story 4.2: Add to Cart

Status: ready-for-dev

## Story

As an operator,
I want the system to click the purchase button after size selection,
So that the product is added to the shopping cart. (FR17)

## Acceptance Criteria

**Given** a size has been successfully selected (Story 4.1)
**When** the system clicks the purchase/buy button using the externalized selector
**Then** the system waits for confirmation that the item was added (page state change, cart indicator, or navigation)
**And** if the button is disabled or missing, the attempt is logged as "add to cart failed" with the page state
**And** the step completes in under 8 seconds (NFR5)

## Tasks / Subtasks

1. **Implement addToCart step** `packages/bot/src/checkout/steps/addToCart.ts`
   - Accept `page: Page`, `selectors: Selectors` as parameters
   - Wait for purchase button using `page.waitForSelector(selectors.purchaseButton, { timeout: 8000 })`
   - Selector maps to `.ncss-btn-primary-dark` from `selectors.yaml`
   - Check button is enabled (not disabled attribute, not aria-disabled)
   - Click the purchase button via `page.click(selectors.purchaseButton)`
   - Wait for cart confirmation: detect page state change (cart count increment, navigation to cart page, or "added to cart" indicator)
   - If button is disabled or missing, return `StepResult` with outcome `error` and details describing the page state
   - **AC ref:** Button clicked, confirmation waited, disabled/missing logged

2. **Wrap with executeStep pattern** `packages/bot/src/checkout/steps/addToCart.ts`
   - Use `performance.now()` timing, try/catch returning `StepResult`
   - Never throw — return classified `StepResult`
   - **AC ref:** Step completes in under 8 seconds (NFR5)

3. **Write unit tests** `packages/bot/src/checkout/steps/addToCart.test.ts`
   - Test: successful add to cart returns outcome `success`
   - Test: disabled button returns outcome `error` with details
   - Test: missing button (timeout) returns outcome `error`
   - Test: button present but click triggers error page returns outcome `error`
   - Mock `page` object with `node:test` mock utilities

## Dev Notes

### executeStep Pattern

Same pattern as Story 4.1. Wrap the step logic in timing + try/catch, return `StepResult`.

### Externalized Selectors

- `selectors.purchaseButton` maps to `.ncss-btn-primary-dark` (the "Acheter" / buy button on Nike FR)
- Nike may change this class name at any time. The externalized selector in `selectors.yaml` allows updating without code changes.

### Cart Confirmation Detection

After clicking the purchase button, the system needs to detect that the item was actually added. Strategies in priority order:
1. Wait for navigation to a cart/checkout URL
2. Wait for a cart count indicator element to appear or increment
3. Wait for a toast/notification element confirming addition
4. Use `page.waitForResponse()` to detect the add-to-cart API call completing with 200

The specific strategy depends on Nike's current page behavior and should be configurable or multi-strategy.

### Project Structure Notes

- Step implementation: `packages/bot/src/checkout/steps/addToCart.ts`
- Step test: `packages/bot/src/checkout/steps/addToCart.test.ts`
- Types: `packages/bot/src/checkout/checkout.types.ts` (from Story 4.1)

### References

- Architecture: executeStep pattern, externalized selectors anti-pattern (never hardcode `.ncss-btn-primary-dark`)
- PRD: FR17, NFR5
- Epics: Epic 4, Story 4.2
- Selectors: `.ncss-btn-primary-dark` for purchase button

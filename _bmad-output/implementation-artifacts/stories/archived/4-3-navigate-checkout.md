---
status: archived
archivedDate: 2026-04-25
archivedReason: |
  Replaced by v3 Epic 12 (API-First Cart & Checkout). The DOM-based step
  is preserved in the self-hosted tier code path but not the canonical
  implementation for the SaaS worker pool.
replacedBy: _bmad-output/implementation-artifacts/stories/12-3-checkout-init-cart-views.md
v3PrdRef: _bmad-output/planning-artifacts/prd.md (FR60-FR75)
v3EpicRef: _bmad-output/planning-artifacts/epics.md (Epic 12)
---

# DEPRECATED — v2 story archived 2026-04-25

This story is preserved for historical reference. The v3 implementation
lives at `12-3-checkout-init-cart-views.md` and should be used for all new work.

---

# Story 4.3: Navigate to Checkout

Status: ready-for-dev

## Story

As an operator,
I want the system to navigate to the Nike France checkout page,
So that the order process can begin. (FR18)

## Acceptance Criteria

**Given** the product has been added to cart (Story 4.2)
**When** the system navigates to `https://www.nike.com/fr/checkout`
**Then** the checkout page loads with the order items visible
**And** if the cart is empty or the page fails to load, the attempt is logged with the error state
**And** the step completes in under 8 seconds (NFR5)

## Tasks / Subtasks

1. **Implement navigateCheckout step** `packages/bot/src/checkout/steps/navigateCheckout.ts`
   - Accept `page: Page`, `selectors: Selectors` as parameters
   - Navigate to `https://www.nike.com/fr/checkout` via `page.goto()`
   - Wait for checkout page to load: detect order summary or cart items using `selectors.checkoutOrderItems`
   - Detect empty cart state: if the checkout page shows an empty cart message or redirects to the cart page, return `StepResult` with outcome `error` and details "cart is empty"
   - Detect page load failure: if the checkout page does not load within timeout, return outcome `error`
   - On success, return `StepResult` with outcome `success`
   - **AC ref:** Checkout page loads with items visible, empty cart logged, load failure logged

2. **Wrap with executeStep pattern** `packages/bot/src/checkout/steps/navigateCheckout.ts`
   - Use `performance.now()` timing, try/catch returning `StepResult`
   - **AC ref:** Step completes in under 8 seconds (NFR5)

3. **Write unit tests** `packages/bot/src/checkout/steps/navigateCheckout.test.ts`
   - Test: successful navigation returns outcome `success`
   - Test: empty cart returns outcome `error` with "cart is empty"
   - Test: page timeout returns outcome `error`
   - Test: redirect to login page returns outcome `error` with "session expired"

## Dev Notes

### Checkout URL

The Nike France checkout URL is `https://www.nike.com/fr/checkout`. This is the hardcoded market path for France. If multi-country support is added later (Phase 3), the market segment (`/fr/`) should come from `bot.config.yaml` `checkout.market`.

### executeStep Pattern

Same pattern as previous steps. Wrap logic in timing + try/catch, return `StepResult`.

### Empty Cart Detection

After navigating to `/fr/checkout`, the system must verify the cart contains items. Nike may:
- Show an "empty cart" message
- Redirect to the cart page (`/fr/cart`)
- Show the checkout form with no items

Check for the presence of order item elements via `selectors.checkoutOrderItems`.

### Project Structure Notes

- Step implementation: `packages/bot/src/checkout/steps/navigateCheckout.ts`
- Step test: `packages/bot/src/checkout/steps/navigateCheckout.test.ts`

### References

- Architecture: executeStep pattern, checkout pipeline
- PRD: FR18, NFR5
- Epics: Epic 4, Story 4.3
- Nike checkout URL: `/fr/checkout`

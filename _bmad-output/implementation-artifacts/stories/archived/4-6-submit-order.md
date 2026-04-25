---
status: archived
archivedDate: 2026-04-25
archivedReason: |
  Replaced by v3 Epic 12 (API-First Cart & Checkout). The DOM-based step
  is preserved in the self-hosted tier code path but not the canonical
  implementation for the SaaS worker pool.
replacedBy: _bmad-output/implementation-artifacts/stories/12-8-final-submit-checkouts.md
v3PrdRef: _bmad-output/planning-artifacts/prd.md (FR60-FR75)
v3EpicRef: _bmad-output/planning-artifacts/epics.md (Epic 12)
---

# DEPRECATED — v2 story archived 2026-04-25

This story is preserved for historical reference. The v3 implementation
lives at `12-8-final-submit-checkouts.md` and should be used for all new work.

---

# Story 4.6: Submit Order

Status: ready-for-dev

## Story

As an operator,
I want the system to submit the order on the review step,
So that the purchase is completed. (FR21)

## Acceptance Criteria

**Given** the payment step is complete and order review step is active
**When** the system clicks the submit order button using the externalized selector
**Then** the system waits for order confirmation (success page, confirmation message, or order number)
**And** if confirmation is detected, the outcome is logged as "ORDER CONFIRMED" with product name, size, account ID, and total price
**And** if the order fails (error message, timeout), the outcome is logged with the failure reason
**And** the step completes in under 8 seconds (NFR5)

## Tasks / Subtasks

1. **Implement submitOrder step** `packages/bot/src/checkout/steps/submitOrder.ts`
   - Accept `page: Page`, `selectors: Selectors`, `accountId: string`, `slug: string`, `size: string` as parameters
   - Wait for order review section to be visible using `selectors.orderReviewSection`
   - Click the submit order button using `selectors.orderSubmitButton`
   - Wait for order confirmation: detect success page URL, confirmation message element, or order number element
   - On confirmation, extract order details (order number, product name, total price) and return `StepResult` with outcome `success` and details including "ORDER CONFIRMED" with extracted info
   - On failure (error message visible, timeout, unexpected page state), return `StepResult` with outcome `error` and details describing the failure
   - **AC ref:** Submit clicked, confirmation detected and logged, failure logged

2. **Wrap with executeStep pattern** `packages/bot/src/checkout/steps/submitOrder.ts`
   - Use `performance.now()` timing, try/catch returning `StepResult`
   - **AC ref:** Step completes in under 8 seconds (NFR5)

3. **Write unit tests** `packages/bot/src/checkout/steps/submitOrder.test.ts`
   - Test: successful order submission returns outcome `success` with order details
   - Test: order error message returns outcome `error` with failure reason
   - Test: timeout waiting for confirmation returns outcome `error`
   - Test: page navigates to error page returns outcome `error`

## Dev Notes

### executeStep Pattern

Same pattern as previous steps. This is the final step in the checkout pipeline (unless dry-run skips it).

### Externalized Selectors

- `selectors.orderReviewSection` maps to the order review container
- `selectors.orderSubmitButton` maps to the submit/place order button
- `selectors.orderConfirmation` maps to the confirmation page/message element
- `selectors.orderNumber` maps to the order number display element

### Order Confirmation Detection

After clicking submit, Nike typically:
1. Shows a loading spinner during payment processing
2. Redirects to a confirmation page with an order number
3. Or shows an error message if the order fails

Use `page.waitForNavigation()` or `page.waitForSelector(selectors.orderConfirmation)` with a timeout. Extract the order number from the confirmation page for logging.

### Dry-Run Integration

Story 4.8 (dry-run mode) will skip this step entirely. The pipeline orchestrator checks the dry-run flag before calling this step. This step itself has no dry-run awareness.

### Project Structure Notes

- Step implementation: `packages/bot/src/checkout/steps/submitOrder.ts`
- Step test: `packages/bot/src/checkout/steps/submitOrder.test.ts`

### References

- Architecture: executeStep pattern, externalized selectors
- PRD: FR21, NFR5
- Epics: Epic 4, Story 4.6

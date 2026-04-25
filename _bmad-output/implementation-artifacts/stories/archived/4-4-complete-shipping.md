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

# Story 4.4: Complete Shipping Step

Status: ready-for-dev

## Story

As an operator,
I want the system to confirm the pre-saved shipping address and proceed,
So that the shipping step is completed without manual input. (FR19)

## Acceptance Criteria

**Given** the checkout page is loaded with shipping as the active step
**When** the system detects the shipping form
**Then** if a pre-saved address is already selected, the system clicks "Enregistrer et continuer" (`[data-attr="saveAddressBtn"]`)
**And** if the address form is empty (no pre-saved address), the attempt is logged as "no pre-saved address found" and the checkout is aborted for this account
**And** the system waits for the payment step to become active before proceeding
**And** the step completes in under 8 seconds (NFR5)

## Tasks / Subtasks

1. **Implement shipping step** `packages/bot/src/checkout/steps/shipping.ts`
   - Accept `page: Page`, `selectors: Selectors` as parameters
   - Wait for shipping form to be visible using `selectors.shippingForm`
   - Detect if a pre-saved address is already selected (address summary visible, not an empty form)
   - If no pre-saved address found, return `StepResult` with outcome `error` and details "no pre-saved address found"
   - Click the save/continue button using `selectors.shippingSaveButton` which maps to `[data-attr="saveAddressBtn"]`
   - Wait for the payment step to become active: detect payment form visibility or shipping step collapse
   - Return `StepResult` with outcome `success` on successful transition
   - **AC ref:** Pre-saved address confirmed, no-address logged and aborted, payment step waited for

2. **Wrap with executeStep pattern** `packages/bot/src/checkout/steps/shipping.ts`
   - Use `performance.now()` timing, try/catch returning `StepResult`
   - **AC ref:** Step completes in under 8 seconds (NFR5)

3. **Write unit tests** `packages/bot/src/checkout/steps/shipping.test.ts`
   - Test: pre-saved address present, click save returns outcome `success`
   - Test: no pre-saved address returns outcome `error` with "no pre-saved address found"
   - Test: save button click but payment step never activates returns outcome `error`
   - Test: timeout waiting for shipping form returns outcome `error`

## Dev Notes

### executeStep Pattern

Same pattern as previous steps. Wrap logic in timing + try/catch, return `StepResult`.

### Externalized Selectors

- `selectors.shippingSaveButton` maps to `[data-attr="saveAddressBtn"]` ("Enregistrer et continuer" button)
- `selectors.shippingForm` maps to the shipping section container
- `selectors.shippingAddressSummary` maps to the pre-saved address display element

### Pre-Saved Address Detection

The bot assumes accounts have pre-saved shipping addresses on nike.com. The system does NOT fill in address fields. It only clicks through. If the address form is empty (no summary visible), the checkout is aborted for that account with a clear error.

### Step Transition Detection

After clicking save, the shipping section collapses and the payment section expands. Use `page.waitForSelector(selectors.paymentForm, { timeout: 8000 })` to detect the transition.

### Project Structure Notes

- Step implementation: `packages/bot/src/checkout/steps/shipping.ts`
- Step test: `packages/bot/src/checkout/steps/shipping.test.ts`

### References

- Architecture: executeStep pattern, externalized selectors
- PRD: FR19, NFR5
- Epics: Epic 4, Story 4.4
- Selectors: `[data-attr="saveAddressBtn"]` for shipping save button

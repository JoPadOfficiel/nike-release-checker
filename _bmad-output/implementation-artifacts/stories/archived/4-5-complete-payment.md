---
status: archived
archivedDate: 2026-04-25
archivedReason: |
  Replaced by v3 Epic 12 (API-First Cart & Checkout). The DOM-based step
  is preserved in the self-hosted tier code path but not the canonical
  implementation for the SaaS worker pool.
replacedBy: _bmad-output/implementation-artifacts/stories/12-5-payment-options-api.md
v3PrdRef: _bmad-output/planning-artifacts/prd.md (FR60-FR75)
v3EpicRef: _bmad-output/planning-artifacts/epics.md (Epic 12)
---

# DEPRECATED — v2 story archived 2026-04-25

This story is preserved for historical reference. The v3 implementation
lives at `12-5-payment-options-api.md` and should be used for all new work.

---

# Story 4.5: Complete Payment Step

Status: ready-for-dev

## Story

As an operator,
I want the system to confirm the pre-saved payment method and proceed,
So that the payment step is completed without manual input. (FR20)

## Acceptance Criteria

**Given** the shipping step is complete and payment step is active
**When** the system detects the payment form
**Then** if a pre-saved payment method is already selected, the system clicks the continue/confirm button
**And** if no pre-saved payment method is found, the attempt is logged as "no pre-saved payment found" and the checkout is aborted for this account
**And** the system waits for the order review step to become active before proceeding
**And** the step completes in under 8 seconds (NFR5)

## Tasks / Subtasks

1. **Implement payment step** `packages/bot/src/checkout/steps/payment.ts`
   - Accept `page: Page`, `selectors: Selectors` as parameters
   - Wait for payment form to be visible using `selectors.paymentForm`
   - Detect if a pre-saved payment method is already selected (card summary visible, not an empty payment form)
   - If no pre-saved payment found, return `StepResult` with outcome `error` and details "no pre-saved payment found"
   - Click the continue/confirm button using `selectors.paymentContinueButton`
   - Wait for the order review step to become active: detect review section visibility or payment step collapse
   - Return `StepResult` with outcome `success` on successful transition
   - **AC ref:** Pre-saved payment confirmed, no-payment logged and aborted, review step waited for

2. **Wrap with executeStep pattern** `packages/bot/src/checkout/steps/payment.ts`
   - Use `performance.now()` timing, try/catch returning `StepResult`
   - **AC ref:** Step completes in under 8 seconds (NFR5)

3. **Write unit tests** `packages/bot/src/checkout/steps/payment.test.ts`
   - Test: pre-saved payment present, click continue returns outcome `success`
   - Test: no pre-saved payment returns outcome `error` with "no pre-saved payment found"
   - Test: continue click but review step never activates returns outcome `error`
   - Test: timeout waiting for payment form returns outcome `error`

## Dev Notes

### executeStep Pattern

Same pattern as previous steps. Wrap logic in timing + try/catch, return `StepResult`.

### Externalized Selectors

- `selectors.paymentForm` maps to the payment section container
- `selectors.paymentContinueButton` maps to the payment continue/confirm button
- `selectors.paymentMethodSummary` maps to the pre-saved card display element

### Pre-Saved Payment Detection

The bot assumes accounts have pre-saved payment methods (credit card via Adyen or PayPal via Braintree) on nike.com. The system does NOT enter card details. It only clicks through. If the payment form shows empty fields instead of a saved card summary, the checkout is aborted.

### 3DS Note

3D Secure detection is handled by Epic 5 (Story 5.5), not this step. This step only handles the payment confirmation click. If 3DS is triggered after clicking, it will be caught by the 3DS detection layer wrapping the pipeline.

### Project Structure Notes

- Step implementation: `packages/bot/src/checkout/steps/payment.ts`
- Step test: `packages/bot/src/checkout/steps/payment.test.ts`

### References

- Architecture: executeStep pattern, externalized selectors
- PRD: FR20, NFR5
- Epics: Epic 4, Story 4.5

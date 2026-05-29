import type { Page } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'
import { naturalClick } from '../naturalClick.ts'

export async function submitOrder(
  page: Page,
  selectors: Selectors,
  dryRun = false,
  timeoutMs = 8000,
): Promise<StepResult> {
  // dry-run check MUST be the FIRST code that runs, before any page interaction
  if (dryRun) {
    return {
      step: 'submit-order',
      outcome: 'success',
      durationMs: 0,
      details: '[DRY-RUN] Order submission skipped',
    }
  }

  return executeStep(
    'submit-order',
    async () => {
      // Use shorter timeout than the executeStep race timer to avoid ghost timeout
      const innerTimeout = Math.max(Math.floor(timeoutMs * 0.7), 2000)

      // Nike's checkout has a progressive 2-stage finish (verified live 2026-05-29
      // on /fr/checkout). Stage 1: the payment step shows a button
      //   <button data-attr="continueToOrderReviewBtn" aria-disabled="true">
      //     Continuer pour voir le récapitulatif de la commande
      // that ENABLES only once the card passes client validation. Stage 2: clicking
      // it reveals the order review whose final CTA is "Soumettre le paiement"
      // (NOT "Passer la commande" on SNKRS launches). Click stage 1 first, waiting
      // for it to enable — aria-disabled, not the `disabled` attribute.
      const toReview = page.locator('[data-attr="continueToOrderReviewBtn"]').first()
      if ((await toReview.count().catch(() => 0)) > 0) {
        const reviewDeadline = Date.now() + innerTimeout
        let reviewEnabled = false
        while (Date.now() < reviewDeadline) {
          if (await page.locator(selectors.checkout.threeDSIframe).isVisible().catch(() => false)) {
            throw Object.assign(new Error('3DS challenge required before order review'), { code: '3DS_REQUIRED' })
          }
          if ((await toReview.getAttribute('aria-disabled').catch(() => null)) !== 'true') { reviewEnabled = true; break }
          await page.waitForTimeout(300)
        }
        if (!reviewEnabled) {
          throw Object.assign(
            new Error('order-review button stayed disabled (payment not accepted by Nike)'),
            { code: 'ERROR' },
          )
        }
        await naturalClick(page, toReview)
        await page.waitForTimeout(1000)
      } else {
        // Older single-stage layouts: a plain "Continuer pour voir le récapitulatif".
        const legacy = page
          .locator('button:has-text("Continuer pour voir le récapitulatif"), button:has-text("Voir le récapitulatif")')
          .first()
        if (await legacy.isVisible({ timeout: 1500 }).catch(() => false)) {
          await naturalClick(page, legacy)
          await page.waitForTimeout(800)
        }
      }

      // Final submit. Combine the configured selector with hardcoded fallbacks so a
      // stale user selectors.yaml (missing "Soumettre le paiement") still works.
      const submitSelector = [
        selectors.checkout.submitOrderButton,
        'button:has-text("Soumettre le paiement")',
        'button:has-text("Passer la commande")',
        'button:has-text("Payer maintenant")',
        'button[type="submit"]:has-text("Payer")',
      ].filter(Boolean).join(', ')
      const submitButton = page.locator(submitSelector).first()

      // Wait for the button to appear AND become enabled. Nike disables it for
      // ~0.8–2.5s while the card iframe validates and the order total settles;
      // an immediate isEnabled() check races that window and false-times-out.
      // `waitFor` only checks visibility, so poll enabled state until the deadline.
      await submitButton.waitFor({ state: 'visible', timeout: innerTimeout }).catch(() => {
        throw Object.assign(new Error('Submit order button never appeared'), { code: 'TIMEOUT' })
      })
      const enabledDeadline = Date.now() + innerTimeout
      let enabled = false
      while (Date.now() < enabledDeadline) {
        // A 3DS challenge can appear before/while the button enables — surface it.
        if (await page.locator(selectors.checkout.threeDSIframe).isVisible().catch(() => false)) {
          throw Object.assign(new Error('3DS challenge required before order submit'), { code: '3DS_REQUIRED' })
        }
        enabled = await submitButton.isEnabled().catch(() => false)
        if (enabled) break
        await page.waitForTimeout(300)
      }
      if (!enabled) {
        throw Object.assign(new Error('Submit order button stayed disabled (card validation / 3DS pending)'), { code: 'TIMEOUT' })
      }
      // Small settle buffer for React re-render after enable.
      await page.waitForTimeout(300)

      await naturalClick(page, submitButton)

      // Confirm the order succeeded by EITHER the confirmation content OR a
      // redirect to an order/confirmation URL (Nike sometimes routes to a
      // separate confirmation page rather than swapping content in place).
      const confirmSelector = [
        selectors.checkout.orderConfirmation,
        'h1:has-text("Commande confirmée")',
        'h1:has-text("Merci")',
        'h2:has-text("Commande confirmée")',
        'h1:has-text(" commande est confirmée")',
        '[data-attr*="confirmation" i]',
      ].filter(Boolean).join(', ')
      const confirmed = await Promise.race([
        page.waitForSelector(confirmSelector, { timeout: innerTimeout }).then(() => true).catch(() => false),
        page.waitForURL(/\/(orders?|confirmation|order-confirmation|thank|merci)\b/i, { timeout: innerTimeout }).then(() => true).catch(() => false),
      ])
      if (!confirmed) {
        throw Object.assign(new Error('Order submitted but confirmation not detected'), { code: 'TIMEOUT' })
      }

      return 'order-submitted'
    },
    timeoutMs,
  )
}

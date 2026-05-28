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

      // Nike's checkout has a progressive 2-stage finish: the payment step shows
      // "Continuer pour voir le récapitulatif de la commande", and only the order
      // summary step (Étape 3) shows the real "Passer la commande" button. Click
      // the continue-to-summary button first if it's present.
      const toSummary = page
        .locator('button:has-text("Continuer pour voir le récapitulatif"), button:has-text("Voir le récapitulatif")')
        .first()
      if (await toSummary.isVisible({ timeout: 2000 }).catch(() => false)) {
        await naturalClick(page, toSummary)
        await page.waitForTimeout(800)
      }

      const submitButton = page.locator(selectors.checkout.submitOrderButton).first()

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
      const confirmed = await Promise.race([
        page.waitForSelector(selectors.checkout.orderConfirmation, { timeout: innerTimeout }).then(() => true).catch(() => false),
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

import type { Page } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'

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
      await page.waitForSelector(selectors.checkout.submitOrderButton, { timeout: timeoutMs })

      const submitButton = page.locator(selectors.checkout.submitOrderButton)
      const isVisible = await submitButton.isVisible()
      const isEnabled = await submitButton.isEnabled()

      if (!isVisible || !isEnabled) {
        throw Object.assign(new Error('Submit order button not ready'), { code: 'TIMEOUT' })
      }

      await submitButton.click()

      // Wait for order confirmation page
      await page.waitForSelector(selectors.checkout.orderConfirmation, { timeout: timeoutMs })

      return 'order-submitted'
    },
    timeoutMs,
  )
}

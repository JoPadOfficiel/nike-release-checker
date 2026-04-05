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
      await page.waitForSelector(selectors.checkout.submitOrderButton, { timeout: innerTimeout })

      const submitButton = page.locator(selectors.checkout.submitOrderButton)
      const isVisible = await submitButton.isVisible()
      const isEnabled = await submitButton.isEnabled()

      if (!isVisible || !isEnabled) {
        throw Object.assign(new Error('Submit order button not ready'), { code: 'TIMEOUT' })
      }

      await naturalClick(page, submitButton)

      // Wait for order confirmation page
      await page.waitForSelector(selectors.checkout.orderConfirmation, { timeout: innerTimeout })

      return 'order-submitted'
    },
    timeoutMs,
  )
}

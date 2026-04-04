import type { Page } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'

export async function completeShipping(
  page: Page,
  selectors: Selectors,
  timeoutMs = 8000,
): Promise<StepResult> {
  return executeStep(
    'complete-shipping',
    async () => {
      // Wait for shipping continue button to be ready
      await page.waitForSelector(selectors.checkout.shippingContinueButton, { timeout: timeoutMs })

      const shippingButton = page.locator(selectors.checkout.shippingContinueButton)
      const isVisible = await shippingButton.isVisible()
      const isEnabled = await shippingButton.isEnabled()

      if (!isVisible || !isEnabled) {
        throw Object.assign(new Error('Shipping continue button not ready'), { code: 'TIMEOUT' })
      }

      await shippingButton.click()

      // Wait for payment section to appear to confirm shipping step is complete
      await page.waitForSelector(selectors.checkout.paymentSection, { timeout: timeoutMs })

      return 'shipping-complete'
    },
    timeoutMs,
  )
}

import type { Page } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'
import { naturalClick } from '../naturalClick.ts'

export async function completeShipping(
  page: Page,
  selectors: Selectors,
  timeoutMs = 8000,
): Promise<StepResult> {
  return executeStep(
    'complete-shipping',
    async () => {
      // Wait for shipping continue button to be ready
      // Use shorter timeout than the executeStep race timer to avoid ghost timeout
      const innerTimeout = Math.max(Math.floor(timeoutMs * 0.7), 2000)
      await page.waitForSelector(selectors.checkout.shippingContinueButton, { timeout: innerTimeout })

      const shippingButton = page.locator(selectors.checkout.shippingContinueButton)
      const isVisible = await shippingButton.isVisible()
      const isEnabled = await shippingButton.isEnabled()

      if (!isVisible || !isEnabled) {
        throw Object.assign(new Error('Shipping continue button not ready'), { code: 'TIMEOUT' })
      }

      await naturalClick(page, shippingButton)

      // Wait for payment section to appear to confirm shipping step is complete
      await page.waitForSelector(selectors.checkout.paymentSection, { timeout: innerTimeout })

      return 'shipping-complete'
    },
    timeoutMs,
  )
}

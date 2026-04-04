import type { Page } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'

export async function completePayment(
  page: Page,
  selectors: Selectors,
  timeoutMs = 8000,
): Promise<StepResult> {
  return executeStep(
    'complete-payment',
    async () => {
      // Wait for payment section
      await page.waitForSelector(selectors.checkout.paymentSection, { timeout: timeoutMs })

      // Check for 3DS BEFORE clicking
      const threeDSBefore = page.locator(selectors.checkout.threeDSIframe)
      const is3DSBefore = await threeDSBefore.isVisible()
      if (is3DSBefore) {
        throw Object.assign(new Error('3DS iframe detected before payment continue'), { code: '3DS_REQUIRED' })
      }

      const paymentButton = page.locator(selectors.checkout.paymentContinueButton)
      const isVisible = await paymentButton.isVisible()
      const isEnabled = await paymentButton.isEnabled()

      if (!isVisible || !isEnabled) {
        throw Object.assign(new Error('Payment continue button not ready'), { code: 'TIMEOUT' })
      }

      await paymentButton.click()

      // Check for 3DS AFTER clicking — Nike may redirect to 3DS after payment selection
      const threeDSAfter = page.locator(selectors.checkout.threeDSIframe)
      const is3DSAfter = await threeDSAfter.isVisible()
      if (is3DSAfter) {
        throw Object.assign(new Error('3DS iframe detected after payment continue'), { code: '3DS_REQUIRED' })
      }

      // Wait for submit order button to appear to confirm payment step done
      await page.waitForSelector(selectors.checkout.submitOrderButton, { timeout: timeoutMs })

      return 'payment-complete'
    },
    timeoutMs,
  )
}

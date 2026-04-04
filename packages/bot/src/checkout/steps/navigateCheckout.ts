import type { Page } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'

export async function navigateCheckout(
  page: Page,
  selectors: Selectors,
  timeoutMs = 8000,
): Promise<StepResult> {
  return executeStep(
    'navigate-checkout',
    async () => {
      // Check for block detection before navigating
      const blockLocator = page.locator(selectors.blockDetectionSignal)
      const isBlocked = await blockLocator.isVisible()
      if (isBlocked) {
        throw Object.assign(new Error('Bot detection signal found'), { code: 'BLOCKED' })
      }

      const checkoutButton = page.locator(selectors.cart.checkoutButton)
      const isVisible = await checkoutButton.isVisible()
      if (!isVisible) {
        throw Object.assign(new Error('Checkout button not visible'), { code: 'BLOCKED' })
      }

      await checkoutButton.click()

      // Wait for shipping section to appear (confirms we are on checkout page)
      await page.waitForSelector(selectors.checkout.shippingContinueButton, { timeout: timeoutMs })

      return 'checkout-page-reached'
    },
    timeoutMs,
  )
}

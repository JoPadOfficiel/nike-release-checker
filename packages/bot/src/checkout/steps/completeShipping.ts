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
      const innerTimeout = Math.max(Math.floor(timeoutMs * 0.6), 2000)
      await page.waitForSelector(selectors.checkout.shippingContinueButton, { timeout: innerTimeout })

      // Pick the first matching button (Nike checkout has multiple submit buttons,
      // text-matches may catch "Modifier" / "Confirmer" etc. — first() narrows to one).
      const shippingButton = page.locator(selectors.checkout.shippingContinueButton).first()

      // Hydration buffer: Nike's React form re-renders after waitForSelector returns,
      // and isVisible/isEnabled fail immediately on the brief intermediate state.
      // Use locator's auto-wait via waitFor instead of polling isVisible/isEnabled.
      try {
        await shippingButton.waitFor({ state: 'visible', timeout: innerTimeout })
      } catch {
        throw Object.assign(new Error('Shipping continue button not visible'), { code: 'TIMEOUT' })
      }

      await naturalClick(page, shippingButton)

      // Wait for payment section to appear to confirm shipping step is complete
      await page.waitForSelector(selectors.checkout.paymentSection, { timeout: innerTimeout })

      return 'shipping-complete'
    },
    timeoutMs,
  )
}

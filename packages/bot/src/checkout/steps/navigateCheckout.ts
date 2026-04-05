import type { Page } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'
import { dismissCookieConsent } from '../dismissCookies.ts'
import { naturalClick } from '../naturalClick.ts'

export async function navigateCheckout(
  page: Page,
  selectors: Selectors,
  timeoutMs = 8000,
): Promise<StepResult> {
  return executeStep(
    'navigate-checkout',
    async () => {
      // Navigate to the cart page first — after ATC we're still on the product page.
      // The checkout button lives on /fr/cart, not on the PDP.
      const gotoTimeout = Math.max(Math.floor(timeoutMs * 0.3), 3000)
      await page.goto('https://www.nike.com/fr/cart', { waitUntil: 'domcontentloaded', timeout: gotoTimeout })
      await dismissCookieConsent(page, selectors, 500)

      // Check for block detection AFTER navigation (Nike serves block pages here)
      const blockLocator = page.locator(selectors.blockDetectionSignal)
      const isBlocked = await blockLocator.isVisible()
      if (isBlocked) {
        throw Object.assign(new Error('Bot detection signal found'), { code: 'BLOCKED' })
      }

      // Wait for the checkout button to appear on the cart page (JS-rendered)
      const checkoutButton = page.locator(selectors.cart.checkoutButton)
      try {
        await checkoutButton.waitFor({ state: 'visible', timeout: Math.max(Math.floor(timeoutMs * 0.3), 3000) })
      } catch {
        throw Object.assign(new Error('Checkout button not visible on cart page'), { code: 'BLOCKED' })
      }

      await naturalClick(page, checkoutButton)

      // Dismiss cookie modal again on checkout page (new domain context).
      await dismissCookieConsent(page, selectors, 800)

      // Wait for shipping section to appear (confirms we are on checkout page)
      // Use shorter timeout than the executeStep race timer to avoid ghost timeout
      const innerTimeout = Math.max(Math.floor(timeoutMs * 0.6), 2000)
      await page.waitForSelector(selectors.checkout.shippingContinueButton, { timeout: innerTimeout })

      return 'checkout-page-reached'
    },
    timeoutMs,
  )
}

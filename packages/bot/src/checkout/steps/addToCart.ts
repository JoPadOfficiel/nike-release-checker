import type { Page } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'
import { checkSoldOut } from '../detectors/soldOutDetector.ts'

export async function addToCart(
  page: Page,
  selectors: Selectors,
  timeoutMs = 8000,
): Promise<StepResult> {
  return executeStep(
    'add-to-cart',
    async () => {
      // Check if sold out using all three signals
      const soldOutResult = await checkSoldOut(page, selectors)
      if (soldOutResult.soldOut) {
        throw Object.assign(
          new Error(`Product is sold out (signal: ${soldOutResult.signal})`),
          { code: 'SOLD_OUT' },
        )
      }

      const atcButton = page.locator(selectors.productPage.addToCartButton)
      const isVisible = await atcButton.isVisible()
      const isEnabled = await atcButton.isEnabled()

      if (!isVisible || !isEnabled) {
        throw Object.assign(new Error('Add to cart button not available'), { code: 'SOLD_OUT' })
      }

      await atcButton.click()

      // Wait for cart count to update to confirm item was added
      await page.waitForSelector(selectors.cart.cartCount, { timeout: timeoutMs })

      return 'added-to-cart'
    },
    timeoutMs,
  )
}

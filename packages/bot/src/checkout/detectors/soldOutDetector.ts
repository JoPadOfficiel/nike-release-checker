import type { Page } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'

export type SoldOutSignal = 'badge_sold_out' | 'button_disabled' | 'text_detection' | null

export interface SoldOutCheckResult {
  soldOut: boolean
  signal: SoldOutSignal
}

const SOLD_OUT_TEXT_PATTERN = /sold[\s-]?out|épuisé|ausverkauft|agotado|esaurito/i

/**
 * Checks for sold-out signals using three strategies:
 * 1. badge_sold_out  — sold-out badge/indicator is visible
 * 2. button_disabled — ATC button is disabled
 * 3. text_detection  — page text matches sold-out regex
 */
export async function checkSoldOut(
  page: Page,
  selectors: Selectors,
): Promise<SoldOutCheckResult> {
  // Signal 1: badge/indicator visible
  const soldOutSelector = selectors.productPage.soldOutIndicator
  if (soldOutSelector) {
    try {
      const badgeLocator = page.locator(soldOutSelector)
      const isBadgeVisible = await badgeLocator.isVisible()
      if (isBadgeVisible) {
        return { soldOut: true, signal: 'badge_sold_out' }
      }
    } catch {
      // selector not found / not applicable — continue
    }
  }

  // Signal 2: ATC button disabled
  const atcSelector = selectors.productPage.addToCartButton
  if (atcSelector) {
    try {
      const atcButton = page.locator(atcSelector)
      const isVisible = await atcButton.isVisible()
      if (isVisible) {
        const isEnabled = await atcButton.isEnabled()
        if (!isEnabled) {
          return { soldOut: true, signal: 'button_disabled' }
        }
      }
    } catch {
      // not applicable — continue
    }
  }

  // Signal 3: page text regex
  try {
    const bodyText = await page.textContent('body') ?? ''
    if (SOLD_OUT_TEXT_PATTERN.test(bodyText)) {
      return { soldOut: true, signal: 'text_detection' }
    }
  } catch {
    // page not available — continue
  }

  return { soldOut: false, signal: null }
}

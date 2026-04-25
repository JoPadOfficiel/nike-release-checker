import type { Page } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'
import { assertNotBlocked } from '../detectors/blockDetector.ts'
import { dismissCookieConsent } from '../dismissCookies.ts'
import { naturalClick } from '../naturalClick.ts'

export async function selectSize(
  page: Page,
  productUrl: string,
  targetSizes: string[],
  selectors: Selectors,
  timeoutMs = 8000,
): Promise<StepResult & { selectedSize?: string }> {
  let selectedSize: string | undefined

  if (targetSizes.length === 0) {
    return {
      step: 'select-size',
      outcome: 'error' as const,
      durationMs: 0,
      error: 'targetSizes array is empty — configure target sizes in bot.config.yaml or pass --sizes',
    }
  }

  const result = await executeStep(
    'select-size',
    async () => {
      // Use a shorter timeout for goto so subsequent operations still have time
      // within the executeStep race timer
      // Use 'domcontentloaded' (fires when HTML parsed, ~1-2s on Nike PDPs).
      // 'load' would wait for all images/3rd-party scripts (5-15s) — too slow.
      // The size grid hydrates from React after DOMContentLoaded, so we poll for it.
      const gotoTimeout = Math.max(Math.floor(timeoutMs * 0.3), 2000)
      const response = await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: gotoTimeout })
      await assertNotBlocked(page, response, selectors)
      // Dismiss Nike's cookie consent modal if it appears — otherwise it blocks clicks.
      await dismissCookieConsent(page, selectors, 800)
      // Trigger lazy hydration of size grid (often below initial viewport on Nike PDPs)
      await page.evaluate(() => window.scrollTo(0, 800)).catch(() => {})
      await page.waitForTimeout(300)
      // Generous selector wait — React hydration on a fully loaded PDP can take 5-10s
      // on cold cache. Spend most of the step budget here.
      const selectorTimeout = Math.max(Math.floor(timeoutMs * 0.6), 5000)
      await page.waitForSelector(selectors.productPage.sizeGrid, { timeout: selectorTimeout, state: 'attached' })

      // Use locator.filter with regex hasText instead of :text-is(...) in the
      // selector template. Playwright's :text-is requires exact normalized text
      // match which fails when the button wraps EU label in nested spans (React
      // render with whitespace + accessibility text). filter+regex is robust to
      // those nesting variations.
      const grid = page.locator(selectors.productPage.sizeGrid)
      for (const size of targetSizes) {
        // Anchored regex so "EU 42" never matches "EU 42.5"
        const escaped = size.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp(`^\\s*EU\\s+${escaped}\\s*$`)
        const sizeButton = grid.filter({ hasText: re }).first()
        const count = await sizeButton.count()
        if (count === 0) continue
        const isVisible = await sizeButton.isVisible().catch(() => false)
        const isEnabled = await sizeButton.isEnabled().catch(() => false)
        if (isVisible && isEnabled) {
          // Use natural mouse movement — Nike's Kasada detects teleported CDP clicks
          await naturalClick(page, sizeButton)
          selectedSize = size
          return `size:${size}`
        }
      }

      throw Object.assign(
        new Error(`No size available from: ${targetSizes.join(', ')}`),
        { code: 'SOLD_OUT' },
      )
    },
    timeoutMs,
  )

  return { ...result, selectedSize }
}

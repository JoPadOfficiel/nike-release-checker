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
      const gotoTimeout = Math.max(Math.floor(timeoutMs * 0.5), 2000)
      const response = await page.goto(productUrl, { waitUntil: 'load', timeout: gotoTimeout })
      await assertNotBlocked(page, response, selectors)
      // Dismiss Nike's cookie consent modal if it appears — otherwise it blocks clicks.
      await dismissCookieConsent(page, selectors, 800)
      // Trigger lazy hydration of size grid (often below initial viewport on Nike PDPs)
      await page.evaluate(() => window.scrollTo(0, 800)).catch(() => {})
      await page.waitForTimeout(300)
      const selectorTimeout = Math.max(Math.floor(timeoutMs * 0.4), 2000)
      await page.waitForSelector(selectors.productPage.sizeGrid, { timeout: selectorTimeout })

      for (const size of targetSizes) {
        const selectorStr = selectors.productPage.sizeButton.replace('{size}', size)
        const sizeButton = page.locator(selectorStr)
        const isVisible = await sizeButton.isVisible()
        const isEnabled = await sizeButton.isEnabled()
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

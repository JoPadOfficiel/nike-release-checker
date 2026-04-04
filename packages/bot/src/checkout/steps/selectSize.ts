import type { Page } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'
import { assertNotBlocked } from '../detectors/blockDetector.ts'

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
      const gotoTimeout = Math.max(Math.floor(timeoutMs * 0.6), 2000)
      const response = await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: gotoTimeout })
      await assertNotBlocked(page, response, selectors)
      const selectorTimeout = Math.max(Math.floor(timeoutMs * 0.5), 2000)
      await page.waitForSelector(selectors.productPage.sizeGrid, { timeout: selectorTimeout })

      for (const size of targetSizes) {
        const selectorStr = selectors.productPage.sizeButton.replace('{size}', size)
        const sizeButton = page.locator(selectorStr)
        const isVisible = await sizeButton.isVisible()
        const isEnabled = await sizeButton.isEnabled()
        if (isVisible && isEnabled) {
          await sizeButton.click()
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

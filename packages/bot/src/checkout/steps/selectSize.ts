import type { Page } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'

export async function selectSize(
  page: Page,
  productUrl: string,
  targetSizes: string[],
  selectors: Selectors,
  timeoutMs = 8000,
): Promise<StepResult & { selectedSize?: string }> {
  let selectedSize: string | undefined

  const result = await executeStep(
    'select-size',
    async () => {
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      await page.waitForSelector(selectors.productPage.sizeGrid, { timeout: timeoutMs })

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

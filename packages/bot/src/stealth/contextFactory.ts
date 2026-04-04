/**
 * Stealth context factory — Story 2-2 minimal stub.
 * Story 3-1 will replace this with a full stealth implementation
 * (playwright-extra, puppeteer-extra-plugin-stealth, fingerprint randomisation, etc.).
 */
import { chromium } from 'playwright'
import type { BrowserContext } from 'playwright'

export async function createStealthContext(proxy?: string): Promise<BrowserContext> {
	const browser = await chromium.launch({ headless: true })
	const context = await browser.newContext({
		locale: 'fr-FR',
		...(proxy ? { proxy: { server: proxy } } : {}),
	})
	// Close the underlying browser when the context is closed (resource cleanup)
	context.on('close', () => void browser.close())
	return context
}

import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import type { BrowserContext, BrowserContextOptions } from 'playwright'
import { maskProxy } from '../logger/credentialMasker.ts'
import { parseProxyUrl } from './proxyValidator.ts'

// Register the stealth plugin once at module level — never inside a function.
// Registering it multiple times causes duplicate plugin warnings and unpredictable behavior.
// Disable conflicting evasions — we handle these explicitly via context options and addInitScript.
// 'user-agent-override' conflicts with our explicit userAgent + locale context settings.
// 'navigator.languages' conflicts with our addInitScript override for French language signals.
const stealth = StealthPlugin()
stealth.enabledEvasions.delete('user-agent-override')
stealth.enabledEvasions.delete('navigator.languages')
chromium.use(stealth)

export interface StealthContextOptions {
	proxy?: string // Full URL: http://user:pass@host:port
	headless?: boolean // Default: true
	locale?: string // Default: 'fr-FR'
	timezone?: string // Default: 'Europe/Paris'
}

/**
 * Creates a new isolated Playwright context with the stealth plugin active.
 *
 * CREATE-USE-DESTROY PATTERN — the caller MUST always call context.close() in a finally block:
 *
 * @example
 * const context = await createStealthContext({ proxy: account.proxy })
 * try {
 *   // use the context
 * } finally {
 *   await context.close()
 * }
 *
 * NEVER pool contexts. NEVER reuse a context across accounts. One context per operation.
 *
 * ISOLATION GUARANTEE:
 * Each BrowserContext is created with its own proxy configuration.
 * Contexts are NEVER shared between accounts.
 * Promise.allSettled() creates one context per account, each with its own proxy.
 * Cookie stores, local storage, and session data are all isolated per context.
 * This means account1's Nike session CANNOT leak into account2's context.
 */
export async function createStealthContext(
	options: StealthContextOptions = {},
): Promise<BrowserContext> {
	const { proxy, headless = true, locale = 'fr-FR', timezone = 'Europe/Paris' } = options

	// Log the masked proxy URL — NEVER log raw credentials
	if (proxy) {
		console.log(`  Proxy: ${maskProxy(proxy)}`)
	}

	const browser = await chromium.launch({
		headless,
		args: [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-dev-shm-usage',
			'--disable-accelerated-2d-canvas',
			'--disable-gpu',
			'--window-size=1920,1080',
		],
	})

	const contextOptions: BrowserContextOptions = {
		locale,
		timezoneId: timezone,
		viewport: { width: 1920, height: 1080 },
		userAgent:
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
		extraHTTPHeaders: {
			'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
			Accept:
				'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
		},
		geolocation: { latitude: 48.8566, longitude: 2.3522 },
		permissions: ['geolocation'],
	}

	// Configure the proxy at the context level (NOT at the browser level).
	// Context-level proxy means each context can have a different proxy — critical for
	// per-account isolation in parallel checkout runs.
	if (proxy) {
		contextOptions.proxy = parseProxyUrl(proxy)
	}

	let context: BrowserContext
	try {
		context = await browser.newContext(contextOptions)
	} catch (err) {
		await browser.close()
		throw err
	}

	// Additional anti-detection: inject init script to hide automation signals.
	// This runs before every page navigation in the context.
	// NOTE: must be a string, not a function — tsx/esbuild compiles arrow functions with
	// `__name()` helper calls that are undefined in the browser, causing silent failures.
	await context.addInitScript(`
		Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
		Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
		Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en'] });
	`)

	// Close the underlying browser when the context is closed (resource cleanup)
	context.on('close', () => void browser.close())

	return context
}

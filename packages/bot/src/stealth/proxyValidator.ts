import type { BrowserContext } from 'playwright'

export type ProxyTestResult =
	| { status: 'ok'; ip: string; latencyMs: number }
	| { status: 'error'; reason: string }

/**
 * Tests proxy connectivity by loading a lightweight external URL.
 * Uses https://api.ipify.org?format=json to retrieve the exit IP address.
 *
 * The caller is responsible for passing a BrowserContext already configured with the proxy.
 * This function creates a page, navigates, and closes the page — it does NOT close the context.
 *
 * @param context - A stealth context configured with the proxy to test
 * @param testUrl - URL to fetch (default: https://api.ipify.org?format=json)
 */
export async function testProxy(
	context: BrowserContext,
	testUrl = 'https://api.ipify.org?format=json',
): Promise<ProxyTestResult> {
	let page: Awaited<ReturnType<typeof context.newPage>> | undefined
	const start = performance.now()
	try {
		page = await context.newPage()
		const response = await page.goto(testUrl, {
			timeout: 10_000,
			waitUntil: 'networkidle',
		})
		if (!response?.ok()) {
			return {
				status: 'error',
				reason: `HTTP ${response?.status() ?? 'unknown'} from ${testUrl}`,
			}
		}
		const body = (await response.json()) as { ip: string }
		const latencyMs = Math.round(performance.now() - start)
		return { status: 'ok', ip: body.ip, latencyMs }
	} catch (err) {
		return {
			status: 'error',
			reason: err instanceof Error ? err.message : String(err),
		}
	} finally {
		// Always close the page — the context remains open (caller's responsibility)
		await page?.close()
	}
}

/**
 * Parses a proxy URL string into Playwright BrowserContextOptions.proxy format.
 *
 * @param proxyUrl - Full proxy URL, e.g. http://user:pass@host:port
 * @returns Object with server, username (optional), password (optional)
 *
 * @example
 * parseProxyUrl('http://admin:secret@proxy.example.com:8080')
 * // → { server: 'http://proxy.example.com:8080', username: 'admin', password: 'secret' }
 *
 * parseProxyUrl('http://proxy.example.com:8080')
 * // → { server: 'http://proxy.example.com:8080' }
 */
export function parseProxyUrl(proxyUrl: string): {
	server: string
	username?: string
	password?: string
} {
	const url = new URL(proxyUrl)
	return {
		server: `${url.protocol}//${url.hostname}:${url.port}`,
		username: url.username || undefined,
		password: url.password || undefined,
	}
}

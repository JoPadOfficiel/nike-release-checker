import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { BrowserContext } from 'playwright'
import type { CookieData } from './auth.types.ts'

const DEFAULT_SESSIONS_DIR = '.bot-data/sessions'

const LOGIN_DOMAINS = ['.nike.com', 'accounts.nike.com', 'api.nike.com', '.paypal.com']

export async function captureCookies(context: BrowserContext): Promise<CookieData[]> {
	const all = await context.cookies()
	return all.filter((c) =>
		LOGIN_DOMAINS.some((d) => c.domain === d || c.domain.endsWith(d)),
	) as CookieData[]
}

export async function persistCookies(
	accountId: string,
	cookies: CookieData[],
	sessionsDir = DEFAULT_SESSIONS_DIR,
): Promise<void> {
	// basename() strips any path separators from accountId, preventing path traversal
	const safeId = basename(accountId)
	await mkdir(sessionsDir, { recursive: true })
	const filePath = `${sessionsDir}/${safeId}.json`
	await writeFile(filePath, JSON.stringify(cookies, null, 2), { encoding: 'utf8', mode: 0o600 })
}

function isValidCookieArray(parsed: unknown): parsed is CookieData[] {
	if (!Array.isArray(parsed)) return false
	return parsed.every(
		(c) =>
			c !== null &&
			typeof c === 'object' &&
			typeof (c as Record<string, unknown>).name === 'string' &&
			typeof (c as Record<string, unknown>).value === 'string' &&
			typeof (c as Record<string, unknown>).domain === 'string' &&
			typeof (c as Record<string, unknown>).path === 'string',
	)
}

export async function loadCookies(
	accountId: string,
	sessionsDir = DEFAULT_SESSIONS_DIR,
): Promise<CookieData[]> {
	const safeId = basename(accountId)
	const filePath = `${sessionsDir}/${safeId}.json`

	let raw: string
	try {
		raw = await readFile(filePath, 'utf8')
	} catch {
		throw new Error(
			`Session file missing for account '${accountId}'. Run 'nike-bot login-all --account ${accountId}' to authenticate.`,
		)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error(
			`Session file corrupted for account '${accountId}'. Re-authenticate with 'nike-bot login-all --account ${accountId}'.`,
		)
	}

	if (!isValidCookieArray(parsed)) {
		throw new Error(
			`Session file corrupted for account '${accountId}'. Re-authenticate with 'nike-bot login-all --account ${accountId}'.`,
		)
	}

	return parsed
}

export async function injectCookies(context: BrowserContext, cookies: CookieData[]): Promise<void> {
	if (cookies.length === 0) return
	await context.addCookies(cookies)
	const domains = [...new Set(cookies.map((c) => c.domain.replace(/^\./, '')))]
	console.log(`Injected ${cookies.length} cookies across ${domains.length} domains (${domains.join(', ')})`)
}

export async function loadAndInjectCookies(
	context: BrowserContext,
	accountId: string,
	sessionsDir = DEFAULT_SESSIONS_DIR,
): Promise<void> {
	const cookies = await loadCookies(accountId, sessionsDir)
	await injectCookies(context, cookies)
}

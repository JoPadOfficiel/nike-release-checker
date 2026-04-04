import { writeFile, mkdir } from 'node:fs/promises'
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
	await mkdir(sessionsDir, { recursive: true })
	const filePath = `${sessionsDir}/${accountId}.json`
	await writeFile(filePath, JSON.stringify(cookies, null, 2), { encoding: 'utf8', mode: 0o600 })
}

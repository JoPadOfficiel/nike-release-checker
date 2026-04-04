import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { CookieData, SessionStatus, SessionValidationResult } from './auth.types.ts'

export type { SessionStatus, SessionValidationResult }

const SESSIONS_DIR = '.bot-data/sessions'

/**
 * Validate session freshness for a given account.
 * The `sid` cookie (accounts.nike.com) is the shortest-lived critical cookie.
 * A session is `valid` only when `sid` has not expired.
 */
export async function validateSession(
	accountId: string,
	sessionsDir = SESSIONS_DIR,
): Promise<SessionValidationResult> {
	const safeId = basename(accountId)
	const filePath = `${sessionsDir}/${safeId}.json`

	let fileStat: Awaited<ReturnType<typeof stat>>
	try {
		fileStat = await stat(filePath)
	} catch {
		return { status: 'missing' }
	}

	let cookies: CookieData[]
	try {
		const raw = await readFile(filePath, 'utf8')
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) {
			return { status: 'missing', error: 'corrupted session file' }
		}
		cookies = parsed as CookieData[]
	} catch {
		return { status: 'missing', error: 'corrupted session file' }
	}

	const now = Math.floor(Date.now() / 1000)

	// sid is the critical short-lived cookie — if expired, the whole session is expired
	const sidCookie = cookies.find((c) => c.name === 'sid' && c.domain === 'accounts.nike.com')
	if (sidCookie && typeof sidCookie.expires === 'number' && sidCookie.expires > 0 && sidCookie.expires < now) {
		return {
			status: 'expired',
			lastLogin: fileStat.mtime,
			expiredAt: sidCookie.expires,
		}
	}

	const domains = new Set(cookies.map((c) => c.domain))
	const futureExpiries = cookies
		.map((c) => c.expires)
		.filter((e): e is number => typeof e === 'number' && e > 0 && e > now)
	const expiresAt = futureExpiries.length > 0 ? Math.min(...futureExpiries) : undefined

	return {
		status: 'valid',
		lastLogin: fileStat.mtime,
		domainCount: domains.size,
		expiresAt,
	}
}

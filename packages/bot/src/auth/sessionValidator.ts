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

	// Filter out null/undefined items that may appear in malformed session files (P4)
	const validCookies = cookies.filter((c): c is CookieData => c !== null && typeof c === 'object')

	// sid is the critical short-lived cookie — must be present and non-expired for a valid session.
	// Playwright stores cookie domains with a leading dot (e.g. `.accounts.nike.com`) — match both forms (P2).
	const sidCookie = validCookies.find(
		(c) => c.name === 'sid' && (c.domain === 'accounts.nike.com' || c.domain === '.accounts.nike.com'),
	)

	// P1: sid absent from a non-empty file → session cannot be confirmed valid → expired
	if (!sidCookie) {
		return { status: 'expired', lastLogin: fileStat.mtime }
	}

	if (typeof sidCookie.expires === 'number' && sidCookie.expires > 0 && sidCookie.expires < now) {
		return {
			status: 'expired',
			lastLogin: fileStat.mtime,
			expiredAt: sidCookie.expires,
		}
	}

	const domains = new Set(validCookies.map((c) => c.domain))
	// P3: use reduce to avoid RangeError from spread on large arrays
	const futureExpiries = validCookies
		.map((c) => c.expires)
		.filter((e): e is number => typeof e === 'number' && e > 0 && e > now)
	const expiresAt = futureExpiries.length > 0
		? futureExpiries.reduce((a, b) => Math.min(a, b), Infinity)
		: undefined

	return {
		status: 'valid',
		lastLogin: fileStat.mtime,
		domainCount: domains.size,
		expiresAt,
	}
}

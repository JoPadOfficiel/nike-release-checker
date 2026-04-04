import { describe, it, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { writeFile, rm, mkdir } from 'node:fs/promises'
import { validateSession } from './sessionValidator.ts'
import type { CookieData } from './auth.types.ts'


const SESSIONS_DIR = '.bot-data/sessions-test'
const ID = 'sess-test-account'
const FILE = `${SESSIONS_DIR}/${ID}.json`

function now(): number {
	return Math.floor(Date.now() / 1000)
}

function cookie(overrides: Partial<CookieData> = {}): CookieData {
	return {
		name: 'sid',
		value: 'abc',
		domain: 'accounts.nike.com',
		path: '/',
		expires: now() + 3600,
		httpOnly: true,
		secure: true,
		...overrides,
	}
}

async function write(cookies: CookieData[]): Promise<void> {
	await writeFile(FILE, JSON.stringify(cookies, null, 2), { encoding: 'utf8', mode: 0o600 })
}

describe('validateSession', () => {
	before(async () => {
		await mkdir(SESSIONS_DIR, { recursive: true })
	})

	after(async () => {
		await rm(SESSIONS_DIR, { recursive: true, force: true })
	})

	it('returns missing when session file does not exist', async () => {
		const result = await validateSession('no-such-account', SESSIONS_DIR)
		assert.equal(result.status, 'missing')
		assert.equal(result.error, undefined)
	})

	it('returns missing with error when session file contains invalid JSON', async () => {
		await writeFile(FILE, 'not-json', 'utf8')
		const result = await validateSession(ID, SESSIONS_DIR)
		assert.equal(result.status, 'missing')
		assert.equal(result.error, 'corrupted session file')
	})

	it('returns missing with error when session file is not an array', async () => {
		await writeFile(FILE, JSON.stringify({ cookies: [] }), 'utf8')
		const result = await validateSession(ID, SESSIONS_DIR)
		assert.equal(result.status, 'missing')
		assert.equal(result.error, 'corrupted session file')
	})

	it('returns expired when sid cookie has past expiration', async () => {
		await write([cookie({ expires: now() - 3600 })])
		const result = await validateSession(ID, SESSIONS_DIR)
		assert.equal(result.status, 'expired')
		assert.ok(result.lastLogin instanceof Date)
		assert.ok(typeof result.expiredAt === 'number')
	})

	it('returns valid when sid cookie has future expiration', async () => {
		const futureExpiry = now() + 3600
		await write([cookie({ expires: futureExpiry })])
		const result = await validateSession(ID, SESSIONS_DIR)
		assert.equal(result.status, 'valid')
		assert.ok(result.lastLogin instanceof Date)
		assert.equal(result.domainCount, 1)
		assert.ok(typeof result.expiresAt === 'number' && result.expiresAt > 0)
	})

	it('returns valid when cookies have expires=-1 (non-expiring session cookies)', async () => {
		await write([cookie({ expires: -1 })])
		const result = await validateSession(ID, SESSIONS_DIR)
		assert.equal(result.status, 'valid')
	})

	it('returns expired when no sid cookie is present (sid required to confirm validity)', async () => {
		await write([cookie({ name: 'cf_clearance', domain: 'accounts.nike.com', expires: now() + 86400 })])
		const result = await validateSession(ID, SESSIONS_DIR)
		assert.equal(result.status, 'expired')
	})

	it('returns expired when sid has leading-dot domain (.accounts.nike.com) and is expired', async () => {
		await write([cookie({ domain: '.accounts.nike.com', expires: now() - 3600 })])
		const result = await validateSession(ID, SESSIONS_DIR)
		assert.equal(result.status, 'expired')
	})

	it('returns valid when sid has leading-dot domain (.accounts.nike.com) and is not expired', async () => {
		await write([cookie({ domain: '.accounts.nike.com', expires: now() + 3600 })])
		const result = await validateSession(ID, SESSIONS_DIR)
		assert.equal(result.status, 'valid')
	})

	it('returns expired (not TypeError) when cookie array contains null items', async () => {
		// Malformed session file with null items alongside valid cookies — no sid present → expired
		await writeFile(FILE, JSON.stringify([null, { name: 'cf_clearance', domain: '.nike.com', expires: now() + 86400 }]), 'utf8')
		const result = await validateSession(ID, SESSIONS_DIR)
		assert.equal(result.status, 'expired')
	})

	it('counts unique domains in domainCount', async () => {
		await write([
			cookie({ domain: 'accounts.nike.com', expires: now() + 3600 }),
			cookie({ name: '_abck', domain: '.nike.com', expires: now() + 86400 }),
			cookie({ name: 'KP_UIDz', domain: 'api.nike.com', expires: now() + 3600 }),
		])
		const result = await validateSession(ID, SESSIONS_DIR)
		assert.equal(result.status, 'valid')
		assert.equal(result.domainCount, 3)
	})
})

import { writeFile, mkdir, readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { loadAccountsFile } from '../config/accountConfig.ts'
import { maskEmail, maskProxy, maskCredentials } from '../logger/credentialMasker.ts'
import { testProxyConnectivity } from './proxyTester.ts'
import type { AccountConfig } from '../config/accountSchema.ts'
import type { ImportResult } from './auth.types.ts'

const DATA_DIR = '.bot-data'
const ACCOUNTS_FILE = `${DATA_DIR}/accounts.json`

export async function importAccounts(filePath: string): Promise<ImportResult> {
	// Step 1: Load and validate the source file (per-entry, non-throwing)
	const { valid, errors: validationErrors } = await loadAccountsFile(filePath)

	// Count unique schema-invalid entries (multiple errors on same entry → 1 invalid entry)
	const invalidIndexes = new Set(validationErrors.map((e) => e.index))

	const importErrors: ImportResult['errors'] = validationErrors.map((e) => ({
		accountId: `index:${e.index}`,
		reason: `${e.field}: ${e.message}`,
	}))

	// All schema-valid accounts are tracked for per-account display
	const processedAccounts: ImportResult['processedAccounts'] = valid.map((a) => ({
		id: a.id,
		email: a.email,
		proxy: a.proxy,
	}))

	// Step 2: Load existing accounts (dedup by id AND email)
	const existing = await loadStoredAccounts()
	const existingIds = new Set(existing.map((a) => a.id))
	const existingEmails = new Set(existing.map((a) => a.email.toLowerCase()))

	// Step 3: Filter valid accounts for proxy testing (dedup by id and email)
	const toImport: AccountConfig[] = []
	const seenEmails = new Set<string>()

	// failed starts with schema-invalid count so denominator = imported + failed = total input
	let imported = 0
	let failed = invalidIndexes.size

	for (const account of valid) {
		if (existingIds.has(account.id)) {
			failed++
			importErrors.push({ accountId: account.id, reason: 'duplicate id — skipped' })
			continue
		}
		const emailKey = account.email.toLowerCase()
		if (existingEmails.has(emailKey) || seenEmails.has(emailKey)) {
			failed++
			importErrors.push({ accountId: account.id, reason: 'duplicate email — skipped' })
			continue
		}
		seenEmails.add(emailKey)
		toImport.push(account)
	}

	// Test proxies concurrently
	const proxyResults = await Promise.allSettled(
		toImport.map(async (account) => {
			const result = await testProxyConnectivity(account.proxy)
			return { account, result }
		}),
	)

	const merged = [...existing]

	for (let i = 0; i < proxyResults.length; i++) {
		const settled = proxyResults[i]!
		const account = toImport[i]!

		if (settled.status === 'rejected') {
			failed++
			importErrors.push({ accountId: account.id, reason: maskCredentials(String(settled.reason)) })
			continue
		}

		const { result } = settled.value

		if (!result.success) {
			failed++
			importErrors.push({
				accountId: account.id,
				reason: `Proxy test failed (${result.latencyMs}ms): ${result.error ?? 'unknown error'}`,
			})
			continue
		}

		merged.push({ ...account, importedAt: new Date().toISOString() } as AccountConfig & { importedAt: string })
		imported++
	}

	// Step 4: Persist — mode: 0o600 avoids chmod-after-write TOCTOU window
	await mkdir(DATA_DIR, { recursive: true })
	await writeFile(ACCOUNTS_FILE, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 })

	return { imported, failed, errors: importErrors, processedAccounts }
}

export async function loadStoredAccounts(): Promise<(AccountConfig & { importedAt: string })[]> {
	try {
		await access(ACCOUNTS_FILE, constants.F_OK)
	} catch {
		return []
	}
	let raw: string
	try {
		raw = await readFile(ACCOUNTS_FILE, 'utf8')
	} catch {
		return []
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) return []
	return parsed as (AccountConfig & { importedAt: string })[]
}

export function formatImportSummary(
	result: ImportResult,
	accounts: Array<{ id: string; email: string; proxy: string }>,
): string[] {
	const lines: string[] = []

	for (const account of accounts) {
		const failure = result.errors.find((e) => e.accountId === account.id)
		const masked = maskEmail(account.email)
		const maskedProxy = maskProxy(account.proxy)
		if (failure) {
			lines.push(`  ✗ ${masked} (proxy: ${maskedProxy}) — ${failure.reason}`)
		} else {
			lines.push(`  ✓ ${masked} (proxy: ${maskedProxy}) — imported`)
		}
	}

	const total = result.imported + result.failed
	lines.push(`\n${result.imported}/${total} accounts imported. ${result.failed} failed.`)
	return lines
}

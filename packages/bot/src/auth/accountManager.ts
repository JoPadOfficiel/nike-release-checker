import { writeFile, mkdir, chmod, readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { loadAccountsFile } from '../config/accountConfig.ts'
import { maskEmail, maskProxy } from '../logger/credentialMasker.ts'
import { testProxyConnectivity } from './proxyTester.ts'
import type { AccountConfig } from '../config/accountSchema.ts'
import type { ImportResult } from './auth.types.ts'

const DATA_DIR = '.bot-data'
const ACCOUNTS_FILE = `${DATA_DIR}/accounts.json`

export async function importAccounts(filePath: string): Promise<ImportResult> {
	// Step 1: Load and validate the source file (per-entry, non-throwing)
	const { valid, errors: validationErrors } = await loadAccountsFile(filePath)

	const importErrors: ImportResult['errors'] = validationErrors.map((e) => ({
		accountId: `index:${e.index}`,
		reason: `${e.field}: ${e.message}`,
	}))

	// Step 2: Load existing accounts (dedup by id)
	const existing = await loadStoredAccounts()
	const existingIds = new Set(existing.map((a) => a.id))

	// Step 3: For valid accounts, test proxy connectivity
	const toImport: AccountConfig[] = []

	for (const account of valid) {
		if (existingIds.has(account.id)) {
			importErrors.push({ accountId: account.id, reason: 'duplicate id — skipped' })
			continue
		}
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
	let imported = 0
	let failed = 0

	for (const settled of proxyResults) {
		if (settled.status === 'rejected') {
			failed++
			importErrors.push({ accountId: 'unknown', reason: String(settled.reason) })
			continue
		}

		const { account, result } = settled.value

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

	// Step 4: Persist with permissions 600
	await mkdir(DATA_DIR, { recursive: true })
	await writeFile(ACCOUNTS_FILE, JSON.stringify(merged, null, 2), 'utf8')
	await chmod(ACCOUNTS_FILE, 0o600)

	return { imported, failed, errors: importErrors }
}

export async function loadStoredAccounts(): Promise<(AccountConfig & { importedAt: string })[]> {
	try {
		await access(ACCOUNTS_FILE, constants.F_OK)
	} catch {
		return []
	}
	const raw = await readFile(ACCOUNTS_FILE, 'utf8')
	return JSON.parse(raw) as (AccountConfig & { importedAt: string })[]
}

export function formatImportSummary(
	result: ImportResult,
	accounts: Array<{ id: string; email: string; proxy: string }>,
): string[] {
	const lines: string[] = []

	for (const account of accounts) {
		const failed = result.errors.find((e) => e.accountId === account.id)
		const masked = maskEmail(account.email)
		const maskedProxy = maskProxy(account.proxy)
		if (failed) {
			lines.push(`  ✗ ${masked} (proxy: ${maskedProxy}) — ${failed.reason}`)
		} else {
			lines.push(`  ✓ ${masked} (proxy: ${maskedProxy}) — imported`)
		}
	}

	const total = result.imported + result.failed
	lines.push(`\n${result.imported}/${total} accounts imported. ${result.failed} failed.`)
	return lines
}

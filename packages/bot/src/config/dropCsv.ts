import { readCsvRows, type CsvIssue } from './csvRead.ts'

export type AccountsFilter =
	| { kind: 'all' }
	| { kind: 'explicit'; ids: string[] }

export type DropRow = {
	sku: string
	sizes: string[]
	accounts_filter: AccountsFilter
}

export type DropParseResult = {
	drops: DropRow[]
	errors: CsvIssue[]
	warnings: CsvIssue[]
}

const SKU_RE = /^[A-Z0-9]{2,6}-?\d{3,4}$/ // tolerant — Nike formats vary

export async function parseDropCsv(
	filePath: string,
	knownAccountIds: Set<string>,
): Promise<DropParseResult> {
	const { rows, parseErrors } = await readCsvRows(filePath)
	const drops: DropRow[] = []
	const errors: CsvIssue[] = [...parseErrors]
	const warnings: CsvIssue[] = []
	const seenSkus = new Set<string>()

	rows.forEach((raw, idx) => {
		const rowNum = idx + 2
		const sku = (raw.sku ?? '').trim().toUpperCase()
		const sizesRaw = raw.sizes ?? ''
		const sizes = sizesRaw.split(';').map((s) => s.trim()).filter(Boolean)
		const filterRaw = (raw.accounts_filter ?? '').trim()

		if (!sku) {
			errors.push({
				row: rowNum,
				column: 'sku',
				value: sku,
				message: 'sku required',
			})
			return
		}
		if (!SKU_RE.test(sku)) {
			warnings.push({
				row: rowNum,
				column: 'sku',
				value: sku,
				message: 'non-standard SKU format (expected AH7389-106 style)',
			})
		}
		if (sizes.length === 0) {
			errors.push({
				row: rowNum,
				column: 'sizes',
				value: sizesRaw,
				message: 'at least one size required (use ";" separator)',
			})
			return
		}

		let accounts_filter: AccountsFilter
		if (filterRaw === 'all' || filterRaw === '') {
			accounts_filter = { kind: 'all' }
		} else {
			const ids = filterRaw.split(';').map((s) => s.trim()).filter(Boolean)
			const unknown = ids.filter((id) => !knownAccountIds.has(id))
			if (unknown.length > 0) {
				errors.push({
					row: rowNum,
					column: 'accounts_filter',
					value: unknown.join(','),
					message: `unknown account_ids: ${unknown.join(', ')}`,
				})
				return
			}
			accounts_filter = { kind: 'explicit', ids }
		}

		if (seenSkus.has(sku)) {
			warnings.push({
				row: rowNum,
				column: 'sku',
				value: sku,
				message: 'duplicate SKU — multiple drop rows for same SKU (intentional?)',
			})
		}
		seenSkus.add(sku)
		drops.push({ sku, sizes, accounts_filter })
	})

	return { drops, errors, warnings }
}

// Runtime resolution — called at drop time, not parse time
export function resolveAccountsFilter(
	filter: AccountsFilter,
	allAccountIds: string[],
	validSessionIds: Set<string>,
): string[] {
	if (filter.kind === 'all') {
		return allAccountIds.filter((id) => validSessionIds.has(id))
	}
	return filter.ids.filter((id) => validSessionIds.has(id))
}

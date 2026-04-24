import * as v from 'valibot'
import { readCsvRows, type CsvIssue } from './csvRead.ts'

// Treat empty/missing CSV cells as "not provided" so `v.optional` can apply.
const OptionalCsvString = v.pipe(
	v.unknown(),
	v.transform((val) => {
		if (val === undefined || val === null) return undefined
		const s = String(val).trim()
		return s === '' ? undefined : s
	}),
)

export const AddressRowSchema = v.object({
	account_id: v.pipe(v.string(), v.minLength(1, 'account_id required')),
	street: v.pipe(v.string(), v.minLength(1, 'street required')),
	city: v.pipe(v.string(), v.minLength(1, 'city required')),
	zip: v.pipe(v.string(), v.minLength(1, 'zip required')),
	country: v.pipe(v.string(), v.length(2, 'country must be a 2-letter ISO code')),
	phone: v.optional(
		v.pipe(OptionalCsvString, v.union([v.undefined(), v.string()])),
	),
})

export type AddressRow = v.InferOutput<typeof AddressRowSchema>

export type AddressParseResult = {
	byAccountId: Map<string, AddressRow>
	errors: CsvIssue[]
	warnings: CsvIssue[]
}

export async function parseAddressesCsv(
	filePath: string,
	knownAccountIds: Set<string>,
	accountCountries: Map<string, string>,
): Promise<AddressParseResult> {
	const { rows, parseErrors } = await readCsvRows(filePath)
	const byAccountId = new Map<string, AddressRow>()
	const errors: CsvIssue[] = [...parseErrors]
	const warnings: CsvIssue[] = []

	rows.forEach((row, idx) => {
		const rowNum = idx + 2 // header is row 1
		const result = v.safeParse(AddressRowSchema, row)
		if (!result.success) {
			for (const issue of result.issues) {
				const column = String(issue.path?.[0]?.key ?? 'unknown')
				const rawValue = String(row[column] ?? '')
				errors.push({
					row: rowNum,
					column,
					value: rawValue,
					message: issue.message,
				})
			}
			return
		}
		const addr = result.output
		if (!knownAccountIds.has(addr.account_id)) {
			warnings.push({
				row: rowNum,
				column: 'account_id',
				value: addr.account_id,
				message: 'orphan — no such account in accounts.csv',
			})
			return
		}
		const accCountry = accountCountries.get(addr.account_id)
		if (accCountry && accCountry !== addr.country) {
			warnings.push({
				row: rowNum,
				column: 'country',
				value: addr.country,
				message: `country mismatch (account is ${accCountry}, address is ${addr.country})`,
			})
		}
		byAccountId.set(addr.account_id, addr)
	})

	// Accounts missing an address row
	for (const id of knownAccountIds) {
		if (!byAccountId.has(id)) {
			warnings.push({
				row: 0,
				column: 'account_id',
				value: id,
				message: 'account has no shipping address — Nike profile fallback required',
			})
		}
	}

	return { byAccountId, errors, warnings }
}

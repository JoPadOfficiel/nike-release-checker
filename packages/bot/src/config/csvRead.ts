import Papa from 'papaparse'
import { readFile } from 'node:fs/promises'

export type CsvIssue = {
	row: number
	column: string
	value: string
	message: string
	suggestion?: string
}

export type CsvRow = Record<string, string>

export type CsvReadResult = {
	rows: CsvRow[]
	parseErrors: CsvIssue[]
}

/**
 * Shared CSV reader used by all bot config parsers (accounts, addresses, drop, cards).
 *
 * Tolerances (per epic-10 spec):
 * - Strips UTF-8 BOM (Excel exports prepend 0xFEFF)
 * - Skips lines starting with `#` (comments)
 * - Lowercases + trims headers via `transformHeader`
 * - Trims every cell value via `transform`
 * - `skipEmptyLines: 'greedy'` collapses trailing/extra blank lines
 */
export async function readCsvRows(filePath: string): Promise<CsvReadResult> {
	let raw = await readFile(filePath, 'utf8')
	if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)

	// Strip comment lines (lines whose first non-whitespace char is `#`).
	// Done before papaparse so row numbering maps to the user-visible data rows.
	const filtered = raw
		.split(/\r?\n/)
		.filter((line) => !/^\s*#/.test(line))
		.join('\n')

	const parsed = Papa.parse<CsvRow>(filtered, {
		header: true,
		skipEmptyLines: 'greedy',
		transformHeader: (h) => h.trim().toLowerCase(),
		transform: (val) => (typeof val === 'string' ? val.trim() : val),
	})

	const parseErrors: CsvIssue[] = parsed.errors.map((e) => ({
		row: (e.row ?? 0) + 2,
		column: '_parse',
		value: '',
		message: e.message,
	}))

	return { rows: parsed.data, parseErrors }
}

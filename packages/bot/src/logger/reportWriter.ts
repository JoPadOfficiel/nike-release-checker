import { writeFile, rename, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'

export type ReportStatus =
	| 'COP'
	| 'SOLD_OUT'
	| 'BLOCKED'
	| 'THREEDS_TIMEOUT'
	| 'ERROR'
	| 'NO_SESSION'

export type ReportRow = {
	account_id: string
	status: ReportStatus
	sku: string
	size?: string
	order_number?: string
	timestamp: string
	error_reason?: string
	duration_ms: number
	retry_attempt?: number
}

const HEADER = [
	'account_id',
	'status',
	'sku',
	'size',
	'order_number',
	'timestamp',
	'error_reason',
	'duration_ms',
	'retry_attempt',
] as const

function escapeCsvCell(v: string | number | undefined): string {
	if (v === undefined || v === null) return ''
	const s = String(v)
	if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
	return s
}

function maskCredentials(s: string | undefined): string {
	if (!s) return ''
	return s
		.replace(/([a-zA-Z0-9+/_-]+):([^@\s]+)@/g, '***:***@')
		.replace(/\b\d{13,19}\b/g, '****')
}

async function exists(p: string): Promise<boolean> {
	try {
		await access(p)
		return true
	} catch {
		return false
	}
}

export async function writeReport(
	rows: ReportRow[],
	folder = './reports',
): Promise<string> {
	await mkdir(folder, { recursive: true, mode: 0o755 })
	const ts = new Date()
	const yyyy = ts.getFullYear()
	const mm = String(ts.getMonth() + 1).padStart(2, '0')
	const dd = String(ts.getDate()).padStart(2, '0')
	const hh = String(ts.getHours()).padStart(2, '0')
	const mi = String(ts.getMinutes()).padStart(2, '0')
	const ss = String(ts.getSeconds()).padStart(2, '0')
	const base = `report-${yyyy}-${mm}-${dd}-${hh}${mi}${ss}`
	let file = join(folder, base + '.csv')
	let suffix = 1
	while (await exists(file)) {
		file = join(folder, `${base}-${suffix}.csv`)
		suffix++
	}
	const tmp = file + '.tmp'

	const lines: string[] = [HEADER.join(',')]
	for (const row of rows) {
		lines.push(
			[
				escapeCsvCell(row.account_id),
				escapeCsvCell(row.status),
				escapeCsvCell(row.sku),
				escapeCsvCell(row.size),
				escapeCsvCell(row.order_number),
				escapeCsvCell(row.timestamp),
				escapeCsvCell(maskCredentials(row.error_reason)),
				escapeCsvCell(row.duration_ms),
				escapeCsvCell(row.retry_attempt),
			].join(','),
		)
	}
	await writeFile(tmp, lines.join('\n') + '\n', 'utf8')
	await rename(tmp, file)
	return file
}

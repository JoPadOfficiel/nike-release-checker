/** @jsxImportSource react */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { SummaryScreen, type CheckoutResult } from './SummaryScreen.tsx'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeResults(copCount: number, soldOutCount: number): CheckoutResult[] {
	const results: CheckoutResult[] = []
	for (let i = 0; i < copCount; i++) {
		results.push({
			accountId: `cop_${i}`,
			status: 'COP',
			sku: 'AH7389-106',
			size: '42',
			orderNumber: `OR-${i}`,
			durationMs: 1000 + i,
		})
	}
	for (let i = 0; i < soldOutCount; i++) {
		results.push({
			accountId: `so_${i}`,
			status: 'SOLD_OUT',
			sku: 'AH7389-106',
			size: '42',
			durationMs: 500 + i,
		})
	}
	return results
}

test('renders headline "2 cops out of 10" for 2 COP + 8 SOLD_OUT', async () => {
	const results = makeResults(2, 8)
	const cwd = process.cwd()
	const tmp = await mkdtemp(join(tmpdir(), 'summary-render-'))
	process.chdir(tmp)
	try {
		const ui = render(<SummaryScreen results={results} onRetry={() => {}} />)
		await sleep(30)
		const out = ui.lastFrame() ?? ''
		assert.match(out, /2 cops out of 10/)
		assert.match(out, /COP/)
		assert.match(out, /SOLD_OUT/)
		ui.unmount()
	} finally {
		process.chdir(cwd)
		await rm(tmp, { recursive: true, force: true })
	}
})

test('writeReport is invoked in useEffect and creates a CSV file', async () => {
	const results = makeResults(1, 2)
	const cwd = process.cwd()
	const tmp = await mkdtemp(join(tmpdir(), 'summary-write-'))
	process.chdir(tmp)
	try {
		const ui = render(<SummaryScreen results={results} onRetry={() => {}} />)
		// Poll for the report directory and a .csv file to appear.
		let files: string[] = []
		for (let i = 0; i < 50; i++) {
			await sleep(20)
			try {
				files = await readdir(join(tmp, 'reports'))
				if (files.some((f) => f.endsWith('.csv'))) break
			} catch {
				// folder not created yet
			}
		}
		assert.ok(
			files.some((f) => f.endsWith('.csv')),
			`expected a .csv report in ${tmp}/reports, got ${JSON.stringify(files)}`,
		)
		ui.unmount()
	} finally {
		process.chdir(cwd)
		await rm(tmp, { recursive: true, force: true })
	}
})

test("pressing 'r' fires onRetry with the failed subset", async () => {
	const results = makeResults(2, 8)
	const cwd = process.cwd()
	const tmp = await mkdtemp(join(tmpdir(), 'summary-retry-'))
	process.chdir(tmp)
	try {
		let retried: CheckoutResult[] | undefined
		const ui = render(
			<SummaryScreen
				results={results}
				onRetry={(failed) => {
					retried = failed
				}}
			/>,
		)
		await sleep(30)
		ui.stdin.write('r')
		await sleep(30)
		assert.ok(retried, 'expected onRetry to have been called')
		assert.equal(retried.length, 8)
		assert.ok(retried.every((r) => r.status !== 'COP'))
		ui.unmount()
	} finally {
		process.chdir(cwd)
		await rm(tmp, { recursive: true, force: true })
	}
})

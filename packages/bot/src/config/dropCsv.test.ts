import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDropCsv, resolveAccountsFilter } from './dropCsv.ts'

async function withTempCsv(content: string, fn: (path: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), 'nike-bot-test-'))
	const file = join(dir, 'drop.csv')
	await writeFile(file, content, 'utf8')
	try {
		await fn(file)
	} finally {
		await rm(dir, { recursive: true })
	}
}

test("accounts_filter='all' parsed as kind:'all'", async () => {
	await withTempCsv(
		'sku,sizes,accounts_filter\nAH7389-106,42;42.5,all',
		async (f) => {
			const r = await parseDropCsv(f, new Set(['kev_001']))
			assert.equal(r.errors.length, 0)
			assert.equal(r.drops.length, 1)
			assert.deepEqual(r.drops[0].accounts_filter, { kind: 'all' })
		},
	)
})

test('explicit filter with known ids parsed as kind:explicit', async () => {
	await withTempCsv(
		'sku,sizes,accounts_filter\nAH7389-106,42;42.5,kev_001;kev_002',
		async (f) => {
			const r = await parseDropCsv(f, new Set(['kev_001', 'kev_002']))
			assert.equal(r.errors.length, 0)
			assert.equal(r.drops.length, 1)
			assert.deepEqual(r.drops[0].accounts_filter, {
				kind: 'explicit',
				ids: ['kev_001', 'kev_002'],
			})
		},
	)
})

test('unknown id in explicit filter → error, drop excluded', async () => {
	await withTempCsv(
		'sku,sizes,accounts_filter\nAH7389-106,42,kev_001;ghost_999',
		async (f) => {
			const r = await parseDropCsv(f, new Set(['kev_001']))
			assert.equal(r.drops.length, 0)
			assert.equal(r.errors.length, 1)
			assert.equal(r.errors[0].column, 'accounts_filter')
			assert.match(r.errors[0].message, /unknown account_ids.*ghost_999/)
		},
	)
})

test('duplicate SKU → warning but both kept', async () => {
	await withTempCsv(
		'sku,sizes,accounts_filter\n' +
			'AH7389-106,42,all\n' +
			'AH7389-106,43,all',
		async (f) => {
			const r = await parseDropCsv(f, new Set())
			assert.equal(r.drops.length, 2)
			assert.equal(r.errors.length, 0)
			assert.equal(r.warnings.length, 1)
			assert.match(r.warnings[0].message, /duplicate SKU/)
		},
	)
})

test('empty filter string defaults to all', async () => {
	await withTempCsv(
		'sku,sizes,accounts_filter\nAH7389-106,42,',
		async (f) => {
			const r = await parseDropCsv(f, new Set())
			assert.equal(r.errors.length, 0)
			assert.equal(r.drops.length, 1)
			assert.deepEqual(r.drops[0].accounts_filter, { kind: 'all' })
		},
	)
})

test("resolveAccountsFilter with kind:'all' returns only validSessionIds", () => {
	const filter = { kind: 'all' as const }
	const all = ['kev_001', 'kev_002', 'kev_003']
	const valid = new Set(['kev_001', 'kev_003'])
	assert.deepEqual(resolveAccountsFilter(filter, all, valid), ['kev_001', 'kev_003'])
})

test('resolveAccountsFilter with explicit kind filters by validSessionIds', () => {
	const filter = {
		kind: 'explicit' as const,
		ids: ['kev_001', 'kev_002', 'kev_003'],
	}
	const all = ['kev_001', 'kev_002', 'kev_003', 'kev_004']
	const valid = new Set(['kev_001', 'kev_003'])
	assert.deepEqual(resolveAccountsFilter(filter, all, valid), ['kev_001', 'kev_003'])
})

test('non-standard SKU warns but keeps row', async () => {
	await withTempCsv(
		'sku,sizes,accounts_filter\nWEIRDSKU!,42,all',
		async (f) => {
			const r = await parseDropCsv(f, new Set())
			assert.equal(r.errors.length, 0)
			assert.equal(r.drops.length, 1)
			assert.equal(r.warnings.length, 1)
			assert.match(r.warnings[0].message, /non-standard SKU/)
		},
	)
})

test('missing sizes → error, drop excluded', async () => {
	await withTempCsv(
		'sku,sizes,accounts_filter\nAH7389-106,,all',
		async (f) => {
			const r = await parseDropCsv(f, new Set())
			assert.equal(r.drops.length, 0)
			assert.equal(r.errors.length, 1)
			assert.equal(r.errors[0].column, 'sizes')
		},
	)
})

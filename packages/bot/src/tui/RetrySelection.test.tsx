/** @jsxImportSource react */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from 'ink-testing-library'
import { RetrySelection } from './RetrySelection.tsx'
import type { CheckoutResult } from './SummaryScreen.tsx'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeFailed(): CheckoutResult[] {
	return [
		{ accountId: 'acct_1', status: 'BLOCKED', sku: 'X', durationMs: 10 },
		{ accountId: 'acct_2', status: 'ERROR', sku: 'X', durationMs: 10 },
		{ accountId: 'acct_3', status: 'BLOCKED', sku: 'X', durationMs: 10 },
		{ accountId: 'acct_4', status: 'THREEDS_TIMEOUT', sku: 'X', durationMs: 10 },
		{ accountId: 'acct_5', status: 'BLOCKED', sku: 'X', durationMs: 10 },
	]
}

test("pressing 'b' selects all BLOCKED then Enter confirms with that subset", async () => {
	const failed = makeFailed()
	let confirmed: CheckoutResult[] | undefined
	let cancelled = false
	const ui = render(
		<RetrySelection
			failed={failed}
			onConfirm={(sel) => {
				confirmed = sel
			}}
			onCancel={() => {
				cancelled = true
			}}
		/>,
	)
	await sleep(20)
	ui.stdin.write('b')
	await sleep(20)
	ui.stdin.write('\r') // Enter
	await sleep(20)
	assert.ok(confirmed, 'expected onConfirm to be called')
	assert.equal(cancelled, false)
	const ids = confirmed.map((r) => r.accountId).sort()
	assert.deepEqual(ids, ['acct_1', 'acct_3', 'acct_5'])
	assert.ok(confirmed.every((r) => r.status === 'BLOCKED'))
	ui.unmount()
})

test('Enter with empty selection is a no-op (onConfirm not called)', async () => {
	const failed = makeFailed()
	let confirmedCalls = 0
	let cancelled = false
	const ui = render(
		<RetrySelection
			failed={failed}
			onConfirm={() => {
				confirmedCalls++
			}}
			onCancel={() => {
				cancelled = true
			}}
		/>,
	)
	await sleep(20)
	ui.stdin.write('\r') // Enter with nothing selected
	await sleep(20)
	assert.equal(confirmedCalls, 0, 'onConfirm must not fire with empty selection')
	assert.equal(cancelled, false)
	ui.unmount()
})

test('Esc triggers onCancel', async () => {
	const failed = makeFailed()
	let confirmedCalls = 0
	let cancelled = false
	const ui = render(
		<RetrySelection
			failed={failed}
			onConfirm={() => {
				confirmedCalls++
			}}
			onCancel={() => {
				cancelled = true
			}}
		/>,
	)
	await sleep(20)
	ui.stdin.write('') // Esc
	await sleep(20)
	assert.equal(cancelled, true, 'onCancel must fire on Esc')
	assert.equal(confirmedCalls, 0)
	ui.unmount()
})

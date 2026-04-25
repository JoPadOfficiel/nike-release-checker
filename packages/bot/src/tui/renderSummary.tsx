/** @jsxImportSource react */
import React from 'react'
import { render } from 'ink'
import { SummaryScreen } from './SummaryScreen.tsx'
import type { CheckoutResult } from './SummaryScreen.tsx'
import { writeReport } from '../logger/reportWriter.ts'

function toReportRow(r: CheckoutResult) {
	return {
		account_id: r.accountId,
		status: r.status,
		sku: r.sku,
		size: r.size,
		order_number: r.orderNumber,
		timestamp: new Date().toISOString(),
		error_reason: r.errorReason,
		duration_ms: r.durationMs,
	}
}

export interface RenderSummaryOptions {
	retryHandler: (failed: CheckoutResult[]) => void
}

/**
 * Auto-save the report CSV, then mount SummaryScreen and await exit.
 *
 * The report is written BEFORE the screen renders so that [O] opens a folder
 * that actually contains the file. If the write fails we still render the
 * screen with a fallback path so the user can exit cleanly (NFR24).
 */
export async function renderSummary(
	results: CheckoutResult[],
	startedAt: Date,
	opts: RenderSummaryOptions,
): Promise<void> {
	const endedAt = new Date()

	let reportPath: string
	try {
		reportPath = await writeReport(results.map(toReportRow), './reports')
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		process.stderr.write(`[summary] writeReport failed: ${msg}\n`)
		reportPath = '(save failed — see logs)'
	}

	const { waitUntilExit } = render(
		React.createElement(SummaryScreen, {
			results,
			startedAt,
			endedAt,
			reportPath,
			onRetry: opts.retryHandler,
			onQuit: () => process.exit(0),
		}),
	)
	await waitUntilExit()
}

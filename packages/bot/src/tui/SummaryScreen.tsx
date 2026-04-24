/** @jsxImportSource react */
import React, { useEffect, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { dirname } from 'node:path'
import { writeReport, type ReportRow, type ReportStatus } from '../logger/reportWriter.ts'

/**
 * Local adapter type used by the summary screen. The checkout pipeline's
 * native result is `CheckoutPipelineResult` (see parallelCheckout.ts); callers
 * of this component are expected to adapt their results into this flat shape.
 * We intentionally avoid coupling the screen to the pipeline's internals.
 */
export interface CheckoutResult {
	accountId: string
	status: ReportStatus
	sku: string
	size?: string
	orderNumber?: string
	errorReason?: string
	durationMs: number
}

function toReportRow(r: CheckoutResult): ReportRow {
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

function groupBy<T, K extends string>(xs: T[], f: (x: T) => K): Record<K, T[]> {
	return xs.reduce((acc, x) => {
		const k = f(x)
		;(acc as Record<K, T[]>)[k] ??= []
		;(acc as Record<K, T[]>)[k].push(x)
		return acc
	}, {} as Record<K, T[]>)
}

function openReportFolder(path: string): void {
	const dir = dirname(path)
	const cmd =
		platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'explorer' : 'xdg-open'
	spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref()
}

export interface SummaryScreenProps {
	results: CheckoutResult[]
	onRetry: (failed: CheckoutResult[]) => void
}

export const SummaryScreen: React.FC<SummaryScreenProps> = ({ results, onRetry }) => {
	const { exit } = useApp()
	const [reportPath, setReportPath] = useState<string>()
	const [writeError, setWriteError] = useState<string>()

	useEffect(() => {
		// NFR24: if writeReport rejects, we still want the user to be able
		// to press [Q] and exit cleanly. We surface the error in the UI and
		// log to stderr so operators can diagnose, but never crash the screen.
		writeReport(results.map(toReportRow), './reports')
			.then((p) => setReportPath(p))
			.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err)
				process.stderr.write(`[summary] writeReport failed: ${msg}\n`)
				setWriteError(msg)
			})
	}, [])

	const byStatus = groupBy(results, (r) => r.status)
	const cops = byStatus.COP?.length ?? 0
	const failed = results.filter((r) => r.status !== 'COP')

	useInput((input) => {
		const key = input.toLowerCase()
		if (key === 'r' && failed.length > 0) onRetry(failed)
		else if (key === 'o' && reportPath) openReportFolder(reportPath)
		else if (key === 'q') exit()
	})

	const STATUSES: readonly ReportStatus[] = [
		'COP',
		'SOLD_OUT',
		'BLOCKED',
		'THREEDS_TIMEOUT',
		'ERROR',
		'NO_SESSION',
	]

	return (
		<Box flexDirection='column' padding={1}>
			<Text bold>
				Drop complete — {cops} cops out of {results.length} accounts
			</Text>
			<Box marginY={1} flexDirection='column'>
				{STATUSES.map((s) => {
					const n = byStatus[s]?.length ?? 0
					if (n === 0) return null
					return (
						<Box key={s}>
							<Text color={s === 'COP' ? 'green' : 'red'}>{s.padEnd(16)}</Text>
							<Text>{n}</Text>
						</Box>
					)
				})}
			</Box>
			{reportPath && <Text dimColor>Report saved: {reportPath}</Text>}
			{writeError && <Text color='red'>Report save failed: {writeError}</Text>}
			<Box marginTop={1}>
				<Text>[R] Retry failed </Text>
				<Text>[O] Open report folder </Text>
				<Text>[Q] Quit</Text>
			</Box>
		</Box>
	)
}

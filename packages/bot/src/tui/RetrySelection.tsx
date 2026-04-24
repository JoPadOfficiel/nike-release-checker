/** @jsxImportSource react */
import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { CheckoutResult } from './SummaryScreen.tsx'
import type { ReportStatus } from '../logger/reportWriter.ts'

export interface RetrySelectionProps {
	failed: CheckoutResult[]
	onConfirm: (selected: CheckoutResult[]) => void
	onCancel: () => void
}

/**
 * Interactive picker for choosing which failed accounts to retry.
 *
 * Keybindings:
 *  - Up/Down (or k/j):  move cursor
 *  - Space:             toggle selection under the cursor
 *  - T:                 select all THREEDS_TIMEOUT
 *  - B:                 select all BLOCKED
 *  - E:                 select all ERROR
 *  - Enter:             confirm (no-op if nothing selected)
 *  - Esc:               cancel
 */
export const RetrySelection: React.FC<RetrySelectionProps> = ({
	failed,
	onConfirm,
	onCancel,
}) => {
	const [cursor, setCursor] = useState(0)
	const [selected, setSelected] = useState<Set<string>>(new Set())

	const maxIdLen = useMemo(
		() => failed.reduce((m, r) => Math.max(m, r.accountId.length), 0),
		[failed],
	)

	const bulkSelectByStatus = (status: ReportStatus): void => {
		setSelected((prev) => {
			const next = new Set(prev)
			for (const r of failed) {
				if (r.status === status) next.add(r.accountId)
			}
			return next
		})
	}

	useInput((input, key) => {
		if (key.escape) {
			onCancel()
			return
		}
		if (key.return) {
			if (selected.size === 0) return
			const picked = failed.filter((r) => selected.has(r.accountId))
			onConfirm(picked)
			return
		}
		if (key.upArrow || input === 'k') {
			setCursor((c) => Math.max(0, c - 1))
			return
		}
		if (key.downArrow || input === 'j') {
			setCursor((c) => Math.min(failed.length - 1, c + 1))
			return
		}
		if (input === ' ') {
			const row = failed[cursor]
			if (!row) return
			setSelected((prev) => {
				const next = new Set(prev)
				if (next.has(row.accountId)) next.delete(row.accountId)
				else next.add(row.accountId)
				return next
			})
			return
		}
		const lower = input.toLowerCase()
		if (lower === 't') bulkSelectByStatus('THREEDS_TIMEOUT')
		else if (lower === 'b') bulkSelectByStatus('BLOCKED')
		else if (lower === 'e') bulkSelectByStatus('ERROR')
	})

	return (
		<Box flexDirection='column' padding={1}>
			<Text bold>Select accounts to retry ({selected.size}/{failed.length})</Text>
			<Box marginY={1} flexDirection='column'>
				{failed.map((r, i) => {
					const isCursor = i === cursor
					const isChecked = selected.has(r.accountId)
					return (
						<Box key={r.accountId}>
							<Text>{isCursor ? '>' : ' '} </Text>
							<Text>{isChecked ? '[x]' : '[ ]'} </Text>
							<Text>{r.accountId.padEnd(maxIdLen)} </Text>
							<Text color='red'>{r.status}</Text>
						</Box>
					)
				})}
			</Box>
			<Text dimColor>
				Space toggle · [T] 3DS · [B] blocked · [E] error · Enter confirm · Esc cancel
			</Text>
		</Box>
	)
}

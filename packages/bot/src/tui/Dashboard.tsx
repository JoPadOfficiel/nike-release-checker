/** @jsxImportSource react */
import { useEffect, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { AccountRow } from './AccountRow.tsx'
import { globalBus, type AccountStatus } from './eventBus.ts'

export interface RowState {
	accountId: string
	status: AccountStatus
	startedAt: number
	lastUpdateAt: number
}

export interface DashboardProps {
	sku: string
	sizes: string[]
	accountIds: string[]
	onFinished: (summary: { cops: number; failures: number; rows: RowState[] }) => void
}

export const Dashboard = ({ sku, sizes, accountIds, onFinished }: DashboardProps) => {
	const { exit } = useApp()
	const [rows, setRows] = useState<RowState[]>(
		accountIds.map((id) => ({
			accountId: id,
			status: { kind: 'pending' },
			startedAt: Date.now(),
			lastUpdateAt: Date.now(),
		})),
	)
	const [now, setNow] = useState(Date.now())

	// Clock tick for elapsed updates (500ms → ≥ 2 FPS)
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 500)
		return () => clearInterval(t)
	}, [])

	// Event bus subscription
	useEffect(() => {
		const off = globalBus.on('accountStatusChanged', ({ accountId, status }) => {
			setRows((prev) =>
				prev.map((r) =>
					r.accountId === accountId
						? { ...r, status, lastUpdateAt: Date.now() }
						: r,
				),
			)
		})
		const off2 = globalBus.on('checkoutFinished', (sum) => {
			setRows((prev) => {
				onFinished({ cops: sum.cops, failures: sum.failures, rows: prev })
				return prev
			})
		})
		return () => {
			off()
			off2()
		}
	}, [onFinished])

	useInput((_, key) => {
		if (key.escape) exit()
	})

	const cops = rows.filter((r) => r.status.kind === 'cop').length
	const fails = rows.filter((r) => r.status.kind === 'fail').length
	const inProgress = rows.length - cops - fails

	return (
		<Box flexDirection='column'>
			<Box>
				<Text bold>Drop: </Text>
				<Text color='cyan'>{sku}</Text>
				<Text> — Sizes: </Text>
				<Text>{sizes.join(', ')}</Text>
				<Text> — Accounts: </Text>
				<Text>{rows.length}</Text>
			</Box>
			<Box flexDirection='column' marginY={1}>
				{rows.map((r) => (
					<AccountRow
						key={r.accountId}
						accountId={r.accountId}
						status={r.status}
						elapsedMs={now - r.startedAt}
					/>
				))}
			</Box>
			<Box>
				<Text>Cops: </Text>
				<Text color='green'>{cops}</Text>
				<Text>   Failed: </Text>
				<Text color='red'>{fails}</Text>
				<Text>   In progress: </Text>
				<Text color='yellow'>{inProgress}</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>Press ESC to abort new starts.</Text>
			</Box>
		</Box>
	)
}

/** @jsxImportSource react */
import { Box, Text } from 'ink'
import type { AccountStatus } from './eventBus.ts'

const TRUNC = 16

function trunc(s: string, n = TRUNC): string {
	return s.length <= n ? s.padEnd(n) : s.slice(0, n - 1) + '…'
}

function icon(status: AccountStatus): { glyph: string; color: string } {
	switch (status.kind) {
		case 'cop':
			return { glyph: '✓', color: 'green' }
		case 'waiting':
			return { glyph: '⏳', color: 'yellow' }
		case 'retrying':
			return { glyph: '🔄', color: 'cyan' }
		case 'fail':
			return { glyph: '✗', color: 'red' }
		case 'pending':
			return { glyph: '…', color: 'gray' }
	}
}

export interface AccountRowProps {
	accountId: string
	status: AccountStatus
	elapsedMs?: number
}

export const AccountRow = ({ accountId, status, elapsedMs }: AccountRowProps) => {
	const { glyph, color } = icon(status)
	const stepLabel =
		status.kind === 'waiting'
			? status.step
			: status.kind === 'retrying'
				? `${status.step} (attempt ${status.attempt})`
				: status.kind === 'cop'
					? `COP size ${status.size}`
					: status.kind === 'fail'
						? status.reason
						: 'pending'
	const detail =
		status.kind === 'cop' && status.orderNumber ? `order ${status.orderNumber}` : ''
	const elapsed = elapsedMs !== undefined ? `${(elapsedMs / 1000).toFixed(1)}s` : ''

	return (
		<Box>
			<Text>{trunc(accountId)}</Text>
			<Text color={color}> {glyph} </Text>
			<Text>{stepLabel.padEnd(20).slice(0, 20)}</Text>
			<Text dimColor> {elapsed.padStart(6)} </Text>
			<Text>{detail}</Text>
		</Box>
	)
}

/** @jsxImportSource react */
import { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openFilePicker } from './filePicker.ts'
import { generateTemplates } from './csvTemplates.ts'
import { parseAccountsCsv } from '../../config/accountsCsv.ts'

export interface CsvPaths {
	accounts: string
	cards: string
	addresses: string
	drop: string
}

type Slot = keyof CsvPaths

const SLOT_ORDER: Slot[] = ['accounts', 'cards', 'addresses', 'drop']

const SLOT_LABELS: Record<Slot, string> = {
	accounts: 'accounts.csv',
	cards: 'cards.csv',
	addresses: 'addresses.csv',
	drop: 'drop.csv',
}

export interface Step2Props {
	onDone: (paths: CsvPaths) => void
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p)
		return true
	} catch {
		return false
	}
}

export function Step2CsvPaths({ onDone }: Step2Props) {
	const [slotIdx, setSlotIdx] = useState(0)
	const [value, setValue] = useState('')
	const [paths, setPaths] = useState<Partial<CsvPaths>>({})
	const [error, setError] = useState<string | undefined>(undefined)
	const [info, setInfo] = useState<string | undefined>(undefined)
	const [busy, setBusy] = useState(false)

	const currentSlot = SLOT_ORDER[slotIdx]

	useInput((input) => {
		if (busy) return
		if (input === 'p') {
			void (async () => {
				setBusy(true)
				const picked = await openFilePicker()
				if (picked) setValue(picked)
				setBusy(false)
			})()
		} else if (input === 'g') {
			void (async () => {
				setBusy(true)
				try {
					const { created, skipped } = await generateTemplates(process.cwd())
					setInfo(`Templates created: ${created.join(', ') || 'none'}. Skipped: ${skipped.join(', ') || 'none'}.`)
				} catch (err) {
					setError(`Template generation failed: ${String(err)}`)
				} finally {
					setBusy(false)
				}
			})()
		}
	})

	const handleSubmit = async (raw: string) => {
		if (!currentSlot) return
		const trimmed = raw.trim()
		if (!trimmed) {
			setError('Path is required')
			return
		}
		const abs = resolve(trimmed)
		const exists = await pathExists(abs)
		if (!exists) {
			setError(`File not found: ${abs}`)
			return
		}

		// Validate accounts.csv now so we can surface structured errors immediately.
		if (currentSlot === 'accounts') {
			try {
				const { accounts, errors } = await parseAccountsCsv(abs)
				if (errors.length > 0) {
					const preview = errors
						.slice(0, 3)
						.map((e) => `row ${e.row} ${e.column}: ${e.message}`)
						.join('; ')
					setError(`accounts.csv has ${errors.length} error(s): ${preview}`)
					return
				}
				if (accounts.length === 0) {
					setError('accounts.csv contains no valid rows')
					return
				}
			} catch (err) {
				setError(`Failed to parse accounts.csv: ${String(err)}`)
				return
			}
		}

		const nextPaths = { ...paths, [currentSlot]: abs }
		setPaths(nextPaths)
		setError(undefined)
		setInfo(undefined)
		setValue('')

		const nextIdx = slotIdx + 1
		if (nextIdx >= SLOT_ORDER.length) {
			onDone(nextPaths as CsvPaths)
			return
		}
		setSlotIdx(nextIdx)
	}

	useEffect(() => {
		// Keep prompt clean whenever the slot advances.
		setValue('')
	}, [slotIdx])

	return (
		<Box flexDirection='column'>
			<Text>Step 2 of 5 — CSV file paths</Text>
			<Text color='gray'>Press 'p' to pick a file (macOS), 'g' to auto-generate templates in cwd.</Text>
			{SLOT_ORDER.map((slot, i) => {
				if (i < slotIdx) {
					return (
						<Text key={slot} color='green'>
							  {SLOT_LABELS[slot]}: {paths[slot]}
						</Text>
					)
				}
				if (i === slotIdx) {
					return (
						<Box key={slot}>
							<Text color='cyan'>{SLOT_LABELS[slot]}: </Text>
							<TextInput value={value} onChange={setValue} onSubmit={(v) => void handleSubmit(v)} />
						</Box>
					)
				}
				return (
					<Text key={slot} color='gray'>
					  {SLOT_LABELS[slot]}: (pending)
					</Text>
				)
			})}
			{info ? <Text color='yellow'>{info}</Text> : null}
			{error ? <Text color='red'>{error}</Text> : null}
		</Box>
	)
}

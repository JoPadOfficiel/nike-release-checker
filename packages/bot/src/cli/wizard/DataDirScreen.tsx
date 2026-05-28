/** @jsxImportSource react */
import { useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { dataDir, defaultDataDir, setDataDir } from '../../config/dataDir.ts'

export interface DataDirScreenProps {
	onDone: () => void
}

/**
 * Lets the user view and CHANGE the folder where the editable CSVs live
 * (accounts.csv, cards.csv, addresses.csv, drop.csv). Default is
 * <home>/Downloads/nikebot; the choice is persisted so run/dry-run/drop read
 * from the same place. Enter on an empty field keeps the current folder.
 */
export function DataDirScreen({ onDone }: DataDirScreenProps) {
	const { exit } = useApp()
	const current = dataDir()
	const [value, setValue] = useState('')
	const [saved, setSaved] = useState<string | undefined>(undefined)
	const [error, setError] = useState<string | undefined>(undefined)

	const finish = () => {
		onDone()
		exit()
	}

	useInput((_input, key) => {
		// Esc → back to menu without changing anything.
		if (key.escape) finish()
	})

	const handleSubmit = (raw: string) => {
		const next = raw.trim()
		if (next === '') {
			// Keep current folder.
			finish()
			return
		}
		try {
			const resolved = setDataDir(next)
			setSaved(resolved)
			setError(undefined)
			// Give the user a beat to see confirmation, then return to menu.
			setTimeout(finish, 900)
		} catch (e) {
			setError((e as Error).message)
		}
	}

	return (
		<Box flexDirection='column' padding={1}>
			<Text color='magenta' bold>
				Dossier de configuration (CSV)
			</Text>
			<Text>
				Actuel : <Text color='cyan'>{current}</Text>
			</Text>
			<Text color='gray'>Défaut : {defaultDataDir()}</Text>
			<Box marginTop={1} flexDirection='column'>
				<Text>Nouveau dossier (chemin absolu) — Entrée vide pour garder l'actuel :</Text>
				<Box>
					<Text color='cyan'>{'> '}</Text>
					<TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
				</Box>
			</Box>
			{saved ? <Text color='green'>✓ Enregistré : {saved}</Text> : null}
			{error ? <Text color='red'>{error}</Text> : null}
			<Box marginTop={1}>
				<Text color='gray'>Esc pour revenir au menu sans changer</Text>
			</Box>
		</Box>
	)
}

export async function runDataDirScreen(): Promise<void> {
	const { render } = await import('ink')
	await new Promise<void>((resolve) => {
		const ui = render(<DataDirScreen onDone={() => {}} />)
		ui.waitUntilExit().then(() => resolve())
	})
}

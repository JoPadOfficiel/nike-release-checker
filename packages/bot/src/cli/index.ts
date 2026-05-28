#!/usr/bin/env node
import { program } from './commands.ts'

function shouldSkipChromiumCheck(argv: readonly string[]): boolean {
	// Skip for --version / --help / install-browser / no-args, so those commands
	// never trigger a ~150MB download.
	const args = argv.slice(2)
	if (args.length === 0) return true
	for (const a of args) {
		if (a === '--version' || a === '-V' || a === '--help' || a === '-h' || a === 'help') return true
		if (a === 'install-browser') return true
	}
	return false
}

/**
 * Is the bot already set up? True when at least one account has been imported.
 * Used to decide between the first-run setup wizard and the home menu.
 */
async function isConfigured(): Promise<boolean> {
	try {
		const { loadStoredAccounts } = await import('../auth/accountManager.ts')
		const accounts = await loadStoredAccounts()
		return accounts.length > 0
	} catch {
		return false
	}
}

/** Count active (non-comment, non-empty) data rows in a CSV file. */
async function countCsvRows(path: string): Promise<number> {
	try {
		const { readFile } = await import('node:fs/promises')
		const raw = await readFile(path, 'utf8')
		const lines = raw.split('\n').map((l) => l.trim())
		// Drop blank lines, comments, and the header row.
		const data = lines.filter((l) => l.length > 0 && !l.startsWith('#'))
		return Math.max(0, data.length - 1)
	} catch {
		return 0
	}
}

/** First imported account id (used to target capture-session). */
async function firstAccountId(): Promise<string | undefined> {
	try {
		const { loadStoredAccounts } = await import('../auth/accountManager.ts')
		const accounts = await loadStoredAccounts()
		return accounts[0]?.id
	} catch {
		return undefined
	}
}

/** Show status inline, then wait for a keypress so the user can read it. */
async function showStatusInline(): Promise<void> {
	try {
		const { getBotStatus, printBotStatus } = await import('../daemon/botStatus.ts')
		const status = await getBotStatus()
		printBotStatus(status)
	} catch (err) {
		console.error('Status indisponible :', (err as Error).message)
	}
	await waitForKey('\nAppuie sur Entrée pour revenir au menu…')
}

/** Block until the user presses a key (Enter). Resolves immediately if no TTY. */
async function waitForKey(prompt: string): Promise<void> {
	if (!process.stdin.isTTY) return
	process.stdout.write(prompt + '\n')
	await new Promise<void>((resolve) => {
		const stdin = process.stdin
		const onData = () => {
			stdin.removeListener('data', onData)
			try { stdin.setRawMode?.(false) } catch {}
			stdin.pause()
			resolve()
		}
		try { stdin.setRawMode?.(true) } catch {}
		stdin.resume()
		stdin.once('data', onData)
	})
}

/**
 * Home loop for an already-configured install. Shows the menu, handles
 * read-only actions inline (status, change folder) and RETURNS to the menu,
 * and for operate-actions (run / dry-run / capture / reconfigure) resolves the
 * argv to dispatch. Returns [] to exit the app.
 *
 * This is what fixes "the app quits after one action / I can't go back".
 */
async function resolveHomeAction(): Promise<string[]> {
	const { runMainMenu } = await import('./wizard/MainMenu.tsx')
	const { dataFile } = await import('../config/dataDir.ts')

	for (;;) {
		const dropCount = await countCsvRows(dataFile('drop.csv'))
		const accountCount = await (async () => {
			try {
				const { loadStoredAccounts } = await import('../auth/accountManager.ts')
				return (await loadStoredAccounts()).length
			} catch {
				return 0
			}
		})()

		const choice = await runMainMenu({
			accountCount,
			dropCount,
			items: [
				{ label: 'Lancer les drops', value: 'run', hint: 'exécute drop.csv (dashboard live)' },
				{ label: 'Tester sans commander (dry-run)', value: 'run:dry', hint: 'même flux, sans payer' },
				{ label: 'État des comptes & sessions', value: 'status', hint: 'retour au menu ensuite' },
				{ label: 'Capturer / rafraîchir une session', value: 'capture', hint: 'connexion manuelle Nike' },
				{ label: 'Dossier de configuration (CSV)', value: 'folder', hint: 'changer où sont les CSV' },
				{ label: 'Reconfigurer (assistant)', value: 'init', hint: 'comptes, cartes, adresses' },
				{ label: 'Quitter', value: 'exit', hint: '' },
			],
		})

		switch (choice) {
			// Read-only / settings actions: handle inline, then LOOP back to the menu.
			case 'status':
				await showStatusInline()
				continue
			case 'folder': {
				const { runDataDirScreen } = await import('./wizard/DataDirScreen.tsx')
				await runDataDirScreen()
				continue
			}
			// Operate actions: dispatch the matching command and leave the loop.
			case 'run':
				return ['run']
			case 'run:dry':
				return ['run', '--dry-run']
			case 'capture': {
				const id = await firstAccountId()
				if (!id) {
					console.error('Aucun compte importé. Lance d’abord "Reconfigurer".')
					continue
				}
				return ['capture-session', '--account', id]
			}
			case 'init':
				return ['init']
			default:
				return []
		}
	}
}

async function main(): Promise<void> {
	// No args → decide between the home menu (already configured) and the
	// first-run setup wizard. End-users double-click the .app; they should land
	// on something they can OPERATE, not a wizard that completes and exits.
	if (process.argv.length <= 2) {
		if (await isConfigured()) {
			// The home menu needs a real terminal (raw-mode keyboard input). When
			// launched without a TTY (piped/CI), don't hang on an unusable menu —
			// print the available commands and exit.
			if (!process.stdin.isTTY) {
				console.log('Nike Bot — déjà configuré. Commandes disponibles :')
				console.log('  nike-bot run            # lancer les drops (drop.csv)')
				console.log('  nike-bot run --dry-run  # tester sans commander')
				console.log('  nike-bot status         # état comptes & sessions')
				console.log('  nike-bot capture-session --account <id>  # capturer/rafraîchir une session')
				console.log('  nike-bot init           # reconfigurer')
				return
			}
			const action = await resolveHomeAction()
			if (action.length === 0) {
				// User chose Quitter → exit cleanly.
				return
			}
			process.argv.push(...action)
		} else {
			process.argv.push('init')
		}
	}

	if (!shouldSkipChromiumCheck(process.argv)) {
		try {
			// Probe without importing the ink-based UI; firstRun.tsx pulls in
			// `ink`, which is external in the SEA bundle and would throw
			// "No such built-in module: ink" on every command otherwise.
			const { isChromiumInstalled } = await import('../installer/chromiumInstaller.ts')
			if (!isChromiumInstalled()) {
				const { ensureChromium } = await import('./firstRun.tsx')
				await ensureChromium()
			}
		} catch (err) {
			console.error('Chromium not available:', (err as Error).message)
		}
	}

	await program.parseAsync(process.argv)
}

main().catch((err: unknown) => {
	console.error(err)
	process.exit(1)
})

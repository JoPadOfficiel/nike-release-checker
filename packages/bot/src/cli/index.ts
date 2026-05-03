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

async function main(): Promise<void> {
	// No args → run the interactive wizard. End-users double-click the .app and
	// land directly in `init` instead of staring at help text.
	if (process.argv.length <= 2) {
		process.argv.push('init')
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

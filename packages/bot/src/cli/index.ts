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
	if (!shouldSkipChromiumCheck(process.argv)) {
		try {
			const { ensureChromium } = await import('./firstRun.tsx')
			await ensureChromium()
		} catch (err) {
			// If install fails, surface the error but don't block commands that may not need browsers
			console.error('Chromium not available:', (err as Error).message)
		}
	}

	await program.parseAsync(process.argv)
}

main().catch((err: unknown) => {
	console.error(err)
	process.exit(1)
})

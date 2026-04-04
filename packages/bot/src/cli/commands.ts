import { createRequire } from 'node:module'
import { Command } from 'commander'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

export const program = new Command()

program
	.name('nike-bot')
	.description('Nike SNKRS auto-checkout bot')
	.version(pkg.version)
	.option('--config <path>', 'Path to bot config file', './bot.config.yaml')

program
	.command('import-accounts')
	.description('Import Nike account configurations from a JSON file')
	.requiredOption('--file <path>', 'Path to the accounts JSON file')
	.action(async (opts: { file: string }) => {
		const { importAccounts, formatImportSummary } = await import('../auth/accountManager.ts')
		const { maskCredentials } = await import('../logger/credentialMasker.ts')
		try {
			const result = await importAccounts(opts.file)

			const lines = formatImportSummary(result, result.processedAccounts)
			for (const line of lines) console.log(line)

			const nonAccountErrors = result.errors.filter((e) => e.accountId.startsWith('index:'))
			if (nonAccountErrors.length > 0) {
				console.log('\nValidation errors:')
				for (const err of nonAccountErrors) {
					console.log(`  ${err.accountId}: ${err.reason}`)
				}
			}
		} catch (err) {
			console.error(`❌ Import failed: ${maskCredentials(String(err))}`)
			process.exit(1)
		}
	})

program
	.command('login-all')
	.description('Authenticate all accounts (or a single one with --account)')
	.option('--account <id>', 'Authenticate a single account by ID')
	.action(async (opts: { account?: string }) => {
		const { authenticateAll, authenticateSingle } = await import('../auth/accountManager.ts')
		const { maskCredentials } = await import('../logger/credentialMasker.ts')
		try {
			if (opts.account) {
				const result = await authenticateSingle(opts.account)
				const elapsed = `${(result.durationMs / 1000).toFixed(1)}s`
				if (result.success) {
					console.log(`  ✓ ${maskCredentials(result.accountId)} — done (${elapsed})`)
				} else {
					const msg = maskCredentials(result.error ?? 'unknown error')
					console.error(`  ✗ ${maskCredentials(result.accountId)} — failed (${msg})`)
					process.exit(1)
				}
			} else {
				const results = await authenticateAll()
				let succeeded = 0
				for (const r of results) {
					const label = maskCredentials(r.accountId)
					const elapsed = `${(r.durationMs / 1000).toFixed(1)}s`
					if (r.success) {
						succeeded++
						console.log(`  ✓ ${label} — done (${elapsed})`)
					} else {
						console.log(`  ✗ ${label} — failed (${maskCredentials(r.error ?? 'unknown error')})`)
					}
				}
				const total = results.length
				console.log(`\n${succeeded}/${total} accounts authenticated. ${total - succeeded} failed.`)
			}
		} catch (err) {
			console.error(`❌ Login failed: ${maskCredentials(String(err))}`)
			process.exit(1)
		}
	})

program
	.command('logout-all')
	.description('Delete sessions for all accounts (or a specific one with --account)')
	.option('--account <id>', 'Account ID to log out')
	.action(() => {
		console.log('Not yet implemented')
		process.exit(0)
	})

program
	.command('accounts')
	.description('List all accounts with their session status')
	.option('--verbose', 'Show additional details')
	.action(() => {
		console.log('Not yet implemented')
		process.exit(0)
	})

program
	.command('start')
	.description('Start monitoring and automatic checkout')
	.requiredOption('--slug <slug>', 'Nike product slug to monitor')
	.option('--sizes <sizes>', 'Target sizes comma-separated (e.g. 42,42.5,43)')
	.option('--auto-checkout', 'Automatically trigger checkout when stock is detected', false)
	.option('--daemon', 'Run as background daemon', false)
	.action(() => {
		console.log('Not yet implemented')
		process.exit(0)
	})

program
	.command('dry-run')
	.description('Test the full checkout flow without placing an order')
	.requiredOption('--slug <slug>', 'Nike product slug')
	.requiredOption('--profile <account_id>', 'Account ID to use for the dry run')
	.action(() => {
		console.log('Not yet implemented')
		process.exit(0)
	})

program
	.command('status')
	.description('Show daemon status and account session health')
	.option('--json', 'Output status as structured JSON')
	.action(() => {
		console.log('Not yet implemented')
		process.exit(0)
	})

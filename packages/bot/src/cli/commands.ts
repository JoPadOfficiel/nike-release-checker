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
					console.log(`Authenticating ${maskCredentials(result.accountId)}... done (${elapsed})`)
				} else if (result.error?.includes('not found in imported accounts')) {
					console.error(`Error: Account '${maskCredentials(result.accountId)}' not found.`)
					process.exit(1)
				} else {
					const msg = maskCredentials(result.error ?? 'unknown error')
					console.error(`Authenticating ${maskCredentials(result.accountId)}... failed (${msg})`)
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
	.action(async (opts: { account?: string }) => {
		const { clearAllSessions, clearSession } = await import('../auth/accountManager.ts')
		const { maskCredentials } = await import('../logger/credentialMasker.ts')
		try {
			if (opts.account) {
				await clearSession(opts.account)
				console.log(`Session cleared for ${maskCredentials(opts.account)}.`)
			} else {
				const { count } = await clearAllSessions()
				if (count === 0) {
					console.log('No sessions to clear.')
				} else {
					console.log(`All sessions cleared. ${count} session file${count === 1 ? '' : 's'} removed.`)
				}
			}
		} catch (err) {
			console.error(`❌ ${maskCredentials(String(err))}`)
			process.exit(1)
		}
	})

program
	.command('accounts')
	.description('List all accounts with their session status')
	.option('--verbose', 'Show additional details')
	.action(async (opts: { verbose?: boolean }) => {
		const { listAccounts } = await import('../auth/accountManager.ts')
		const { maskEmail, maskProxy } = await import('../logger/credentialMasker.ts')

		const rows = await listAccounts(opts.verbose ?? false)

		if (rows.length === 0) {
			console.log("No accounts found. Run 'nike-bot import-accounts' first.")
			return
		}

		const SESSION_LABEL: Record<string, string> = {
			valid: 'valid',
			expired: 'expired',
			missing: 'missing',
		}

		// Build display rows with masked values
		const displayRows = rows.map((r) => ({
			id: r.id,
			email: maskEmail(r.email),
			country: r.country,
			proxy: r.proxy ? maskProxy(r.proxy) : '(none)',
			session: SESSION_LABEL[r.session.status] ?? r.session.status,
			...(opts.verbose
				? {
						sizes: r.preferredSizes?.join(', ') ?? '',
						lastLogin: r.session.lastLogin?.toISOString().slice(0, 19).replace('T', ' ') ?? '—',
						domains: String(r.session.domainCount ?? '—'),
					}
				: {}),
		}))

		// Column headers
		const baseHeaders = ['ID', 'Email', 'Country', 'Proxy', 'Session']
		const verboseHeaders = opts.verbose ? ['Sizes', 'Last Login', 'Domains'] : []
		const headers = [...baseHeaders, ...verboseHeaders]
		const keys = opts.verbose
			? (['id', 'email', 'country', 'proxy', 'session', 'sizes', 'lastLogin', 'domains'] as const)
			: (['id', 'email', 'country', 'proxy', 'session'] as const)

		// Compute column widths
		const widths = headers.map((h, i) => {
			const key = keys[i]!
			// use reduce to avoid RangeError from spread on large account lists (P3)
			const maxVal = displayRows.reduce(
				(m, r) => Math.max(m, String((r as Record<string, string>)[key] ?? '').length),
				0,
			)
			return Math.max(h.length, maxVal)
		})

		const pad = (s: string, w: number): string => s.padEnd(w)
		const line = (cols: string[]): string => cols.map((c, i) => pad(c, widths[i]!)).join('  ')

		console.log(`\nNike Accounts — ${rows.length} account(s)\n`)
		console.log(line(headers))
		console.log(widths.map((w) => '-'.repeat(w)).join('  '))
		for (const r of displayRows) {
			console.log(line(keys.map((k) => String((r as Record<string, string>)[k] ?? ''))))
		}
		console.log()
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
	.option('--sizes <sizes>', 'Target sizes comma-separated (e.g. 42,42.5,43)')
	.option('--selectors <path>', 'Path to selectors YAML file', './selectors.yaml')
	.action(async (opts: { slug: string; profile: string; sizes?: string; selectors?: string }) => {
		const { maskCredentials } = await import('../logger/credentialMasker.ts')
		const { loadStoredAccounts } = await import('../auth/accountManager.ts')
		const { loadBotConfig } = await import('../config/botConfig.ts')
		const { loadSelectors } = await import('../config/selectors.ts')
		const { runCheckoutPipeline } = await import('../checkout/checkoutPipeline.ts')
		const configPath = program.opts<{ config: string }>().config
		try {
			const accounts = await loadStoredAccounts()
			const account = accounts.find((a) => a.id === opts.profile)
			if (!account) {
				console.error(`Error: Account '${opts.profile}' not found.`)
				process.exit(1)
			}
			const config = await loadBotConfig(configPath)
			const selectors = await loadSelectors(opts.selectors)
			const targetSizes = opts.sizes ? opts.sizes.split(',').map((s) => s.trim()) : account.preferredSizes ?? []
			const productUrl = `https://www.nike.com/fr/launch/t/${opts.slug}`
			console.log(`[DRY-RUN] Starting dry-run for slug: ${opts.slug}`)
			const result = await runCheckoutPipeline(account, config, selectors, {
				productUrl,
				targetSizes,
				dryRun: true,
			})
			console.log(`[DRY-RUN] Result: ${result.finalOutcome} (${result.durationMs}ms)`)
			for (const step of result.steps) {
				const status = step.outcome === 'success' ? '✓' : '✗'
				console.log(`  ${status} ${step.step}: ${step.outcome}${step.details ? ` — ${step.details}` : ''}`)
			}
			if (result.finalOutcome !== 'success' && result.finalOutcome !== '3ds_success' && result.finalOutcome !== 'no_session') {
				process.exit(1)
			}
		} catch (err) {
			console.error(`❌ Dry-run failed: ${maskCredentials(String(err))}`)
			process.exit(1)
		}
	})

program
	.command('checkout')
	.description('Run the checkout pipeline for all accounts (or a single one)')
	.requiredOption('--slug <slug>', 'Nike product slug to checkout')
	.option('--sizes <sizes>', 'Target sizes comma-separated (e.g. 42,42.5,43)')
	.option('--account <id>', 'Run checkout for a single account by ID')
	.option('--dry-run', 'Simulate checkout without placing real orders', false)
	.option('--selectors <path>', 'Path to selectors YAML file', './selectors.yaml')
	.action(async (opts: { slug: string; sizes?: string; account?: string; dryRun?: boolean; selectors?: string }) => {
		const { maskCredentials } = await import('../logger/credentialMasker.ts')
		const { runParallelCheckout } = await import('../checkout/parallelCheckout.ts')
		const { loadStoredAccounts } = await import('../auth/accountManager.ts')
		const configPath = program.opts<{ config: string }>().config
		try {
			const productUrl = `https://www.nike.com/fr/launch/t/${opts.slug}`
			const targetSizes = opts.sizes ? opts.sizes.split(',').map((s) => s.trim()) : undefined
			const dryRun = opts.dryRun ?? false

			let accounts
			if (opts.account) {
				const all = await loadStoredAccounts()
				const found = all.find((a) => a.id === opts.account)
				if (!found) {
					console.error(`Error: Account '${opts.account}' not found.`)
					process.exit(1)
				}
				accounts = [found]
			}

			const summary = await runParallelCheckout({
				productUrl,
				targetSizes,
				dryRun,
				configPath,
				selectorsPath: opts.selectors,
				accounts,
			})

			if (summary.complete === 0 && summary.total > 0) {
				process.exit(1)
			}
		} catch (err) {
			console.error(`❌ Checkout failed: ${maskCredentials(String(err))}`)
			process.exit(1)
		}
	})

program
	.command('status')
	.description('Show daemon status and account session health')
	.option('--json', 'Output status as structured JSON')
	.action(() => {
		console.log('Not yet implemented')
		process.exit(0)
	})

import { loadStoredAccounts } from '../auth/accountManager.ts'
import { loadBotConfig } from '../config/botConfig.ts'
import { loadSelectors } from '../config/selectors.ts'
import { maskEmail } from '../logger/credentialMasker.ts'
import { printCheckoutSummary } from '../logger/terminal.ts'
import { runCheckoutPipeline, type CheckoutPipelineResult } from './checkoutPipeline.ts'
import type { AccountConfig } from '../config/accountSchema.ts'

export interface ParallelCheckoutOptions {
  productUrl: string
  targetSizes?: string[]
  dryRun?: boolean
  configPath?: string
  selectorsPath?: string
  /** Override accounts list (useful for testing) */
  accounts?: AccountConfig[]
}

export interface ParallelCheckoutSummary {
  total: number
  complete: number
  failed: number
  noSession: number
  results: CheckoutPipelineResult[]
  durationMs: number
}

export async function runParallelCheckout(
  options: ParallelCheckoutOptions,
): Promise<ParallelCheckoutSummary> {
  const summaryStart = performance.now()
  const { productUrl, dryRun = false, configPath, selectorsPath } = options

  if (dryRun) {
    console.log('⚠️ DRY-RUN MODE — orders will NOT be placed')
  }

  // Load config and selectors
  const config = await loadBotConfig(configPath)
  const selectors = await loadSelectors(selectorsPath)

  // Use provided accounts or load from store (MUST await — loadStoredAccounts is async)
  const accounts = options.accounts ?? await loadStoredAccounts()
  const targetSizes = options.targetSizes ?? config.checkout?.defaultSizes ?? []

  if (accounts.length === 0) {
    console.log('No accounts found. Run nike-bot import-accounts first.')
    return {
      total: 0,
      complete: 0,
      failed: 0,
      noSession: 0,
      results: [],
      durationMs: Math.round(performance.now() - summaryStart),
    }
  }

  console.log(`Running checkout for ${accounts.length} account(s) in parallel...`)

  // MUST use Promise.allSettled — never Promise.all
  const settled = await Promise.allSettled(
    accounts.map((account) =>
      runCheckoutPipeline(account, config, selectors, {
        productUrl,
        targetSizes,
        dryRun,
      }),
    ),
  )

  const results: CheckoutPipelineResult[] = []
  let complete = 0
  let failed = 0
  let noSession = 0

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!
    const account = accounts[i]!
    const maskedEmail = maskEmail(account.email)

    if (outcome.status === 'fulfilled') {
      const result = outcome.value
      results.push(result)

      if (result.finalOutcome === 'complete') {
        complete++
        console.log(`  ✓ ${maskedEmail} — complete`)
      } else if (result.finalOutcome === 'no_session') {
        noSession++
        console.log(`  - ${maskedEmail} — no session`)
      } else {
        failed++
        const lastStep = result.steps[result.steps.length - 1]
        console.log(`  ✗ ${maskedEmail} — ${result.finalOutcome}${lastStep?.error ? ` (${lastStep.error})` : ''}`)
      }
    } else {
      failed++
      const fakeResult: CheckoutPipelineResult = {
        accountId: account.id,
        accountEmail: maskedEmail,
        steps: [],
        finalOutcome: 'error',
        durationMs: 0,
      }
      results.push(fakeResult)
      console.log(`  ✗ ${maskedEmail} — pipeline threw: ${String(outcome.reason)}`)
    }
  }

  const durationMs = Math.round(performance.now() - summaryStart)
  const summary: ParallelCheckoutSummary = {
    total: accounts.length,
    complete,
    failed,
    noSession,
    results,
    durationMs,
  }

  printCheckoutSummary(
    results.map((r) => ({
      accountEmail: r.accountEmail,
      finalOutcome: r.finalOutcome,
      steps: r.steps,
      durationMs: r.durationMs,
    })),
    dryRun,
  )

  return summary
}

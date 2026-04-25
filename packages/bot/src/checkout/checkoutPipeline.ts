import type { BrowserContext, Page } from 'playwright'
import type { BotConfig } from '../config/botConfigSchema.ts'
import type { AccountConfig } from '../config/accountSchema.ts'
import type { Selectors } from '../config/selectorSchema.ts'
import { createRealCheckoutContext } from '../stealth/realCheckoutContext.ts'
import type { RealChromeHandle } from '../stealth/realChrome.ts'
import { maskEmail } from '../logger/credentialMasker.ts'
import { logStep } from '../logger/logger.ts'
import { printStepResult } from '../logger/terminal.ts'
import { registerContext, unregisterContext } from '../daemon/gracefulShutdown.ts'
import type { StepResult, StepOutcome } from './executeStep.ts'
import { classifyOutcome, type FinalOutcome } from './outcomeClassifier.ts'
import { selectSize } from './steps/selectSize.ts'
import { addToCart } from './steps/addToCart.ts'
import { navigateCheckout } from './steps/navigateCheckout.ts'
import { completeShipping, type ShippingAddress } from './steps/completeShipping.ts'
import { completePayment, type CardData } from './steps/completePayment.ts'
import { handle3DSIfRequired } from './steps/handle3DS.ts'
import { submitOrder } from './steps/submitOrder.ts'
import { globalBus } from '../tui/eventBus.ts'

export interface CheckoutPipelineResult {
  accountId: string
  accountEmail: string
  steps: StepResult[]
  finalOutcome: FinalOutcome
  durationMs: number
}

export interface CheckoutPipelineOptions {
  productUrl: string
  targetSizes: string[]
  dryRun?: boolean
  /**
   * Pre-resolved shipping address — caller (CLI) reads from addresses.csv.
   * Optional: when omitted and the form is empty, completeShipping returns an
   * error outcome rather than guessing.
   */
  shippingAddress?: ShippingAddress
  /**
   * Pre-decrypted card payload — caller (CLI) unlocks the cards DB and pulls
   * the row before invoking. Optional for the same reason as shippingAddress.
   */
  card?: CardData
}

/**
 * Handle returned by `createCheckoutContext` — pairs the underlying real-Chrome
 * BrowserContext with the first usable Page, plus a `close()` to tear it down.
 *
 * Exposed so callers (e.g. WarmupController) can pre-launch contexts ahead of a
 * drop and then hand them to the checkout pipeline at T=0 with zero cold-start.
 */
export interface CheckoutContextHandle {
  context: BrowserContext
  page: Page
  close: () => Promise<void>
}

/**
 * Launch a real Chrome process for one account and return the prepared
 * BrowserContext + initial Page. Identical to the inline launch used at the top
 * of `runCheckoutPipeline`, just hoisted so it can be called independently
 * (warmup phase, integration tests, future parallel pre-launch, …).
 *
 * Callers MUST invoke `handle.close()` in a `finally` block — the BrowserContext
 * holds a Chrome subprocess.
 */
export async function createCheckoutContext(
  account: AccountConfig,
): Promise<CheckoutContextHandle> {
  const handle = await createRealCheckoutContext({
    accountId: account.id,
    headless: false, // Visible browser — Kasada blocks headless Chrome at accounts.nike.com
  })
  const page = handle.context.pages()[0] ?? (await handle.context.newPage())
  return {
    context: handle.context,
    page,
    close: handle.close,
  }
}

// Internal: keep the launch wrapped so `runCheckoutPipeline` can reuse the
// helper without changing its existing no-session error semantics.
async function safeCreateRealCheckoutContext(
  account: AccountConfig,
): Promise<RealChromeHandle> {
  return createRealCheckoutContext({
    accountId: account.id,
    headless: false,
  })
}

export async function runCheckoutPipeline(
  account: AccountConfig,
  config: BotConfig,
  selectors: Selectors,
  options: CheckoutPipelineOptions,
): Promise<CheckoutPipelineResult> {
  const pipelineStart = performance.now()
  const maskedEmail = maskEmail(account.email)
  const stepTimeoutMs = config.checkout?.stepTimeoutMs ?? 8000
  const { productUrl, targetSizes, dryRun = false, shippingAddress, card } = options

  console.log(`[checkout] Starting pipeline for ${maskedEmail}${dryRun ? ' [DRY-RUN]' : ''}`)

  // Use real Chrome via CDP — bypasses Kasada's Playwright-launch detection.
  // This spawns Chrome as an independent process with a per-account persistent
  // profile, injects session snapshot, and completes OAuth handshake.
  let handle: RealChromeHandle
  try {
    handle = await safeCreateRealCheckoutContext(account)
  } catch (err) {
    if (err instanceof Error && err.message.includes('Session snapshot missing')) {
      console.log(`  No session for ${maskedEmail} — skipping. Run: nike-bot capture-session --account ${account.id}`)
      return {
        accountId: account.id,
        accountEmail: maskedEmail,
        steps: [],
        finalOutcome: 'no_session',
        durationMs: Math.round(performance.now() - pipelineStart),
      }
    }
    throw err
  }

  const context = handle.context
  registerContext(context)

  try {
    // Reuse existing page (Chrome opens with a default new-tab page) instead of creating a new one.
    // After OAuth handshake, this page is at www.nike.com/member/profile.
    const page = handle.context.pages()[0] ?? (await handle.context.newPage())
    const steps: StepResult[] = []

    // Step 1: Select size
    globalBus.emit('accountStatusChanged', {
      accountId: account.id,
      status: { kind: 'waiting', step: 'selectSize' },
    })
    const sizeResult = await selectSize(page, productUrl, targetSizes, selectors, stepTimeoutMs)
    steps.push(sizeResult)
    logStep(account.email, sizeResult)
    printStepResult(sizeResult)
    if (sizeResult.outcome !== 'success') {
      return buildResult(account.id, maskedEmail, steps, sizeResult.outcome, pipelineStart)
    }

    // Step 2: Add to cart
    globalBus.emit('accountStatusChanged', {
      accountId: account.id,
      status: { kind: 'waiting', step: 'addToCart' },
    })
    const cartResult = await addToCart(page, selectors, stepTimeoutMs)
    steps.push(cartResult)
    logStep(account.email, cartResult)
    printStepResult(cartResult)
    if (cartResult.outcome !== 'success') {
      return buildResult(account.id, maskedEmail, steps, cartResult.outcome, pipelineStart)
    }

    // Step 3: Navigate to checkout
    globalBus.emit('accountStatusChanged', {
      accountId: account.id,
      status: { kind: 'waiting', step: 'navigateCheckout' },
    })
    const navResult = await navigateCheckout(page, selectors, stepTimeoutMs)
    steps.push(navResult)
    logStep(account.email, navResult)
    printStepResult(navResult)
    if (navResult.outcome !== 'success') {
      return buildResult(account.id, maskedEmail, steps, navResult.outcome, pipelineStart)
    }

    // Step 4: Complete shipping
    globalBus.emit('accountStatusChanged', {
      accountId: account.id,
      status: { kind: 'waiting', step: 'completeShipping' },
    })
    const shippingResult = await completeShipping(page, selectors, { timeoutMs: stepTimeoutMs, address: shippingAddress })
    steps.push(shippingResult)
    logStep(account.email, shippingResult)
    printStepResult(shippingResult)
    if (shippingResult.outcome !== 'success') {
      return buildResult(account.id, maskedEmail, steps, shippingResult.outcome, pipelineStart)
    }

    // Step 5: Complete payment
    globalBus.emit('accountStatusChanged', {
      accountId: account.id,
      status: { kind: 'waiting', step: 'completePayment' },
    })
    const paymentResult = await completePayment(page, selectors, { timeoutMs: stepTimeoutMs, card })
    steps.push(paymentResult)
    logStep(account.email, paymentResult)
    printStepResult(paymentResult)
    if (paymentResult.outcome !== 'success') {
      return buildResult(account.id, maskedEmail, steps, paymentResult.outcome, pipelineStart)
    }

    // Step 5b: Handle 3DS if required
    const threeDSStepResult = await handle3DSIfRequired(page, selectors, stepTimeoutMs)
    const effectiveResult: StepResult = threeDSStepResult ?? {
      step: '3ds-check',
      outcome: 'success' as const,
      durationMs: 0,
      details: 'not_required',
    }
    steps.push(effectiveResult)
    logStep(account.email, effectiveResult)
    printStepResult(effectiveResult)
    if (effectiveResult.outcome !== 'success') {
      return buildResult(account.id, maskedEmail, steps, effectiveResult.outcome, pipelineStart)
    }

    // Step 6: Submit order (dry-run aware)
    globalBus.emit('accountStatusChanged', {
      accountId: account.id,
      status: { kind: 'waiting', step: dryRun ? 'dryRun' : 'submitOrder' },
    })
    const submitResult = await submitOrder(page, selectors, dryRun, stepTimeoutMs)
    steps.push(submitResult)
    logStep(account.email, submitResult)
    printStepResult(submitResult)
    if (submitResult.outcome !== 'success') {
      return buildResult(account.id, maskedEmail, steps, submitResult.outcome, pipelineStart)
    }

    const finalOutcome = classifyOutcome(steps)
    console.log(`[checkout] Pipeline complete for ${maskedEmail}${dryRun ? ' [DRY-RUN]' : ''}`)

    return {
      accountId: account.id,
      accountEmail: maskedEmail,
      steps,
      finalOutcome,
      durationMs: Math.round(performance.now() - pipelineStart),
    }
  } finally {
    unregisterContext(context)
    await handle.close().catch(() => undefined)
  }
}

function stepOutcomeToFinal(outcome: StepOutcome): FinalOutcome {
  switch (outcome) {
    case 'success': return 'success'
    case 'sold_out': return 'sold_out'
    case 'blocked': return 'blocked'
    case '3ds_required': return 'error' // 3DS detected but unresolved at pipeline level
    case '3ds_timeout': return '3ds_timeout'
    case 'timeout': return 'timeout'
    case 'no_session': return 'no_session'
    case 'error': return 'error'
  }
}

function buildResult(
  accountId: string,
  accountEmail: string,
  steps: StepResult[],
  outcome: StepOutcome,
  pipelineStart: number,
): CheckoutPipelineResult {
  return {
    accountId,
    accountEmail,
    steps,
    finalOutcome: stepOutcomeToFinal(outcome),
    durationMs: Math.round(performance.now() - pipelineStart),
  }
}

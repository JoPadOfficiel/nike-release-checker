import type { BotConfig } from '../config/botConfigSchema.ts'
import type { AccountConfig } from '../config/accountSchema.ts'
import type { Selectors } from '../config/selectorSchema.ts'
import { createRealCheckoutContext } from '../stealth/realCheckoutContext.ts'
import { maskEmail } from '../logger/credentialMasker.ts'
import { logStep } from '../logger/logger.ts'
import { printStepResult } from '../logger/terminal.ts'
import { registerContext, unregisterContext } from '../daemon/gracefulShutdown.ts'
import type { StepResult, StepOutcome } from './executeStep.ts'
import { classifyOutcome, type FinalOutcome } from './outcomeClassifier.ts'
import { selectSize } from './steps/selectSize.ts'
import { addToCart } from './steps/addToCart.ts'
import { navigateCheckout } from './steps/navigateCheckout.ts'
import { completeShipping } from './steps/completeShipping.ts'
import { completePayment } from './steps/completePayment.ts'
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
  const { productUrl, targetSizes, dryRun = false } = options

  console.log(`[checkout] Starting pipeline for ${maskedEmail}${dryRun ? ' [DRY-RUN]' : ''}`)

  // Use real Chrome via CDP — bypasses Kasada's Playwright-launch detection.
  // This spawns Chrome as an independent process with a per-account persistent
  // profile, injects session snapshot, and completes OAuth handshake.
  let handle: Awaited<ReturnType<typeof createRealCheckoutContext>>
  try {
    handle = await createRealCheckoutContext({
      accountId: account.id,
      headless: false,  // Visible browser — Kasada blocks headless Chrome at accounts.nike.com
    })
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
    const shippingResult = await completeShipping(page, selectors, stepTimeoutMs)
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
    const paymentResult = await completePayment(page, selectors, stepTimeoutMs)
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

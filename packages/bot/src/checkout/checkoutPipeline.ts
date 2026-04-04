import type { BotConfig } from '../config/botConfigSchema.ts'
import type { AccountConfig } from '../config/accountSchema.ts'
import type { Selectors } from '../config/selectorSchema.ts'
import { createStealthContext } from '../stealth/contextFactory.ts'
import { loadAndInjectCookies } from '../auth/cookieStore.ts'
import { maskEmail } from '../logger/credentialMasker.ts'
import { logStep } from '../logger/logger.ts'
import { printStepResult } from '../logger/terminal.ts'
import type { StepResult, StepOutcome } from './executeStep.ts'
import { selectSize } from './steps/selectSize.ts'
import { addToCart } from './steps/addToCart.ts'
import { navigateCheckout } from './steps/navigateCheckout.ts'
import { completeShipping } from './steps/completeShipping.ts'
import { completePayment } from './steps/completePayment.ts'
import { handle3DSIfRequired } from './steps/handle3DS.ts'
import { submitOrder } from './steps/submitOrder.ts'

export interface CheckoutPipelineResult {
  accountId: string
  accountEmail: string
  steps: StepResult[]
  finalOutcome: StepOutcome | 'complete'
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

  const context = await createStealthContext({ proxy: account.proxy })

  try {
    // Load and inject session cookies — throw if session file missing
    try {
      await loadAndInjectCookies(context, account.id)
    } catch (err) {
      if (err instanceof Error && err.message.includes('Session file missing')) {
        console.log(`  No session for ${maskedEmail} — skipping`)
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

    const page = await context.newPage()
    const steps: StepResult[] = []

    // Step 1: Select size
    const sizeResult = await selectSize(page, productUrl, targetSizes, selectors, stepTimeoutMs)
    steps.push(sizeResult)
    logStep(account.email, sizeResult)
    printStepResult(sizeResult)
    if (sizeResult.outcome !== 'success') {
      return buildResult(account.id, maskedEmail, steps, sizeResult.outcome, pipelineStart)
    }

    // Step 2: Add to cart
    const cartResult = await addToCart(page, selectors, stepTimeoutMs)
    steps.push(cartResult)
    logStep(account.email, cartResult)
    printStepResult(cartResult)
    if (cartResult.outcome !== 'success') {
      return buildResult(account.id, maskedEmail, steps, cartResult.outcome, pipelineStart)
    }

    // Step 3: Navigate to checkout
    const navResult = await navigateCheckout(page, selectors, stepTimeoutMs)
    steps.push(navResult)
    logStep(account.email, navResult)
    printStepResult(navResult)
    if (navResult.outcome !== 'success') {
      return buildResult(account.id, maskedEmail, steps, navResult.outcome, pipelineStart)
    }

    // Step 4: Complete shipping
    const shippingResult = await completeShipping(page, selectors, stepTimeoutMs)
    steps.push(shippingResult)
    logStep(account.email, shippingResult)
    printStepResult(shippingResult)
    if (shippingResult.outcome !== 'success') {
      return buildResult(account.id, maskedEmail, steps, shippingResult.outcome, pipelineStart)
    }

    // Step 5: Complete payment
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
    const submitResult = await submitOrder(page, selectors, dryRun, stepTimeoutMs)
    steps.push(submitResult)
    logStep(account.email, submitResult)
    printStepResult(submitResult)
    if (submitResult.outcome !== 'success') {
      return buildResult(account.id, maskedEmail, steps, submitResult.outcome, pipelineStart)
    }

    const finalOutcome = 'complete'
    console.log(`[checkout] Pipeline complete for ${maskedEmail}${dryRun ? ' [DRY-RUN]' : ''}`)

    return {
      accountId: account.id,
      accountEmail: maskedEmail,
      steps,
      finalOutcome,
      durationMs: Math.round(performance.now() - pipelineStart),
    }
  } finally {
    await context.close().catch(() => undefined)
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
    finalOutcome: outcome,
    durationMs: Math.round(performance.now() - pipelineStart),
  }
}

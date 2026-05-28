import type { Page, Locator, FrameLocator } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'
import { naturalClick } from '../naturalClick.ts'

export interface CardData {
	number: string
	expiry: string
	cvv: string
	holderName: string
}

export interface CompletePaymentOpts {
	timeoutMs?: number
	card?: CardData
}

type Scope = Page | FrameLocator

async function findFirstVisibleIn(scope: Scope, candidates: string[]): Promise<Locator | null> {
	for (const sel of candidates) {
		try {
			const loc = scope.locator(sel).first()
			if (await loc.isVisible({ timeout: 250 }).catch(() => false)) {
				return loc
			}
		} catch {
			// next candidate
		}
	}
	return null
}

async function fillIfPresentIn(scope: Scope, candidates: string[], value: string | undefined): Promise<boolean> {
	if (!value) return false
	const loc = await findFirstVisibleIn(scope, candidates)
	if (!loc) return false
	try {
		await loc.fill(value)
		return true
	} catch {
		return false
	}
}

export async function completePayment(
	page: Page,
	selectors: Selectors,
	opts: CompletePaymentOpts = {},
): Promise<StepResult> {
	const timeoutMs = opts.timeoutMs ?? 8000
	return executeStep(
		'complete-payment',
		async () => {
			// Use shorter timeout than the executeStep race timer to avoid ghost timeout
			const innerTimeout = Math.max(Math.floor(timeoutMs * 0.7), 2000)
			// Wait for payment section
			await page.waitForSelector(selectors.checkout.paymentSection, { timeout: innerTimeout })

			// Check for 3DS BEFORE filling
			const threeDSBefore = page.locator(selectors.checkout.threeDSIframe)
			const is3DSBefore = await threeDSBefore.isVisible().catch(() => false)
			if (is3DSBefore) {
				throw Object.assign(new Error('3DS iframe detected before payment continue'), { code: '3DS_REQUIRED' })
			}

			// Nike FR checkout is a single progressive page. The payment method is
			// chosen via a radio (`paymentOptions` = creditDebit | paypal | …); the
			// card form only renders once "creditDebit" is selected. Select it first.
			const creditRadio = page
				.locator('input[name="paymentOptions"][value="creditDebit"]')
				.first()
			if (await creditRadio.isVisible({ timeout: 1000 }).catch(() => false)) {
				await creditRadio.check().catch(() => {})
				// Give the card iframe a moment to mount.
				await page.waitForSelector('iframe[src*="paymentcc.nike.com"]', { timeout: innerTimeout }).catch(() => {})
			}

			// Card fields live inside Nike's hosted PCI iframe — historically Adyen
			// (iframe[src*="adyen"]), now paymentcc.nike.com ("Formulaire de carte de
			// crédit"). Try the Nike host first, then Adyen, then inline page DOM.
			let scope: Scope = page.frameLocator('iframe[src*="paymentcc.nike.com"]').first()
			let cardNumberLoc = await findFirstVisibleIn(scope, [
				'#creditCardNumber',
				'input[name="cardNumber"]',
			])
			if (!cardNumberLoc) {
				scope = page.frameLocator('iframe[src*="adyen"]').first()
				cardNumberLoc = await findFirstVisibleIn(scope, [
					'input[name="encryptedCardNumber"]',
					'input[name="cardNumber"]',
					'input[aria-label*="arte"]',
				])
			}
			if (!cardNumberLoc) {
				// Iframe not present (or rotated) — fall back to the main page DOM.
				scope = page
				cardNumberLoc = await findFirstVisibleIn(scope, [
					'#creditCardNumber',
					'input[name="cardNumber"]',
					'input[name="encryptedCardNumber"]',
					'input[autocomplete="cc-number"]',
				])
			}

			// Detect empty card form: if the card-number input exists and is empty,
			// we should attempt to fill (caller's responsibility to provide opts.card).
			const cardNumberValue = cardNumberLoc ? await cardNumberLoc.inputValue().catch(() => '') : ''
			const cardFormEmpty = cardNumberLoc !== null && cardNumberValue.trim() === ''

			if (cardFormEmpty) {
				if (!opts.card) {
					throw Object.assign(
						new Error('payment form empty and no card provided'),
						{ code: 'ERROR' },
					)
				}

				const card = opts.card

				// Card number — fill into whichever scope (iframe vs page) we resolved.
				if (cardNumberLoc) {
					try {
						await cardNumberLoc.fill(card.number)
					} catch {
						// keep going — partial fill better than total fail
					}
				}

				await fillIfPresentIn(scope, [
					'#expirationDate',
					'input[name="encryptedExpiryDate"]',
					'input[name="expirationDate"]',
					'input[name="expiry"]',
					'input[autocomplete="cc-exp"]',
					'input[aria-label*="xpiration"]',
				], card.expiry)

				await fillIfPresentIn(scope, [
					'#cvNumber',
					'input[name="encryptedSecurityCode"]',
					'input[name="cvNumber"]',
					'input[name="cvv"]',
					'input[autocomplete="cc-csc"]',
					'input[aria-label*="ryptogramme"]',
				], card.cvv)

				// Holder name typically lives on the parent Nike page (not the card iframe).
				await fillIfPresentIn(page, [
					'input[name="cardholderName"]',
					'input[name="holderName"]',
					'input[autocomplete="cc-name"]',
					'input[aria-label*="itulaire"]',
				], card.holderName)
			}

			// Optional "continue / save card" button. Nike's single-page flow often
			// has NO separate continue step — the only remaining action is the final
			// "Passer la commande" submit, which submitOrder handles. So clicking the
			// continue button is best-effort; its absence is NOT a failure.
			const paymentButton = page.locator(selectors.checkout.paymentContinueButton).first()
			if (await paymentButton.isVisible({ timeout: 1500 }).catch(() => false)) {
				await naturalClick(page, paymentButton)
			}

			// Check for 3DS AFTER filling — Nike may redirect to 3DS after payment selection
			const threeDSAfter = page.locator(selectors.checkout.threeDSIframe)
			const is3DSAfter = await threeDSAfter.isVisible().catch(() => false)
			if (is3DSAfter) {
				throw Object.assign(new Error('3DS iframe detected after payment continue'), { code: '3DS_REQUIRED' })
			}

			return cardFormEmpty ? 'payment-filled-and-complete' : 'payment-complete'
		},
		timeoutMs,
	)
}

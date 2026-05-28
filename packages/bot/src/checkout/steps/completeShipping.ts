import type { Page, Locator } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'
import { naturalClick } from '../naturalClick.ts'

export interface ShippingAddress {
	street: string
	city: string
	zip: string
	country: string
	phone?: string
	firstName?: string
	lastName?: string
	email?: string
}

export interface CompleteShippingOpts {
	timeoutMs?: number
	address?: ShippingAddress
}

/**
 * Try a list of candidate selectors and return the first one that resolves to
 * a visible locator. Wrapped in try/catch so a missing selector never throws —
 * Nike rotates form selectors and we want graceful fallback (placeholder /
 * aria-label matching) before giving up.
 */
async function findFirstVisible(page: Page, candidates: string[]): Promise<Locator | null> {
	for (const sel of candidates) {
		try {
			const loc = page.locator(sel).first()
			if (await loc.isVisible({ timeout: 250 }).catch(() => false)) {
				return loc
			}
		} catch {
			// next candidate
		}
	}
	return null
}

async function fillIfPresent(page: Page, candidates: string[], value: string | undefined): Promise<boolean> {
	if (!value) return false
	const loc = await findFirstVisible(page, candidates)
	if (!loc) return false
	try {
		await loc.fill(value)
		return true
	} catch {
		return false
	}
}

export async function completeShipping(
	page: Page,
	selectors: Selectors,
	opts: CompleteShippingOpts = {},
): Promise<StepResult> {
	const timeoutMs = opts.timeoutMs ?? 8000
	return executeStep(
		'complete-shipping',
		async () => {
			// Use shorter timeout than the executeStep race timer to avoid ghost timeout
			const innerTimeout = Math.max(Math.floor(timeoutMs * 0.6), 2000)

			// Shipping may ALREADY be complete: on a persistent profile Nike keeps
			// the saved address and collapses the shipping section, jumping straight
			// to payment. In that case the shipping continue button never appears.
			// Race the shipping button against the payment section — if payment is
			// already reachable and there's no shipping button, treat shipping as done.
			// Cap this probe at 6s: the checkout page is already loaded by
			// navigate-checkout, so the shipping button (if it's going to show)
			// appears fast. This avoids burning the full timeout on every run where
			// the address is already saved (payment shown directly).
			const probeTimeout = Math.min(innerTimeout, 6000)
			const shippingBtnReady = await page
				.locator(selectors.checkout.shippingContinueButton)
				.first()
				.waitFor({ state: 'visible', timeout: probeTimeout })
				.then(() => true)
				.catch(() => false)

			if (!shippingBtnReady) {
				const paymentReachable = await findFirstVisible(page, [
					'input[name="paymentOptions"]',
					'iframe[src*="paymentcc.nike.com"]',
					'iframe[src*="adyen"]',
					'h2:has-text("Paiement")',
				])
				if (paymentReachable) {
					return 'shipping-already-complete'
				}
				throw Object.assign(
					new Error('Shipping continue button not visible and payment not reachable'),
					{ code: 'TIMEOUT' },
				)
			}

			// Detect whether the form is empty:
			// - Nike shows a "Saisir l'adresse manuellement" toggle when no address pre-filled.
			// - Or: the address1 input exists but is empty.
			// If either signal is true AND we have an opts.address, fill the form.
			const manualToggle = await findFirstVisible(page, [
				'button:has-text("Saisir l\'adresse manuellement")',
				'button:has-text("Saisir l adresse manuellement")',
				'button:has-text("Enter address manually")',
				'[data-testid="manual-address-toggle"]',
			])

			const address1Loc = await findFirstVisible(page, [
				'input[name="address.address1"]',
				'input[name="address1"]',
				'input[name="addressLine1"]',
				'input[aria-label*="dresse"]',
			])
			const address1Value = address1Loc ? await address1Loc.inputValue().catch(() => '') : ''
			const formEmpty = Boolean(manualToggle) || (address1Loc !== null && address1Value.trim() === '')

			if (formEmpty) {
				if (!opts.address) {
					throw Object.assign(
						new Error('shipping form empty and no address provided'),
						{ code: 'ERROR' },
					)
				}

				// CRITICAL: Nike hides the manual address fields behind the autocomplete
				// typeahead (`#search-address-input`). The actual `name="address.*"`
				// inputs have aria-hidden="true" until the user clicks the
				// "Saisir l'adresse manuellement" button (id=addressSuggestionOptOut).
				// We MUST click that toggle first or fill() will refuse on hidden fields.
				const manualBtn = page.locator('button#addressSuggestionOptOut').first()
				if (await manualBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
					await naturalClick(page, manualBtn)
					await page.waitForTimeout(400)
				} else if (manualToggle) {
					await naturalClick(page, manualToggle).catch(() => {})
					await page.waitForTimeout(400)
				}

				const addr = opts.address

				// Verified live 2026-04-25 against /fr/checkout — Nike uses
				// `name="address.<field>"` (dot-separated namespacing) for all inputs.
				// Fallback chains kept for resilience to future rotation.
				if (addr.email) {
					await fillIfPresent(page, [
						'input[name="address.email"]',
						'input#email',
						'input[type="email"]',
						'input[autocomplete="shipping email"]',
					], addr.email)
				}
				if (addr.firstName) {
					await fillIfPresent(page, [
						'input[name="address.firstName"]',
						'input#firstName',
						'input[autocomplete="shipping given-name"]',
					], addr.firstName)
				}
				if (addr.lastName) {
					await fillIfPresent(page, [
						'input[name="address.lastName"]',
						'input#lastName',
						'input[autocomplete="shipping family-name"]',
					], addr.lastName)
				}
				await fillIfPresent(page, [
					'input[name="address.address1"]',
					'input#address1',
					'input[autocomplete="shipping street-address"]',
				], addr.street)
				await fillIfPresent(page, [
					'input[name="address.postalCode"]',
					'input#postalCode',
					'input[autocomplete="shipping postal-code"]',
				], addr.zip)
				await fillIfPresent(page, [
					'input[name="address.city"]',
					'input#city',
					'input[autocomplete="shipping address-level2"]',
				], addr.city)
				// Country: readonly select on Nike (auto-set to "France" from locale).
				// Skip — filling readonly inputs throws.
				if (addr.phone) {
					await fillIfPresent(page, [
						'input[name="address.phoneNumber"]',
						'input#phoneNumber',
						'input[autocomplete="shipping tel"]',
						'input[type="tel"]',
					], addr.phone)
				}

				// Trigger React form validation: blur the last filled field so
				// the saveAddressBtn flips from aria-disabled=true to enabled.
				await page.keyboard.press('Tab').catch(() => {})
				await page.waitForTimeout(600)
			}

			// Pick the first matching button (Nike checkout has multiple submit buttons,
			// text-matches may catch "Modifier" / "Confirmer" etc. — first() narrows to one).
			const shippingButton = page.locator(selectors.checkout.shippingContinueButton).first()

			// Hydration buffer: Nike's React form re-renders after waitForSelector returns,
			// and isVisible/isEnabled fail immediately on the brief intermediate state.
			// Use locator's auto-wait via waitFor instead of polling isVisible/isEnabled.
			try {
				await shippingButton.waitFor({ state: 'visible', timeout: innerTimeout })
			} catch {
				throw Object.assign(new Error('Shipping continue button not visible'), { code: 'TIMEOUT' })
			}

			await naturalClick(page, shippingButton)

			// Wait for payment section to appear to confirm shipping step is complete
			await page.waitForSelector(selectors.checkout.paymentSection, { timeout: innerTimeout })

			return formEmpty ? 'shipping-filled-and-complete' : 'shipping-complete'
		},
		timeoutMs,
	)
}

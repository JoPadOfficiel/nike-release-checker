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
			// Wait for shipping continue button to be ready
			// Use shorter timeout than the executeStep race timer to avoid ghost timeout
			const innerTimeout = Math.max(Math.floor(timeoutMs * 0.6), 2000)
			await page.waitForSelector(selectors.checkout.shippingContinueButton, { timeout: innerTimeout })

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

				// Reveal the manual address fields if Nike hides them behind the toggle.
				if (manualToggle) {
					try {
						await naturalClick(page, manualToggle)
					} catch {
						// fall through — fields may already be visible
					}
				}

				const addr = opts.address

				// Many of these selectors are best-effort guesses based on Nike's
				// French checkout. We always pass through findFirstVisible →
				// fallbacks so a single rotated `name=` doesn't crash the bot.
				if (addr.firstName) {
					await fillIfPresent(page, [
						'input[name="firstName"]',
						'input[autocomplete="given-name"]',
						'input[aria-label*="rénom"]',
					], addr.firstName)
				}
				if (addr.lastName) {
					await fillIfPresent(page, [
						'input[name="lastName"]',
						'input[autocomplete="family-name"]',
						'input[aria-label*="om de famille"]',
					], addr.lastName)
				}
				if (addr.email) {
					await fillIfPresent(page, [
						'input[name="email"]',
						'input[type="email"]',
						'input[autocomplete="email"]',
					], addr.email)
				}
				await fillIfPresent(page, [
					'input[name="address1"]',
					'input[name="addressLine1"]',
					'input[autocomplete="address-line1"]',
					'input[aria-label*="dresse"]',
				], addr.street)
				await fillIfPresent(page, [
					'input[name="city"]',
					'input[autocomplete="address-level2"]',
					'input[aria-label*="ille"]',
				], addr.city)
				await fillIfPresent(page, [
					'input[name="postalCode"]',
					'input[name="zip"]',
					'input[autocomplete="postal-code"]',
					'input[aria-label*="ostal"]',
				], addr.zip)
				// Country: usually a select on Nike (auto-set from locale). Best-effort.
				await fillIfPresent(page, [
					'input[name="country"]',
					'select[name="country"]',
				], addr.country)
				if (addr.phone) {
					await fillIfPresent(page, [
						'input[name="phoneNumber"]',
						'input[name="phone"]',
						'input[autocomplete="tel"]',
						'input[type="tel"]',
					], addr.phone)
				}
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

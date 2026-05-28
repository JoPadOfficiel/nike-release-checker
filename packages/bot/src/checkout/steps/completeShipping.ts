import type { Page, Locator } from 'playwright'
import type { Selectors } from '../../config/selectorSchema.ts'
import { executeStep, type StepResult } from '../executeStep.ts'
import { naturalClick } from '../naturalClick.ts'
import { displayedAddressMatches, type TargetAddress } from './addressMatcher.ts'

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

/**
 * Fill the manual shipping-address form fields. Assumes the manual form is
 * already revealed (caller clicks the "Saisir l'adresse manuellement" toggle).
 * Verified live 2026-04-25 against /fr/checkout — Nike uses `name="address.*"`.
 */
async function fillAddressForm(page: Page, addr: ShippingAddress): Promise<void> {
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
	// Country: readonly select on Nike (auto-set from locale) — skip.
	if (addr.phone) {
		await fillIfPresent(page, [
			'input[name="address.phoneNumber"]',
			'input#phoneNumber',
			'input[autocomplete="shipping tel"]',
			'input[type="tel"]',
		], addr.phone)
	}
	// Blur the last field so Nike's React validation enables the save button.
	await page.keyboard.press('Tab').catch(() => {})
	await page.waitForTimeout(600)
}

/**
 * Reveal the manual-entry fields. Nike hides `name="address.*"` behind the
 * autocomplete typeahead (#search-address-input); the actual inputs are
 * aria-hidden until "Saisir l'adresse manuellement" (#addressSuggestionOptOut)
 * is clicked. Best-effort — no-op if the form is already manual.
 */
async function revealManualAddressFields(page: Page): Promise<void> {
	const manualBtn = page.locator('button#addressSuggestionOptOut').first()
	if (await manualBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
		await naturalClick(page, manualBtn)
		await page.waitForTimeout(400)
		return
	}
	const textBtn = await findFirstVisible(page, [
		'button:has-text("Saisir l\'adresse manuellement")',
		'button:has-text("Saisir l adresse manuellement")',
		'button:has-text("Enter address manually")',
	])
	if (textBtn) {
		await naturalClick(page, textBtn).catch(() => {})
		await page.waitForTimeout(400)
	}
}

/**
 * The address pre-selected by Nike does not match the operator's target. Force
 * the target by clicking "Ajouter une nouvelle adresse", filling the manual
 * form, and saving it (Nike auto-selects a freshly-added address). Best-effort:
 * returns true if the switch likely succeeded, false to let the caller fall
 * back to the pre-selected address (never throws — we must not crash a drop).
 */
async function addNewAddress(
	page: Page,
	addr: ShippingAddress,
	innerTimeout: number,
): Promise<boolean> {
	try {
		const addBtn = await findFirstVisible(page, [
			'button:has-text("Ajouter une nouvelle adresse")',
			'button:has-text("Ajouter une adresse")',
			'button:has-text("Add a new address")',
			'button:has-text("Add address")',
		])
		if (!addBtn) return false
		await naturalClick(page, addBtn)
		// Wait for the address form to mount.
		await page.waitForSelector(
			'input[name="address.address1"], input#address1, button#addressSuggestionOptOut, input#search-address-input',
			{ timeout: innerTimeout, state: 'visible' },
		).catch(() => {})
		await revealManualAddressFields(page)
		await fillAddressForm(page, addr)

		// Save the new address — Nike labels this "Enregistrer et continuer" /
		// "Utiliser cette adresse" / the generic shipping continue button.
		const saveBtn = await findFirstVisible(page, [
			'button:has-text("Enregistrer et continuer")',
			'button:has-text("Utiliser cette adresse")',
			'button:has-text("Enregistrer")',
			'button#saveAddressBtn',
		])
		const btn = saveBtn ?? page.locator('button[type="submit"]').first()
		await naturalClick(page, btn).catch(() => {})
		// Confirm we advanced to payment (or at least the form closed).
		await page.waitForSelector(
			'input[name="paymentOptions"], iframe[src*="paymentcc.nike.com"], h2:has-text("Paiement")',
			{ timeout: innerTimeout, state: 'attached' },
		).catch(() => {})
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
	const target: TargetAddress | undefined = opts.address
		? { street: opts.address.street, city: opts.address.city, zip: opts.address.zip, country: opts.address.country }
		: undefined
	return executeStep(
		'complete-shipping',
		async () => {
			// Use shorter timeout than the executeStep race timer to avoid ghost timeout
			const innerTimeout = Math.max(Math.floor(timeoutMs * 0.6), 2000)

			// Shipping may ALREADY be complete: on a persistent profile Nike keeps
			// the saved address and collapses the shipping section, jumping straight
			// to payment. In that case the shipping continue button never appears.
			// Cap this probe at 6s: the page is already loaded by navigate-checkout.
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
				if (!paymentReachable) {
					throw Object.assign(
						new Error('Shipping continue button not visible and payment not reachable'),
						{ code: 'TIMEOUT' },
					)
				}

				// Verify the pre-selected address is the one we WANT. Nike pre-selects
				// a saved address on a returning account, which may not be the address
				// configured for this drop. If it doesn't match, force ours.
				if (target) {
					const pageText = await page.evaluate(() => document.body.innerText).catch(() => '')
					if (displayedAddressMatches(pageText, target)) {
						return 'shipping-already-complete'
					}
					console.warn(
						'[shipping] pre-selected address does not match the configured address — switching to the configured one',
					)
					const switched = await addNewAddress(page, opts.address!, innerTimeout)
					if (switched) {
						// Re-verify; if the target now shows, great. Otherwise fall back.
						const after = await page.evaluate(() => document.body.innerText).catch(() => '')
						return displayedAddressMatches(after, target)
							? 'shipping-switched-to-configured-address'
							: 'shipping-switch-attempted'
					}
					console.warn(
						'[shipping] could not switch address — proceeding with Nike pre-selected address (FALLBACK, no crash)',
					)
					return 'shipping-address-mismatch-fallback'
				}

				return 'shipping-already-complete'
			}

			// Shipping section is editable. Detect whether the form is empty.
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
				await revealManualAddressFields(page)
				await fillAddressForm(page, opts.address)
			}

			// Pick the first matching continue button (page has several submit buttons).
			const shippingButton = page.locator(selectors.checkout.shippingContinueButton).first()
			try {
				await shippingButton.waitFor({ state: 'visible', timeout: innerTimeout })
			} catch {
				throw Object.assign(new Error('Shipping continue button not visible'), { code: 'TIMEOUT' })
			}

			await naturalClick(page, shippingButton)

			// Wait for payment section to confirm shipping is complete.
			await page.waitForSelector(selectors.checkout.paymentSection, { timeout: innerTimeout })

			return formEmpty ? 'shipping-filled-and-complete' : 'shipping-complete'
		},
		timeoutMs,
	)
}

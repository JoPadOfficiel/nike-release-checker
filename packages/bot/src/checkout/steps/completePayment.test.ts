import { test } from 'node:test'
import assert from 'node:assert/strict'
import { completePayment } from './completePayment.ts'
import type { Selectors } from '../../config/selectorSchema.ts'

const selectors = {
	checkout: {
		paymentSection: 'section.payment',
		paymentContinueButton: 'button.payment-continue',
		threeDSIframe: 'iframe.3ds',
		submitOrderButton: 'button.submit-order',
	},
} as unknown as Selectors

interface FakeLocator {
	visible: boolean
	enabled: boolean
	value: string
	fillCalls: string[]
	clickCalls: number
	first: () => FakeLocator
	isVisible: () => Promise<boolean>
	isEnabled: () => Promise<boolean>
	inputValue: () => Promise<string>
	fill: (v: string) => Promise<void>
	click: () => Promise<void>
	evaluate: (fn: unknown) => Promise<void>
	waitFor: () => Promise<void>
	boundingBox: () => Promise<null>
}

function makeLocator(opts: { visible?: boolean; enabled?: boolean; value?: string } = {}): FakeLocator {
	const loc: FakeLocator = {
		visible: opts.visible ?? true,
		enabled: opts.enabled ?? true,
		value: opts.value ?? '',
		fillCalls: [],
		clickCalls: 0,
		first(): FakeLocator { return loc },
		async isVisible(): Promise<boolean> { return loc.visible },
		async isEnabled(): Promise<boolean> { return loc.enabled },
		async inputValue(): Promise<string> { return loc.value },
		async fill(v: string): Promise<void> { loc.fillCalls.push(v); loc.value = v },
		async click(): Promise<void> { loc.clickCalls++ },
		async evaluate(): Promise<void> { loc.clickCalls++ },
		async waitFor(): Promise<void> { /* noop */ },
		async boundingBox(): Promise<null> { return null },
	}
	return loc
}

function makePage(locators: Record<string, FakeLocator>) {
	return {
		locator(sel: string) {
			const found = locators[sel]
			if (found) return found
			return makeLocator({ visible: false })
		},
		async waitForSelector(): Promise<void> { /* noop */ },
		async waitForTimeout(): Promise<void> { /* noop */ },
		mouse: {
			async move(): Promise<void> { /* noop */ },
			async wheel(): Promise<void> { /* noop */ },
		},
		frameLocator(_sel: string) {
			// No Adyen iframe present in tests — return a frame whose locators are
			// all invisible so the implementation falls back to the page DOM.
			return {
				locator(_s: string) { return makeLocator({ visible: false }) },
				first() { return this },
			}
		},
	}
}

test('completePayment: clicks continue when card form is pre-filled', async () => {
	const continueBtn = makeLocator({ visible: true, enabled: true })
	// Card number input visible AND populated → form NOT empty.
	const cardNumber = makeLocator({ visible: true, value: '4242424242424242' })
	const page = makePage({
		'button.payment-continue': continueBtn,
		'input[name="cardNumber"]': cardNumber,
	})

	const result = await completePayment(page as never, selectors, { timeoutMs: 1000 })
	assert.equal(result.outcome, 'success')
	assert.equal(result.details, 'payment-complete')
	assert.equal(continueBtn.clickCalls, 1)
	assert.deepEqual(cardNumber.fillCalls, [])
})

test('completePayment: fills empty card form using opts.card', async () => {
	const continueBtn = makeLocator({ visible: true, enabled: true })
	const cardNumber = makeLocator({ visible: true, value: '' })
	const expiry = makeLocator({ visible: true })
	const cvv = makeLocator({ visible: true })
	const holder = makeLocator({ visible: true })

	const page = makePage({
		'button.payment-continue': continueBtn,
		'input[name="cardNumber"]': cardNumber,
		'input[name="expirationDate"]': expiry,
		'input[name="cvNumber"]': cvv,
		'input[name="cardholderName"]': holder,
	})

	const result = await completePayment(page as never, selectors, {
		timeoutMs: 1000,
		card: {
			number: '4111111111111111',
			expiry: '12/27',
			cvv: '123',
			holderName: 'CANDID AUDIO',
		},
	})

	assert.equal(result.outcome, 'success')
	assert.equal(result.details, 'payment-filled-and-complete')
	assert.deepEqual(cardNumber.fillCalls, ['4111111111111111'])
	assert.deepEqual(expiry.fillCalls, ['12/27'])
	assert.deepEqual(cvv.fillCalls, ['123'])
	assert.deepEqual(holder.fillCalls, ['CANDID AUDIO'])
	assert.equal(continueBtn.clickCalls, 1)
})

test('completePayment: errors when card form is empty and no card provided', async () => {
	const continueBtn = makeLocator({ visible: true, enabled: true })
	const cardNumber = makeLocator({ visible: true, value: '' })

	const page = makePage({
		'button.payment-continue': continueBtn,
		'input[name="cardNumber"]': cardNumber,
	})

	const result = await completePayment(page as never, selectors, { timeoutMs: 1000 })
	assert.equal(result.outcome, 'error')
	assert.match(result.error ?? '', /payment form empty/)
	assert.equal(continueBtn.clickCalls, 0)
})

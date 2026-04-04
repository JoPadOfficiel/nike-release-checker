import { describe, it, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSelectors } from './index.ts'

const tmpSelectors = join(tmpdir(), `test-selectors-${Date.now()}.yaml`)

const VALID_YAML = `
sizeAvailable: '[data-qa="size-available"]'
sizeSelected: '[data-qa="size-available"][aria-checked="true"]'
purchaseButton: '.ncss-btn-primary-dark.btn-lg'
checkoutLink: 'a[href="/fr/checkout"]'
shippingSaveButton: '[data-attr="saveAddressBtn"]'
paymentContinueButton: '[data-attr="continuePaymentBtn"]'
orderSubmitButton: '[data-attr="placeOrderBtn"]'
soldOutIndicator: '[data-qa="not-available-message"]'
blockDetectionSignal: '#challenge-running'
threeDSecureIframe: 'iframe[src*="3ds"]'
`

describe('loadSelectors', () => {
	after(async () => {
		await rm(tmpSelectors, { force: true })
	})

	it('loads a valid complete selectors file successfully', async () => {
		await writeFile(tmpSelectors, VALID_YAML)
		const selectors = await loadSelectors(tmpSelectors)
		assert.equal(selectors.sizeAvailable, '[data-qa="size-available"]')
		assert.equal(selectors.purchaseButton, '.ncss-btn-primary-dark.btn-lg')
		assert.equal(selectors.orderSubmitButton, '[data-attr="placeOrderBtn"]')
		assert.equal(selectors.threeDSecureIframe, 'iframe[src*="3ds"]')
	})

	it('throws with field name when a single required key is missing', async () => {
		await writeFile(
			tmpSelectors,
			VALID_YAML.replace(/^purchaseButton:.*$/m, ''),
		)
		await assert.rejects(
			() => loadSelectors(tmpSelectors),
			(err: Error) => err.message.includes('purchaseButton'),
		)
	})

	it('throws listing all missing keys when multiple required keys are absent', async () => {
		await writeFile(
			tmpSelectors,
			`
sizeAvailable: '.size'
sizeSelected: '.size-sel'
purchaseButton: '.buy'
`,
		)
		await assert.rejects(
			() => loadSelectors(tmpSelectors),
			(err: Error) =>
				err.message.includes('checkoutLink') &&
				err.message.includes('orderSubmitButton') &&
				err.message.includes('threeDSecureIframe'),
		)
	})

	it('throws listing all required keys when file is empty', async () => {
		await writeFile(tmpSelectors, '')
		await assert.rejects(
			() => loadSelectors(tmpSelectors),
			(err: Error) => err.message.includes('Invalid selectors'),
		)
	})

	it('throws with path and mentions selectors.example.yaml when file is not found', async () => {
		const missingPath = '/nonexistent/selectors.yaml'
		await assert.rejects(
			() => loadSelectors(missingPath),
			(err: Error) =>
				err.message.includes('Selectors file not found') &&
				err.message.includes(missingPath) &&
				err.message.includes('selectors.example.yaml'),
		)
	})

	it('loads successfully and ignores extra unknown keys', async () => {
		await writeFile(tmpSelectors, VALID_YAML + '\nunknownKey: ".something"\n')
		const selectors = await loadSelectors(tmpSelectors)
		assert.equal(selectors.sizeAvailable, '[data-qa="size-available"]')
		assert.ok(!('unknownKey' in selectors), 'Unknown keys should be stripped by Valibot')
	})

	it('loads selectors.example.yaml as a valid reference file', async () => {
		const examplePath = new URL('../../selectors.example.yaml', import.meta.url).pathname
		const exampleContent = await readFile(examplePath, 'utf-8')
		await writeFile(tmpSelectors, exampleContent)
		const selectors = await loadSelectors(tmpSelectors)
		assert.ok(selectors.sizeAvailable)
		assert.ok(selectors.purchaseButton)
		assert.ok(selectors.threeDSecureIframe)
	})
})

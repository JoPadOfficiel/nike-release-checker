import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as v from 'valibot'
import { CountrySchema } from './types.ts'
import { countryRegistry, UnknownCountryError } from './registry.ts'

describe('countryRegistry — shape validation', () => {
	test('all 10 entries pass CountrySchema (also asserted at module load)', () => {
		const all = countryRegistry.list()
		assert.equal(all.length, 10, 'should have 10 entries')
		for (const entry of all) {
			assert.doesNotThrow(
				() => v.parse(CountrySchema, entry),
				`entry ${entry.code} should pass CountrySchema`,
			)
		}
	})
})

describe('countryRegistry — get()', () => {
	test('get("FR") returns the FR entry', () => {
		const fr = countryRegistry.get('FR')
		assert.equal(fr.code, 'FR')
		assert.equal(fr.currency, 'EUR')
		assert.equal(fr.locale, 'fr-FR')
		assert.equal(fr.enabled, true)
	})

	test('get("fr") (lowercase) also returns FR entry', () => {
		const fr = countryRegistry.get('fr')
		assert.equal(fr.code, 'FR')
	})

	test('get("XX") throws UnknownCountryError with .code === "XX"', () => {
		assert.throws(
			() => countryRegistry.get('XX'),
			(err: unknown) => {
				assert.ok(err instanceof UnknownCountryError)
				assert.equal(err.code, 'XX')
				return true
			},
		)
	})
})

describe('countryRegistry — isSupported()', () => {
	test('isSupported("FR") === true (v3.0 only FR enabled)', () => {
		assert.equal(countryRegistry.isSupported('FR'), true)
	})

	test('isSupported("US") === false (v3.0 baseline)', () => {
		assert.equal(countryRegistry.isSupported('US'), false)
	})

	test('isSupported("XX") === false (unknown country)', () => {
		assert.equal(countryRegistry.isSupported('XX'), false)
	})
})

describe('countryRegistry — list()', () => {
	test('list() returns all 10 entries', () => {
		assert.equal(countryRegistry.list().length, 10)
	})

	test('list({ enabledOnly: true }) returns only FR in v3.0', () => {
		const enabled = countryRegistry.list({ enabledOnly: true })
		assert.equal(enabled.length, 1)
		assert.equal(enabled[0]?.code, 'FR')
	})
})

describe('countryRegistry — immutability', () => {
	test('frozen entry throws in strict mode when mutating', () => {
		const fr = countryRegistry.get('FR')
		assert.throws(() => {
			;(fr as Record<string, unknown>)['code'] = 'XX'
		})
	})
})

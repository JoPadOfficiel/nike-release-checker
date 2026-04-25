import * as v from 'valibot'
import { CountrySchema, UnknownCountryError } from './types.ts'
import type { Country } from './types.ts'
import { FR } from './entries/fr.ts'
import { US } from './entries/us.ts'
import { GB } from './entries/gb.ts'
import { DE } from './entries/de.ts'
import { JP } from './entries/jp.ts'
import { ES } from './entries/es.ts'
import { IT } from './entries/it.ts'
import { NL } from './entries/nl.ts'
import { BE } from './entries/be.ts'
import { AU } from './entries/au.ts'

const ENTRIES: ReadonlyArray<Country> = Object.freeze([FR, US, GB, DE, JP, ES, IT, NL, BE, AU])

// Validate every entry at module load — fail fast on shape drift
for (const entry of ENTRIES) v.parse(CountrySchema, entry)

const BY_CODE = new Map(ENTRIES.map((c) => [c.code, c]))

export const countryRegistry = {
	get(code: string): Country {
		const entry = BY_CODE.get(code.toUpperCase())
		if (!entry) throw new UnknownCountryError(code)
		return entry
	},
	list(opts?: { enabledOnly?: boolean }): Country[] {
		return opts?.enabledOnly === true ? ENTRIES.filter((c) => c.enabled) : [...ENTRIES]
	},
	isSupported(code: string): boolean {
		const entry = BY_CODE.get(code.toUpperCase())
		return entry?.enabled === true
	},
}

export { UnknownCountryError } from './types.ts'
export type { Country } from './types.ts'

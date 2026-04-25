# Story 13.1: Country Registry — Interface + Initial Country Set

Status: backlog

## Story

As a SaaS operator,
I want a typed `Country` registry covering at minimum FR, US, UK, DE, JP, ES, IT, NL, BE, AU,
so that all multi-country code paths (cart endpoint country, locale headers, validation, selectors, Adyen iframe) read from a single source of truth instead of hard-coding `FR`. (FR56)

## Acceptance Criteria

**Given** the bot package is scaffolded and TypeScript strict mode is enforced
**When** `packages/bot/src/country/registry.ts` and `packages/bot/src/country/types.ts` are created
**Then** the `Country` interface exposes fields: `code` (ISO 3166-1 alpha-2), `name`, `currency` (ISO 4217), `locale` (BCP 47), `languageCode`, `defaultPhonePrefix`, `phonePattern` (RegExp), `zipPattern` (RegExp), `addressFields` (string[] ordering), `adyenIframeLocale`, `selectorOverridePath` (string | null)
**And** a `CountryRegistry` exposes `get(code)`, `list()`, `isSupported(code)`, with `get` throwing a typed `UnknownCountryError` on miss
**And** registry ships with static immutable entries for FR, US, UK (`GB`), DE, JP, ES, IT, NL, BE, AU — each entry validated by a valibot schema at module load
**And** v3.0 only flips `isSupported` to `true` for `FR`; the other 9 entries are present but flagged `enabled: false` (so v3.1/v3.2 can promote them by changing one boolean, with no shape change)
**And** unit tests cover: every entry passes the valibot shape check, `get('FR')` returns the FR entry, `get('XX')` throws `UnknownCountryError`, `isSupported('US')` returns `false` in v3.0, `list({ enabledOnly: true })` returns only enabled countries
**And** no other module in `packages/bot/` references country fields directly — they all go through `registry.get(code)`

## Tasks / Subtasks

### Task 1: Define `Country` type and valibot schema (AC: type shape)

Create `packages/bot/src/country/types.ts`:

```typescript
import * as v from 'valibot'

export const CountrySchema = v.object({
  code: v.pipe(v.string(), v.length(2), v.regex(/^[A-Z]{2}$/)),
  name: v.pipe(v.string(), v.minLength(1)),
  currency: v.pipe(v.string(), v.length(3), v.regex(/^[A-Z]{3}$/)),
  locale: v.pipe(v.string(), v.regex(/^[a-z]{2}-[A-Z]{2}$/)),
  languageCode: v.pipe(v.string(), v.length(2)),
  defaultPhonePrefix: v.pipe(v.string(), v.regex(/^\+\d{1,3}$/)),
  phonePattern: v.instance(RegExp),
  zipPattern: v.instance(RegExp),
  addressFields: v.array(v.picklist(['street', 'street2', 'city', 'state', 'zip', 'country'])),
  adyenIframeLocale: v.pipe(v.string(), v.regex(/^[a-z]{2}_[A-Z]{2}$/)),
  selectorOverridePath: v.nullable(v.string()),
  enabled: v.boolean(),
})

export type Country = v.InferOutput<typeof CountrySchema>

export class UnknownCountryError extends Error {
  constructor(public readonly code: string) {
    super(`Unknown country code: ${code}`)
  }
}
```

### Task 2: Create static country entries (AC: 10 country entries)

Create `packages/bot/src/country/entries/` with one file per country (`fr.ts`, `us.ts`, `gb.ts`, `de.ts`, `jp.ts`, `es.ts`, `it.ts`, `nl.ts`, `be.ts`, `au.ts`). Each file exports a `Country` const. Examples:

- **FR** (enabled): `{ code:'FR', name:'France', currency:'EUR', locale:'fr-FR', languageCode:'fr', defaultPhonePrefix:'+33', phonePattern:/^\+33[1-9]\d{8}$/, zipPattern:/^\d{5}$/, addressFields:['street','city','zip','country'], adyenIframeLocale:'fr_FR', selectorOverridePath:null, enabled:true }`
- **US** (disabled v3.0): `{ code:'US', name:'United States', currency:'USD', locale:'en-US', languageCode:'en', defaultPhonePrefix:'+1', phonePattern:/^\+1\d{10}$/, zipPattern:/^\d{5}(-\d{4})?$/, addressFields:['street','street2','city','state','zip','country'], adyenIframeLocale:'en_US', selectorOverridePath:'selectors/US.yaml', enabled:false }`
- **GB** (disabled): postcode pattern must match UK alphanumeric format `/^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i`
- Equivalent shapes for DE, JP, ES, IT, NL, BE, AU

Each entry is `as const` and frozen via `Object.freeze`.

### Task 3: Implement registry (AC: get/list/isSupported semantics)

Create `packages/bot/src/country/registry.ts`:

```typescript
import * as v from 'valibot'
import { CountrySchema, UnknownCountryError, type Country } from './types.js'
import { FR } from './entries/fr.js' /* ...other imports */

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
    return opts?.enabledOnly ? ENTRIES.filter((c) => c.enabled) : [...ENTRIES]
  },
  isSupported(code: string): boolean {
    const entry = BY_CODE.get(code.toUpperCase())
    return entry?.enabled === true
  },
}
```

### Task 4: Unit tests (AC: scenarios listed)

Create `packages/bot/src/country/registry.test.ts`:

- All 10 entries pass `v.parse(CountrySchema, entry)` (asserted by importing the registry — module-load throws on failure)
- `get('FR')` returns FR entry; `get('fr')` (lowercase) also returns FR entry
- `get('XX')` throws `UnknownCountryError` with `.code === 'XX'`
- `isSupported('FR') === true`, `isSupported('US') === false` (v3.0 baseline)
- `list().length === 10`, `list({ enabledOnly: true }).length === 1`
- Frozen entry: attempting `(registry.get('FR') as any).code = 'XX'` throws in strict mode

### Task 5: Documentation block in `packages/bot/src/country/README.md` (AC: source-of-truth doc)

Short doc explaining: how to add a country (create `entries/<cc>.ts` + register), how to flip a country to enabled, the valibot guarantee, and the no-direct-field-access rule. Include a one-line note: "every other module imports `countryRegistry`, never an entry file directly."

## Dev Notes

### Why a Static Registry vs Dynamic Config

Country definitions are infrequent-change data tied to code (regex, address ordering). A YAML file would still need a TypeScript loader and would not give compile-time safety against typos like `'F'` vs `'FR'`. Static module = compile-time `as const` + IDE autocomplete + no runtime IO.

### Why Pre-Ship 10 Entries Even Though v3.0 is FR-only

Architecture section "Multi-country Abstraction" explicitly lists FR, US, UK, DE, JP, ES, IT, NL, BE, AU. Pre-shipping the entries ensures every downstream story (13.2 endpoint, 13.3 validation, 13.4 selectors, 13.5 drop CSV) treats country as a generic parameter from day one — no last-minute refactors when v3.1 promotes US/UK/DE.

### UK = `GB` Quirk

ISO 3166-1 alpha-2 code is `GB` not `UK`. Operator-facing surfaces (drop.csv, accounts.csv) accept `UK` or `GB` and normalize to `GB` before lookup. This story owns the canonical code; the input-normalization is Story 13.5's concern.

### Project Structure Notes

New files:
- `packages/bot/src/country/types.ts`
- `packages/bot/src/country/registry.ts`
- `packages/bot/src/country/registry.test.ts`
- `packages/bot/src/country/entries/{fr,us,gb,de,jp,es,it,nl,be,au}.ts`
- `packages/bot/src/country/README.md`

No existing files modified.

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` Epic 13 + Story 13.1 skeleton
- PRD: `_bmad-output/planning-artifacts/prd.md` FR56
- Architecture: `_bmad-output/planning-artifacts/architecture.md` "Multi-country Abstraction" (lines ~108-131)
- Downstream consumers: Story 13.2 (cart endpoint), 13.3 (validation), 13.4 (selectors), 13.5 (drop.csv country column)

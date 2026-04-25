# Story 13.3: Per-Country Locale Validation (Phone + Zip)

Status: backlog

## Story

As a SaaS operator,
I want phone numbers and ZIP/postal codes validated against per-country regex rules at both CSV-load time and API-request time,
so that operators see human-readable row-level errors before the drop instead of cryptic Nike 4xx responses mid-checkout. (FR59, NFR34)

## Acceptance Criteria

**Given** the country registry from Story 13.1 with `phonePattern` and `zipPattern` per country
**When** `packages/bot/src/country/validation.ts` exposes `validatePhone(code, value)` and `validateZip(code, value)`
**Then** each function returns `{ ok: true }` or `{ ok: false, expected: string, country: string, value: string }` with a country-specific human-readable `expected` ("e.g. `+33612345678` (FR mobile, 10 digits with +33 prefix)")
**And** valibot schemas keyed by country are exposed: `phoneSchema(code)` and `zipSchema(code)` returning `v.GenericSchema<string>` instances
**And** `addresses.csv` parser (Story 10.3) is extended to use these schemas based on the row's `country` column — replacing the loose generic phone regex
**And** every API request body that carries a phone or zip (`cart_views` shipping payload, `payment` billing address) is re-validated server-side before send; a validation failure aborts the checkout with classification `invalid_address` instead of letting Nike reject it
**And** suggested-fix messages are country-specific — e.g. for US zip `12345` says "OK"; for `1234` says "expected 5-digit US ZIP (e.g. 90210) or ZIP+4 (90210-1234)"
**And** unit tests cover at least 3 valid + 3 invalid samples per country for the 10 registry countries (60 phone cases + 60 zip cases minimum)
**And** an empty/null phone is allowed (phone is optional per Story 10.3); empty zip is always rejected (zip is required)

## Tasks / Subtasks

### Task 1: Define validation result type + helpers (AC: result shape)

- **File:** `packages/bot/src/country/validation.ts` (new)

```typescript
import { countryRegistry } from './registry.js'

export type ValidationResult =
  | { ok: true }
  | { ok: false; field: 'phone' | 'zip'; country: string; value: string; expected: string }

export function validatePhone(countryCode: string, value: string): ValidationResult {
  if (value === '') return { ok: true } // phone optional
  const country = countryRegistry.get(countryCode)
  if (country.phonePattern.test(value)) return { ok: true }
  return {
    ok: false,
    field: 'phone',
    country: country.code,
    value,
    expected: PHONE_HINTS[country.code],
  }
}

export function validateZip(countryCode: string, value: string): ValidationResult {
  const country = countryRegistry.get(countryCode)
  if (value !== '' && country.zipPattern.test(value)) return { ok: true }
  return {
    ok: false,
    field: 'zip',
    country: country.code,
    value,
    expected: ZIP_HINTS[country.code],
  }
}
```

### Task 2: Country-specific hint table (AC: human-readable expected messages)

- **File:** `packages/bot/src/country/validationHints.ts` (new)

```typescript
export const PHONE_HINTS: Record<string, string> = {
  FR: 'e.g. +33612345678 (FR mobile, 10 digits with +33 prefix)',
  US: 'e.g. +14155552671 (US, 10 digits with +1 prefix)',
  GB: 'e.g. +447911123456 (UK mobile, 10 digits with +44 prefix)',
  DE: 'e.g. +491701234567 (DE mobile, 10-11 digits with +49 prefix)',
  JP: 'e.g. +819012345678 (JP mobile, 10-11 digits with +81 prefix)',
  ES: 'e.g. +34612345678 (ES mobile, 9 digits with +34 prefix)',
  IT: 'e.g. +393123456789 (IT mobile, 9-10 digits with +39 prefix)',
  NL: 'e.g. +31612345678 (NL mobile, 9 digits with +31 prefix)',
  BE: 'e.g. +32412345678 (BE mobile, 9 digits with +32 prefix)',
  AU: 'e.g. +61412345678 (AU mobile, 9 digits with +61 prefix)',
}

export const ZIP_HINTS: Record<string, string> = {
  FR: 'expected 5-digit French postal code (e.g. 75001)',
  US: 'expected 5-digit US ZIP (e.g. 90210) or ZIP+4 (90210-1234)',
  GB: 'expected UK postcode (e.g. SW1A 1AA)',
  DE: 'expected 5-digit German Postleitzahl (e.g. 10115)',
  JP: 'expected 7-digit Japanese postcode with hyphen (e.g. 100-0001)',
  ES: 'expected 5-digit Spanish código postal (e.g. 28001)',
  IT: 'expected 5-digit Italian CAP (e.g. 00100)',
  NL: 'expected NL postcode (e.g. 1012 JS)',
  BE: 'expected 4-digit Belgian postcode (e.g. 1000)',
  AU: 'expected 4-digit Australian postcode (e.g. 2000)',
}
```

### Task 3: Valibot schemas for CSV parsing reuse (AC: schemas keyed by country)

- **File:** `packages/bot/src/country/validation.ts` (continue)
- Expose factories that wrap valibot:

```typescript
import * as v from 'valibot'

export function phoneSchema(countryCode: string) {
  const country = countryRegistry.get(countryCode)
  return v.union([
    v.literal(''),
    v.pipe(v.string(), v.regex(country.phonePattern, PHONE_HINTS[country.code])),
  ])
}

export function zipSchema(countryCode: string) {
  const country = countryRegistry.get(countryCode)
  return v.pipe(v.string(), v.regex(country.zipPattern, ZIP_HINTS[country.code]))
}
```

These return `v.GenericSchema<string>` instances usable inside larger object schemas.

### Task 4: Wire into addresses.csv parser (AC: per-row country-aware validation)

- **File:** `packages/bot/src/config/addressesCsv.ts` (modify — created in Story 10.3)
- Replace the loose generic `phone` regex with `phoneSchema(row.country)` resolved per-row at parse time
- Replace the generic `zip: v.string().minLength(1)` with `zipSchema(row.country)`
- A row with an unknown `country` short-circuits to a single error "country `XX` not supported (see `nike-bot countries` for list)" instead of cascading phone/zip errors
- Error messages flow through the existing `CsvError` pipeline with the country-specific `expected` hint as the `suggestedFix`

### Task 5: Wire into API request guards (AC: re-validation server-side)

- **File:** `packages/bot/src/checkout/cartViewsApi.ts` (modify)
- Before sending a `PUT /buy/cart_views/v1/{view-uuid}` shipping payload, run `validatePhone(country, payload.phone)` and `validateZip(country, payload.zip)`
- On failure, throw `InvalidAddressError` with `field`, `country`, `expected`
- Caller (checkout pipeline) catches and classifies the outcome as `invalid_address` (new outcome added to Story 5.7's enum via a follow-up edit; documented in Dev Notes)

### Task 6: Unit tests (AC: 60+ phone + 60+ zip cases)

- **File:** `packages/bot/src/country/validation.test.ts` (new)
- Per-country fixture file `packages/bot/src/country/__fixtures__/validationCases.ts` with `{ valid: string[]; invalid: string[] }` entries for each of the 10 countries (3+3 minimum)
- Loop assertion: for each country × each valid sample, `validatePhone(cc, v).ok === true`; for each invalid, `ok === false` with `expected` matching the hint
- Same loop for `validateZip`
- Edge cases: empty phone returns `ok: true`; empty zip returns `ok: false`; unknown country code throws `UnknownCountryError`

## Dev Notes

### Validation at Two Layers

CSV parse-time validation catches the **bulk** of operator errors before the drop. API-request-time validation is a defense-in-depth: even if a downstream code path constructs a payload from non-CSV data (e.g. a vault import, future REST API), the request-time guard prevents Nike from rejecting it. The duplication is intentional and cheap.

### Why Hint Strings Live in a Separate File

`validation.ts` is pure logic; `validationHints.ts` is i18n-adjacent operator-facing copy. Future work (v3.2+) may translate hints per operator locale. Splitting now avoids touching validation logic when copy changes.

### `invalid_address` Outcome

Story 5.7 currently lists 8 outcome types. Adding `invalid_address` is a follow-up edit — call out in PR description; this story does not edit Story 5.7 directly to keep the diff scoped.

### Country-Code Field on `addresses.csv`

Story 10.3 already has a `country` column on `addresses.csv`. This story changes its semantic from "ISO format check only" to "lookup key into the country registry." If the country is not in the registry, validation fails at parse time with a clear message — no silent passthrough to Nike.

### Project Structure Notes

New files:
- `packages/bot/src/country/validation.ts`
- `packages/bot/src/country/validationHints.ts`
- `packages/bot/src/country/validation.test.ts`
- `packages/bot/src/country/__fixtures__/validationCases.ts`

Modified files:
- `packages/bot/src/config/addressesCsv.ts`
- `packages/bot/src/config/addressesCsvSchema.ts`
- `packages/bot/src/checkout/cartViewsApi.ts`

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` Story 13.3
- PRD: FR59, NFR34
- Architecture: "Multi-country Abstraction" (per-country phoneFormat / zipFormat)
- Depends on: Story 13.1 (registry), Story 10.3 (addresses.csv parser)
- Consumed by: Story 12.3 (cart_views shipping), Story 5.7 (outcome classification — needs `invalid_address` added)

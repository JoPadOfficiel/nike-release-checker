# Story 13.5: Multi-Country `drop.csv` Schema Extension

Status: backlog

## Story

As a SaaS operator stacking drops across markets,
I want `drop.csv` to accept an optional `country` column per row,
so that one CSV can schedule a US drop and a JP drop in the same execution batch — falling back to the bot.config default when the column is omitted. (FR51 extension, FR56)

## Acceptance Criteria

**Given** the existing `drop.csv` schema from Story 10.4 (`sku,sizes,accounts_filter`) and the country registry from Story 13.1
**When** the schema is extended to `sku,sizes,accounts_filter,country` with `country` optional
**Then** rows without a `country` value default to `bot.config.yaml` `checkout.market` (currently `FR`)
**And** rows with a country value are validated via `countryRegistry.isSupported(code)` at parse time — disabled or unknown countries surface a row-level error with the row number and the unrecognized code
**And** input normalization: `UK`→`GB`, lowercase→uppercase before lookup; trailing whitespace stripped
**And** the parsed `Drop` type gains a `country: string` field (always populated post-parse — defaults already applied)
**And** `accounts_filter` resolution is country-scoped: when `accounts_filter=all`, only accounts whose `accounts.csv country` matches the drop's `country` are selected (so a `JP` drop with `all` filter doesn't pull in FR accounts)
**And** the drop runner passes `drop.country` into the `cartApi`, `cart_views`, `payment`, `review`, `checkout` API constructors (via Story 13.2's parameterized endpoints)
**And** unit tests cover: missing country defaults to config, valid country code, unknown country code errors, disabled country code errors (US in v3.0), `UK`→`GB` normalization, `all` filter scoped per-country, mixed-country CSV with both FR and JP rows
**And** the existing `drop.csv` example template (Story 9.6) is updated to document the new column with a sample row

## Tasks / Subtasks

### Task 1: Extend `drop.csv` valibot schema (AC: optional country with default + validation)

- **File:** `packages/bot/src/config/dropCsvSchema.ts` (modify — created in Story 10.4)

```typescript
import * as v from 'valibot'
import { countryRegistry } from '../country/registry.js'

export const DropCsvRowSchema = v.object({
  sku: v.pipe(v.string(), v.regex(/^[A-Z0-9-]+$/)),
  sizes: v.pipe(v.string(), v.minLength(1)),
  accounts_filter: v.pipe(v.string(), v.minLength(1)),
  country: v.optional(v.string(), ''),
})

export type DropCsvRow = v.InferOutput<typeof DropCsvRowSchema>
```

Country validation happens in the parser (Task 2) so we can surface row-level errors with the row index, not at the schema layer.

### Task 2: Country normalization + resolution helper (AC: UK→GB, casing)

- **File:** `packages/bot/src/country/normalize.ts` (new)

```typescript
const ALIASES: Record<string, string> = { UK: 'GB' }

export function normalizeCountryCode(input: string): string {
  const upper = input.trim().toUpperCase()
  return ALIASES[upper] ?? upper
}
```

Used by the drop parser AND by the accounts.csv parser (follow-up — flagged in Dev Notes; not modified here to keep diff scoped).

### Task 3: Extend `parseDropCsv` (AC: per-row country resolution + scoping)

- **File:** `packages/bot/src/config/dropCsv.ts` (modify)
- After valibot row parse, for each row:
  1. If `country === ''`, set to `defaultCountry` from `bot.config.yaml` `checkout.market`
  2. Normalize via `normalizeCountryCode(row.country)`
  3. If `!countryRegistry.isSupported(normalized)`:
     - If country exists but `enabled: false` → error: "row N: country `US` is in registry but disabled in v3.0 (enable it via Story 13.x)"
     - If country not in registry → error: "row N: unknown country code `XX` (see `nike-bot countries` for supported list)"
  4. Replace `row.country` with the normalized value
- Public type:

```typescript
export type Drop = {
  sku: string
  sizes: string[]
  accountsFilter: 'all' | string[]
  country: string  // always populated post-parse
}

export async function parseDropCsv(
  filePath: string,
  defaultCountry: string,
): Promise<{ drops: Drop[]; errors: CsvError[] }>
```

### Task 4: Country-scoped `accounts_filter=all` resolution (AC: per-country `all` semantics)

- **File:** `packages/bot/src/checkout/dropRunner.ts` (modify — exists per Stories 10.4/11.3)
- When resolving `accounts_filter=all` at execution time, filter the account pool by `account.country === drop.country`
- Explicit `account_id` lists are NOT filtered by country (operator opts in deliberately) but a warning is logged if a listed account's country differs from the drop's country: "drop SKU AH7389-106 country JP includes account kev_001 (country FR) — Nike may reject the order"

### Task 5: Wire drop.country through the API pipeline (AC: country flows into endpoints)

- **File:** `packages/bot/src/checkout/dropRunner.ts` (continue)
- For each drop, when constructing per-account checkout pipelines:
  - `new NikeCartApi(page, drop.country)` — Story 13.2 contract
  - Same for `cart_views`, `payment`, `review`, `checkout` API modules
  - Pass `drop.country` into `loadSelectorsForCountry(drop.country)` — Story 13.4
  - Pass `drop.country` into `getProductFeed({ marketplace: drop.country, ... })` — Story 13.2 Task 3

### Task 6: Update CSV template + unit tests (AC: documentation + scenarios)

- **File:** `packages/bot/templates/drop.csv` (modify — created in Story 9.6)
- Add header comment for the new `country` column:

```csv
# sku,sizes,accounts_filter,country
# country: optional. ISO 3166-1 alpha-2 (e.g. FR, US, JP). Defaults to bot.config.yaml checkout.market when omitted.
# accounts_filter=all is scoped per-country — only accounts in the drop's country are selected.
sku,sizes,accounts_filter,country
AH7389-106,42;42.5;43,all,FR
DD1391-100,US9;US9.5,all,US
```

- **File:** `packages/bot/src/config/dropCsv.test.ts` (extend)
- Test 1: row without `country` → resolves to `defaultCountry` (`FR` in test fixture)
- Test 2: row with `country=FR` → resolves to `FR`
- Test 3: row with `country=fr` (lowercase) → normalizes to `FR`
- Test 4: row with `country=UK` → normalizes to `GB`
- Test 5: row with `country=XX` → error with row number + suggestion message
- Test 6: row with `country=US` (v3.0 disabled) → error mentioning disabled state
- Test 7: backward compatibility — old CSV without `country` column at all → all rows inherit default
- Test 8: mixed-country CSV (FR row + JP row) → 2 drops, each with correct country
- Test 9: `accounts_filter=all` scoped — JP drop with mixed-country account pool returns only JP accounts (mock account list with FR and JP entries)

## Dev Notes

### Backward Compatibility

Existing v2 `drop.csv` files (no country column) keep working — the missing column resolves to `bot.config.yaml` `checkout.market`. CSV header detection is case-insensitive (Story 10.3 helper) so `Country`, `country`, `COUNTRY` all match.

### Why Country-Scoped `accounts_filter=all`

A FR account checking out a JP product would fail at Nike's address validation (FR shipping address ≠ JP delivery zone). Pre-filtering at the runner layer prevents wasted browser context launches and surfaces operator intent earlier. Operators who genuinely want cross-country attempts use explicit `account_id` lists.

### Aliases

Only `UK → GB` for v3.0 because that is the documented historical confusion. Other ISO aliases (e.g. `EL → GR` for Greece) are not added preemptively. Add as needed when those countries enable.

### Disabled vs Unknown Country Error Distinction

A disabled country (in registry, `enabled: false`) suggests "v3.0 not yet, comes in v3.1" — actionable for operator. An unknown country (not in registry) suggests typo or unsupported market — actionable as "check the supported list." Two distinct messages help operators self-diagnose.

### Follow-up: accounts.csv Country Normalization

`accounts.csv` (Story 10.1) already has a `country` column. It currently does only an ISO-format check, not a registry lookup. Recommend a follow-up to apply `normalizeCountryCode` + `countryRegistry.isSupported` there too — flagged in Dev Notes; out of scope for this story.

### Project Structure Notes

New files:
- `packages/bot/src/country/normalize.ts`

Modified files:
- `packages/bot/src/config/dropCsvSchema.ts`
- `packages/bot/src/config/dropCsv.ts`
- `packages/bot/src/config/dropCsv.test.ts`
- `packages/bot/src/checkout/dropRunner.ts`
- `packages/bot/templates/drop.csv`

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` Story 13.5 (extension of 10.4)
- PRD: FR51 (drop.csv schema), FR56 (country registry), FR57 (per-country endpoint)
- Depends on: Story 13.1 (registry), Story 13.2 (parameterized endpoints), Story 13.4 (selector loader), Story 10.4 (drop.csv parser baseline)

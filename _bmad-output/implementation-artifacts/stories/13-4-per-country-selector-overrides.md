# Story 13.4: Per-Country Selector Overrides

Status: done

## Review Findings (2026-04-25)

### MEDIUM — Dead variable `overrideRel`/`overridePath` computed when `selectorOverridePath === null`
File: `packages/bot/src/country/selectorLoader.ts` lines 119-120
When `country.selectorOverridePath === null`, the variables `overrideRel` and `overridePath` were computed and never used. The conditional on line 121 immediately returned `null` without reading the file. Dead code that could mislead maintainers into thinking the computed path was somehow used.

## Patches Applied (2026-04-25)

| # | Severity | File | Change |
|---|----------|------|--------|
| 1 | MEDIUM | `selectorLoader.ts:119-138` | Replaced dead `overrideRel`/`overridePath` block with conditional that only computes path when `selectorOverridePath !== null`; improved error message to reference resolved path or `(no override)` |

## Story

As a SaaS operator running drops on multiple Nike country sites,
I want per-country `selectors/<COUNTRY>.yaml` files that override only the deltas vs the FR baseline,
so that I can ship a US drop with `selectors/US.yaml` containing 3 overridden keys instead of duplicating the entire 40-key selector set. (FR58)

## Acceptance Criteria

**Given** the existing `selectors.yaml` (FR baseline from Story 1.4) and the country registry from Story 13.1
**When** `packages/bot/src/country/selectorLoader.ts` is created
**Then** `loadSelectorsForCountry(code: string): Selectors` returns a merged selector map: defaults from `selectors.yaml` overridden by `selectors/<code>.yaml` if present
**And** the loader is a deep merge — keys absent from the country file inherit from base; keys present override; nested objects merge per-key (not whole-object replacement)
**And** if `selectors/<code>.yaml` does not exist, the function returns the base unchanged with no warning (silent passthrough — by design, since most countries share the FR DOM)
**And** the loader validates the merged result against the existing selector schema from Story 1.4; missing required keys throw with the country code in the error message ("Missing selector `purchaseButton` for country US after merging selectors/US.yaml + selectors.yaml")
**And** loaded selectors are cached per-country (LRU max 10 entries — one per supported country) to avoid repeated file reads during a drop
**And** existing checkout pipeline reads selectors via `selectorLoader.forCountry(country)` instead of the current single global `selectors` object
**And** unit tests cover: base-only (no override file), partial override (1 key), nested override (e.g. `threeDSecure.iframe`), missing required key after merge fails loudly, cache hit on second call

## Tasks / Subtasks

### Task 1: Selector loader module (AC: deep merge + schema validation)

- **File:** `packages/bot/src/country/selectorLoader.ts` (new)

```typescript
import { readFile, access } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { countryRegistry } from './registry.js'
import { SelectorsSchema, type Selectors } from '../config/selectorsSchema.js'
import * as v from 'valibot'

const cache = new Map<string, Selectors>()
const BASE_PATH = 'selectors.yaml'

async function readYamlIfExists(path: string): Promise<unknown | null> {
  try {
    await access(path)
  } catch {
    return null
  }
  return parseYaml(await readFile(path, 'utf8'))
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof out[key] === 'object'
    ) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out as T
}

export async function loadSelectorsForCountry(code: string): Promise<Selectors> {
  const country = countryRegistry.get(code)
  if (cache.has(country.code)) return cache.get(country.code)!

  const base = await readYamlIfExists(BASE_PATH)
  if (!base) throw new Error(`Base selectors file not found at ${BASE_PATH}`)

  const overridePath = country.selectorOverridePath ?? `selectors/${country.code}.yaml`
  const override = (await readYamlIfExists(overridePath)) ?? {}

  const merged = deepMerge(base as Record<string, unknown>, override as Record<string, unknown>)

  try {
    const validated = v.parse(SelectorsSchema, merged)
    cache.set(country.code, validated)
    return validated
  } catch (e) {
    throw new Error(
      `Invalid selectors for country ${country.code} after merging ${overridePath} + ${BASE_PATH}: ${(e as Error).message}`,
    )
  }
}

export function clearSelectorCache(): void {
  cache.clear()
}
```

### Task 2: Sample country override file (AC: example for US)

- **File:** `selectors/US.yaml` (new at repo root, alongside `selectors.yaml`)
- Contains only the deltas vs FR baseline. For v3.0 (US not yet enabled in registry), commit a minimal example file with documented overrides:

```yaml
# US-specific selector overrides. Inherits all keys from selectors.yaml
# Only override the deltas (Nike US uses different shipping button text + ZIP+4 input)
shipping:
  saveAddressBtn: "[data-attr=\"saveAddressBtn-us\"]"
  zipInput: "input[name=\"zipCode\"]"
checkout:
  url: "https://www.nike.com/checkout"  # no /us/ prefix on the US site
```

- Include header comment block explaining the override pattern: "this file is deep-merged on top of `selectors.yaml`. Keys absent here inherit from base."

### Task 3: Update checkout pipeline to read per-country selectors (AC: pipeline integration)

- **File:** `packages/bot/src/checkout/checkoutPipeline.ts` (modify)
- Replace any module-level `import { selectors } from '../config/selectors'` with per-call `await loadSelectorsForCountry(account.country)` resolved at the start of each checkout
- Pass the resolved `Selectors` into each step (`selectSize`, `addToCart`, `completeShipping`, `completePayment`, `submitOrder`) as a function argument so steps remain pure
- Cache hit on second account in same drop ensures zero overhead

### Task 4: Wire into Epic 11 warmup (AC: pre-resolve selectors at warmup)

- **File:** `packages/bot/src/monitor/warmupMode.ts` (modify — created in Story 11.3)
- During the T-1 context pre-launch phase, eagerly call `loadSelectorsForCountry(account.country)` for each unique country in the drop's account set. Hot cache means T=0 has zero IO overhead
- For v3.0 with FR-only this is a single call; documented future-proofing for v3.1+

### Task 5: Unit tests (AC: scenarios listed)

- **File:** `packages/bot/src/country/selectorLoader.test.ts` (new)
- Test fixtures: tmp `selectors.yaml` and tmp `selectors/US.yaml`, `selectors/JP.yaml`
- Test 1: country with no override file → returns base unchanged
- Test 2: partial override (1 key) → that key reflects override, all others inherit
- Test 3: nested override (`threeDSecure.iframe`) → only the leaf is overridden, sibling keys preserved
- Test 4: override removes a required key (sets it to empty/null) → validator throws with country code in message
- Test 5: cache hit — second call to `loadSelectorsForCountry('FR')` does not re-read from disk (mock `readFile` to assert call count)
- Test 6: `clearSelectorCache()` then re-call → re-reads disk

### Task 6: Documentation in `selectors/README.md` (AC: source-of-truth doc)

- **File:** `selectors/README.md` (new)
- Explains: why per-country overrides exist (Nike runs slightly different DOM per market), how to add a new country override (create `selectors/<CC>.yaml`, register in country entry's `selectorOverridePath`), how the deep merge works (example diff), and the validation contract (merged result must satisfy the full base schema)

## Dev Notes

### Why Deep Merge vs Whole-File Replacement

Nike's per-market deltas are typically 1-5 selectors out of 40+. Whole-file replacement would force every country file to duplicate the entire base, making upstream Nike changes painful (every country file needs the patch). Deep merge keeps overrides minimal and intent-clear.

### Why `selectorOverridePath` is Configurable per Country

The default convention is `selectors/<CC>.yaml`. The country entry can override this (e.g. set to `null` to skip the existence check entirely, or to a non-standard path). FR explicitly sets `selectorOverridePath: null` because the base IS the FR baseline.

### Cache Lifetime

LRU max 10 (one per supported country). No TTL — selectors don't change at runtime. `clearSelectorCache()` is exposed for hot-reload during dev (e.g. operator edits a YAML file and wants to see the change without restart). Production drops never call it.

### File Layout

```
selectors.yaml              # base (FR-derived, since FR is v3.0 only enabled country)
selectors/
  US.yaml                   # overrides for US
  GB.yaml                   # overrides for UK
  JP.yaml                   # overrides for JP
  README.md                 # how-to
```

### Project Structure Notes

New files:
- `packages/bot/src/country/selectorLoader.ts`
- `packages/bot/src/country/selectorLoader.test.ts`
- `selectors/US.yaml` (example)
- `selectors/README.md`

Modified files:
- `packages/bot/src/checkout/checkoutPipeline.ts`
- `packages/bot/src/monitor/warmupMode.ts`

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` Story 13.4
- PRD: FR58
- Story 1.4: `selectors.yaml` schema (`packages/bot/src/config/selectorsSchema.ts`)
- Architecture: "Multi-country Abstraction" — `selectorOverridePath` field
- Depends on: Story 13.1 (registry), Story 1.4 (selector schema)

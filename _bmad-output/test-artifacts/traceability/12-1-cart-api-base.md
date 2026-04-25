# Traceability — Story 12.1 NikeCartApi base class

**Date:** 2026-04-25
**Story:** [`12-1-cart-api-base.md`](../../implementation-artifacts/stories/12-1-cart-api-base.md)
**Status:** Quality gate **PASS**.
**Test suite:** 27 unit tests (mocks) + 1 live integration test (gated `RUN_LIVE_TESTS=1`).
**Run:** `node --import tsx --test src/checkout/api/cartApi.test.ts` → 27 pass / 0 fail.
**Regression:** Full bot suite 184/186 pass; the 2 failures (`completeShipping.test.ts`, `config/config.test.ts`) predate this branch (commit `7c3a66d`) and are out of scope.

---

## AC ↔ Test mapping

### AC1 — `cartApi.initVisitor(visitorId)` issues PATCH with merge op against `/buy/carts/v2/FR/NIKE/NIKECOM?modifiers=…`

| Assertion | Test |
|---|---|
| URL = `https://api.nike.com/buy/carts/v2/FR/NIKE/NIKECOM?modifiers=VALIDATELIMITS,VALIDATEAVAILABILITY` | `cartApi.test.ts` › `NikeCartApi.initVisitor › issues PATCH with merge op…` |
| Method = `PATCH` | same |
| `content-type: application/json-patch+json` | same |
| Body = `[{op:'merge', path:'/', value:{visitorId}}]` | same |
| Response = `Cart` with `id`, `country='FR'`, `currency='EUR'`, `items=[]` | `mockPage` returns `sampleCart`; assertion `deepEqual(result, sampleCart)` |
| `?modifiers=…` query is non-optional | `cartApi.test.ts` › `PATCH URL always carries the ?modifiers= query (regression guard)` |

### AC2 — `cartApi.addItem(skuId, slug, styleColor, 1)` issues add op with `itemData.url`

| Assertion | Test |
|---|---|
| Body = `[{op:'add', path:'/items', value:{itemData:{url:'/fr/t/${slug}/${styleColor}'}, skuId, quantity:1}}]` | `cartApi.test.ts` › `NikeCartApi.addItem › issues PATCH with add op…` |
| Returned cart has 1 item with matching skuId + qty=1 | `cartApi.live.test.ts` (live; gated) |
| Default `quantity=1` | covered in default-quantity test |
| Explicit `quantity=N` passes through | `passes explicit quantity through unchanged` |
| Pinned `content-type: application/json-patch+json` | `pins content-type to application/json-patch+json` |

### AC3 — `getCart()`, `removeItem(itemId)`, `setQuantity(itemId, 2)` use the right verbs

| Assertion | Test |
|---|---|
| `getCart` → `GET /buy/carts/v2/FR/NIKE/NIKECOM` (no modifiers query) | `NikeCartApi.getCart › issues GET against the bare cart path…` |
| `removeItem` → `PATCH` with `[{op:'remove', path:'/items/{id}'}]` | `NikeCartApi.removeItem › issues PATCH with remove op…` + content-type test |
| `setQuantity` → `PATCH` with `[{op:'replace', path:'/items/{id}/quantity', value:N}]` | `NikeCartApi.setQuantity › issues PATCH with replace op…` + content-type test |
| RFC 6901 escape on `itemId` (`~` → `~0`, `/` → `~1`) | `removeItem › escapes JSON Pointer special chars…` + `setQuantity › escapes JSON Pointer special chars` |

### AC4 — Non-2xx responses throw `NikeCartApiError` with redaction-safe shape

| Assertion | Test |
|---|---|
| 403 throws with `{status, method, path}` populated | `error handling › throws NikeCartApiError on 403 with status, method, path` |
| 404 throws | `throws NikeCartApiError on 404` |
| 500 throws | `throws NikeCartApiError on 500` |
| `bodyPreview` truncated to 256 chars | `truncates bodyPreview to 256 chars` |
| Headers redaction: only `x-akamai-request-id`, `x-kpsdk-st` surface (no `sid`, `set-cookie`, `Authorization`) | `redacts headers — only x-akamai-request-id and x-kpsdk-st surface` |
| Mixed-case header keys still resolved correctly | `lower-cases header keys before extraction (mixed-case input)` |
| Missing diagnostic headers handled gracefully | `handles missing diagnostic headers (both undefined)` |
| 200 OK with non-JSON body (Akamai HTML interstitial) → typed `NikeCartApiError` (not raw `SyntaxError`) | `throws NikeCartApiError when 200 body is non-JSON (HTML interstitial)` |

### AC5 — JSON Patch body construction has 100% branch coverage including edge cases

| Branch | Test |
|---|---|
| `initVisitor` body shape | `NikeCartApi.initVisitor` (2 tests) |
| `addItem` body shape (default + explicit qty) | `NikeCartApi.addItem` (3 tests + content-type) |
| `removeItem` body shape | `NikeCartApi.removeItem` (3 tests) |
| `setQuantity` body shape | `NikeCartApi.setQuantity` (4 tests) |
| `qty=0` does NOT auto-convert to remove | `still issues replace (NOT remove) when quantity is 0` |
| `missing slug` (empty string) refused | `throws synchronously when slug is empty (AC5 "missing slug" branch)` |
| `missing styleColor` (empty string) refused | `throws synchronously when styleColor is empty` |
| Non-FR market in PATCH path | `multi-country › honours non-FR market in PATCH path` |
| Non-FR market in GET path | `multi-country › honours non-FR market in GET path` |

---

## NFR coverage

| NFR | Status | Evidence |
|---|---|---|
| **Security — secret redaction** | ✅ Covered | Headers redaction structural (whitelist), body truncated; pattern-based PII redaction deferred to Story 12.9 |
| **Security — URL injection** | ✅ Covered | Live test PDP host allow-list (`*.nike.com`); JSON Pointer escape on `itemId` |
| **Reliability — non-JSON 200 response** | ✅ Covered | New test for HTML interstitial → `NikeCartApiError` |
| **Reliability — `res.text()` failure** | ✅ Defensive | Caught and surfaced as empty `bodyPreview`, original status preserved |
| **Reliability — timeout / retry / 429 backoff** | ⏸ Deferred | Story 12.9 owns API error handling policy |
| **Reliability — runtime schema validation** | ⏸ Deferred | Story 12.9 (zod / valibot guard on Cart shape) |
| **Multi-country support** | ⚠ Partial | Country honoured in URL path; `addItem.itemData.url` hardcoded `/fr/t/` (Story 13.4 owns the locale-prefix table) |

---

## Quality gate decision

**PASS** for Story 12.1 scope. Recommended sequencing:

1. **Now** — merge 12.1 to phase-1 branch.
2. **Story 12.9** — pick up deferred reliability items (timeout, retry, runtime schema validation, deeper bodyPreview redaction).
3. **Story 13.4** — pick up locale-prefix table for `itemData.url` so multi-country `addItem` is no longer FR-hardcoded.
4. **Story 14.1** — replace `waitForTimeout(2000)` in the live test with explicit KPSDK readiness polling.

Live test should be exercised once with a real Nike FR account before declaring Phase 1 complete (run `RUN_LIVE_TESTS=1 NIKE_TEST_*=… node packages/bot/scripts/live-test-cart-api.ts` against a known in-stock SKU).

# Story 12.10: Pivot NikeCartApi transport to `page.evaluate` + Bearer injection

Status: review

## Story

As a v3 SaaS bot operator,
I want `NikeCartApi.request<T>()` to issue cart calls from the browser's JS context (via `page.evaluate(() => fetch(...))`) with the OAuth Bearer token extracted from OIDC localStorage,
So that Kasada's injected ServiceWorker can attach valid `x-kpsdk-cd` proof-of-work headers and Nike's auth layer accepts the request — debunking the 403/401 storm seen on Story 12.1's live tests. (FR60)

## Background — why this story exists

Story 12.1 shipped `NikeCartApi` calling `api.nike.com/buy/carts/v2/...` via Playwright's `page.request.fetch()`. Two live runs against Nike FR with account `candid_audio` failed:

- Run 1: 403 Forbidden + HeadlessChrome UA leak. UA hotfix applied.
- Run 2: 403 Forbidden persists. Headers reveal `x-kpsdk-r: 1-AA` (Kasada says "no valid POW received"). No `Authorization` header in outgoing request.

Investigative POC (`packages/bot/scripts/poc-page-evaluate-cart.ts`) compared transports against Nike:

| Transport | Result | Diagnosis |
|---|---|---|
| `page.request.fetch()` (current 12.1) | -1 / Timeout | Kasada hard-drops at network — ServiceWorker not invoked |
| `page.evaluate(() => fetch())` | 401 Unauthorized | Kasada accepts POW (`x-kpsdk-r: 1-B…`); only Bearer is missing |

POC found Bearer in `localStorage` under key matching `^oidc\.user:` with shape `{ access_token: "..." }`.

## Acceptance Criteria

**Given** a Playwright `Page` bootstrapped on a Nike PDP with a valid authenticated session (OIDC localStorage populated)
**When** `cartApi.initVisitor(visitorId)` is invoked
**Then** the underlying transport is `page.evaluate(async (args) => fetch(args.url, { method, headers: { ...args.headers, Authorization: 'Bearer ${args.token}' }, credentials: 'include', body: args.data }))`
**And** the response status is 2xx
**And** the parsed body is a `Cart` matching the spec from Story 12.1

**Given** the page's `localStorage` contains no key matching `^oidc\.user:` (or all matched entries have null `access_token`)
**When** any cart API method is called
**Then** the method throws `SessionExpiredError` (from Story 12.9) before issuing any network request, with a clear message naming the missing OIDC key family

**Given** the response from `page.evaluate(fetch)` is non-2xx
**When** `request<T>()` processes it
**Then** it throws the same `NikeCartApiError` shape as Story 12.1 (status, method, path, redaction-safe headers, 256-char bodyPreview), preserving the existing public error contract

**Given** the existing 27 mock tests in `cartApi.test.ts`
**When** they run after this refactor
**Then** all 27 pass without modification of their assertions about request shape (URL / method / headers / body) — only the **mock surface** may shift from `page.request.fetch` to `page.evaluate` and a new `localStorage` accessor

**Given** unit tests of the new transport
**When** the suite executes
**Then** there is explicit coverage for: (a) Bearer extraction success, (b) Bearer extraction failure → SessionExpiredError, (c) `page.evaluate` returning non-2xx → NikeCartApiError, (d) JSON parse failure on 200 OK → NikeCartApiError, (e) the OIDC key search prefers `oidc.user:*` over `oidc.<hash>` aliases

## Tasks / Subtasks

### Task 1: Extract Bearer accessor [x]

Create `packages/bot/src/checkout/api/oidcBearer.ts` exporting `getBearerToken(page: Page): Promise<string>`:
- Run `page.evaluate(() => Object.keys(localStorage)...)` to find every key starting with `oidc.user:`
- Parse the JSON value, return `access_token` if non-null
- If multiple `oidc.user:` keys exist, pick the first with a non-null `access_token`
- If none has a valid token, throw `SessionExpiredError` (from `apiErrors.ts`) with details about which keys were probed

### Task 2: Refactor `NikeCartApi.request<T>()` [x]

Replace the body of `NikeCartApi.request<T>()` in `packages/bot/src/checkout/api/cartApi.ts`:
- Call `getBearerToken(this.page)` first; let `SessionExpiredError` propagate
- Build a single `page.evaluate(async (args) => { ... }, { url, method, headers, data, token })` block
- Inside the evaluate body: call `fetch(args.url, { method: args.method, credentials: 'include', body: args.data ?? null, headers: { ...args.headers, Authorization: 'Bearer ' + args.token } })`
- Return `{ status, headers: <plain object>, body: <full text>, ok: <boolean> }`
- Outside: rebuild the `NikeCartApiError` envelope from that shape; preserve the existing JSON-parse fallback path (200 OK with non-JSON → typed error)

The `ensureKpsdkToken()` pre-flight (Story 14.2) stays in place — it warms the cache, no harm.

### Task 3: Update `cartApi.test.ts` mock factory [x]

The mock factory `mockPage()` currently stubs `page.request.fetch`. Switch it to stub:
- `page.evaluate` — discriminate by inspecting the function source or first arg shape; return `{ status, headers, body, ok }` for the cart fetch path, return the bearer string for the localStorage read path
- Keep all 27 existing assertions (URL / method / headers / body) green

### Task 4: New tests [x]

Add to `cartApi.test.ts`:
- Test that `getBearerToken` failure surfaces as `SessionExpiredError` and **no fetch is issued**
- Test that bearer is added to `Authorization` header in the evaluate args
- Test that `oidc.user:` is preferred when `oidc.<hash>` aliases also exist
- Test that 200 OK with non-JSON body still throws `NikeCartApiError` (regression guard from 12.1)

### Task 5: Update live integration test [x]

`packages/bot/test/integration/cartApi.live.test.ts`:
- Remove the `page.waitForTimeout(2000)` magic sleep — replace with: navigate, then `page.waitForFunction(() => Object.keys(localStorage).some(k => k.startsWith('oidc.user:')))` with a 30s timeout
- Keep cleanup (removeItem after assertions)

### Task 6: Update `oidcBearer.test.ts` [x]

Mock-based unit tests for `getBearerToken`:
- Multiple `oidc.user:` keys → returns first with non-null token
- Only `oidc.<hash>` aliases (no `oidc.user:`) → throws SessionExpiredError
- Malformed JSON in localStorage → throws SessionExpiredError
- Empty localStorage → throws SessionExpiredError

## Dev Notes

### Implementation guidance

- **Critical contract preservation**: The public surface of `NikeCartApi` (constructor, methods, return types, `NikeCartApiError`) MUST stay unchanged. Downstream stories (12.3 cart_views, 12.7 hybrid pipeline) consume the barrel.
- **Why credentials: 'include'**: ensures the page-origin cookies (`KP_UIDz`, `bm_sv`, `sid` if same-origin) are attached. The fetch is already running in the page context, but explicitly setting it is cheap insurance.
- **Why we don't strip Authorization on retry**: Bearer is short-lived (typically 1h); `SessionExpiredError` is the user-facing signal. Story 12.9's `withApiRetry` already maps it to `outcome: 'session-expired'`.
- **POC reference**: every architectural decision here is grounded in `packages/bot/scripts/poc-page-evaluate-cart.ts` results. Re-run it if behavior diverges.

### Pitfalls to avoid

- Don't `JSON.stringify` inside `page.evaluate` if the data is already a string — Playwright auto-serializes the second arg. Pass `data` as a plain string.
- Don't pass non-serializable objects (Maps, Sets, functions) into the evaluate args.
- Don't try to access `KPSDK` global directly — Kasada's intercept happens at `fetch()` itself, not at any explicit API.
- Bearer tokens MUST NOT be logged. Add to redaction whitelist in `NikeCartApiError` if needed (currently the error only surfaces `x-akamai-request-id` and `x-kpsdk-st` — Bearer never enters the error path).

### Project Structure Notes

Files created:
```
packages/bot/src/checkout/api/oidcBearer.ts
packages/bot/src/checkout/api/oidcBearer.test.ts
```

Files modified:
```
packages/bot/src/checkout/api/cartApi.ts          (request<T> body + import getBearerToken)
packages/bot/src/checkout/api/cartApi.test.ts     (mock factory)
packages/bot/src/checkout/api/index.ts            (barrel: export getBearerToken)
packages/bot/test/integration/cartApi.live.test.ts (drop magic sleep)
```

### References

- Story 12.1: `_bmad-output/implementation-artifacts/stories/12-1-cart-api-base.md`
- Story 12.9: `_bmad-output/implementation-artifacts/stories/12-9-api-error-handling.md` (`SessionExpiredError`)
- POC: `packages/bot/scripts/poc-page-evaluate-cart.ts`
- API trace: `packages/bot/scripts/api-trace.ndjson`
- Architecture pivot rationale: this story's Background section

## File List

### Created
- `packages/bot/src/checkout/api/oidcBearer.ts` — Bearer token extractor from OIDC localStorage
- `packages/bot/src/checkout/api/oidcBearer.test.ts` — 8 unit tests for getBearerToken

### Modified
- `packages/bot/src/checkout/api/cartApi.ts` — pivoted request<T>() from page.request.fetch to page.evaluate + Bearer injection; added getBearerToken import
- `packages/bot/src/checkout/api/cartApi.test.ts` — pivoted mockPage() to stub page.evaluate; added 4 Story 12.10 transport tests
- `packages/bot/src/checkout/api/index.ts` — barrel exports getBearerToken
- `packages/bot/test/integration/cartApi.live.test.ts` — replaced page.waitForTimeout(2000) with page.waitForFunction polling for oidc.user: key

## Dev Agent Record

**Agent**: claude-sonnet-4-6
**Date**: 2026-04-25
**Branch**: epic/bot-package

### Implementation Notes

- Discriminated `page.evaluate` calls in mock by checking presence of `token` field in args object (case A = getBearerToken, case B = cart fetch). This is resilient to function-body changes.
- `void` cast used to satisfy TS6133 on the type-assertion-only variable in test.
- The evaluate args object is fully JSON-serializable (strings, null, plain Record) — no Maps/Sets/functions.
- `credentials: 'include'` explicitly set in evaluate body even though it's in the page context — cheap insurance per story dev notes.
- Bearer token never surfaces in NikeCartApiError (it's in the request headers, which are not captured post-evaluate; only response headers are recorded).

### Test Results

- `cartApi.test.ts` + `oidcBearer.test.ts`: **39 pass / 0 fail** (27 original + 4 new transport tests + 8 oidcBearer tests)
- Full bot suite: 267 pass / 6 fail — **same 5 top-level failures as baseline** (skuResolver ×3, loadBotConfig ×1, completeShipping ×1); net new tests absorbed without regression
- `tsc --noEmit`: **4 errors** (all pre-existing in navigateCheckout.ts and commands.ts; reduced from 5 by fixing TS6133 we introduced)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-25 | Implemented Story 12.10: pivoted NikeCartApi transport from page.request.fetch to page.evaluate + OIDC Bearer injection | claude-sonnet-4-6 |

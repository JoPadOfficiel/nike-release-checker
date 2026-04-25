# Deferred Work

## Deferred from: code review of 12-1-cart-api-base (2026-04-25)

- **Runtime validation of `Cart` / `CartItem` response shape** — `request<T>` casts via `as T` with no zod / valibot guard. Story 12.9 (API error handling) owns adding runtime validation across all cart API responses.
- **Per-request timeout on `page.request.fetch`** — no timeout configured; Nike outage hangs caller forever. Story 12.9.
- **Retry / Retry-After honour on 429 + 503** — single-shot today; rate-limit response triggers immediate caller failure. Story 12.9 + Epic 14 KPSDK retry.
- **KPSDK readiness verification in live test** — `waitForTimeout(2000)` is a magic-number sleep with no token-presence assertion. Epic 14 / Story 14.1 (KPSDK token extractor) replaces this with `window.KPSDK?.ready` polling.
- **Money typed as `number`** — `priceInfo.total`, `totals.subtotal/total` are floats. Cross-cutting refactor (cents-as-int or string-decimal); out of scope for this story.
- **`Cart.visitorId` optional but mandatory after `initVisitor`** — type cleanup, defer until consuming stories (12.3 cart_views) settle the post-init contract.
- **3xx redirect treated as failure** — `res.ok()` is 2xx-only; any redirect raises `NikeCartApiError`. Acceptable for v3.0; revisit if Nike begins issuing redirects on the cart endpoint.
- **Concurrent call serialization** — no internal mutex; PATCH ordering is caller responsibility. Story 12.7 hybrid pipeline already serialises through the checkout flow.
- **`API_ORIGIN` not env-overridable** — hardcoded `https://api.nike.com`; staging / MITM proxy hook can be added when CI fixture support is needed.
- **`bodyPreview` pattern-based PII redaction** — current implementation truncates to 256 chars only; does not scrub `sid`, JWT, email, or shipping-address fragments inside the truncated window. Story 12.9 owns full error-redaction policy.
- **`merge` op path allow-list** — only internal callers reach the patch builder, and the only `merge` site uses `path: '/'`. Generic allow-list deferred unless caller surface widens.
- **`page.isClosed()` precondition** — Playwright surfaces `TargetClosedError` clearly; explicit guard skipped.
- **Multi-country `addItem` URL prefix** — `/fr/t/` is hardcoded in the JSON Patch `itemData.url`. Story 13.4 (per-country selector / URL overrides) is the natural home for the locale lookup table; documented inline as a TODO.
- **`addItem` quantity domain validation** — negative / NaN / Infinity client-side guard skipped; the server-side `VALIDATELIMITS` modifier rejects invalid quantities.

## Deferred from: code review of 2-6-load-cookies-context (2026-04-04)

- **No max file size guard before `JSON.parse` in `loadCookies`** — pre-existing pattern throughout codebase (persistCookies, same concern as 2-1 OOM deferred item).
- **`injectCookies` silent early return on empty array** — intentional guard; caller must ensure session was validated before calling. No log needed for MVP.
- **`loadAndInjectCookies` no error wrapping with accountId context** — Playwright errors bubble up without account context. MVP scope; callers already have accountId.
- **`sessionValidator` validation looser than `loadCookies`** — sessionValidator checks cookies without full field type checks. Pre-existing story 2-4 scope.

## Deferred from: code review of 2-2-authenticate-all-accounts (2026-04-04)

- **--account option not implemented** — `login-all --account <id>` silently authenticates all accounts. Story 2-3 scope.
- **Cookies stored in plaintext** — session cookie files written as plain JSON. Pre-existing architecture decision ("No encryption at rest by design"), consistent with 2-1 deferred-work.
- **persistCookies relative path** — `sessionsDir` default is relative to `process.cwd()`. Consistent with `.bot-data/` pattern used throughout codebase.
- **Zero-account case exits 0** — `login-all` with no imported accounts prints `0/0 authenticated` and exits successfully with no guidance. Acceptable MVP behavior.
- **Cloudflare not classified distinctly** — all non-login outcomes fall into generic timeout/error. Story 5-4 (Block Detection) covers this.

## Deferred from: code review of 2-3-authenticate-single-account (2026-04-04)

- **Sequential `authenticateAll` no per-account timeout** — hung account blocks entire batch indefinitely. Pre-existing story 2-2 scope.
- **`loadStoredAccounts` returns unvalidated array** — corrupt accounts.json can yield accounts with undefined fields silently passed to Playwright. Pre-existing story 2-1 scope.
- **`authenticateSingle` re-reads all accounts on every call** — performance concern; full file read per invocation. Not a correctness issue.
- **`persistCookies` basename collision** — two account IDs sharing same basename (e.g. `dir/foo` and `foo`) overwrite each other's session file. Pre-existing from story 2-2 path traversal patch.
- **`login-all` all-accounts path exits 0 on total failure** — inconsistent with `--account` path which exits 1. Pre-existing story 2-2.
- **Missing test: other session files not modified** — spec Task 4 requires it, but verifying no side-effects needs Playwright mocking. Out of scope for current test approach.

## Deferred from: code review of 2-5-clear-sessions-logout (2026-04-04)

- **Non-session `.json` files in SESSIONS_DIR silently deleted by `clearAllSessions`** — sessions dir is a dedicated directory by design; no other tool should write `.json` there.
- **`clearSession` basename edge cases** — `'/'` or `'..'` as accountId produce unexpected paths; account IDs are validated as `minLength(1)` at import time, making this unreachable in practice.

## Deferred from: code review of 2-4-list-accounts-status (2026-04-04)

- **`_abck` and `KP_UIDz` not checked for expiry** — spec lists all three critical cookies; dev notes justify sid as the sole gating cookie (shortest-lived). Adding all three would need expanded tests. Defer until real-world data shows _abck expires first.
- **TOCTOU stat + readFile** — mtime and cookie data may come from two different file generations in a concurrent write. Pre-existing design pattern throughout codebase.
- **Sequential `validateSession` calls** — O(n) wall-clock latency for N accounts; `Promise.all` would parallelize. Performance concern, not correctness.
- **CWD-relative `.bot-data/sessions` path** — all sessions appear `missing` if CLI invoked from a directory other than project root. Pre-existing pattern.
- **`loadStoredAccounts()` unvalidated cast** — corrupt accounts.json entry with undefined `id` field causes `basename(undefined)` TypeError crash in `listAccounts`. Pre-existing story 2-1 scope.

## Deferred from: code review of 2-1-import-accounts (2026-04-04)

- **writeFile not atomic** — crash mid-write can corrupt `.bot-data/accounts.json`; correct fix is write-to-temp-then-`rename()` (POSIX atomic). Deferred: exceeds MVP scope for personal local tool.
- **Malicious proxy buffer OOM** — infinite-streaming proxy fills the TCP buffer before the 10s timeout fires; needs a max buffer size cap in `proxyTester.ts`. Deferred: security hardening, out of story scope.
- **Proxy + password stored in plaintext** — `accounts.json` stores raw credentials including proxy auth. Architecture doc acknowledges this ("No encryption at rest by design"). Deferred: pre-existing architecture decision.
- **maskEmail exposes full domain** — `u***@gmail.com` leaks the email provider, potentially identifying the account. Deferred: intentional design choice, sufficient for personal tool.

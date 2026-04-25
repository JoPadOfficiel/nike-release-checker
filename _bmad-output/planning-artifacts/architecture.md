---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
status: 'complete'
completedAt: '2026-03-31'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/epics.md
  - docs/Integration_Anti_Detection_et_Checkout.md
  - docs/Nike_Selectors.md
  - docs/Automatisation Bot Nike SNKRS Multi-pays.md
workflowType: 'architecture'
project_name: 'nike-release-checker'
user_name: 'Jopad'
date: '2026-03-31'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Version History

| Version | Date | Headline |
|---------|------|----------|
| v1 / v2 | 2026-03-31 → 2026-04-24 | Local CLI architecture. 8 modules in `packages/bot/src/`, single-tenant, FR-only, file-based persistence. Fully implemented. See §"v1/v2 baseline" below. |
| v3 | 2026-04-25 | API-first multi-country B2B SaaS. Worker pool, REST gateway, encrypted multi-tenant vault, Stripe billing. Adds new sections at top; v1/v2 sections preserved verbatim and govern the self-hosted tier. |

---

## v3 Architecture Overview

### System Topology (ASCII)

```
                                         +--------------------+
                                         |  Stripe Webhooks   |
                                         |  (events.* IDs)    |
                                         +---------+----------+
                                                   |
+-----------+   HTTPS/WSS   +-------------------+  v  +---------------------+
| Customer  | ============> | API Gateway       |---->| Billing Engine      |
| (REST/WS) | <============ | (Fastify, auth,   |     | (Stripe, per-cop    |
+-----------+   webhooks    |  rate-limit, OAS) |     |  metering, invoice) |
                            +---------+---------+     +---------------------+
                                      |
                                      v
                            +---------+---------+
                            | Drop Scheduler    |
                            | (Epic 17, queue)  |
                            +---------+---------+
                                      |
                          dispatch    v
                            +---------+---------+      +---------------------+
                            | Worker Pool       |<---->| KPSDK Token Cache   |
                            | N nodes, M Chrome |      | (Redis, per-acct)   |
                            | per node          |      +---------------------+
                            +---------+---------+
                                      |
                  page.request.fetch  | inherits cookies + KPSDK
                                      v
                            +---------+---------+
                            | api.nike.com/buy  |
                            | cart, cart_views, |
                            | fulfillment,      |
                            | payment, reviews, |
                            | checkouts         |
                            +-------------------+

Side stores:
+----------------------+   +----------------------+   +----------------------+
| Account Vault        |   | Audit Log            |   | Webhook Outbox       |
| (Postgres, per-cust  |   | (immutable, 12 mo,   |   | (queue, HMAC sign,   |
|  DEK, encrypted rows)|   |  drop runs + PUT     |   |  exp-backoff retry,  |
|                      |   |  /checkouts + mut.)  |   |  DLQ)                |
+----------------------+   +----------------------+   +----------------------+
```

### Component Responsibilities

| Component | Responsibility | Key NFRs |
|-----------|---------------|----------|
| **API Gateway** | Bearer-token auth, per-tier rate limit, OpenAPI 3.1, WebSocket fan-out for drop events | NFR36, NFR38 |
| **Drop Scheduler** | Owns `Drop` lifecycle (DRAFT → SCHEDULED → ACTIVE → COMPLETED). Cron + drop_at timestamps. Per-customer quota. | — |
| **Worker Pool** | N Linux nodes (8 vCPU / 16 GB), each running M headed Chrome instances with persistent profiles per Nike account. Sticky session per account. Auto-scale at 70 % node load. | NFR29, NFR31 |
| **KPSDK Token Cache** | Per-account `x-kpsdk-ct/-v` token, Redis TTL ≈ token lifetime. Refreshed on 403/429 by triggering a silent page reload in the owning worker. | NFR35 |
| **Account Vault** | Multi-tenant Postgres. Per-customer KMS-derived DEK wraps row-level encryption for credentials, sessions, cards. | NFR32, NFR33 |
| **Webhook Outbox** | Persistent queue, HMAC-SHA256 signature header, exponential backoff to 24 h, DLQ. | NFR37 |
| **Audit Log** | Immutable append-only store of all drop runs, all `PUT /buy/checkouts/*` calls to Nike, all customer-data mutations. 12 mo retention. | NFR39 |
| **Billing Engine** | Stripe customer + subscription + metered usage. Idempotent webhook reception on `event.id`. | NFR40 |

### Migration Plan — DOM → API

Each existing v2 checkout step transitions into one of three states:

| v2 Step | v3 State | Rationale |
|---------|----------|-----------|
| Story 4.1 Select Size (DOM click on PDP) | **Hybrid** — DOM size click stays (FR69), then skuId is harvested from page hydration and the rest of the flow is API. | The PDP must be loaded anyway for the KPSDK bootstrap; clicking the size on a real DOM is the cheapest signal that the size is actually selectable, and the resulting skuId is needed by `cartApi.addItem`. |
| Story 4.2 Add to Cart | **Replaced** by `cartApi.initVisitor()` + `cartApi.addItem()` (FR60). | DOM "Ajouter au panier" click is replaced by `PATCH /buy/carts/v2/{country}/NIKE/NIKECOM` JSON Patch. |
| Story 4.3 Navigate to Checkout | **Deleted** (no equivalent — cart_views is the new state machine). | The `/checkout` page navigation was DOM scaffolding; the API doesn't need it. |
| Story 4.4 Complete Shipping | **Replaced** by `PUT /buy/cart_views/v1/{view-uuid}` shipping payload (FR62). | + `GET /buy/fulfillment_offerings/v1` + jobs polling for shipping method. |
| Story 4.5 Complete Payment — selection | **Replaced** by `POST /payment/options/v3` + bind via cart_views (FR64). | DOM card-data entry stays (Story 4.5b — Adyen iframe, FR70). |
| Story 4.5b Adyen card entry | **DOM-only** (FR70) — Adyen Web Components iframe encrypts card data client-side. | Cannot be replaced; the encrypted blob is what `/payment/options/v3` accepts. |
| Story 4.6 Submit Order | **Replaced** by `PUT /buy/checkouts/{cart-uuid}` (FR65, KPSDK-protected). | Returns Nike `orderNumber`. |
| Story 5.5 / 5.6 3DS | **DOM-only** (FR71) — issuer-controlled iframe popup. | Identical to v2. |

The v3 SaaS tier uses the migrated path. The **self-hosted tier (v2)** keeps the original DOM pipeline as a fallback for users without our infra.

### Multi-country Abstraction

```typescript
interface Country {
  code: string                  // ISO 3166-1 alpha-2 (e.g., "FR")
  name: string                  // "France"
  currency: string              // ISO 4217 (e.g., "EUR")
  locale: string                // BCP 47 (e.g., "fr-FR")
  defaultLanguage: string       // "fr"
  phoneFormat: RegExp           // /^\+33[1-9]\d{8}$/
  zipFormat: RegExp             // /^\d{5}$/
  adyenIframeLocale: string     // "fr_FR" — used to resolve correct iframe
  addressLineOrder: string[]    // ["street", "city", "zip", "country"]
  selectorOverridePath: string  // "selectors/FR.yaml" or null for default
}

interface CountryRegistry {
  get(code: string): Country
  list(): Country[]
  isSupported(code: string): boolean
}
```

Registry is a static module loaded at startup. Per-country adapter classes are created **only when** a country requires more than the registry fields can express (e.g., DE phone validation requires sub-rules for mobile vs landline). Default behaviour: pure data-driven country, no adapter.

### Multi-Tenant Data Model

```sql
-- All identifiers are UUIDs unless otherwise stated.

customers (
  id, email, stripe_customer_id, tier, dek_wrapped,
  api_key_hash, created_at, deleted_at
)

nike_accounts (
  id, customer_id [FK], country, email_encrypted, password_encrypted,
  proxy_url_encrypted, preferred_sizes, last_login_at, session_status,
  created_at
)

cards (
  id, customer_id [FK], nike_account_id [FK nullable], holder_name,
  card_number_encrypted, expiry_encrypted, cvv_encrypted,
  brand, last4, created_at
)

addresses (
  id, customer_id [FK], nike_account_id [FK nullable], country,
  street, city, zip, phone, created_at
)

drops (
  id, customer_id [FK], country, sku, sizes_json, max_accounts,
  payment_method_id [FK], scheduled_at, state, created_at, completed_at
)

drop_runs (
  id, drop_id [FK], nike_account_id [FK], state, order_number,
  error_reason, started_at, completed_at, retry_attempt
)

orders (
  id, drop_run_id [FK], customer_id [FK], nike_order_number,
  total_amount_cents, currency, status, created_at
)

webhooks (
  id, customer_id [FK], url, secret_hash, events_subscribed,
  active, created_at
)

webhook_deliveries (
  id, webhook_id [FK], event_type, payload_json, http_status,
  attempt_count, next_retry_at, delivered_at, created_at
)

audit_log (
  id, customer_id [FK nullable], actor, action, resource_type,
  resource_id, payload_redacted_json, created_at
)
```

All `*_encrypted` columns use AES-256-GCM with the customer's DEK. Every read path resolves DEK from KMS by `customer_id`, never trusting client-supplied keys.

### Worker Pool Topology

- **Worker node:** Linux VM, 8 vCPU / 16 GB RAM, headed Chrome. Hosts up to M ≈ 50 Chrome contexts (one per active Nike account). Persistent profile dir per account on local SSD (synced to S3 on shutdown, restored on cold-start).
- **Sticky session per Nike account:** an account always lands on the same worker node when possible. This preserves cookies + Akamai `_abck` + KPSDK warm state.
- **Auto-scaling:** node count scales horizontally per drop schedule. A drop scheduled with `maxAccounts=200` triggers provisioning of ⌈200/50⌉ = 4 worker nodes 5 min before drop time. Nodes warmed during pre-drop phase (cookies refreshed, KPSDK bootstrapped).
- **Failure isolation:** node crash drains its accounts to other nodes via session restore from Account Vault. No checkout in-flight is silently lost — the drop_run row is marked `FAILED` with reason `worker_evicted`, and per-customer retry policy (NFR35 retry-once) applies.

### Security Model

- **Customer API keys:** generated server-side, displayed once, stored as `argon2id` hash in `customers.api_key_hash`. Rotation supported.
- **Per-customer KMS DEK:** envelope encryption. Master key in cloud KMS (e.g., AWS KMS or GCP Cloud KMS); DEK wrapped per customer. DEK rotation re-encrypts all rows for that customer in a background job.
- **KPSDK token refresh strategy:** silent page reload triggered by the worker holding the affected context. Token cached in Redis with TTL = observed token lifetime (currently ~30 min). On 403/429, cache invalidated and refresh dispatched.
- **Audit log per checkout:** every `PUT /buy/checkouts/{cart-uuid}` is logged with customer_id, drop_id, drop_run_id, nike_account_id (encrypted reference, not credentials), request shape (PII redacted), response shape, latency. 12-month retention. Used for billing reconciliation, abuse investigation, and customer-side incident response.
- **TLS in transit:** TLS 1.3 between API gateway and customers; mTLS between API gateway and worker pool; TLS 1.3 between worker pool and `api.nike.com` (Nike's choice).
- **Threat model exclusions:** we do not defend against a customer leaking their own cards / Nike credentials. We do defend against a customer reading another customer's data (NFR32).

---

## v1 / v2 baseline (preserved)

The remainder of this document is the v1/v2 architecture as of 2026-03-31, preserved unchanged. It governs the **self-hosted CLI tier** of the product. The v3 sections above govern the SaaS tier and supersede the multi-country and DOM-only assumptions.

---

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
41 FRs across 7 capability domains. The architecture must support a pipeline flow: Configuration → Account Auth → Stealth Browser → Checkout Steps → Error Handling → Monitoring Trigger → Daemon Operations. Each domain maps to a distinct module with clear interfaces.

**Non-Functional Requirements:**
20 NFRs that drive key architectural decisions:
- **Performance (NFR1-5):** Sub-30s checkout mandates parallel execution, minimal overhead in context creation, and efficient selector interactions. No room for sequential account processing.
- **Security (NFR6-10):** Credential masking must be a cross-cutting concern applied at the logging layer, not per-module. File permissions (600) on cookie files. Zero third-party data transmission.
- **Reliability (NFR11-15):** 24h+ daemon stability requires careful memory management — Playwright contexts must follow a strict create-use-destroy lifecycle per checkout cycle, never held in memory between cycles. Fault isolation via `Promise.allSettled` pattern.
- **Integration (NFR16-20):** Zero modification constraint on existing packages. SDK consumed as opaque dependency. Pinned Playwright versions to prevent upstream breaks.

**Scale & Complexity:**

- Primary domain: CLI Tool + Browser Automation
- Complexity level: High
- Estimated architectural components: 8 modules
- Key challenge: Adversarial environment with evolving defenses requires maximum externalization of volatile configurations

### Technical Constraints & Dependencies

- **Runtime:** Node.js 24.x (enforced by existing monorepo)
- **Language:** TypeScript 5.9.3, strict mode, ESM (`nodenext`)
- **Package Manager:** npm with workspaces
- **Build:** No bundling needed for bot (unlike CLI which uses Rspack). Direct TypeScript execution via `tsx` or compiled JS.
- **Testing:** Node.js built-in test runner (`node --test`) with `node:assert`
- **Existing SDK API surface:** `getProductFeed(countryCode, language)`, `formatProductFeedResponse(response)`, `availableCountries`
- **Existing CLI:** React 19 + Ink.js 6 + Nanostores — completely separate paradigm, not extensible for command-line argument parsing
- **Code Style:** Prettier (tabs, single quotes, no semicolons, 100 char width)
- **Validation library:** `valibot` (already used by SDK for schema validation)

### Module Boundaries

```
packages/bot/src/
├── cli/           # CLI entry point + argument parsing (commander)
├── config/        # Config loader (bot.config.yaml, accounts.json, selectors.yaml)
├── auth/          # Account management, Playwright login, cookie persistence
├── stealth/       # Stealth context factory, proxy isolation, locale config
├── checkout/      # Checkout pipeline (steps 1-6), dry-run mode
├── monitor/       # SDK integration, polling loop, stock transition detection
├── logger/        # Structured logging (NDJSON + terminal), credential masking
└── daemon/        # Process daemonization, PID management, signal handling
```

### Browser Context Lifecycle (Critical Pattern)

Playwright browser contexts are expensive resources. The architecture enforces a strict **create-use-destroy** pattern:

1. **Created on demand** — only when a stock trigger fires or dry-run is invoked
2. **One context per account** — each with dedicated proxy, cookies, locale
3. **Destroyed after each checkout cycle** — success or failure, context is closed
4. **Never pooled or cached** — no browser contexts held in memory between cycles
5. **Crash-resilient** — a context crash is caught and does not leak memory or affect other contexts

This pattern is essential for the 24h+ daemon stability requirement (NFR11).

### Cross-Cutting Concerns Identified

1. **Credential Masking** — Enforced at logging layer across all modules. Emails, passwords, proxy credentials, and cookie values never appear in logs.
2. **Externalized Configuration** — Selectors, stealth parameters, headers, and checkout flow steps configurable without code changes. Volatile by nature (Nike changes frequently).
3. **Fault Isolation** — Per-account error boundaries. One account's failure (proxy ban, 3DS timeout, crash) does not affect others.
4. **Structured Logging** — NDJSON log format + colorized terminal output as parallel concerns, applied consistently across all modules.
5. **Graceful Resource Management** — Playwright browser contexts created lazily and destroyed reliably, even on crash/signal.

### Testing Strategy

- **Unit tests** — Mock Playwright interactions (`page.click()`, `page.waitForSelector()`) to test checkout step logic individually. Use `node:test` mock utilities.
- **Integration tests** — Local HTML mock server simulating Nike pages (product page, checkout flow) to test the full pipeline offline. Externalized selectors point to mock server during tests.
- **SDK mocking** — Reuse existing MSW (Mock Service Worker) pattern from the SDK for mocking `getProductFeed()` responses.
- **Dry-run** — Not a test substitute. Used for live validation against Nike, not for CI/automated testing.

## Starter Template Evaluation

### Approach: Manual Scaffolding (No Starter)

**Rationale:** Brownfield project. The existing monorepo dictates all foundational technical decisions. A starter template would conflict with these constraints or require significant modification. Manual scaffolding of `packages/bot/` ensures perfect alignment.

**Decisions Inherited from Existing Project:**

| Decision | Value | Source |
|----------|-------|--------|
| Language | TypeScript 5.9.3 | Root `tsconfig.json` |
| Module System | ESM (`nodenext`) | Root config + `"type": "module"` |
| Strict Mode | Enabled | Root `tsconfig.json` |
| Target | `esnext` | Root `tsconfig.json` |
| Package Manager | npm with workspaces | Root `package.json` |
| Node Version | 24.x | `.npmrc` `engine-strict=true` |
| Code Style | Prettier (tabs, single quotes, no semicolons, 100 char) | Root `.prettierrc` |
| Testing | Node.js built-in test runner (`node --test`) | Existing convention |
| Schema Validation | Valibot | SDK precedent |
| HTTP Mocking | MSW (Mock Service Worker) | SDK precedent |

**New Dependencies for Bot Package:**

| Package | Purpose | Rationale |
|---------|---------|-----------|
| `commander` | CLI argument parsing | Standard de facto, 0 deps, subcommand support |
| `yaml` | YAML config parsing | For bot.config.yaml + selectors.yaml |
| `playwright` | Browser automation | Core requirement |
| `playwright-extra` | Plugin system for Playwright | Stealth plugin host |
| `puppeteer-extra-plugin-stealth` | Anti-detection | Masks webdriver, canvas, WebGL |
| `valibot` (reuse) | Config schema validation | Consistent with SDK pattern |

## Core Architectural Decisions

### Data & Persistence

No database. File-based persistence only:

| Data | Path | Format | Permissions |
|------|------|--------|-------------|
| Imported accounts | `.bot-data/accounts.json` | JSON | 600 |
| Session cookies | `.bot-data/sessions/<account_id>.json` | Playwright cookie JSON | 600 |
| Logs | `./logs/bot.log` | NDJSON (append-only) | 644 |
| Bot config | `bot.config.yaml` | YAML (read-only) | 644 |
| Selectors | `selectors.yaml` | YAML (read-only) | 644 |
| Daemon PID | `./bot.pid` | Plain text | 644 |

All data files in `.bot-data/` and config files excluded from version control via `.gitignore`.

### Security

- **Credential masking:** Logger layer intercepts all output. Values matching email, password, or proxy-auth patterns are replaced with `***` before writing to terminal or log file.
- **Cookie storage:** JSON files with `fs.chmod(path, 0o600)` after write. Owner read/write only.
- **No encryption at rest:** Cookies are temporary tokens. AES encryption adds complexity without value for personal local use — if filesystem is compromised, the encryption key would be on the same machine.
- **Zero network exfiltration:** No data leaves the machine. No telemetry, no analytics, no third-party calls.

### Error Handling & Communication Patterns

- **Per-account fault boundaries:** `Promise.allSettled()` for parallel execution. Each account is an independent flow. One failure cannot cascade.
- **Error classification:** `success | sold_out | blocked | 3ds_success | 3ds_timeout | timeout | no_session | error`
- **Checkout step errors:** Each step wrapped in individual try/catch with configurable timeout. Error classified and logged before aborting or continuing.
- **3DS handling:** Async pause/resume pattern. Detect 3DS iframe via selector, pause with `page.waitForSelector()` (120s timeout), resume on iframe disappearance or page navigation.

### Module Communication

- **Synchronous direct imports** — No event bus, no message queue. Modules call each other via TypeScript imports.
- **Pipeline pattern for checkout:**
  ```
  monitor.onTrigger()
    → checkout.execute(accounts)
      → Promise.allSettled(accounts.map(a => checkoutPipeline(a)))
  ```
- **Lightweight dependency injection:** Modules receive config and dependencies as parameters, not via DI framework. Example: `createCheckoutPipeline(config, logger, stealthFactory)`

### Infrastructure & Deployment

- **Local-first:** Runs on operator's machine (macOS/Linux). No cloud deployment.
- **Daemon:** `child_process.spawn({ detached: true, stdio: 'ignore' })` with PID file for tracking. Signal handling (SIGTERM/SIGINT) for graceful shutdown.
- **No CI/CD:** Personal tool, not a deployed service.
- **No containerization:** Playwright requires native browsers. Operator installs via `npx playwright install`.

### Deferred Decisions (Post-MVP)

| Decision | Phase | Rationale |
|----------|-------|-----------|
| Webhook transport (Discord/Telegram) | Phase 2 | MVP = terminal logs only |
| Multi-country config routing | Phase 3 | MVP = France only |
| TLS impersonation library | Phase 3 | MVP = browser-only checkout |
| Proxy health check protocol | Phase 2 | MVP = manual proxy management |

## Implementation Patterns & Consistency Rules

### Naming Patterns

**File & Directory Naming:**
- Files: `camelCase.ts` (ex: `checkoutPipeline.ts`, `stealthFactory.ts`)
- Test files: `*.test.ts` co-located with source (ex: `checkoutPipeline.test.ts`)
- Config schemas: `*Schema.ts` (ex: `botConfigSchema.ts`, `accountSchema.ts`)
- Types: `*.types.ts` when types-only file needed
- Follows existing SDK convention: co-located tests, camelCase files

**Function & Variable Naming:**
- Functions: `camelCase` (ex: `createStealthContext`, `validateSession`, `executeCheckout`)
- Constants: `SCREAMING_SNAKE_CASE` (ex: `DEFAULT_POLLING_INTERVAL`, `MAX_CHECKOUT_TIMEOUT`)
- Types/Interfaces: `PascalCase` (ex: `AccountConfig`, `CheckoutOutcome`, `StealthContextOptions`)
- Enums: `PascalCase` with `PascalCase` members (ex: `OutcomeType.Success`, `OutcomeType.SoldOut`)

**Config Keys:**
- YAML/JSON keys: `camelCase` (ex: `polling.interval`, `checkout.defaultSizes`)
- Selector keys: `camelCase` descriptive (ex: `sizeAvailable`, `purchaseButton`, `shippingSaveButton`, `threeDSecureIframe`)

### Structure Patterns

**Module Organization:**
```
packages/bot/src/<module>/
├── index.ts          # Public exports only
├── <feature>.ts      # Implementation
├── <feature>.test.ts # Tests (co-located)
└── <feature>.types.ts # Types (if needed)
```

**Import Order** (matching existing Prettier import sort):
1. Node.js builtins (`import { readFile } from 'node:fs/promises'`)
2. Third-party packages (`import { chromium } from 'playwright'`)
3. Internal modules (`import { logger } from '../logger/index.ts'`)
4. Types (`import type { AccountConfig } from '../config/account.types.ts'`)

**Export Pattern:**
- Each module has an `index.ts` that re-exports its public API
- Internal implementation details are NOT exported
- Types exported separately via `export type`

### Format Patterns

**Log Format (NDJSON):**
```json
{"ts":"2026-03-31T09:00:01.234Z","account":"account_1","step":"sizeSelect","durationMs":2340,"outcome":"success","details":"EU 42.5 selected"}
```

**Terminal Output Format:**
```
[account_1] ✓ Size selected (EU 42.5) — 2.3s
[account_2] ✗ Blocked (HTTP 403) — 1.1s
[account_3] 🔐 3DS required — validate on banking app
```

**Checkout Outcome Object:**
```typescript
interface CheckoutResult {
  accountId: string
  outcome: OutcomeType
  slug: string
  size: string | null
  durationMs: number
  steps: StepResult[]
  error?: string
}
```

### Process Patterns

**Checkout Pipeline Pattern:**
```typescript
async function executeStep(page: Page, selectors: Selectors, stepName: string): Promise<StepResult> {
  const start = performance.now()
  try {
    // step logic using externalized selectors
    return { step: stepName, outcome: 'success', durationMs: performance.now() - start }
  } catch (error) {
    return { step: stepName, outcome: 'error', durationMs: performance.now() - start, error: String(error) }
  }
}
```

**Error Handling Pattern:**
- Each step catches its own errors — never propagate raw exceptions
- Classify the error into `OutcomeType` immediately
- Log the classified result via the logger module
- Return the result to the pipeline — let the pipeline decide to continue or abort

**Resource Cleanup Pattern:**
```typescript
const context = await stealthFactory.create(account)
try {
  // checkout logic
} finally {
  await context.close() // ALWAYS close, even on error
}
```

**Config Loading Pattern:**
1. Load raw file
2. Parse YAML/JSON
3. Validate with Valibot schema
4. Return typed config object
5. Never use unvalidated config values

### Enforcement Guidelines

**All AI agents MUST:**
- Use externalized selectors from `selectors.yaml` — never hardcode CSS selectors
- Mask credentials in all log output via the logger module — never log raw credentials
- Close Playwright contexts in `finally` blocks — never leave contexts open
- Return `CheckoutResult` objects from pipeline functions — never use side effects for results
- Follow existing Prettier config — tabs, single quotes, no semicolons, 100 char width
- Use `node:test` for tests — never introduce Jest, Vitest, or other frameworks
- Validate all external input (config files, CLI args) with Valibot schemas before use

### Anti-Patterns

- `await page.click('.ncss-btn-primary-dark')` — use `selectors.purchaseButton` instead
- `console.log(account.password)` — use `logger.info(...)` which auto-masks
- `const ctx = await browser.newContext()` without `finally { await ctx.close() }`
- `throw new Error(...)` in checkout step — return `StepResult` with outcome `error`
- `import { someInternal } from '@nike-release-checker/sdk/productFeed/api'` — use public exports only

## Project Structure & Boundaries

### Complete Project Directory Structure

```
packages/bot/
├── package.json                    # @nike-release-checker/bot
├── tsconfig.json                   # extends ../../tsconfig.json
├── .gitignore                      # bot.config.yaml, accounts.json, .bot-data/
├── bot.config.example.yaml         # Sample config with documented defaults
├── selectors.example.yaml          # Sample Nike FR selectors
├── accounts.example.json           # Sample account config
├── src/
│   ├── index.ts                    # Package entry (exports public API)
│   ├── cli/
│   │   ├── index.ts                # CLI entry point (bin target)
│   │   ├── commands.ts             # Commander command definitions
│   │   └── commands.test.ts
│   ├── config/
│   │   ├── index.ts                # Config loading public API
│   │   ├── botConfig.ts            # bot.config.yaml loader + validation
│   │   ├── botConfigSchema.ts      # Valibot schema for bot config
│   │   ├── accountConfig.ts        # accounts.json loader + validation
│   │   ├── accountSchema.ts        # Valibot schema for accounts
│   │   ├── selectors.ts            # selectors.yaml loader + validation
│   │   ├── selectorSchema.ts       # Valibot schema for selectors
│   │   ├── config.types.ts         # BotConfig, AccountConfig, Selectors types
│   │   └── config.test.ts
│   ├── auth/
│   │   ├── index.ts                # Auth public API
│   │   ├── loginFlow.ts            # 2-step Nike login (email → password)
│   │   ├── cookieStore.ts          # Cookie serialization, persistence, loading
│   │   ├── sessionValidator.ts     # Check cookie expiration, session freshness
│   │   ├── accountManager.ts       # Import, list, logout operations
│   │   ├── proxyTester.ts          # Proxy connectivity validation
│   │   ├── auth.types.ts           # SessionStatus, LoginResult types
│   │   ├── loginFlow.test.ts
│   │   ├── cookieStore.test.ts
│   │   └── sessionValidator.test.ts
│   ├── stealth/
│   │   ├── index.ts                # Stealth public API
│   │   ├── contextFactory.ts       # Create stealth browser context
│   │   ├── proxyConfig.ts          # Per-account proxy configuration
│   │   ├── localeConfig.ts         # French locale, headers, timezone
│   │   ├── stealth.types.ts        # StealthContextOptions type
│   │   ├── contextFactory.test.ts
│   │   └── localeConfig.test.ts
│   ├── checkout/
│   │   ├── index.ts                # Checkout public API
│   │   ├── pipeline.ts             # Orchestrates full checkout flow
│   │   ├── steps/
│   │   │   ├── selectSize.ts       # Step 1: Navigate + select size
│   │   │   ├── addToCart.ts        # Step 2: Click purchase button
│   │   │   ├── navigateCheckout.ts # Step 3: Go to /fr/checkout
│   │   │   ├── shipping.ts        # Step 4: Confirm shipping
│   │   │   ├── payment.ts         # Step 5: Confirm payment
│   │   │   ├── submitOrder.ts     # Step 6: Submit order
│   │   │   ├── selectSize.test.ts
│   │   │   ├── addToCart.test.ts
│   │   │   ├── shipping.test.ts
│   │   │   ├── payment.test.ts
│   │   │   └── submitOrder.test.ts
│   │   ├── parallelExecutor.ts     # Promise.allSettled multi-account
│   │   ├── dryRun.ts              # Dry-run mode (skip submit)
│   │   ├── checkout.types.ts       # CheckoutResult, StepResult, OutcomeType
│   │   ├── pipeline.test.ts
│   │   └── parallelExecutor.test.ts
│   ├── monitor/
│   │   ├── index.ts                # Monitor public API
│   │   ├── poller.ts               # SDK polling loop
│   │   ├── stockDetector.ts        # Stock transition detection logic
│   │   ├── trigger.ts              # Auto-trigger checkout on detection
│   │   ├── monitor.types.ts        # StockTransition, PollResult types
│   │   ├── poller.test.ts
│   │   └── stockDetector.test.ts
│   ├── logger/
│   │   ├── index.ts                # Logger public API
│   │   ├── terminalLogger.ts       # Colorized terminal output
│   │   ├── fileLogger.ts           # NDJSON file writer
│   │   ├── credentialMasker.ts     # Mask emails, passwords, proxy creds
│   │   ├── logger.types.ts         # LogEntry, LogLevel types
│   │   ├── credentialMasker.test.ts
│   │   └── fileLogger.test.ts
│   └── daemon/
│       ├── index.ts                # Daemon public API
│       ├── daemonize.ts            # Process detach, PID file management
│       ├── signalHandler.ts        # SIGTERM/SIGINT graceful shutdown
│       ├── statusChecker.ts        # Read PID file, check process alive
│       ├── daemon.types.ts         # DaemonStatus type
│       └── daemonize.test.ts
├── mocks/
│   ├── nikePages/                  # Static HTML mock pages for integration tests
│   │   ├── productPage.html
│   │   ├── checkoutShipping.html
│   │   ├── checkoutPayment.html
│   │   └── checkoutReview.html
│   └── mockServer.ts              # Local HTTP server serving mock pages
└── .bot-data/                      # Runtime data (gitignored)
    ├── accounts.json
    └── sessions/
        ├── account_1.json
        └── account_2.json
```

### Epic → Structure Mapping

| Epic | Primary Modules | Key Files |
|------|----------------|-----------|
| Epic 1: Foundation | `cli/`, `config/` | `commands.ts`, `botConfig.ts`, `selectors.ts`, `package.json` |
| Epic 2: Accounts | `auth/` | `loginFlow.ts`, `cookieStore.ts`, `accountManager.ts`, `proxyTester.ts` |
| Epic 3: Stealth | `stealth/` | `contextFactory.ts`, `proxyConfig.ts`, `localeConfig.ts` |
| Epic 4: Checkout | `checkout/`, `checkout/steps/` | `pipeline.ts`, `selectSize.ts`→`submitOrder.ts`, `parallelExecutor.ts`, `dryRun.ts` |
| Epic 5: Error/3DS | `checkout/`, `logger/` | `checkout.types.ts`, `credentialMasker.ts`, `terminalLogger.ts`, `fileLogger.ts` |
| Epic 6: Monitoring | `monitor/` | `poller.ts`, `stockDetector.ts`, `trigger.ts` |
| Epic 7: Daemon | `daemon/` | `daemonize.ts`, `signalHandler.ts`, `statusChecker.ts` |

### Architectural Boundaries

**Module Dependency Flow (one-directional):**
```
cli → config → auth → stealth → checkout → monitor → daemon
                 ↑                    ↑          ↑
              logger ─────────────────┴──────────┘
              (cross-cutting, used by all modules)
```

**External Integration Points:**
- `@nike-release-checker/sdk` → consumed by `monitor/poller.ts` via `getProductFeed()`, `formatProductFeedResponse()`
- `playwright` + `playwright-extra` → consumed by `stealth/contextFactory.ts` and `auth/loginFlow.ts`
- `commander` → consumed by `cli/commands.ts` only
- `yaml` → consumed by `config/botConfig.ts` and `config/selectors.ts` only
- `valibot` → consumed by `config/*Schema.ts` files only

**Data Flow:**
```
bot.config.yaml ──→ config/ ──→ all modules (typed config objects)
accounts.json ────→ config/ ──→ auth/ (import/validate)
selectors.yaml ──→ config/ ──→ checkout/steps/ (selector lookups)
.bot-data/sessions/ ←→ auth/cookieStore.ts ──→ stealth/contextFactory.ts
SDK Product Feed ──→ monitor/poller.ts ──→ monitor/trigger.ts ──→ checkout/pipeline.ts
```

## Architecture Validation Results

### Coherence Validation ✅

- All technology choices compatible (TS 5.9.3 + ESM + commander + Playwright + valibot + Node 24.x)
- Naming conventions consistent across all modules (camelCase files, PascalCase types)
- Co-located test pattern matches existing SDK convention
- Module export pattern (index.ts) coherent across all 8 modules
- Dependency flow unidirectional — no cycles detected

### Requirements Coverage ✅

- **41/41 FRs** mapped to specific modules and files
- **20/20 NFRs** addressed by architectural patterns (performance → pipeline timing, security → credential masker, reliability → create-use-destroy lifecycle, integration → SDK public API constraint)
- **7/7 Epics** have explicit module mapping

### Implementation Readiness ✅

- All critical decisions documented with specific package names
- 60+ files defined with clear purpose annotations
- Code examples for all major patterns (checkout step, error handling, resource cleanup, config loading)
- Anti-patterns documented to prevent common mistakes

### Architecture Completeness Checklist

- [x] Project context analyzed (existing monorepo, React/Ink.js CLI discovery)
- [x] Scale and complexity assessed (high — adversarial environment)
- [x] Technical constraints identified (Node 24.x, TS 5.9.3, ESM, npm workspaces)
- [x] Cross-cutting concerns mapped (credential masking, fault isolation, logging, config externalization)
- [x] Critical decisions documented with rationale
- [x] Technology stack fully specified
- [x] Integration patterns defined
- [x] Performance considerations addressed
- [x] Naming conventions established
- [x] Structure patterns defined
- [x] Communication patterns specified
- [x] Process patterns documented with code examples
- [x] Complete directory structure defined
- [x] Component boundaries established
- [x] Integration points mapped
- [x] Requirements to structure mapping complete

### Architecture Readiness Assessment

**Overall Status: READY FOR IMPLEMENTATION**
**Confidence Level: High**

**First Implementation Priority:** Epic 1, Story 1.1 — Scaffold `packages/bot/` with `package.json`, `tsconfig.json`, npm workspace registration, and `commander` CLI skeleton.

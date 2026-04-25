---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-e-v2-add-epics-9-10-11
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/brainstorming/brainstorming-session-2026-04-13-1800.md
lastEdited: '2026-04-25'
v2Changes: 'Added Epics 9/10/11. Noted Epic 7 deprioritized to v3. Noted Epic 8 (Real Chrome) already implemented in packages/bot/src/. Added FR42-FR55, NFR21-NFR28. Updated FR Coverage Map.'
v3Changes: 'API-first multi-country SaaS pivot. Added Epics 12 (API-First Cart & Checkout), 13 (Multi-Country), 14 (KPSDK Token Bootstrap), 15 (B2B REST API), 16 (Account Vault), 17 (Drop-as-a-Service Primitive), 18 (Billing & Subscription). Marked v2 DOM checkout steps in Epic 4 as [REPLACED BY v3 EPIC 12] for the SaaS tier (v2 self-hosted tier keeps DOM). Added FR56-FR75, NFR29-NFR40. Updated Build Sequence.'
---

# nike-release-checker - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for nike-release-checker bot extension, decomposing the requirements from the PRD into implementable stories. The bot is a **new package (`packages/bot/`)** within the existing monorepo — it does not modify the existing CLI (React/Ink.js UI) or SDK packages.

## Requirements Inventory

### Functional Requirements

- FR1: Operator can import multiple Nike account configurations from a JSON file, including credentials, proxy, country, and preferred sizes
- FR2: Operator can view the list of all configured accounts with their current session status (valid, expired, or missing)
- FR3: Operator can authenticate all configured accounts in a single command, capturing session cookies across all required Nike domains
- FR4: Operator can authenticate a single specific account by ID
- FR5: Operator can clear all stored sessions and cookies for all accounts or a specific account
- FR6: System validates proxy connectivity for each account during import
- FR7: System captures and persists authenticated session cookies across `nike.com`, `accounts.nike.com`, `api.nike.com`, and payment provider domains during login
- FR8: System loads persisted cookies into isolated Playwright browser contexts before checkout execution
- FR9: System validates session freshness before initiating checkout and reports expired sessions to the operator
- FR10: System performs 2-step Nike login flow (email submission → password submission) via Playwright Stealth on `accounts.nike.com`
- FR11: System monitors target product availability by slug using the existing SDK's Product Feed API polling
- FR12: System detects stock status transitions for target sizes on the configured market (France)
- FR13: System triggers checkout execution automatically when target product becomes available in at least one specified size
- FR14: Operator can configure polling interval for Product Feed checks
- FR15: Operator can specify target product by slug and target sizes via CLI arguments or config file
- FR16: System navigates to the target product page and selects an available target size from the size grid
- FR17: System clicks the purchase button to add the selected size to cart
- FR18: System navigates to the Nike France checkout page (`/fr/checkout`)
- FR19: System completes the shipping step by confirming the pre-saved address and clicking "save and continue"
- FR20: System completes the payment step by confirming the pre-saved payment method and clicking continue
- FR21: System completes the order review step by submitting the order
- FR22: System executes the full checkout flow (FR16–FR21) independently for each configured account in parallel
- FR23: Operator can run the full checkout flow in dry-run mode that stops before order submission
- FR24: System launches each account's checkout in a separate Playwright Stealth browser context with dedicated proxy
- FR25: System masks browser automation signals (`navigator.webdriver`, canvas fingerprint, WebGL renderer)
- FR26: System injects pre-captured cookies into each browser context before navigation
- FR27: System ensures no cross-contamination of cookies, storage, or network state between account contexts
- FR28: System configures browser locale, language, and geolocation headers consistent with the target market (French IP, `fr-FR` language)
- FR29: System detects when a product becomes unavailable during checkout ("sold out") and logs the failure with elapsed time
- FR30: System detects Akamai/Cloudflare blocks (HTTP 403, challenge pages) and logs the failure with the affected account and proxy
- FR31: System detects 3D Secure iframe injection during payment, pauses checkout execution, and logs an urgent alert to terminal
- FR32: *(v1 simplified)* System times out paused account after 120s if 3DS validation not completed. Manual retry path: TUI "Retry failed accounts" action on final summary screen re-runs checkout for selected account_ids with fresh proxy rotation.
- FR33: System classifies each checkout attempt outcome (success, sold out, blocked, 3DS triggered, timeout, unknown error) and logs it distinctly
- FR34: System logs each checkout step with timestamp, account ID, step name, duration, and outcome
- FR35: Operator can configure the bot via a YAML/JSON configuration file (polling interval, market, default sizes, proxy settings, stealth options, log file path)
- FR36: `[DEFERRED v3]` Operator can start the bot in headless daemon mode — **not in scope v1, do not implement, Epic 7 code kept but not wired**
- FR37: `[DEFERRED v3]` System writes a PID file when running as daemon — **not in scope v1, do not implement**
- FR38: System writes structured JSON log entries to a log file in addition to terminal output
- FR39: System provides colorized real-time terminal output during checkout execution showing progress per account
- FR40: Operator can check the status of running bot instances and account session health
- FR41: All selectors used for Nike page interaction are stored in an external configuration file, updatable without code changes

#### v2 Additions — Distribution & Onboarding (Epic 9)

- FR42: System provides `nike-bot init` wizard walking non-dev users through account import (native file picker macOS, manual path entry Windows), session capture, and dry-run validation
- FR43: `[v1.1]` System distributes as SEA binary (Node.js Single Executable) for macOS universal (ARM+x64) and Windows x64 via GitHub Releases
- FR44: `[v1.1]` System bundles Playwright + Chromium in installer, zero additional deps required
- FR45: `[v1.0]` System provides one-line install script `curl ... | bash` installing Node.js + bot + Playwright browsers
- FR46: System ships `FIRST_LAUNCH.md` with annotated Gatekeeper (macOS) and SmartScreen (Windows) bypass screenshots
- FR47: Wizard auto-generates sample CSV templates (accounts, cards, addresses, drop) in user-chosen folder, with inline schema docs as CSV comments

#### v2 Additions — CSV-First Config (Epic 10)

- FR48: System loads `accounts.csv` schema `account_id,email,password,proxy_url,country,preferred_sizes`. Validates columns, detects duplicate ids, reports row-level errors.
- FR49: System loads `cards.csv` schema `account_id,card_number,expiry,cvv,holder_name`. Data encrypted at rest in local SQLite via AES-256 with user-derived passphrase.
- FR50: System loads `addresses.csv` schema `account_id,street,city,zip,country,phone`. Joins on account_id.
- FR51: System loads `drop.csv` schema `sku,sizes,accounts_filter`. `accounts_filter=all` means every account_id in accounts.csv with session status=valid at execution time; alternative: `;`-separated explicit ids.
- FR52: System generates `report-YYYY-MM-DD-HHMMSS.csv` post-drop with schema `account_id,status,sku,size,order_number,timestamp,error_reason,duration_ms`.

#### v2 Additions — TUI Dashboard Live (Epic 11)

- FR53: System provides live Ink TUI dashboard during drop with per-account rows (✓ COP / ⏳ WAIT / ✗ FAIL / 🔄 RETRY), step label, elapsed time, result details
- FR54: System provides pre-drop warmup mode starting at user-configured lead time (default 5 min before drop): SDK polling, slug pre-resolution, session validation, pre-launch Playwright contexts with cookies. Transitions seamlessly to drop execution at T=0.
- FR55: System displays final summary screen post-drop with aggregated counts (total, cops, failures by category) and auto-saves report CSV to user-chosen folder.

#### v3 Additions — Country Abstraction (Epic 13)

- FR56: System exposes a `Country` registry covering at minimum `FR, US, UK, DE, JP, ES, IT, NL, BE, AU` for v3.1; v3.0 ships only `FR`. Registry fields: code, name, currency, locale, default language, phone format regex, zip format regex, default Adyen iframe locale, address-line ordering.
- FR57: All cart/checkout API calls accept the country as a parameter and substitute it into the endpoint path (`/buy/carts/v2/{COUNTRY}/NIKE/NIKECOM`).
- FR58: Per-country selector overrides for residual DOM steps in `selectors/{COUNTRY}.yaml` with fallback to `selectors/default.yaml`.
- FR59: Phone numbers and ZIP codes validated against per-country regex at load time, with row-level human-readable errors.

#### v3 Additions — API-First Cart & Checkout (Epic 12)

- FR60: System replaces v2 DOM `addToCart` with `cartApi.initVisitor()` + `cartApi.addItem()` PATCH `/buy/carts/v2/{COUNTRY}/NIKE/NIKECOM` via `page.request.fetch()`. (REPLACES FR17 for SaaS tier.)
- FR61: System resolves `skuId` (UUID per size variant) from styleColor via SDK Product Feed before adding to cart.
- FR62: System replaces v2 DOM `navigateCheckout` + `completeShipping` with `PUT /buy/cart_views/v1/{view-uuid}`. (REPLACES FR18, FR19 for SaaS tier.)
- FR63: System fetches shipping methods via `GET /buy/fulfillment_offerings/v1`, drives price-calc job via `PUT /buy/fulfillment_offerings_jobs/v2/{job-uuid}`, polls until terminal state.
- FR64: System replaces v2 DOM `completePayment` selection with `POST /payment/options/v3` to enumerate stored payment methods + `PUT /buy/cart_views/v1/{view-uuid}` to bind selected method. Card-data entry stays DOM (Adyen). (REPLACES FR20 for SaaS tier.)
- FR65: System replaces v2 DOM `submitOrder` with `PUT /buy/checkouts/{cart-uuid}` (KPSDK-protected), surfaces returned `orderNumber`. (REPLACES FR21 for SaaS tier.)
- FR66: System runs review step via `PUT /buy/cart_reviews/v2/{review-uuid}` then `GET` to fetch computed totals + tax. Total mismatches abort with classification `total_mismatch`.

#### v3 Additions — KPSDK Token Bootstrap (Epic 14)

- FR67: System bootstraps fresh KPSDK token per browser context via real Chrome page-load running obfuscated `p.js`, caches `x-kpsdk-ct`/`x-kpsdk-v` in memory, uses `page.request.fetch()` to inherit it.
- FR68: On 403/429 responses, system invalidates cached KPSDK token, performs silent page reload to re-bootstrap, retries failed call exactly once. Beyond one retry → `blocked` classification.

#### v3 Additions — DOM Residual Steps (Epic 12 / 13)

- FR69: Size selection on PDP via DOM click on `[data-testid="pdp-grid-selector-item"]`; `skuId` extracted from page hydration state for subsequent API calls.
- FR70: Adyen card data entry remains DOM (typing into Adyen Web Components iframe, encrypted client-side). Iframe resolved per-country via FR56 registry.
- FR71: 3D Secure handling identical to v2 (FR31, FR32).

#### v3 Additions — B2B REST Surface (Epic 15)

- FR72: System exposes REST API at `https://api.<our-domain>/v1/*` with bearer-token auth (per-customer API keys). Min endpoints: `POST/GET /v1/drops`, `POST /v1/drops/{id}/run`, `GET /v1/orders`, `GET/POST /v1/accounts`, `POST /v1/webhooks`.
- FR73: Per-customer rate-limiting at API gateway: Solo 60/min, Pro 600/min, Enterprise unmetered. Returns 429 with `Retry-After`.
- FR74: System delivers webhook events `drop.scheduled|started|cop|fail|completed`, `order.refunded` to customer URLs with HMAC-SHA256 signature. Failed deliveries retry with exponential backoff up to 24 h.

#### v3 Additions — Account Vault (Epic 16)

- FR75: System stores per-customer Nike account credentials + cards in encrypted multi-tenant Postgres. Per-customer KMS-derived DEK wrapped by master key. Cross-customer isolation enforced at row level (`customer_id`) and key level (DEK separation).

### NonFunctional Requirements

- NFR1: End-to-end checkout time (stock detection → order submission) must complete in under 30 seconds for a single account
- NFR2: Parallel checkout execution for 5 accounts must complete within 35 seconds
- NFR3: Product Feed polling must detect stock transitions within one polling interval (configurable, default 5 seconds)
- NFR4: Playwright browser context launch must complete in under 5 seconds per context
- NFR5: Each checkout step must complete in under 8 seconds individually
- NFR6: Nike account credentials must never be logged in plaintext
- NFR7: Session cookie files must be stored with restricted file permissions (600)
- NFR8: Proxy credentials must be masked in all log output
- NFR9: Bot configuration and accounts files excluded from version control via `.gitignore`
- NFR10: No credentials or session data transmitted to any third-party service
- NFR11: Daemon process must run continuously for 24+ hours without memory leaks or crashes
- NFR12: A failure in one account's checkout must not affect other accounts (fault isolation)
- NFR13: Unexpected errors must be caught, logged, and not crash the main process
- NFR14: System must gracefully handle network timeouts with configurable thresholds
- NFR15: System must handle Playwright browser context crashes without terminating the daemon
- NFR16: Bot module must consume the existing SDK via its public API only
- NFR17: Bot must not modify any existing files in `packages/sdk/` or `packages/cli/`
- NFR18: Bot must follow existing TypeScript configuration (strict mode, ESM modules)
- NFR19: Bot must be installable without conflicts with existing dependencies
- NFR20: Playwright and stealth plugin versions must be pinned

#### v2 Additions

- NFR21: Batch session capture for 50 accounts must complete in under 3 minutes (parallel, max 10 concurrent browser contexts)
- NFR22: TUI dashboard must render frame updates ≥ 2 FPS during active drop execution (ink render loop ≤ 500ms between frames, verified via instrumented test with 10 parallel accounts)
- NFR23: Payment card data from `cards.csv` must be encrypted at rest in local SQLite using AES-256 with user-derived passphrase; never plaintext on disk
- NFR24: If TUI dashboard crashes, report CSV must still be generated from persisted state (no data loss)
- NFR25: Non-dev user with Excel familiarity must complete `nike-bot init` wizard from first launch to successful dry-run in under 10 minutes without external docs
- NFR26: CSV schema errors must be reported with row number, column name, and human-readable suggested fix
- NFR27: TUI dashboard must be readable in 80x24 terminal (standard default) without horizontal scroll or truncated account rows
- NFR28: First-launch Gatekeeper/SmartScreen bypass flow must be documented with annotated screenshots for both macOS and Windows

#### v3 Additions

- NFR29: API-call success rate on Kasada-protected endpoints ≥ 99 % over 7-day rolling window per country.
- NFR30: Per-country cart-init p95 latency < 2 s (initVisitor + addItem + cart_view shipping write), excluding KPSDK bootstrap.
- NFR31: Single worker node (8 vCPU / 16 GB / Linux / Chrome headed) sustains 50 parallel checkouts without NFR30 degradation. Auto-scale at 70 % node load.
- NFR32: Per-customer isolation — no cross-customer cart pollution possible. Verified by automated cross-tenant integration test in CI.
- NFR33: GDPR-compliant card vault. Per-customer DEK rotation on demand + forced quarterly. "Delete-my-data" purges PII within 24 h.
- NFR34: Country-localized phone/zip validation per FR56 registry. Country-specific suggested-fix messages.
- NFR35: Retry-with-fresh-KPSDK on 403/429 — total checkout latency ≤ 35 s including one retry (matches v2 NFR2 SLA).
- NFR36: REST API availability ≥ 99.5 % monthly (excluding announced maintenance).
- NFR37: Webhook delivery — 99 % of events delivered within 30 s of event firing in worker pool.
- NFR38: Per-tier rate-limit headers (`X-RateLimit-*`) on every API response, including 429.
- NFR39: Audit log — every drop run, every Nike checkout PUT, every customer-data mutation appended to immutable log retained 12 months.
- NFR40: Stripe webhook reception idempotent on `event.id` — replays do not double-charge or double-provision.

### Additional Requirements

- Bot is a NEW package `packages/bot/` within the existing npm workspaces monorepo
- Existing CLI is a React/Ink.js UI app — bot does NOT integrate into it
- Bot has its own CLI entry point using a standard argument parser (commander/citty)
- Command invocation: `nike-bot` or `npx @nike-release-checker/bot`
- Configuration via YAML/JSON files (not localStorage/SQLite pattern used by existing CLI)
- SDK consumed via public API: `getProductFeed()`, `formatProductFeedResponse()`, `availableCountries`
- Tests must use Node.js built-in test runner (matching existing project convention)
- TypeScript 5.9.3, ESM, strict mode, target esnext, module nodenext
- Package manager: npm with workspaces
- Prettier config: tabs, single quotes, no semicolons, 100 char width

### UX Design Requirements

v1 is CLI-first (wizard + TUI dashboard via Ink). No graphical UI until v4. UX concerns handled inline in Epic 9 (wizard onboarding flow) and Epic 11 (TUI layout, emojis, animations, readability in 80x24). Dedicated UX doc not required for v1.

### FR Coverage Map

| FR | Epic | Description |
|----|------|-------------|
| FR1 | Epic 2 | Import account configs from JSON |
| FR2 | Epic 2 | View accounts with session status |
| FR3 | Epic 2 | Authenticate all accounts |
| FR4 | Epic 2 | Authenticate single account |
| FR5 | Epic 2 | Clear sessions/cookies |
| FR6 | Epic 2 | Validate proxy connectivity |
| FR7 | Epic 2 | Capture multi-domain cookies |
| FR8 | Epic 2 | Load cookies into browser contexts |
| FR9 | Epic 5 | Validate session freshness pre-checkout |
| FR10 | Epic 2 | 2-step Nike login flow |
| FR11 | Epic 6 | Monitor product by slug via SDK |
| FR12 | Epic 6 | Detect stock transitions |
| FR13 | Epic 6 | Auto-trigger checkout on availability |
| FR14 | Epic 6 | Configurable polling interval |
| FR15 | Epic 6 | Specify slug and sizes |
| FR16 | Epic 4 | Select target size from grid |
| FR17 | Epic 4 | Click purchase button |
| FR18 | Epic 4 | Navigate to checkout page |
| FR19 | Epic 4 | Complete shipping step |
| FR20 | Epic 4 | Complete payment step |
| FR21 | Epic 4 | Submit order |
| FR22 | Epic 4 | Parallel multi-account execution |
| FR23 | Epic 4 | Dry-run mode |
| FR24 | Epic 3 | Separate Playwright Stealth contexts |
| FR25 | Epic 3 | Mask automation signals |
| FR26 | Epic 3 | Inject pre-captured cookies |
| FR27 | Epic 3 | No cross-contamination |
| FR28 | Epic 3 | French locale/headers |
| FR29 | Epic 5 | Detect sold out |
| FR30 | Epic 5 | Detect Akamai/Cloudflare blocks |
| FR31 | Epic 5 | Detect 3DS iframe, pause |
| FR32 | Epic 5 | Resume after 3DS validation |
| FR33 | Epic 5 | Classify checkout outcomes |
| FR34 | Epic 5 | Log each step with timing |
| FR35 | Epic 1 | Bot config file (YAML/JSON) |
| FR36 | Epic 7 | Headless daemon mode |
| FR37 | Epic 7 | PID file for daemon |
| FR38 | Epic 5 | JSON log file |
| FR39 | Epic 5 | Colorized terminal output |
| FR40 | Epic 7 `[DEFERRED v3]` | Check bot/account status |
| FR41 | Epic 1 | Externalized selector config |
| FR42 | Epic 9 | Wizard nike-bot init |
| FR43 | Epic 9 | SEA binary packaging (v1.1) |
| FR44 | Epic 9 | Auto-installer bundled (v1.1) |
| FR45 | Epic 9 | One-line install script (v1.0) |
| FR46 | Epic 9 | FIRST_LAUNCH.md bypass docs |
| FR47 | Epic 9 | Auto-generate CSV templates |
| FR48 | Epic 10 | accounts.csv parser + validator |
| FR49 | Epic 10 | cards.csv + SQLite AES-256 |
| FR50 | Epic 10 | addresses.csv join account_id |
| FR51 | Epic 10 | drop.csv accounts_filter semantics |
| FR52 | Epic 10 | report.csv generator post-drop |
| FR53 | Epic 11 | Ink TUI dashboard live |
| FR54 | Epic 11 | Pre-drop warmup mode |
| FR55 | Epic 11 | Final summary + auto-save report |
| FR56 | Epic 13 | Country registry (FR/US/UK/DE/JP/ES/IT/NL/BE/AU) |
| FR57 | Epic 13 | Country-parametric cart endpoint |
| FR58 | Epic 13 | Per-country selector overrides |
| FR59 | Epic 13 | Per-country phone/zip validation |
| FR60 | Epic 12 | Cart API initVisitor + addItem (REPLACES FR17 SaaS) |
| FR61 | Epic 12 | skuId resolution from styleColor |
| FR62 | Epic 12 | cart_views API (REPLACES FR18-19 SaaS) |
| FR63 | Epic 12 | fulfillment_offerings + jobs API |
| FR64 | Epic 12 | payment/options API + view bind (REPLACES FR20 SaaS) |
| FR65 | Epic 12 | PUT /buy/checkouts (REPLACES FR21 SaaS) |
| FR66 | Epic 12 | cart_reviews API + total mismatch detection |
| FR67 | Epic 14 | KPSDK token bootstrap via real Chrome p.js |
| FR68 | Epic 14 | KPSDK refresh on 403/429 + retry once |
| FR69 | Epic 12 | DOM size click + skuId hydration extraction |
| FR70 | Epic 12 | Adyen iframe DOM (per-country) |
| FR71 | Epic 12 | 3DS handling (identical to v2 FR31/FR32) |
| FR72 | Epic 15 | REST API surface |
| FR73 | Epic 15 | Per-tier rate-limiting |
| FR74 | Epic 15 | Webhook delivery + HMAC + retries |
| FR75 | Epic 16 | Encrypted multi-tenant account + card vault |

## Epic List

### Epic 1: Project Foundation & Bot Package Setup
The operator can install the bot as a new package within the existing monorepo. The package has its own CLI entry point with argument parsing (commander/citty), a configuration loader for `bot.config.yaml` and `accounts.json`, and an externalized selector config file. Zero modification to existing `packages/sdk/` or `packages/cli/`.
**FRs covered:** FR35, FR41

### Epic 2: Account Management & Authentication
The operator can import Nike accounts, authenticate them via Playwright Stealth (2-step login on `accounts.nike.com`), capture and persist multi-domain cookies, and manage session lifecycle (list status, refresh, logout).
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR8, FR9, FR10

### Epic 3: Stealth Browser Engine
The system can launch isolated Playwright Stealth browser contexts per account — each with dedicated proxy, injected cookies, masked automation signals, and French locale headers — with zero cross-contamination.
**FRs covered:** FR24, FR25, FR26, FR27, FR28

### Epic 4: Checkout Flow Automation
The system executes the full Nike France checkout flow — size selection, add to cart, shipping confirmation, payment confirmation, order submission — in parallel across multiple accounts, with dry-run support.
**FRs covered:** FR16, FR17, FR18, FR19, FR20, FR21, FR22, FR23

### Epic 5: Error Handling, Diagnostics & 3D Secure
The system detects and classifies all checkout outcomes (success, sold out, blocked, 3DS, timeout), logs each step with timing data, handles 3D Secure pause/resume, and provides structured terminal + JSON file logging.
**FRs covered:** FR9, FR29, FR30, FR31, FR32, FR33, FR34, FR38, FR39

### Epic 6: Product Monitoring & Auto-Trigger
The system monitors target products via the existing SDK's `getProductFeed()` API, detects stock transitions for specified sizes on the French market, and automatically triggers checkout across all accounts.
**FRs covered:** FR11, FR12, FR13, FR14, FR15

### Epic 7: Daemon Mode & Operations `[DEFERRED v3]`
The operator can run the bot as a headless background daemon with PID management and check system/account status at any time.
**FRs covered:** FR36, FR37, FR40
**v2 Status:** Code implemented in `packages/bot/src/daemon/` but **not wired** into v1 `nike-bot` binary. Deferred to v3 SaaS cloud. Do not invoke in v1 user-facing commands.

### Epic 8: Real Chrome + Advanced Bypass `[ALREADY IMPLEMENTED]`
Real Chrome via CDP, session snapshot with OAuth token capture, natural click patterns with Bezier curves, capture-session CLI.
**Stories (8.1-8.9) already done** in `packages/bot/src/{stealth,auth,checkout}/` — no additional work required for v1.

### Epic 9: Distribution & Onboarding Non-Dev `[v2 NEW]`
Kevin (non-dev reseller) can download, install, and configure the bot without opening a terminal. Covers wizard, SEA binary, auto-installer, install script, bypass docs, CSV templates.
**FRs covered:** FR42, FR43, FR44, FR45, FR46, FR47
**v1 Target:** Stories 9.1, 9.4, 9.5, 9.6 in v1.0 (3 weeks). Stories 9.2, 9.3 in v1.1 (1 week).

### Epic 10: CSV-First Config System `[v2 NEW]`
All user-facing config via CSV files. Replaces JSON-based config for non-dev users. Foundation for Epic 9 wizard and Epic 11 TUI.
**FRs covered:** FR48, FR49, FR50, FR51, FR52
**v1 Target:** v1.0 (2 weeks). **Build first — foundation for everything else.**

### Epic 11: TUI Dashboard Live `[v2 NEW]`
Live multi-account dashboard during drop execution. Pre-drop warmup mode. Final summary with retry action. Primary user-facing UI in v1.
**FRs covered:** FR53, FR54, FR55, also supports FR32 retry path
**v1 Target:** v1.0, parallel with Epic 9 after Epic 10 is stable (2 weeks).

### Epic 12: API-First Cart & Checkout Layer `[v3 NEW]`
Replaces the v2 DOM checkout pipeline (Epic 4 stories 4.2–4.6) with direct calls to `api.nike.com/buy/*` via `page.request.fetch()` to inherit the page's KPSDK token. New modules: `cartApi.ts`, `checkoutApi.ts`, `fulfillmentApi.ts`, `paymentApi.ts`, `reviewApi.ts`. DOM is retained ONLY for size click (FR69), Adyen iframe (FR70), and 3DS challenge (FR71).
**FRs covered:** FR60, FR61, FR62, FR63, FR64, FR65, FR66, FR69, FR70, FR71
**Replaces (for SaaS tier):** v2 Epic 4 stories 4.2 (FR17), 4.3 (FR18), 4.4 (FR19), 4.5 (FR20), 4.6 (FR21). v2 self-hosted tier keeps the DOM pipeline as a fallback.
**v3 Target:** v3.0 (4-6 weeks). Sequential dependency on Epic 14 (KPSDK).

### Epic 13: Multi-Country Support `[v3 NEW]`
Country registry, per-country selector overrides, locale phone/zip validation, currency handling, language injection. Removes the FR-only assumption baked into v1/v2.
**FRs covered:** FR56, FR57, FR58, FR59
**v3 Target:** v3.0 ships FR-only registry; v3.1 extends to US, UK, DE; v3.2+ adds JP, ES, IT, NL, BE, AU. Built in parallel with Epic 12 — country is a parameter to every API call.

### Epic 14: KPSDK Token Bootstrap `[v3 NEW]`
Extracts and refreshes the Kasada anti-bot token from a real browser context. Required by every Epic 12 API call. Per-account fingerprint isolation.
**FRs covered:** FR67, FR68
**v3 Target:** v3.0 (sequential prerequisite for Epic 12). Built first inside the v3.0 phase.

### Epic 15: B2B REST API `[v3 NEW]`
Fastify/Express gateway exposing the bot as a hosted service. Bearer-token auth via per-customer API keys. Per-tier rate-limiting. Webhook delivery with HMAC signatures.
**FRs covered:** FR72, FR73, FR74
**v3 Target:** v3.1 alpha (4-6 weeks). Depends on Epic 12 + 14 being stable.

### Epic 16: Account Vault `[v3 NEW]`
Multi-tenant encrypted Postgres for customer Nike account credentials, sessions, and cards. Per-customer KMS-derived data encryption keys. GDPR-compliant rotation + delete-my-data.
**FRs covered:** FR75
**v3 Target:** v3.1 (parallel with Epic 15). Required to multi-tenant the v2 single-tenant SQLite vault.

### Epic 17: Drop-as-a-Service Primitive `[v3 NEW]`
Introduces a first-class `Drop` entity with explicit lifecycle (`DRAFT → SCHEDULED → ACTIVE → COMPLETED`), per-account-per-drop isolation, and scheduling. v2 only had implicit drop runs (one TUI session = one drop); v3 promotes drops to a queryable, schedulable entity that the REST API surfaces.
**FRs covered:** FR72 (the `POST /v1/drops` semantics depend on this primitive)
**v3 Target:** v3.1 (parallel with Epic 15 + 16).

### Epic 18: Billing & Subscription `[v3 NEW]`
Stripe integration for subscription tiers (Solo / Pro / Enterprise) and per-cop usage metering. Customer self-serve dashboard read-API (the actual frontend deferred to v4).
**FRs covered:** NFR40 (Stripe webhook idempotency), and the business-model wiring referenced in v3 PRD.
**v3 Target:** v3.2 (2-3 weeks). After Epic 15+16+17 are stable enough to bill against.

### v2 Epic 4 Status Update under v3

For the **SaaS tier**, the following v2 Epic 4 stories are `[REPLACED BY v3 EPIC 12]`:
- Story 4.2 Add to Cart → `cartApi.addItem()`
- Story 4.3 Navigate to Checkout → `cart_views` create
- Story 4.4 Complete Shipping → `PUT /buy/cart_views/v1/{view-uuid}` shipping payload
- Story 4.5 Complete Payment (selection) → `POST /payment/options/v3` + bind. (Card data entry stays Story 4.5 DOM via Adyen.)
- Story 4.6 Submit Order → `PUT /buy/checkouts/{cart-uuid}`

Story 4.1 (Select Size) is **retained** in both tiers per FR69 — DOM size click feeds skuId into the API path.

For the **self-hosted tier (v2)**, all of Epic 4 remains as-is and continues to be the supported execution path.

## Epic 1: Project Foundation & Bot Package Setup

The operator can install the bot as a new package within the existing monorepo with its own CLI, configuration system, and externalized selectors.

### Story 1.1: Scaffold Bot Package in Monorepo

As an operator,
I want a new `packages/bot/` package registered in the npm workspaces monorepo,
So that I can develop the bot without modifying existing SDK or CLI packages.

**Acceptance Criteria:**

**Given** the existing monorepo with `packages/sdk/` and `packages/cli/`
**When** `packages/bot/` is created with its own `package.json`, `tsconfig.json` extending root config, and registered in root `package.json` workspaces
**Then** `npm install` from root resolves all workspaces including bot
**And** `packages/bot/` has `"type": "module"`, TypeScript strict mode, target `esnext`, module `nodenext`
**And** `@nike-release-checker/sdk` is listed as a workspace dependency
**And** no files in `packages/sdk/` or `packages/cli/` are modified

### Story 1.2: CLI Entry Point with Argument Parsing

As an operator,
I want to run `nike-bot --help` and see available commands,
So that I can discover and execute bot functionality from the terminal.

**Acceptance Criteria:**

**Given** the bot package is scaffolded (Story 1.1)
**When** a CLI entry point is created using a standard argument parser (commander or citty) with a `bin` entry in `package.json`
**Then** `npx @nike-release-checker/bot --help` displays the list of available commands
**And** commands include placeholders for: `import-accounts`, `login-all`, `logout-all`, `accounts`, `start`, `dry-run`, `status`
**And** each command placeholder returns "Not yet implemented" with exit code 0
**And** `--version` displays the package version

### Story 1.3: Configuration Loader (bot.config.yaml)

As an operator,
I want to configure the bot via a `bot.config.yaml` file,
So that I can set polling interval, market, default sizes, proxy settings, and stealth options without changing code. (FR35)

**Acceptance Criteria:**

**Given** a `bot.config.yaml` file exists in the project root or a path specified by `--config` flag
**When** the bot CLI starts and loads configuration
**Then** all config values are parsed and validated (polling.interval, checkout.market, checkout.defaultSizes, proxy.rotationMode, stealth.headless, daemon.logFile)
**And** missing required fields produce a clear error message with the field name
**And** default values are applied for optional fields
**And** a sample `bot.config.example.yaml` is provided in the package
**And** `bot.config.yaml` and `accounts.json` are listed in `.gitignore`

### Story 1.4: Externalized Selector Configuration

As an operator,
I want all CSS selectors used for Nike page interaction stored in an external config file,
So that I can update selectors when Nike changes their DOM without modifying code. (FR41)

**Acceptance Criteria:**

**Given** a `selectors.yaml` (or `selectors.json`) file exists in the bot config directory
**When** the bot loads selectors at startup
**Then** selectors are available for: size grid items (`[data-qa="size-available"]`), purchase button (`.ncss-btn-primary-dark`), checkout link, shipping save button (`[data-attr="saveAddressBtn"]`), payment continue button, order submit button, 3DS iframe detection
**And** missing selectors produce a clear error at startup listing the missing keys
**And** a sample `selectors.example.yaml` is provided with documented Nike FR selectors from the PRD

## Epic 2: Account Management & Authentication

The operator can import Nike accounts, authenticate them, capture multi-domain cookies, and manage session lifecycle.

### Story 2.1: Import Accounts from JSON

As an operator,
I want to import Nike account configurations from an `accounts.json` file,
So that I can configure multiple accounts with their credentials, proxies, and preferences in one step. (FR1, FR6)

**Acceptance Criteria:**

**Given** an `accounts.json` file with entries containing id, email, password, proxy, country, preferredSizes, paymentMethod
**When** I run `nike-bot import-accounts --file accounts.json`
**Then** each account is validated for required fields (id, email, password, proxy, country)
**And** proxy connectivity is tested for each account and results reported (success/fail per account)
**And** valid accounts are stored locally (JSON file in a `.bot-data/` directory)
**And** credentials are never logged in plaintext to terminal output (NFR6)
**And** invalid entries are reported with specific error (missing field, bad proxy) without stopping the import of other accounts

### Story 2.2: Authenticate All Accounts (Login Flow)

As an operator,
I want to authenticate all imported accounts in a single command,
So that I have valid session cookies ready for checkout. (FR3, FR7, FR10)

**Acceptance Criteria:**

**Given** accounts have been imported (Story 2.1)
**When** I run `nike-bot login-all`
**Then** for each account, a Playwright Stealth browser context is launched with the account's dedicated proxy
**And** the system navigates to `accounts.nike.com` and performs 2-step login (email field → continue → password field → submit)
**And** session cookies are captured across all domains (`nike.com`, `accounts.nike.com`, `api.nike.com`, payment providers)
**And** cookies are serialized and stored locally per account in `.bot-data/sessions/<account_id>.json`
**And** cookie files are created with restricted permissions (600) (NFR7)
**And** terminal reports progress: "Authenticating account_1... ✓", "Authenticating account_2... ✗ (reason)"
**And** a final summary is displayed: "4/5 accounts authenticated. 1 failed."

### Story 2.3: Authenticate Single Account

As an operator,
I want to authenticate a single account by ID,
So that I can refresh one expired session without re-authenticating all accounts. (FR4)

**Acceptance Criteria:**

**Given** accounts have been imported
**When** I run `nike-bot login-all --account account_2`
**Then** only the specified account is authenticated using the same flow as Story 2.2
**And** only that account's session file is updated
**And** an error is returned if the account ID doesn't exist in the imported accounts

### Story 2.4: List Accounts with Session Status

As an operator,
I want to view all configured accounts with their current session status,
So that I know which accounts are ready and which need re-authentication. (FR2, FR9)

**Acceptance Criteria:**

**Given** accounts have been imported and some have been authenticated
**When** I run `nike-bot accounts`
**Then** a table is displayed with columns: ID, Email (masked), Country, Proxy (masked), Session Status (valid/expired/missing)
**And** session validity is determined by checking cookie expiration dates against current time
**And** `--verbose` flag shows additional details (preferred sizes, last login timestamp, cookie domain count)
**And** proxy credentials in the output are masked (NFR8)

### Story 2.5: Clear Sessions and Logout

As an operator,
I want to clear stored sessions for all or a specific account,
So that I can force re-authentication or clean up data. (FR5)

**Acceptance Criteria:**

**Given** session files exist for authenticated accounts
**When** I run `nike-bot logout-all`
**Then** all session files in `.bot-data/sessions/` are deleted
**And** terminal confirms: "All sessions cleared. 5 session files removed."
**When** I run `nike-bot logout-all --account account_2`
**Then** only that account's session file is deleted
**And** terminal confirms: "Session cleared for account_2."
**And** an error is returned if no session exists for the specified account

### Story 2.6: Load Cookies into Browser Context

As an operator,
I want the system to load persisted cookies into Playwright browser contexts before checkout,
So that sessions are pre-authenticated without requiring login at checkout time. (FR8)

**Acceptance Criteria:**

**Given** a valid session file exists for an account
**When** a Playwright browser context is created for that account
**Then** all cookies from the session file are injected via `context.addCookies()`
**And** cookies are injected for all stored domains (`.nike.com`, `accounts.nike.com`, `api.nike.com`, etc.)
**And** the browser context is usable for authenticated navigation on nike.com without re-login
**And** if the session file is missing or corrupted, a clear error is logged identifying the account

## Epic 3: Stealth Browser Engine

The system launches isolated Playwright Stealth browser contexts per account with anti-detection, proxy isolation, and French locale.

### Story 3.1: Playwright Stealth Context Factory

As an operator,
I want the system to create Playwright Stealth browser contexts with anti-detection measures,
So that each browser session appears as a legitimate human Chrome browser to Nike's protection systems. (FR24, FR25)

**Acceptance Criteria:**

**Given** Playwright, playwright-extra, and puppeteer-extra-plugin-stealth are installed
**When** a stealth browser context is requested for an account
**Then** the context is created with stealth plugin active, masking `navigator.webdriver`, canvas fingerprint, WebGL renderer strings, and Chrome plugin list
**And** the User-Agent string matches a recent Chrome version on the appropriate OS
**And** headless mode is configurable via `bot.config.yaml` (`stealth.headless`)
**And** context launch completes in under 5 seconds (NFR4)

### Story 3.2: Per-Account Proxy Isolation

As an operator,
I want each account's browser context to use its own dedicated residential proxy,
So that Nike cannot correlate multiple accounts by shared IP address. (FR24, FR27)

**Acceptance Criteria:**

**Given** each account has a proxy URL configured in `accounts.json`
**When** a browser context is created for that account
**Then** all HTTP traffic from that context routes through the account's dedicated proxy
**And** no two account contexts share the same proxy connection
**And** proxy authentication (username/password from URL) is handled transparently
**And** if the proxy connection fails, the error is logged with the account ID and proxy host (credentials masked per NFR8)

### Story 3.3: Cookie Injection and Session Isolation

As an operator,
I want each browser context to have its pre-captured cookies injected with zero cross-contamination between accounts,
So that each account operates as a fully independent authenticated session. (FR26, FR27)

**Acceptance Criteria:**

**Given** valid session cookies exist for an account (from Epic 2)
**When** a browser context is created for that account
**Then** cookies are loaded and injected via `context.addCookies()` before any navigation
**And** each context has its own isolated cookie jar, localStorage, and sessionStorage
**And** closing one context does not affect cookies or state of other contexts
**And** a test can verify that `document.cookie` in context A does not contain cookies from context B

### Story 3.4: French Locale and Geolocation Headers

As an operator,
I want each browser context configured with French locale, language headers, and geolocation consistency,
So that Nike's geographic validation accepts the session as a legitimate French user. (FR28)

**Acceptance Criteria:**

**Given** the bot config specifies `checkout.market: "FR"` and `checkout.language: "fr"`
**When** a browser context is created
**Then** the `Accept-Language` header is set to `fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7`
**And** the browser locale is set to `fr-FR`
**And** the timezone is set to `Europe/Paris`
**And** the geolocation (if configurable) is consistent with a French IP
**And** these settings match across all navigation requests within the context

## Epic 4: Checkout Flow Automation

The system executes the full Nike France checkout flow in parallel across multiple accounts with dry-run support.

### Story 4.1: Navigate to Product and Select Size

As an operator,
I want the system to navigate to a Nike product page and select an available target size,
So that the correct product and size are added to the cart. (FR16)

**Acceptance Criteria:**

**Given** a stealth browser context with injected cookies (from Epic 3) and a target product slug and sizes
**When** the system navigates to the Nike FR product page for the given slug
**Then** the size grid is located using the externalized selector for available sizes (`[data-qa="size-available"]`)
**And** the system clicks the first matching target size that is available
**And** if none of the target sizes are available, the attempt is logged as "no target size available" with the list of available sizes found
**And** the step completes in under 8 seconds (NFR5)

### Story 4.2: Add to Cart

As an operator,
I want the system to click the purchase button after size selection,
So that the product is added to the shopping cart. (FR17)

**Acceptance Criteria:**

**Given** a size has been successfully selected (Story 4.1)
**When** the system clicks the purchase/buy button using the externalized selector
**Then** the system waits for confirmation that the item was added (page state change, cart indicator, or navigation)
**And** if the button is disabled or missing, the attempt is logged as "add to cart failed" with the page state
**And** the step completes in under 8 seconds (NFR5)

### Story 4.3: Navigate to Checkout

As an operator,
I want the system to navigate to the Nike France checkout page,
So that the order process can begin. (FR18)

**Acceptance Criteria:**

**Given** the product has been added to cart (Story 4.2)
**When** the system navigates to `https://www.nike.com/fr/checkout`
**Then** the checkout page loads with the order items visible
**And** if the cart is empty or the page fails to load, the attempt is logged with the error state
**And** the step completes in under 8 seconds (NFR5)

### Story 4.4: Complete Shipping Step

As an operator,
I want the system to confirm the pre-saved shipping address and proceed,
So that the shipping step is completed without manual input. (FR19)

**Acceptance Criteria:**

**Given** the checkout page is loaded with shipping as the active step
**When** the system detects the shipping form
**Then** if a pre-saved address is already selected, the system clicks "Enregistrer et continuer" (`[data-attr="saveAddressBtn"]`)
**And** if the address form is empty (no pre-saved address), the attempt is logged as "no pre-saved address found" and the checkout is aborted for this account
**And** the system waits for the payment step to become active before proceeding
**And** the step completes in under 8 seconds (NFR5)

### Story 4.5: Complete Payment Step

As an operator,
I want the system to confirm the pre-saved payment method and proceed,
So that the payment step is completed without manual input. (FR20)

**Acceptance Criteria:**

**Given** the shipping step is complete and payment step is active
**When** the system detects the payment form
**Then** if a pre-saved payment method is already selected, the system clicks the continue/confirm button
**And** if no pre-saved payment method is found, the attempt is logged as "no pre-saved payment found" and the checkout is aborted for this account
**And** the system waits for the order review step to become active before proceeding
**And** the step completes in under 8 seconds (NFR5)

### Story 4.6: Submit Order

As an operator,
I want the system to submit the order on the review step,
So that the purchase is completed. (FR21)

**Acceptance Criteria:**

**Given** the payment step is complete and order review step is active
**When** the system clicks the submit order button using the externalized selector
**Then** the system waits for order confirmation (success page, confirmation message, or order number)
**And** if confirmation is detected, the outcome is logged as "ORDER CONFIRMED" with product name, size, account ID, and total price
**And** if the order fails (error message, timeout), the outcome is logged with the failure reason
**And** the step completes in under 8 seconds (NFR5)

### Story 4.7: Parallel Multi-Account Checkout Execution

As an operator,
I want the system to execute the full checkout flow independently for each configured account in parallel,
So that multiple accounts attempt to purchase simultaneously, maximizing success probability. (FR22)

**Acceptance Criteria:**

**Given** multiple accounts with valid sessions and a target product
**When** checkout is triggered
**Then** the system launches a stealth browser context for each account concurrently (using `Promise.allSettled` or equivalent)
**And** each account executes the complete flow (Stories 4.1–4.6) independently
**And** a failure in one account does not affect other accounts' execution (NFR12)
**And** parallel execution for 5 accounts completes within 35 seconds total (NFR2)
**And** results are collected and reported per account after all executions complete

### Story 4.8: Dry-Run Mode

As an operator,
I want to run the full checkout flow without submitting the order,
So that I can validate selectors, sessions, and the flow work correctly before a real drop. (FR23)

**Acceptance Criteria:**

**Given** a target product slug and an account ID
**When** I run `nike-bot dry-run --slug "air-force-1" --profile account_1`
**Then** the system executes the full flow (Stories 4.1–4.5) but stops before the submit order step (Story 4.6)
**And** terminal displays each step result: "✓ Size selected (42.5)", "✓ Added to cart", "✓ Shipping confirmed", "✓ Payment confirmed", "⏸ Dry-run: order submission skipped"
**And** total elapsed time is displayed
**And** the browser context is closed and no order is placed

## Epic 5: Error Handling, Diagnostics & 3D Secure

The system detects and classifies all checkout outcomes, handles 3D Secure, and provides structured logging.

### Story 5.1: Checkout Step Timing and Structured Logging

As an operator,
I want every checkout step logged with timestamp, account ID, step name, duration, and outcome,
So that I can analyze performance and identify bottlenecks. (FR34, FR38)

**Acceptance Criteria:**

**Given** a checkout execution is in progress for an account
**When** each step completes (size selection, add to cart, checkout navigation, shipping, payment, order submit)
**Then** a structured log entry is written to the JSON log file with fields: `timestamp`, `accountId`, `step`, `durationMs`, `outcome` (success/fail), `details`
**And** the log file path is configurable via `bot.config.yaml` (`daemon.logFile`)
**And** each log entry is a single JSON line (NDJSON format) for easy parsing
**And** credentials and proxy passwords are never present in log entries (NFR6, NFR8)

### Story 5.2: Colorized Terminal Output

As an operator,
I want colorized real-time terminal output showing progress per account during checkout,
So that I can monitor what's happening when running interactively. (FR39)

**Acceptance Criteria:**

**Given** checkout is executing for multiple accounts
**When** each step completes or fails
**Then** terminal displays a color-coded line per event: green for success (✓), red for failure (✗), yellow for warning (⚠), magenta for 3DS (🔐)
**And** each line is prefixed with `[account_id]` and includes the step name and duration
**And** a final summary is displayed after all accounts complete: "2/5 succeeded, 2 failed, 1 blocked"
**And** terminal output works in headless/daemon mode by writing to stdout (captured by log file redirect)

### Story 5.3: Sold Out Detection

As an operator,
I want the system to detect when a product becomes unavailable during checkout,
So that the attempt is cleanly aborted and logged rather than hanging. (FR29)

**Acceptance Criteria:**

**Given** a checkout is in progress for an account
**When** Nike displays "This item is no longer available", the size grid shows all sizes as unavailable, or the cart becomes empty during checkout
**Then** the checkout is aborted for that account
**And** the outcome is classified as `sold_out`
**And** the log entry includes elapsed time at the point of detection
**And** other accounts' checkouts continue unaffected (NFR12)

### Story 5.4: Akamai/Cloudflare Block Detection

As an operator,
I want the system to detect when a session is blocked by anti-bot systems,
So that I know which proxies or accounts need attention. (FR30)

**Acceptance Criteria:**

**Given** a checkout is in progress for an account
**When** the page returns HTTP 403, a Cloudflare challenge page, an Akamai "Pardon Our Interruption" page, or the expected page content (size grid, checkout form) is not found within timeout
**Then** the checkout is aborted for that account
**And** the outcome is classified as `blocked`
**And** the log entry includes the account ID, proxy host (credentials masked), and the detection signal (403 status, challenge page, missing expected element)
**And** other accounts' checkouts continue unaffected (NFR12)

### Story 5.5: 3D Secure Detection and Pause

As an operator,
I want the system to detect 3D Secure iframe injection and pause checkout with an urgent terminal alert,
So that I can manually validate the transaction on my banking app. (FR31)

**Acceptance Criteria:**

**Given** a checkout has reached the payment or order submission step
**When** a 3D Secure iframe is detected (iframe from bank domain, Adyen 3DS challenge, or payment verification modal)
**Then** the checkout execution pauses for that account (browser context stays open)
**And** an urgent terminal alert is logged: "🔐 3DS REQUIRED — [product] — [account_id] — Validate on your banking app NOW"
**And** the alert is distinctly formatted (color, emoji) to stand out from regular log output
**And** other accounts' checkouts continue unaffected

### Story 5.6: 3D Secure Resume After Validation

As an operator,
I want the system to detect when 3D Secure validation is complete and resume checkout,
So that the order is submitted after I approve on my banking app. (FR32)

**Acceptance Criteria:**

**Given** the checkout is paused waiting for 3DS validation (Story 5.5)
**When** the 3DS iframe disappears, the page redirects back to Nike checkout, or the order confirmation page loads
**Then** the system resumes checkout execution for that account
**And** if the order was confirmed, outcome is classified as `success`
**And** if the 3DS validation times out (configurable, default 120 seconds), the outcome is classified as `3ds_timeout`
**And** the total elapsed time includes the 3DS wait time, logged separately from checkout step time

### Story 5.7: Checkout Outcome Classification

As an operator,
I want every checkout attempt classified with a distinct outcome type,
So that I can understand results at a glance and track success rates over time. (FR33)

**Acceptance Criteria:**

**Given** a checkout attempt completes (success or failure) for an account
**When** the final outcome is determined
**Then** the outcome is classified as exactly one of: `success`, `sold_out`, `blocked`, `3ds_success`, `3ds_timeout`, `timeout`, `no_session`, `error`
**And** each outcome has a dedicated log entry with the classification, account ID, product slug, size attempted, and total duration
**And** the terminal summary after all accounts uses these classifications: "✅ 2 success, ❌ 1 sold_out, ⚠️ 1 blocked, 🔐 1 3ds_timeout"

### Story 5.8: Pre-Checkout Session Validation

As an operator,
I want the system to validate session freshness before initiating checkout,
So that I don't waste time on accounts with expired cookies. (FR9)

**Acceptance Criteria:**

**Given** checkout is about to be triggered for multiple accounts
**When** the system checks each account's session file before launching browser contexts
**Then** accounts with missing session files are skipped and logged as `no_session`
**And** accounts with expired cookies (based on cookie expiration timestamps) are flagged with a terminal warning: "⚠️ account_2: session expired (last login: 2h ago). Run login-all to refresh."
**And** only accounts with valid sessions proceed to checkout
**And** the operator is informed how many accounts were skipped and why

## Epic 6: Product Monitoring & Auto-Trigger

The system monitors products via the SDK and triggers checkout automatically when stock appears.

### Story 6.1: SDK Integration for Product Feed Polling

As an operator,
I want the system to poll the Nike Product Feed API via the existing SDK,
So that product availability is monitored without re-implementing API logic. (FR11, FR14)

**Acceptance Criteria:**

**Given** the bot config specifies `checkout.market: "FR"` and `polling.interval: 5000`
**When** monitoring is started for a target slug
**Then** the system calls the SDK's `getProductFeed()` with `countryCode: "FR"` and the configured language at the configured interval
**And** responses are parsed using the SDK's `formatProductFeedResponse()`
**And** the polling loop runs continuously until stopped or a trigger condition is met
**And** stock transitions are detected within one polling interval (NFR3)
**And** if the SDK returns an error (network timeout, rate limit), the error is logged and polling continues on next interval without crashing (NFR13)

### Story 6.2: Stock Transition Detection for Target Sizes

As an operator,
I want the system to detect when target sizes become available,
So that checkout is triggered at the earliest possible moment. (FR12)

**Acceptance Criteria:**

**Given** the system is polling the Product Feed for a target slug
**When** the response indicates stock status changed to `HIGH`, `MEDIUM`, or `LOW` (from `OOS` or not previously seen) for at least one of the operator's target sizes
**Then** the transition is detected and logged with: slug, size, previous stock level, new stock level, timestamp
**And** sizes not in the operator's target list are ignored
**And** a transition from `HIGH` to `MEDIUM` does not re-trigger (only `OOS`/absent → available transitions trigger)
**And** if multiple target sizes become available simultaneously, all are detected

### Story 6.3: Auto-Trigger Checkout on Availability

As an operator,
I want the system to automatically trigger parallel checkout execution when stock is detected,
So that I don't need to be present when the drop goes live. (FR13)

**Acceptance Criteria:**

**Given** monitoring is running with `--auto-checkout` flag
**When** a stock transition is detected for at least one target size (Story 6.2)
**Then** the system immediately triggers the checkout flow (Epic 4) for all accounts with valid sessions
**And** the first available target size is used for checkout (priority order from the operator's size list)
**And** pre-checkout session validation (Story 5.8) runs before launching browser contexts
**And** the terminal logs: "🚀 STOCK DETECTED — [slug] — Size [X] — Triggering checkout for [N] accounts"
**And** the total time from detection to first browser context launch is under 5 seconds
**And** after checkout completes (all accounts finished), monitoring resumes for subsequent restocks

### Story 6.4: CLI Start Command with Monitoring

As an operator,
I want to start monitoring and auto-checkout via a single CLI command with slug and size arguments,
So that I can set up a drop watcher quickly. (FR15)

**Acceptance Criteria:**

**Given** accounts are imported and authenticated
**When** I run `nike-bot start --slug "air-jordan-1-royal" --sizes 42,42.5,43 --auto-checkout`
**Then** the system starts polling for the specified slug on the configured market
**And** target sizes are parsed from the `--sizes` argument (comma-separated)
**And** if `--sizes` is omitted, default sizes from `bot.config.yaml` are used
**And** the terminal displays: "Monitoring [slug] for sizes [42, 42.5, 43] on market FR. Polling every 5s. Waiting for stock..."
**And** the process runs until manually stopped (Ctrl+C) or a checkout cycle completes
**And** `--slug` is required; missing it produces a clear error

## Epic 7: Daemon Mode & Operations

The operator can run the bot as a background daemon and check status at any time.

### Story 7.1: Headless Daemon Mode

As an operator,
I want to start the bot as a background daemon process,
So that it runs unattended after I close the terminal or SSH session. (FR36, FR37)

**Acceptance Criteria:**

**Given** accounts are imported, authenticated, and a target slug is specified
**When** I run `nike-bot start --slug "air-jordan-1-royal" --sizes 42,42.5 --auto-checkout --daemon`
**Then** the process detaches from the terminal and runs in the background
**And** a PID file is written to the path configured in `bot.config.yaml` (`daemon.pidFile`, default `./bot.pid`)
**And** the terminal outputs: "Bot started in daemon mode. PID: [pid]. Log: [logFile]"
**And** all output is redirected to the configured log file instead of terminal
**And** the process continues running after the terminal session is closed
**And** the daemon runs continuously for 24+ hours without memory leaks or crashes (NFR11)
**And** Playwright browser context crashes are caught and do not terminate the daemon process (NFR15)

### Story 7.2: Bot Status Command

As an operator,
I want to check the status of running bot instances and account session health,
So that I can verify the bot is alive and accounts are ready without inspecting log files. (FR40)

**Acceptance Criteria:**

**Given** a bot daemon is running (or not)
**When** I run `nike-bot status`
**Then** the system checks for an active PID file and verifies the process is alive
**And** if running, displays: PID, uptime, target slug, monitoring status (polling/idle/checkout in progress), last poll timestamp
**And** if not running, displays: "No active bot instance found."
**And** account session health is displayed: count of valid/expired/missing sessions
**And** `--json` flag outputs the status as structured JSON for scripting

### Story 7.3: Graceful Shutdown Handling

As an operator,
I want the daemon to shut down gracefully on SIGTERM/SIGINT,
So that browser contexts are properly closed and no resources leak. (NFR11, NFR15)

**Acceptance Criteria:**

**Given** a bot daemon is running with active monitoring or checkout in progress
**When** the process receives SIGTERM or SIGINT (kill command or Ctrl+C in foreground mode)
**Then** the polling loop stops accepting new cycles
**And** any active Playwright browser contexts are closed gracefully (not force-killed)
**And** the PID file is removed
**And** the log file records: "Bot shutting down gracefully. [N] browser contexts closed."
**And** the process exits with code 0

---

## Epic 8: Real Chrome + Advanced Bypass `[ALREADY IMPLEMENTED]`

Stories 8.1 through 8.9 already written and implemented in `packages/bot/src/{stealth,auth,checkout}/`. See individual story files in `_bmad-output/implementation-artifacts/stories/`. No further action required for v1.

**Stories:**
- 8.1 Real Chrome CDP integration
- 8.2 Session snapshot with OAuth capture
- 8.3 Natural click Bezier patterns
- 8.4 capture-session CLI command
- 8.5 Real Chrome pipeline integration
- 8.6 complete-shipping ARIA disabled handling
- 8.7 complete-payment verify
- 8.8 submit-order verify
- 8.9 capture-session register account

---

## Epic 9: Distribution & Onboarding Non-Dev `[v2 NEW]`

Kevin (non-dev reseller) can install and configure the bot in under 10 minutes without opening a terminal manually. This epic wraps the technically-complete bot (Epics 1-8) in a zero-friction onboarding layer.

**Build order:** 10.1 → 9.1 → 9.4 → 9.5 → 9.6 → 9.2 → 9.3. Stories 9.2 and 9.3 ship in v1.1.

### Story 9.1: Interactive Wizard `nike-bot init`

As Kevin,
I want a single `nike-bot init` command that walks me through setup step by step,
So that I can configure accounts, cards, addresses, capture sessions, and validate the flow without typing other commands. (FR42)

**Acceptance Criteria:**

**Given** the bot is installed (via npm, install script, or SEA binary)
**When** I run `nike-bot init` in an empty folder
**Then** an Ink-based wizard prompts me step-by-step:
- Step 1: "How many accounts? (1-100)" — numeric input with validation
- Step 2: "Where is your accounts.csv?" — native file picker on macOS (via `open -a Finder`-equivalent flow) or manual path entry with tab-autocomplete on Windows
- Step 3: Same prompt for `cards.csv` and `addresses.csv`
- Step 4: "Capturing sessions for N accounts..." — auto-runs Epic 2 batch session capture with live per-account progress
- Step 5: "Running dry-run on first account..." — auto-runs Epic 4 dry-run against a known in-stock test product
- Step 6: Final summary: "✓ Setup complete. N accounts authenticated, N proxies validated, dry-run successful."
**And** total wizard completion time < 10 minutes for 10 accounts (NFR25)
**And** all CSV parse errors are surfaced with row/column/suggested-fix (NFR26)
**And** wizard can be re-run idempotently (re-captures expired sessions, re-validates, skips dry-run if recent)

### Story 9.2: SEA Binary Packaging `[v1.1]`

As Kevin,
I want to download a single `.dmg` or `.exe` file and double-click to run,
So that I don't need to install Node.js or npm. (FR43)

**Acceptance Criteria:**

**Given** Node.js Single Executable Application (SEA) tooling is configured for macOS universal (ARM+x64) and Windows x64
**When** a release is tagged in the repo
**Then** GitHub Actions builds:
- `nike-bot-v1.1.0-macos-universal.dmg` (DMG containing universal binary, ad-hoc signed)
- `nike-bot-v1.1.0-windows-x64.exe` (self-extracting installer)
**And** binaries are published to GitHub Releases
**And** the macOS binary launches a native Terminal window on double-click (embedded launcher script)
**And** the Windows binary launches a Command Prompt window on double-click
**And** binary size < 150MB (Node.js + Ink + Playwright launcher; Chromium downloaded on first run)
**And** first-launch success rate > 90% measured via opt-in telemetry (NFR28)
**And** download → first successful `nike-bot init` completion in < 5 minutes

### Story 9.3: Auto-Installer Bundling Playwright + Chromium `[v1.1]`

As Kevin,
I want the installer to download and set up Playwright + Chromium automatically on first launch,
So that I never see a "missing dependency" error. (FR44)

**Acceptance Criteria:**

**Given** the SEA binary (Story 9.2) is launched for the first time
**When** the bot detects no Chromium binary in the expected cache path
**Then** an Ink progress screen displays: "First-time setup — downloading browser engine (~200MB). This takes 2-3 minutes on fiber."
**And** the bot invokes `playwright install chromium` programmatically and streams download progress to the TUI
**And** on failure (no network, corporate proxy blocking), a clear error message with recovery path is shown: "Unable to download browser. Try: 1) check internet, 2) run `nike-bot install-browser --proxy <url>`"
**And** successful install stores Chromium in a predictable location (`~/.nike-bot/browsers/` or `%APPDATA%\nike-bot\browsers\`)
**And** subsequent launches skip this step (detected via cache)

### Story 9.4: One-Line Install Script `[v1.0]`

As Kevin (or a slightly-more-technical user),
I want a single curl command that installs everything,
So that I don't need to manually install Node.js. (FR45)

**Acceptance Criteria:**

**Given** a hosted install script at `https://nike-bot.dev/install.sh` (or GitHub raw URL)
**When** a user runs `curl -fsSL https://nike-bot.dev/install.sh | bash` on macOS or Linux
**Then** the script detects OS and architecture
**And** installs Node.js 24+ via nvm if not present (or skips if a compatible version exists)
**And** installs `@nike-release-checker/bot` globally via npm
**And** runs `playwright install chromium` for the Playwright browser
**And** prints a success message: "✓ Installed. Run `nike-bot init` to get started."
**And** handles the common failure modes (no curl, corporate network, non-sudo user) with specific error messages
**And** is idempotent (safe to re-run to upgrade)
**And** Windows equivalent is a PowerShell one-liner: `iwr -useb https://nike-bot.dev/install.ps1 | iex`

### Story 9.5: FIRST_LAUNCH.md with Gatekeeper/SmartScreen Screenshots

As Kevin,
I want a documentation file explaining how to bypass macOS Gatekeeper and Windows SmartScreen on first launch,
So that I can run the bot even though it's not code-signed. (FR46, NFR28)

**Acceptance Criteria:**

**Given** the `.dmg` or `.exe` binary is distributed without a paid code-signing certificate
**When** Kevin double-clicks the binary for the first time and the OS blocks it
**Then** he refers to `FIRST_LAUNCH.md` (shipped alongside the binary and displayed on first launch if possible)
**And** the document contains:
- Annotated screenshots for macOS: "Right-click → Open → Open" flow, Gatekeeper dialog, Terminal launching
- Annotated screenshots for Windows SmartScreen: "More info → Run anyway" flow
- Fallback instructions: `xattr -d com.apple.quarantine /Applications/nike-bot.app` for macOS command-line bypass
- Explanation of why (budget constraint: no paid code-signing), with trust-building framing (open-source, auditable)
**And** the document is also linked from the GitHub Releases page

### Story 9.6: Auto-Generate CSV Templates

As Kevin,
I want the wizard to generate template CSV files for me,
So that I don't need to remember the schema or create them from scratch. (FR47)

**Acceptance Criteria:**

**Given** Kevin runs `nike-bot init` in an empty folder (Story 9.1)
**When** the wizard offers: "I can generate sample CSV templates. Create them here? [Y/n]"
**Then** if yes, the wizard writes to the current folder:
- `accounts.csv` with header row + 2 commented sample rows demonstrating the schema
- `cards.csv` with header + commented samples
- `addresses.csv` with header + commented samples
- `drop.csv` with header + 1 commented sample: `# sku,sizes,accounts_filter\n# AH7389-106,"42;42.5;43",all`
**And** each CSV top-level has a `#`-prefixed comment block documenting each column (format, required/optional, example value)
**And** files are created with permissions 600 for credential files (accounts, cards)
**And** the wizard does not overwrite existing files without confirmation

---

## Epic 10: CSV-First Config System `[v2 NEW]`

Foundation for Epic 9 (wizard consumes it) and Epic 11 (TUI surfaces it). Must be built first. Replaces the v1 JSON-based `accounts.json` config pattern for end-users while keeping the JSON path available for power users and tests.

**Build order:** 10.1 → 10.3 → 10.4 → 10.2 → 10.5. Cards (10.2) last because encryption adds complexity and can be stubbed initially.

### Story 10.1: `accounts.csv` Parser and Validator

As Kevin,
I want to configure my accounts in a CSV file editable in Excel,
So that I don't need to learn JSON syntax. (FR48, NFR26)

**Acceptance Criteria:**

**Given** an `accounts.csv` file exists with header: `account_id,email,password,proxy_url,country,preferred_sizes`
**When** the bot loads the file (via `papaparse` or equivalent)
**Then** every row is validated:
- `account_id` present, unique across rows, matches `[a-zA-Z0-9_-]+`
- `email` matches basic email regex
- `password` non-empty (never logged)
- `proxy_url` valid URL (http/https/socks5); optional — empty allowed for local testing
- `country` is a valid 2-letter ISO code (default `FR`)
- `preferred_sizes` is a `;`-separated list matching size format (e.g., `42;42.5;43`)
**And** all errors are collected and returned together (not fail-fast), each with: row number, column name, actual value (password masked), suggested fix
**And** valid rows are parsed into an in-memory `Account[]` structure reused across the bot
**And** the parser is case-insensitive for column headers and tolerant of extra whitespace
**And** unit tests cover: happy path, missing required column, duplicate account_id, malformed proxy, malformed size list

### Story 10.2: `cards.csv` Parser + SQLite AES-256 Encryption at Rest

As Kevin,
I want my payment card data stored encrypted locally,
So that if someone copies my bot folder they can't steal my cards. (FR49, NFR23)

**Acceptance Criteria:**

**Given** a `cards.csv` file exists with header: `account_id,card_number,expiry,cvv,holder_name`
**When** the bot first loads the file via `nike-bot init` or `nike-bot cards import`
**Then** the wizard prompts Kevin for a passphrase (min 8 chars) that is used with PBKDF2 (100k iterations) to derive an AES-256 key
**And** card data is inserted into a local SQLite database at `~/.nike-bot/cards.db` (Windows: `%APPDATA%\nike-bot\cards.db`) with `card_number`, `cvv`, `expiry` columns encrypted via AES-256-GCM
**And** the original `cards.csv` is renamed to `cards.csv.imported` to prevent re-import
**And** subsequent launches require the same passphrase to unlock; wrong passphrase returns "Wrong passphrase, try again" after 3 seconds delay (rate-limit)
**And** at checkout time, cards are decrypted in memory only for the duration of the transaction
**And** passphrase is never stored on disk; held in memory only during the session
**And** a `nike-bot cards reset` command deletes the SQLite DB if Kevin forgets the passphrase (re-import required)

### Story 10.3: `addresses.csv` Parser + Join on account_id

As Kevin,
I want shipping addresses managed per account in a simple CSV,
So that I can have different addresses per account (family members, work, etc.). (FR50)

**Acceptance Criteria:**

**Given** an `addresses.csv` file exists with header: `account_id,street,city,zip,country,phone`
**When** the bot loads the file
**Then** each row is validated for non-empty required fields (street, city, zip, country)
**And** `account_id` must match an entry in the parsed `accounts.csv`; orphan rows are reported with a warning but do not block startup
**And** accounts missing an address entry are reported: "⚠️ account_kev_003 has no shipping address in addresses.csv. That account will fail at checkout shipping step unless Nike has a pre-saved address on the profile."
**And** the join is materialized as `Account.shippingAddress?: Address` in memory, consumed by Epic 4 shipping step
**And** `country` must match `accounts.csv country` (warning if mismatch, e.g., FR account but DE address)

### Story 10.4: `drop.csv` Parser with `accounts_filter` Semantics

As Kevin,
I want to configure which drops to attempt via a simple CSV,
So that I can stack multiple upcoming drops and let the bot handle them. (FR51)

**Acceptance Criteria:**

**Given** a `drop.csv` file exists with header: `sku,sizes,accounts_filter`
**When** the bot loads the file via `nike-bot run` or `nike-bot drops`
**Then** each row is parsed:
- `sku` matches Nike SKU format (e.g., `AH7389-106`); not empty
- `sizes` is a `;`-separated list of sizes
- `accounts_filter` is either the literal string `all` OR a `;`-separated list of `account_id`s that exist in `accounts.csv`
**And** `accounts_filter=all` resolves at execution time (not load time) to all `account_id`s in `accounts.csv` whose session status is `valid` — accounts with expired sessions are excluded and reported in the TUI
**And** explicit `account_id` lists in the filter are validated at load time (unknown ids reported with row number)
**And** duplicate SKUs across rows are allowed (e.g., same SKU with different size sets for different account groups) but flagged in the TUI for user awareness
**And** empty `drop.csv` is valid (no drops configured) — `nike-bot run` displays "No drops configured. Run `nike-bot drops add` to add one."

### Story 10.5: `report.csv` Generator Post-Drop

As Kevin,
I want a CSV report generated after every drop attempt,
So that I can see in Excel which accounts copped and which failed. (FR52, NFR24)

**Acceptance Criteria:**

**Given** a drop execution completes (success or abort) via Epic 11 TUI
**When** the final summary screen is displayed
**Then** a CSV file is written to `./reports/report-YYYY-MM-DD-HHMMSS.csv` (folder configurable)
**And** the file contains header: `account_id,status,sku,size,order_number,timestamp,error_reason,duration_ms`
**And** one row per account per SKU attempted; `status` is one of `COP`, `SOLD_OUT`, `BLOCKED`, `THREEDS_TIMEOUT`, `ERROR`, `NO_SESSION`
**And** `error_reason` contains a short human-readable description matching the status
**And** `duration_ms` is from stock detection to final outcome per account
**And** the CSV is written atomically (write to `.tmp` then rename) to prevent corruption if TUI crashes mid-write (NFR24)
**And** if a report for the same timestamp already exists (rapid re-run), it is suffixed: `report-…-HHMMSS-1.csv`
**And** all card/credential data is masked in the report

---

## Epic 11: TUI Dashboard Live `[v2 NEW]`

The primary v1 user-facing UI. Built on Ink (React for terminals). Provides live per-account status during drops, pre-drop warmup mode, and a summary screen with retry action.

**Build order:** 11.1 → 11.3 → 11.4 → 11.5 → 11.2 (animations polish last).

### Story 11.1: Ink TUI Dashboard — Multi-Account Live Rows

As Kevin,
I want a live dashboard showing each of my accounts' status during a drop,
So that I can see at a glance what's happening and know the bot is working. (FR53, NFR22, NFR27)

**Acceptance Criteria:**

**Given** a drop is executing for N accounts (Epic 4)
**When** the `nike-bot run` command starts drop execution
**Then** the terminal displays an Ink-rendered dashboard with:
- Header line: "Drop: [sku] — Sizes: [42,42.5,43] — Accounts: N/M valid"
- One row per account: `[account_id] [status_icon] [step_label] [elapsed_time] [details]`
- Footer stats: "Cops: X / Failed: Y / In progress: Z"
**And** status icons use Unicode: ✓ COP (green), ⏳ WAIT (yellow), ✗ FAIL (red), 🔄 RETRY (cyan)
**And** row updates are event-driven (not polling) via an event bus consumed by the Ink component tree
**And** dashboard renders at ≥ 2 FPS during active execution (NFR22), verified by instrumented test with 10 parallel mock accounts
**And** fits in an 80-column terminal without horizontal scroll (account_id truncated with ellipsis if > 16 chars; details truncated with `…`) (NFR27)
**And** ESC key returns the user to the final summary screen immediately (soft-abort — running checkouts continue but new ones don't start)

### Story 11.2: Emojis, Animations, Progress Bars (Polish)

As Kevin,
I want the dashboard to feel alive with animations and emojis,
So that I don't panic and kill the process thinking it's frozen.

**Acceptance Criteria:**

**Given** the base dashboard (Story 11.1) is functional
**When** an account is in an `⏳ WAIT` state
**Then** an animated spinner (braille or dots) is displayed next to the row, cycling every 100ms
**And** each step label transition (size → cart → shipping → payment → submit) briefly highlights the row with a fade-in effect
**And** a COP outcome briefly flashes the row green (one-shot 500ms)
**And** a FAIL outcome briefly flashes the row red (one-shot 500ms)
**And** the footer stats animate counts with a brief highlight when they change
**And** all animations are disabled when `NIKE_BOT_NO_ANIMATIONS=1` env var is set (for CI and accessibility)

### Story 11.3: Pre-Drop Warmup Mode with Countdown

As Kevin,
I want a warmup mode that starts a few minutes before drop time,
So that my sessions are fresh, slug is pre-resolved, and contexts are pre-launched — shaving seconds off cop time. (FR54)

**Acceptance Criteria:**

**Given** a drop configured in `drop.csv` and a target drop time set by the user via prompt or config
**When** the user runs `nike-bot run` and selects "Warmup mode"
**Then** the TUI displays a countdown: "T-minus 04:53 to drop. Warmup starts at T-05:00."
**And** at T-05:00, warmup begins:
- SDK polls at accelerated interval (default 2s) for the target SKU
- Slug is pre-resolved as soon as it appears in the feed (using `resolveSkuToSlug` from `packages/bot/src/monitor/poller.ts`)
- Session freshness is re-validated for all accounts in the filter; expired sessions surface a row alert
- Playwright browser contexts are pre-launched (headless) with cookies injected — ready to navigate
**And** the TUI dashboard updates live showing warmup progress: "✓ Slug resolved", "✓ 9/10 sessions valid", "✓ 9 contexts pre-launched"
**And** at T=0, warmup transitions seamlessly to drop execution — contexts navigate to product page immediately
**And** if the SKU is already live at T-05:00 (already in stock), warmup collapses into immediate drop execution

### Story 11.4: Final Summary Screen + Auto-Save Report

As Kevin,
I want a clear summary at the end showing results and auto-saving a report,
So that I can review the drop outcome and share with my Discord friends. (FR55)

**Acceptance Criteria:**

**Given** a drop execution completes (all accounts finished or aborted)
**When** the last account reaches a terminal state
**Then** the TUI transitions to a summary screen showing:
- Headline: "Drop complete — [N] cops out of [M] accounts"
- Breakdown table by status (COP, SOLD_OUT, BLOCKED, THREEDS_TIMEOUT, ERROR, NO_SESSION) with counts
- Total duration from drop start to last outcome
- Report file path: "Report saved: ./reports/report-2026-04-24-100015.csv"
- Menu: "[R] Retry failed / [O] Open report folder / [Q] Quit"
**And** the report CSV (Story 10.5) is auto-saved before the summary screen renders
**And** `[O]` opens the reports folder in the OS file manager (`open` on macOS, `explorer` on Windows)
**And** `[Q]` exits the bot cleanly (all contexts already closed at this point)

### Story 11.5: Retry Failed Accounts Action

As Kevin,
I want to retry checkout for accounts that failed 3DS timeout or blocked status,
So that I get a second chance without re-editing drop.csv. (FR32, FR55)

**Acceptance Criteria:**

**Given** the final summary screen (Story 11.4) shows failed accounts
**When** Kevin presses `[R] Retry failed`
**Then** a selection prompt appears: "Select accounts to retry (space to toggle, enter to confirm)" with a list of all non-COP account rows
**And** Kevin can also select which failure types to auto-include: "All THREEDS_TIMEOUT / All BLOCKED / All ERROR"
**And** on confirmation, a new checkout batch is triggered for selected accounts against the same SKU
**And** proxies rotate fresh for BLOCKED retries (if proxy pool supports rotation); same proxy for THREEDS_TIMEOUT (that account's bank is the limiting factor)
**And** the dashboard re-renders with only the retry accounts
**And** after retry completes, the summary screen updates; retries are included in the existing report CSV with a `retry_attempt` column (value 2, 3, etc.)
**And** max 3 retries per account per drop; further retries rejected with a message

---

## Existing Epic Modifications `[v2]`

The v2 product layer requires small extensions to existing epics 1, 2, 5. No new stories required — these extensions integrate into the existing story acceptance criteria at implementation time.

### Epic 1 — Foundation

- **Story 1.3 (Configuration Loader)** extended to support CSV loading alongside YAML. The CSV parsers live in Epic 10; Story 1.3's config loader dispatches to the right loader based on file extension.

### Epic 2 — Accounts

- **Story 2.2 (Authenticate All Accounts)** extended to support **batch parallel login for 50 accounts** in under 3 minutes (NFR21). Max 10 concurrent browser contexts to avoid overloading Kevin's machine. The existing story's acceptance criteria already imply parallelism; v2 adds the concurrency cap and the 3-minute SLA.
- **Story 2.1 (Import Accounts)** extended to parse `accounts.csv` format in addition to the legacy JSON. The CSV parser is Epic 10 Story 10.1.

### Epic 5 — Logging & Errors

- **New sub-story 5.9 (CSV Export for Reports)** — extract structured log entries for a given drop execution into `report-*.csv`. Implementation is part of Epic 10 Story 10.5; Epic 5 provides the underlying structured log source.

---

## Build Sequence Summary

```
Foundation (already done): Epics 1, 2, 3, 4, 5, 6, 8 (37 stories IMPLEMENTED)
Deferred to v3 SaaS:       Epic 7 (Daemon mode reactivated as worker pool)

v1.0 (2-3 weeks):          Epic 10 (CSV foundation)
                              ↓
                           Epic 11 (TUI dashboard)  +  Epic 9 [partial: 9.1, 9.4, 9.5, 9.6]
                              (parallel)

v1.1 (1 week):             Epic 9 [9.2, 9.3 — SEA binary + auto-installer]

Gate to v2:                50+ active users, 10+ community cops  [self-hosted tier complete]

[v3 strategic pivot — captured Nike API surface 2026-04-25, multi-country B2B SaaS]

v3.0 (4-6 weeks):          Epic 14 (KPSDK bootstrap)
                              ↓
                           Epic 12 (API-first cart & checkout)
                              ↓
                           Epic 13 (Multi-country, FR-only registry shipped first)
                           [sequential — each depends on the previous]

v3.1 (4-6 weeks):          Epic 15 (REST API)  +  Epic 16 (Account vault)  +  Epic 17 (Drop primitive)
                           [parallel after Epic 12 + 14 are stable]
                           Epic 13 extends to US, UK, DE registries.

v3.2 (2-3 weeks):          Epic 18 (Stripe billing & subscription)

v4 (frontends, separate planning):
                           - Telegram bot (Maxime persona)
                           - Web dashboard (Sarah persona)
                           - Mobile app (iOS/Android)
                           - GUI desktop (Tauri/Python — Kevin persona, optional)
```

---

## Epic 12: API-First Cart & Checkout Layer `[v3 NEW]`

Replaces the v2 DOM checkout pipeline with direct API calls to `api.nike.com/buy/*`. See `docs/NIKE_API_REFERENCE.md` for the live-captured endpoint shapes.

**Build order:** 14.1 → 14.2 (Epic 14 prerequisite) → 12.1 → 12.2 → 12.3 → 12.4 → 12.5 → 12.6.

### Stories (skeleton)

- **Story 12.1: `cartApi.ts` — initVisitor + addItem.** Wraps `PATCH /buy/carts/v2/{country}/NIKE/NIKECOM` via `page.request.fetch()`. JSON Patch bodies. Returns parsed cart shape with id, totals, items.
- **Story 12.2: skuId resolver.** Resolves `styleColor → skuId` (UUID per size variant) via SDK Product Feed query. Caches per-context.
- **Story 12.3: `cart_views` write — shipping address.** `PUT /buy/cart_views/v1/{view-uuid}` with shipping payload. Replaces v2 Story 4.4.
- **Story 12.4: `fulfillmentApi.ts` — offerings + jobs.** `GET /buy/fulfillment_offerings/v1`, `PUT/GET /buy/fulfillment_offerings_jobs/v2/{job-uuid}` polling loop until terminal state.
- **Story 12.5: `paymentApi.ts` — options + view bind.** `POST /payment/options/v3`, `PUT /buy/cart_views/v1/{view-uuid}` to bind selected method. Adyen card-data entry remains DOM (Story 12.5b).
- **Story 12.6: `reviewApi.ts` + submit.** `PUT /buy/cart_reviews/v2/{review-uuid}` + `GET` to read computed totals + tax. Total mismatch detection. Final `PUT /buy/checkouts/{cart-uuid}` to submit. Returns Nike `orderNumber`.

---

## Epic 13: Multi-Country Support `[v3 NEW]`

Removes the FR-only assumption from v1/v2.

**Build order:** 13.1 → 13.2 → 13.3 (parallel) → 13.4. v3.0 ships only FR registry; v3.1 adds US/UK/DE.

### Stories (skeleton)

- **Story 13.1: `Country` registry interface + FR entry.** Type definitions, validation via valibot, FR entry covering currency EUR, locale fr-FR, phone format `+33[1-9]\d{8}`, zip format `\d{5}`, Adyen iframe locale fr_FR.
- **Story 13.2: Per-country selector overrides.** `selectors/{COUNTRY}.yaml` with fallback to `selectors/default.yaml`. Loader injects override into checkout pipeline.
- **Story 13.3: Country-localized phone + zip validators.** Used by both v2 CSV loaders (multi-country accounts.csv) and v3 vault import.
- **Story 13.4: US/UK/DE registry entries.** v3.1. Includes language injection for Accept-Language headers.
- **Story 13.5: JP/ES/IT/NL/BE/AU registry entries.** v3.2+.
- **Story 13.6: Per-country smoke test.** Live polling + dry-run cart-init against each supported country in CI.

---

## Epic 14: KPSDK Token Bootstrap `[v3 NEW]`

Sequential prerequisite for Epic 12. Without a fresh KPSDK token every protected API call returns 403.

**Build order:** 14.1 → 14.2 → 14.3 → 14.4.

### Stories (skeleton)

- **Story 14.1: Token capture from page context.** Read `x-kpsdk-ct` and `x-kpsdk-v` from response headers of the first PDP load running `p.js`. Persist in per-context cache.
- **Story 14.2: `kpsdkClient` wrapper around `page.request.fetch()`.** Auto-injects token headers on every API call.
- **Story 14.3: 403/429 refresh-and-retry-once.** On Kasada block, silent page reload to re-bootstrap, retry exactly once. Beyond → `blocked` classification.
- **Story 14.4: Per-account fingerprint isolation.** Each Nike account context gets its own KPSDK bootstrap (no token sharing across accounts).

---

## Epic 15: B2B REST API `[v3 NEW]`

Hosted REST surface exposing the bot to third-party developers.

**Build order:** 15.1 → 15.2 → 15.3 → 15.4 → 15.5 → 15.6.

### Stories (skeleton)

- **Story 15.1: Fastify gateway + bearer-token auth.** Per-customer API keys validated against the customer table. HTTPS only. Standard CORS allow-list.
- **Story 15.2: `POST /v1/drops` + `POST /v1/drops/{id}/run` + `GET /v1/drops/{id}`.** Wires Epic 17 Drop primitive into the API.
- **Story 15.3: `GET /v1/orders` + `GET /v1/accounts` + `POST /v1/accounts`.** Read paginated; Nike account credentials encrypted on POST per Epic 16.
- **Story 15.4: Per-tier rate-limiting middleware.** Solo 60/min, Pro 600/min, Enterprise unmetered. `X-RateLimit-*` headers.
- **Story 15.5: Webhook delivery worker.** HMAC-SHA256 signature, exponential backoff retries up to 24 h, dead-letter queue.
- **Story 15.6: OpenAPI 3.1 spec + generated SDK stub for TypeScript + Python.** Customers consume the API with typed clients out-of-the-box.

---

## Epic 16: Account Vault `[v3 NEW]`

Multi-tenant encrypted storage. Replaces v2 single-tenant local SQLite for the SaaS tier.

**Build order:** 16.1 → 16.2 → 16.3 → 16.4 → 16.5.

### Stories (skeleton)

- **Story 16.1: Postgres schema + per-customer DEK derivation.** `customers`, `nike_accounts`, `cards`, `addresses`, `sessions` tables. DEK derived per `customer_id` via KMS, wrapped by master key.
- **Story 16.2: Account credentials encryption at rest.** Email + password + proxy + cookies encrypted per row using DEK.
- **Story 16.3: Card vault encryption (multi-tenant port of v2 Story 10.2).** Same AES-256-GCM, but DEK is KMS-derived not passphrase-derived.
- **Story 16.4: Cross-tenant isolation integration test in CI.** Asserts customer A cannot read customer B's row even with raw DB access.
- **Story 16.5: GDPR delete-my-data + DEK rotation endpoint.** Self-serve via `DELETE /v1/me/data` and `POST /v1/me/rotate-dek`.

---

## Epic 17: Drop-as-a-Service Primitive `[v3 NEW]`

Promotes "drop" from an implicit TUI session (v2) to a queryable, schedulable, multi-tenant entity.

**Build order:** 17.1 → 17.2 → 17.3 → 17.4.

### Stories (skeleton)

- **Story 17.1: `Drop` entity + lifecycle state machine.** States: `DRAFT → SCHEDULED → ACTIVE → COMPLETED` (+ `FAILED`, `CANCELLED`). Transitions audited.
- **Story 17.2: Per-account-per-drop `DropRun` rows.** Each account's attempt is a row with status, timing, orderNumber, error_reason.
- **Story 17.3: Scheduler (cron-style + drop_at timestamp).** Worker dispatches a Drop into ACTIVE at the configured time.
- **Story 17.4: Per-customer drop quota enforcement.** Max active drops per tier (Solo 1, Pro 5, Enterprise unmetered). 429 on exceeded.

---

## Epic 18: Billing & Subscription `[v3 NEW]`

Stripe integration for subscriptions + per-cop usage metering.

**Build order:** 18.1 → 18.2 → 18.3 → 18.4.

### Stories (skeleton)

- **Story 18.1: Stripe Customer + Subscription provisioning.** On signup, create Stripe customer + attach to `customers` table.
- **Story 18.2: Per-cop usage event emission.** On each successful `PUT /buy/checkouts/*` returning orderNumber, emit a Stripe metered usage event with idempotency key = our internal order id.
- **Story 18.3: Webhook receiver + idempotent event processing.** Verify `Stripe-Signature`. Idempotent on `event.id` per NFR40.
- **Story 18.4: Customer dashboard read-API (`GET /v1/me/usage`, `GET /v1/me/invoices`).** No frontend — that's v4. The API surfaces are JSON only.

---

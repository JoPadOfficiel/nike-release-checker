---
stepsCompleted:
  - step-01-init
  - step-02-discovery
  - step-02b-vision
  - step-02c-executive-summary
  - step-03-success
  - step-04-journeys
  - step-05-domain
  - step-06-innovation
  - step-07-project-type
  - step-08-scoping
  - step-09-functional
  - step-10-nonfunctional
  - step-11-polish
  - step-12-complete
  - step-e-01-discovery
  - step-e-02-review
  - step-e-03-edit
inputDocuments:
  - docs/Integration_Anti_Detection_et_Checkout.md
  - docs/Nike_Selectors.md
  - docs/code_source.md
  - docs/Automatisation Bot Nike SNKRS Multi-pays.md
  - _bmad-output/brainstorming/brainstorming-session-2026-04-13-1800.md
documentCounts:
  briefs: 0
  research: 1
  brainstorming: 1
  projectDocs: 4
workflowType: 'prd'
workflow: 'edit'
classification:
  projectType: cli_tool_distributable_product
  domain: e-commerce_automation
  complexity: high
  projectContext: brownfield
lastEdited: '2026-04-25'
editHistory:
  - date: '2026-04-24'
    changes: 'v2 pivot — target user changed from dev solo to reseller semi-technique (Kevin persona). Added Roadmap v1→v4, Budget Constraints, 14 new FRs (Distribution, CSV Config, TUI Dashboard). Deprioritized Epic 7 Daemon and sophisticated 3DS. North Star added.'
  - date: '2026-04-25'
    changes: 'v3 strategic pivot — API-first multi-country SaaS. Captured full Nike checkout API surface (docs/NIKE_API_REFERENCE.md). Replaced DOM scraping (where possible) with direct api.nike.com calls via page.request.fetch. Multi-country abstraction (any market). New B2B SaaS tier with REST API + per-customer account vault. New personas Sarah and Maxime. Added FR56-FR75, NFR29-NFR40.'
---

# Product Requirements Document - nike-release-checker

**Author:** Jopad
**Date (v1):** 2026-03-28
**Date (v2 edit):** 2026-04-24
**Date (v3 edit):** 2026-04-25

## Version History

| Version | Date | Headline | Status |
|---------|------|----------|--------|
| v1 | 2026-03-28 | Local CLI for solo developer. France-only. JSON config. Daemon mode. 41 FRs / 20 NFRs. | Superseded by v2; kept in §"v1/v2 baseline" below for traceability. |
| v2 | 2026-04-24 | Distributable product for non-dev reseller (Kevin persona). CSV-first config, Ink TUI, SEA binary, wizard `nike-bot init`. France-only. 55 FRs / 28 NFRs. | Active for self-hosted tier. Pipeline reached 5/6 steps live on Nike FR (commits 7c3a66d → 59bb933). |
| v3 | 2026-04-25 | API-first multi-country B2B SaaS pivot. DOM → `api.nike.com` checkout (Kasada-protected via `page.request.fetch`). Country-parametric. Hosted REST API + per-customer account vault. v1/v2 stay alive as "self-hosted" tier. 75 FRs / 40 NFRs. | Active. See §"v3 — API-first Multi-country SaaS" below. |

The v1 and v2 sections that follow this header are preserved verbatim. They remain the source of truth for the **self-hosted CLI tier** of the product. The new v3 section sits in front and supersedes the multi-country and B2B portions.

---

## v3 — API-first Multi-country SaaS

### Strategic Pivot Summary

During live testing on 2026-04-25 (`docs/LIVE_TEST_FINDINGS_2026-04-25.md`) the v2 DOM-driven pipeline reached 5/6 checkout steps but consistently timed out at `select-size`. In parallel, the discovery script `packages/bot/scripts/sniff-api-flow.ts` captured the **complete** Nike checkout API surface (`docs/NIKE_API_REFERENCE.md`) — `cart`, `cart_views`, `fulfillment_offerings`, `fulfillment_offerings_jobs`, `payment/options`, `cart_reviews`, `checkouts`. All endpoints are KPSDK (Kasada) protected, but the token is browser-derived and can be reused via Playwright's `page.request.fetch()` to inherit the page's cookie jar AND its KPSDK fingerprint. Direct Node `fetch` is blocked.

Three structural conclusions:

1. **DOM is the wrong abstraction layer for everything except size click + Adyen iframe + 3DS challenge.** The cart, shipping address, fulfillment selection, payment-method selection, review and submit can all be driven by 7 REST calls in < 2 seconds — versus 25-second selector waits. This is not an optimization, it is a category change.
2. **Country is parametric in the API.** The cart endpoint is `/buy/carts/v2/{COUNTRY}/NIKE/NIKECOM`. Switching from FR to US, UK, DE, JP, ES, IT, NL, BE, AU is a string substitution + a per-country phone/zip validator + a per-country Adyen iframe locale. There is no architectural reason to stay FR-only.
3. **A reliable cop engine has commercial value beyond the original Kevin persona.** Resellers running 50+ accounts, developers integrating drop notifications into Telegram bots, and sneaker boutiques wanting "drop-as-a-service" all want the same thing: a hosted REST endpoint that takes a SKU and returns an order number. The v1/v2 self-hosted tier remains fully supported as the entry point, and v3 adds a B2B SaaS layer above it.

### Personas (v3 additions)

| Persona | Role | Use case | Tier |
|---------|------|----------|------|
| **Kevin** (v2, retained) | Reseller semi-technique. 5–50 accounts, residential proxies, France. | Local CLI. Cops on his laptop on Saturday morning. | Self-hosted (free / OSS). |
| **Sarah** (v3, new) | B2B reseller. 50+ Nike accounts across FR/UK/DE/IT. Runs an agency. | Hits our REST API to schedule drops, integrates per-account billing via Stripe, exports cop reports for clients. | Pro / Enterprise. |
| **Maxime** (v3, new) | Independent developer. Builds a Telegram bot for a sneaker community. | Subscribes to webhook events (`drop.cop`, `drop.fail`) to push real-time notifications to Telegram channels. Does not own Nike accounts — uses our pooled-account credit system. | Solo (with API). |

### Business Model (v3)

| Tier | Price | Accounts | Countries | Per-cop fee | Target persona |
|------|-------|----------|-----------|-------------|----------------|
| **Self-hosted** | Free (OSS) | Bring your own | FR (v3.0); +US/UK/DE (v3.1) | — | Kevin |
| **Solo** | $29 / mo | 5 (BYO or pooled) | FR only | $5 / cop | Maxime, hobbyist resellers |
| **Pro** | $99 / mo | 25 (BYO) | 3 of {FR, US, UK, DE, IT, ES, NL, BE, JP, AU} | $3 / cop | Sarah, mid-size resellers |
| **Enterprise** | Custom (≥ $500 / mo) | 100+ | All supported | $2 / cop | Boutiques, large agencies |

Per-cop fees apply only to **successful** orders (Nike orderNumber returned). Failures, sold-out, blocked attempts are free. Stripe meters per-cop usage; subscription handles base + account-count quota.

### Out of Scope for v3

- **Telegram bot reference implementation** — v4. v3 ships only the webhook events Maxime would consume.
- **Web dashboard** — v4. v3 ships only the REST read-API a dashboard would consume.
- **Mobile app (iOS/Android)** — v4+.
- **SNKRS raffle integration (`/launch/entries/v3`)** — out of scope. Live findings show SNKRS launch URLs do not expose a DOM checkout path; the API endpoint exists (`POST /launch/entries/v3`, KPSDK-protected) but raffle outcomes are non-deterministic and out of v3 scope.
- **Auto-account creation / mass registration** — explicitly excluded (legal exposure).
- **Pooled card vault for Solo tier (shared cards)** — out. Cards remain per-customer.

### Functional Requirements (v3 additions)

#### Country Abstraction (Epic 13)

- **FR56:** System exposes a `Country` registry (code, name, currency, locale, default language, phone format regex, zip format regex, default Adyen iframe locale, address-line ordering) covering at minimum `FR, US, UK, DE, JP, ES, IT, NL, BE, AU` for v3.1. v3.0 ships only `FR`.
- **FR57:** All cart/checkout API calls accept the country as a parameter and substitute it into the endpoint path (`/buy/carts/v2/{COUNTRY}/NIKE/NIKECOM`).
- **FR58:** Per-country selector overrides for the residual DOM steps (size click + Adyen iframe + 3DS) live in `selectors/{COUNTRY}.yaml` with a fallback to `selectors/default.yaml`.
- **FR59:** Phone numbers and ZIP codes in `addresses.csv` (or equivalent multi-tenant store) are validated against the per-country regex at load time, with row-level human-readable errors.

#### API-first Cart & Checkout (Epic 12)

Citations: see `docs/NIKE_API_REFERENCE.md` for the live-captured endpoint shapes, payloads, and KPSDK protection list.

- **FR60:** System replaces the v2 DOM `addToCart` step with `cartApi.initVisitor()` + `cartApi.addItem(skuId, slug, styleColor, qty)` — both PATCH `/buy/carts/v2/{COUNTRY}/NIKE/NIKECOM` with RFC 6902 JSON Patch bodies, called via `page.request.fetch()`.
- **FR61:** System resolves `skuId` (UUID per size variant) from `styleColor` via `GET /product_feed/threads/v3/?filter=marketplace({COUNTRY})&filter=productCode({styleColor})` before adding to cart. (Already done by SDK; v3 wires it into the API path.)
- **FR62:** System replaces the v2 DOM `navigateCheckout` + `completeShipping` steps with `PUT /buy/cart_views/v1/{view-uuid}` carrying the shipping address payload. View UUIDs are generated client-side per checkout cycle.
- **FR63:** System fetches available shipping methods via `GET /buy/fulfillment_offerings/v1?filter=countryCode({COUNTRY})&filter=currency({CCY})&filter=skuId({sku})`, then drives the price-calculation job via `PUT /buy/fulfillment_offerings_jobs/v2/{job-uuid}` and polls `GET /buy/fulfillment_offerings_jobs/v2/{job-uuid}` until terminal state.
- **FR64:** System replaces the v2 DOM `completePayment` (selection part only) with `POST /payment/options/v3` to enumerate stored payment methods for the cart, then a `PUT /buy/cart_views/v1/{view-uuid}` write to bind the selected payment method. The card-data entry itself stays DOM (Adyen Web Components iframe) per FR68.
- **FR65:** System replaces the v2 DOM `submitOrder` step with `PUT /buy/checkouts/{cart-uuid}` (KPSDK-protected) and surfaces the returned `orderNumber` to the report / event stream.
- **FR66:** System runs the `cart_reviews` step via `PUT /buy/cart_reviews/v2/{review-uuid}` then `GET` the same to fetch computed totals + tax + final order shape before submission. Mismatches between expected and computed totals abort with classification `total_mismatch`.

#### KPSDK Token Bootstrap (Epic 14)

- **FR67:** System bootstraps a fresh KPSDK token per browser context via a real Chrome page-load that runs the obfuscated `p.js` script, caches the resulting `x-kpsdk-ct`/`x-kpsdk-v` pair in memory, and uses `page.request.fetch()` to inherit it for all subsequent API calls within that context's session.
- **FR68:** When any API call returns 403 (Kasada block) or 429 (rate-limited), the system invalidates the cached KPSDK token, performs a silent page reload to re-bootstrap, and retries the failed call exactly once. Beyond one retry, the account is classified `blocked` for that drop.

#### DOM Residual Steps (still in scope)

- **FR69:** Size selection on the PDP is performed via DOM click on `[data-testid="pdp-grid-selector-item"]` (per the v2 selector findings) so the styleColor → skuId resolution stays consistent with what a human would see. Once the size is chosen, the `skuId` is extracted from the page's hydration state and the rest of the flow goes API. (This is the smallest DOM surface that gives us the highest signal-to-API-blackbox ratio.)
- **FR70:** Adyen card data entry remains DOM (typing into the Adyen Web Components iframe) because card data is encrypted client-side before reaching `/payment/options/v3`. The iframe is resolved per-country via the registry (FR56).
- **FR71:** 3D Secure challenge handling stays exactly as v2 (FR31, FR32) — detect, alert via TUI / webhook, time out at 120 s, manual retry path. Per-country bank behaviour does not change the contract.

#### B2B REST Surface (Epic 15)

- **FR72:** System exposes a REST API (Fastify or Express) over HTTPS at `https://api.<our-domain>/v1/*` with bearer-token auth (per-customer API keys, generated in the customer dashboard read-API). At minimum:
  - `POST /v1/drops` — create a drop `{country, sku, sizes[], maxAccounts, paymentMethodId, scheduledAt?}` → `{dropId, status: DRAFT}`
  - `POST /v1/drops/{id}/run` — trigger or schedule run → `202 Accepted`
  - `GET /v1/drops/{id}` — read drop status + per-account outcomes
  - `GET /v1/orders` — list orders across drops, paginated
  - `GET /v1/accounts` — list customer's Nike accounts (status, country, last login)
  - `POST /v1/accounts` — register a Nike account (credentials encrypted server-side per FR74)
  - `POST /v1/webhooks` — register a webhook URL for `drop.*` and `order.*` events
- **FR73:** System enforces per-customer rate-limiting at the API gateway: Solo 60 req/min, Pro 600 req/min, Enterprise unmetered. Returns `429` with `Retry-After` header.
- **FR74:** System delivers webhook events `drop.scheduled`, `drop.started`, `drop.cop`, `drop.fail`, `drop.completed`, `order.refunded` to customer-registered URLs with HMAC-SHA256 signature header (`X-NikeBot-Signature`). Failed deliveries retry with exponential backoff up to 24 h.

#### Account Vault (Epic 16)

- **FR75:** System stores per-customer Nike account credentials (email, password, proxy URL, country, preferred sizes, session cookies, OIDC tokens) in an encrypted multi-tenant Postgres table. Each customer has a per-customer KMS-derived data encryption key (DEK); the DEK is wrapped by a master key held only by the API gateway. Card vault uses the same per-customer DEK (extends v2's local SQLite AES-256 model to multi-tenant). Cross-customer isolation is enforced at the row level by `customer_id` and at the key level by DEK separation — no cross-customer cart pollution is possible.

### Non-Functional Requirements (v3 additions)

- **NFR29:** API-call success rate on Kasada-protected endpoints (`PATCH /buy/carts/v2/*`, `PUT /buy/checkouts/*`, `PUT /buy/cart_reviews/*`) ≥ 99 % over a rolling 7-day window per country, measured at the worker pool. Sub-99 % triggers a paging alert.
- **NFR30:** Per-country cart-init (initVisitor + addItem + cart_view shipping write) p95 latency < 2 s, measured server-side from the first PATCH to the last 2xx, excluding KPSDK bootstrap (which is amortized across the worker's session).
- **NFR31:** A single worker node (8 vCPU / 16 GB RAM, Linux, Chrome headed) sustains 50 parallel checkouts without degradation in NFR30. Auto-scaling kicks in at 70 % node load.
- **NFR32:** Per-customer isolation: it is impossible for customer A's drop run to read, write, or affect customer B's cart, account credentials, or webhook deliveries. Verified by an automated cross-tenant integration test in CI.
- **NFR33:** GDPR-compliant card vault. Per-customer DEK rotation supported on demand and forced quarterly. Customer self-serve "delete-my-data" purges all PII (cards, account credentials, addresses, order PII) within 24 h, leaving only anonymized order metadata for billing reconciliation.
- **NFR34:** Country-localized phone and ZIP validation per the FR56 registry. A French ZIP validator must reject `90210` and a US ZIP validator must reject `75002`. Errors surface with country-specific suggested-fix messages.
- **NFR35:** Retry-with-fresh-KPSDK on 403/429: total checkout latency including one retry must remain under 35 s (matches v2 NFR2 — the SLA is not relaxed by the API migration).
- **NFR36:** REST API availability ≥ 99.5 % monthly (excluding planned maintenance windows announced 7 days in advance).
- **NFR37:** Webhook delivery: 99 % of events delivered (≥ 1 successful POST or 5xx-from-customer, whichever first) within 30 s of the event firing in the worker pool.
- **NFR38:** Per-tier rate-limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) returned on every API response, including 429.
- **NFR39:** Audit log: every `POST /v1/drops/{id}/run`, every `PUT /buy/checkouts/*` to Nike, and every customer-data mutation is appended to an immutable audit log retained for 12 months.
- **NFR40:** Stripe webhook reception is idempotent on `event.id` — a replayed Stripe webhook does not double-charge per-cop fees or double-provision quota.

### v3 Scope Cuts (explicit)

The following were considered for v3 and explicitly cut for size/risk:

- Customer self-serve dashboard frontend (deferred to v4 web app — only the read-API ships in v3).
- Bring-your-own-Kasada-token endpoint (we rely on browser bootstrap for now; removes a customer-facing degree of freedom but eliminates a class of token-leak abuse).
- Multi-region worker pool (v3 ships single-region EU-West; US-East and AP-South are v3.2+).
- Pooled-account credit system for Solo tier (deferred; Solo customers must BYO accounts in v3.0–v3.1).

---

## v1 / v2 baseline (preserved)

The remainder of this document is the v2 PRD as of 2026-04-24, preserved unchanged. Where v3 supersedes a v2 requirement (in particular the multi-country and DOM-only checkout assumptions), the v3 section above takes precedence for the SaaS tier; the v2 text continues to govern the self-hosted tier.

---

## Executive Summary

Nike SNKRS auto-checkout bot is a **distributable product** for sneaker resellers, built on top of the open-source `whoisYeshua/nike-release-checker` TypeScript SDK/CLI. The existing project already solves real-time monitoring of Nike's Product Feed API (`/product_feed/threads/v3/`) with country/language filtering, stock level detection per SKU, and release classification. This product adds **automated checkout execution** triggered the instant a monitored product becomes available, wrapped in a **zero-terminal UX** for non-dev users.

**Target user (Kevin persona):** reseller semi-technique, ~24 years old, sells ~15 pairs/month on StockX, uses Discord + Excel daily, has never opened a terminal. Technically savvy enough to edit a CSV file, but not to clone a git repo or `pnpm install`. Operates locally on macOS or Windows. Has 5-50 Nike accounts pre-created with residential proxies.

The system monitors desired releases via the existing SDK, and when stock transitions to available status for a target size, it automatically navigates the full Nike purchase flow — size selection, add to cart, shipping confirmation, payment validation, and order submission — using credentials, addresses, and payment methods loaded from CSV files. The scope is limited to **direct purchase drops (LEO / "En stock")** only; draw-based releases (DAN / tirage au sort) are explicitly excluded.

The core technical challenge is anti-detection: Nike deploys Akamai Bot Manager with TLS fingerprinting (JA3/JA4), JavaScript sensor data collection, canvas/WebGL fingerprinting, and IP geolocation correlation. The system addresses this through Playwright Stealth for browser automation, residential rotating proxies for IP consistency, and multi-domain cookie management across `nike.com`, `accounts.nike.com`, and payment providers. The checkout flow targets **Nike France** (`/fr/`) with EUR currency and DSP2/3D Secure compliance handled via terminal alert for manual bank app validation.

### North Star Principle

> **"The most important thing is to cop the pair. Everything else can be sacrificed."**

Sub-principle: *Ship reliable cop-attempts, not reliable UI.* Every feature must be evaluated against this: does it increase the probability of securing a pair during the 2 critical minutes of a drop? If not, it is out of scope for v1.

### What Makes This Special

Unlike commercial sneaker bots (Cybersole, Wrath, Kodai — all $300+/month, closed-source, opaque) this system is **self-hosted, open-source, and vertically integrated**. The monitoring layer leverages an actively maintained community SDK that tracks Nike API changes — the operator doesn't need to reverse-engineer product feed endpoints. The checkout layer is custom-built and fully transparent, allowing direct modification and debugging.

The architectural insight is that speed alone doesn't win on SNKRS — human refresh speeds are structurally insufficient against limited drops that sell out in seconds. The only viable approach is full-chain automation: API-level detection (milliseconds ahead of the UI) triggering browser-based checkout with pre-authenticated sessions and pre-filled forms, reducing the entire purchase flow to a series of automated "continue" clicks through shipping → payment → order review.

### Competitive Moat

Versus commercial bots:
- **Price:** free/open-source vs $300/month subscription
- **Trust:** open-source = auditable, no backdoor vs closed black box
- **Bundle opportunity (v2+):** residential proxies bundled in single abonnement — commercial bots require separate proxy purchase
- **Transparency:** user owns their sessions, credentials, logs — nothing sent to external server

Moat is **not feature parity** with Cybersole — it is price + trust + transparency for the 80% of the market priced out of commercial bots.

## Roadmap v1 → v4

Product evolution across four phases, each validating the previous before investment.

### v1 — Local CLI (current scope)

**Target ship:** 3-4 weeks. Local installation on user's machine, CLI-based, no server required. Split into two micro-releases:

- **v1.0 (P0 — 2-3 weeks):** CSV-first config, wizard `nike-bot init`, TUI dashboard live, batch session capture, pre-drop warmup mode, rapport CSV post-drop. Distribution via `npm install -g` or manual install guide.
- **v1.1 (P1 — 1 week):** SEA binary packaging (Node.js Single Executable Applications) for macOS + Windows. Auto-installer bundling Playwright + Chromium. Gatekeeper/SmartScreen bypass documentation.

**Success gate for v2:** 50+ active users, at least 10 successful cop-events reported by community.

### v2 — Discord / Telegram Bot (6-8 weeks post v1)

Remote control from phone via Discord/Telegram. User's PC still runs the bot locally, but commands are issued via chat bot. Enables operation without being at the computer. Residential proxy bundling offered as optional add-on.

### v3 — SaaS Cloud (3-6 months post v2)

Server-side execution. User's PC can be off. Supports 100+ parallel checkout instances (impossible on a laptop). Subscription model with proxies bundled. Requires auth, billing, multi-tenant isolation, Kubernetes-grade scaling.

### v4 — GUI Desktop App (if market validated)

Native GUI via Tauri (Rust) or Python/ChatCNI. Drag-and-drop account management, visual config editor, in-app analytics. Only built if v2/v3 demonstrate product-market fit.

## Project Classification

- **Project Type:** CLI Tool / Distributable Product (extending existing npm monorepo with SDK + CLI packages, packaged as SEA binary in v1.1)
- **Domain:** E-commerce Automation (specialized Nike SNKRS checkout)
- **Complexity:** High — anti-detection (Akamai/Cloudflare bypass), TLS fingerprint spoofing, multi-domain session management, DSP2/3D Secure compliance, multi-account isolation with proxy rotation, zero-terminal UX for non-dev users
- **Project Context:** Brownfield — extends `whoisYeshua/nike-release-checker` (TypeScript monorepo, actively maintained)
- **Scope Exclusion:** No DAN/draw support, no mass account registration, no commercial redistribution

## Budget Constraints

Documented constraints that shape distribution strategy:

| Cost | Monthly | Annual | Decision |
|------|---------|--------|----------|
| Apple Developer Program | — | $99 | ❌ Not purchased — document Gatekeeper bypass (`xattr -d com.apple.quarantine`) |
| EV Code Signing (Windows) | — | ~$300 | ❌ Not purchased — document SmartScreen first-launch "More info → Run anyway" flow |
| Residential proxy pool | €20-50 | — | ✅ User responsibility v1. v2+ considers bundling |
| CI/CD | — | free | ✅ GitHub Actions free tier |
| Distribution | — | free | ✅ GitHub Releases for SEA binaries |

**Credentials at rest:**
- `accounts.csv` stored plaintext on user's machine (user responsibility, file permission 600)
- `cards.csv` stored encrypted in local SQLite (AES-256 with user-derived passphrase)
- Session cookies stored with restricted file permissions (600) per account

## Success Criteria

### User Success

- **Zero-terminal setup:** A non-dev user (Kevin) can install, configure 50 accounts, and run a successful dry-run in under 10 minutes without ever manually typing a command beyond `nike-bot init`.
- **Confirmation moment:** Success is defined as the TUI dashboard showing a green `✓ COP` status row for at least one account, with the Nike order number populated, and the terminal log emitting the line "ORDER CONFIRMED — [product name] — Size [X] — Account [Y]". Nike's order confirmation email arrives in the user's inbox within seconds.
- **Multi-account coverage:** Kevin can run 5-50 accounts simultaneously on a single drop, each isolated with its own proxy and session, maximizing the probability of securing at least one pair.
- **Zero-anxiety execution:** During the 2 critical minutes of a drop, Kevin sees live per-account progress (`✓ cop / ⏳ waiting / ✗ sold out / 🔄 retry`) with animations proving the bot is alive. He does not kill the process out of panic.

### Business Success

- **Adoption viability:** 50+ active users within 3 months of v1.0 release (measured via GitHub stars, install telemetry if opted-in, or community Discord signups). Single successful cop validates entire investment.
- **Reliability over volume:** The system runs the pre-drop warmup and full drop attempt without crashing, memory leaks, or losing session state. For resellers running centralized drops, the system is "set-and-forget" for the minutes surrounding the drop time.
- **Cost efficiency:** Total operational cost (residential proxies only) remains under €50/month for 5-50 accounts, dramatically cheaper than commercial bots at $300+/month.

### Technical Success

- **Checkout speed:** End-to-end time from stock detection to order submission must be **under 30 seconds** per account. Above 30s = critical failure.
- **Anti-detection resilience:** The system must not trigger Akamai/Cloudflare blocks (HTTP 403/429) during checkout execution. Sessions must appear as legitimate human browser traffic.
- **Multi-account isolation:** Each account runs in its own Playwright browser context with dedicated proxy, cookies, and user-agent. No cross-contamination between sessions.
- **Install success rate:** 95%+ of users complete installation and first dry-run without requesting support on Discord.

### Measurable Outcomes

| Metric | Target | Critical Threshold |
|--------|--------|--------------------|
| Install → first dry-run | < 10 minutes | > 30 min = onboarding failure |
| Stock detection → order submitted | < 30 seconds | > 30s = drop failure |
| Concurrent accounts per drop | 5–50 | Minimum 5 |
| Anti-detection success rate | > 90% sessions unblocked | < 50% = unusable |
| Successful order on real drop | ≥ 1 within first month per user | 0 = product failure |
| v1.0 adoption | 50+ users in 3 months | < 10 = market signal invalid |
| v1.1 SEA binary first-launch success rate | > 90% (download → successful wizard init) | < 70% = SEA flow broken |
| v1.1 binary download → first successful run | < 5 minutes | > 15 min = packaging failure |

## User Journeys

### Journey 1: First-Time Setup — "Kevin installs the bot"

**Persona:** Kevin, 24, sneakerhead-reseller. Sells 15 pairs/month on StockX. Uses Discord + Excel daily. Has never opened a terminal. Just downloaded `nike-bot-v1.0.dmg` from GitHub Releases.

**Opening Scene:** Kevin has 10 Nike accounts pre-created with residential proxies. He has a spreadsheet with his accounts, payment cards, and shipping addresses. He double-clicks `nike-bot.dmg`.

**Rising Action:**
1. macOS shows Gatekeeper warning: "nike-bot can't be opened because Apple cannot check it for malicious software." Kevin follows the included `FIRST_LAUNCH.md` docs: Right-click → Open → Open. Bot launches in a native Terminal window.
2. Bot displays a welcome TUI: "Welcome! Let's set up your first drop. Press Enter to start the wizard."
3. Wizard step 1: "How many Nike accounts do you have? (1-100)" Kevin enters `10`.
4. Wizard step 2: "Where is your accounts.csv file?" Kevin drags his spreadsheet onto the terminal. Bot parses it, validates schema, reports "✓ 10 accounts valid. 0 errors."
5. Wizard step 3: "Same for cards.csv and addresses.csv." Kevin drags both files.
6. Wizard step 4: "Capturing sessions for all accounts..." Bot launches Playwright in parallel for 10 accounts, auto-logs in each, captures OIDC tokens. TUI shows per-account progress. Takes ~90 seconds.
7. Wizard step 5: "Running dry-run on 1 account to validate the checkout flow works..." Bot runs a dry-run against an in-stock, non-limited product. Completes in 18 seconds.

**Climax:** Wizard summary: "✓ Setup complete! 10 accounts authenticated, 10 proxies validated, dry-run successful. You're ready to cop."

**Resolution:** Kevin now has a fully configured bot. Total setup time: 8 minutes. He did not type a single command.

### Journey 2: Live Drop — Happy Path — "The cop that changes everything"

**Opening Scene:** A new Air Jordan colorway is announced for release on Nike SNKRS France next Saturday at 10:00 AM. SKU `AH7389-106`. Kevin adds the drop to his `drop.csv`: `AH7389-106, 42;42.5;43, all`.

**Rising Action:**
1. Saturday 9:55 AM, Kevin opens the bot. TUI shows: "Upcoming drop: AH7389-106 at 10:00:00. Start warmup? [Y/n]". Kevin presses `Y`.
2. The bot enters **pre-drop warmup mode** at 9:55:05: polls the Nike Product Feed every 2 seconds for the SKU, pre-resolves the product slug as soon as it appears, warms DNS, validates session freshness for all 10 accounts. TUI shows a countdown and per-account readiness status.
3. At 10:00:00 the SDK detects `stockLevel` transition to `HIGH` for sizes 42.5 and 43. The bot triggers immediately.
4. For each of the 10 accounts, a Playwright Stealth browser context is launched in parallel, each with its own proxy and pre-loaded session cookies.
5. TUI dashboard updates live: `account_1 ⏳ selecting size`, `account_2 ✓ in cart`, `account_3 🔄 retry`, etc. Emojis, sablier animé, progress bars.
6. Each context: size → cart → shipping → payment → submit.

**Climax:** 22 seconds after stock detection. Accounts 3 and 5 receive order confirmation. TUI dashboard shows `account_3 ✓ COP — size 42.5 — order #A1B2C3`. Celebratory sound plays (if enabled).

**Resolution:** Kevin sees 2 green rows. The bot saves `report-2026-04-24.csv` with all attempt details. Kevin opens Excel, reads the report. He got 2 pairs of 10 accounts.

### Journey 3: Live Drop — Failure Scenarios — "When things go wrong"

**Opening Scene:** Same setup as Journey 2, but a hyper-limited Travis Scott collab. Competition extreme.

**Scenario A — Sold Out During Checkout:**
Bot detects stock, begins checkout, but by payment step (28 seconds in) Nike returns "This item is no longer available." TUI row: `account_1 ✗ SOLD_OUT — 28s elapsed`. All 10 accounts fail similarly. Kevin opens `report.csv`: all rows show `status=SOLD_OUT`, `error_reason=stock_depleted`. He shares the report on Discord with his reseller friends.

**Scenario B — Akamai Block (HTTP 403):**
Account 2's proxy IP is flagged. TUI row: `account_2 ⚠️ BLOCKED — HTTP 403 — proxy flagged`. Other 9 accounts continue unaffected due to session isolation.

**Scenario C — 3D Secure Triggered:**
Account 4 reaches order submission successfully, but the bank triggers 3D Secure. The bot detects the 3DS iframe, pauses the checkout, logs an urgent TUI alert: `🔐 3DS REQUIRED — Account 4 — Validate on your banking app NOW`. Kevin opens his banking app, approves the transaction. The bot times out after 120 seconds if no approval (simplified v1: no automatic resume — Kevin re-runs that specific account manually).

**Resolution:** Even in failure, each failure mode has a distinct report classification. Kevin understands what happened and adjusts (swap proxies, refresh cookies).

### Journey 4: Warmup Mode — "Preparing the arsenal"

**Opening Scene:** Kevin has a drop at 10:00 AM. It's 9:45 AM.

**Rising Action:**
1. Kevin opens the bot. TUI shows recent drops configured in `drop.csv`.
2. Kevin selects "Run warmup for drop `AH7389-106`". TUI asks: "Start at 9:55 (5 min before drop)? [Y/n]". Kevin confirms.
3. Bot waits until 9:55 in low-power mode. At 9:55:00, it begins active warmup: poll Product Feed, resolve slug as soon as it appears, validate all 10 sessions, pre-launch 10 Playwright contexts (headless) with cookies injected.
4. At 9:59:55, TUI shows "T-minus 5 seconds to drop. All accounts ready."
5. At 10:00:00, bot transitions seamlessly from warmup to drop execution.

**Climax:** The warmup gives each checkout a 2-3 second head start over accounts that start cold. Kevin sees his `account_3` cop at 10:00:15, before most competitors even load the product page.

**Resolution:** Warmup mode is the core competitive advantage. Kevin runs it for every drop.

### Journey 5: Maintenance — "Refreshing sessions"

**Opening Scene:** Two weeks after initial setup. Some sessions have expired.

**Rising Action:**
1. Kevin opens the bot. TUI shows account status dashboard: `account_1 ✓ session valid / account_2 ⚠️ expired 3d ago / account_3 ✓ / ...`
2. Kevin selects "Refresh all expired sessions". Bot launches Playwright parallel re-login for 4 expired accounts. Takes 45 seconds.
3. 3 succeed. Account 5 fails — Cloudflare challenge not bypassed. TUI: "`account_5 ✗ LOGIN_FAILED — try different proxy`."
4. Kevin edits `accounts.csv` to change account_5's proxy URL. Bot auto-detects change, offers to re-run login. Kevin confirms.

**Climax:** 10/10 accounts now session-valid. Kevin runs a dry-run to confirm system health.

**Resolution:** Total maintenance time: 6 minutes. All in-TUI, zero terminal commands.

### Journey Requirements Summary

| Journey | Key Capabilities Revealed |
|---------|--------------------------|
| Setup | Wizard `nike-bot init`, CSV drag-drop parsing, batch session capture, auto dry-run |
| Happy Path | Pre-drop warmup, SDK stock detection, parallel multi-account checkout, TUI live dashboard, report CSV generation |
| Failure Scenarios | Error detection and classification (sold out, blocked, 3DS), per-account isolation, simplified 3DS (detect + alert + timeout, no auto-resume in v1), failure diagnostics in report CSV |
| Warmup | Pre-drop surveillance, DNS warmup, session pre-validation, headless context pre-launch, seamless warmup-to-drop transition |
| Maintenance | Session refresh TUI widget, per-account health status, expired session detection, in-TUI config edit |

## Domain-Specific Requirements

### Anti-Detection / Adversarial Environment

Nike deploys a multi-layered bot protection stack that actively evolves:

- **Akamai Bot Manager:** Analyzes TLS handshake fingerprints (JA3/JA4 hashes) to detect non-browser clients. A Python `requests` library or unmodified Playwright instance presents a distinctly different cipher suite order than Chrome, resulting in instant HTTP 403 blocks.
- **JavaScript Sensor Data:** Akamai injects scripts that collect browser environment data — `navigator.webdriver` presence, canvas fingerprint, WebGL renderer strings, installed plugins, window dimensions. Failed checks prevent generation of critical cookies (`_abck`, `bm_sz`).
- **Cloudflare Turnstile:** Login flows on `accounts.nike.com` are protected by Cloudflare challenges requiring valid `cf_clearance` cookies. Standard automation tools fail these challenges without stealth modifications.
- **IP Reputation & Geolocation:** Requests targeting `/fr/` endpoints from non-French IPs or datacenter ASNs are flagged. Accept-Language headers must be consistent with IP geolocation (`fr-FR,fr;q=0.9`).
- **Evolving Defenses:** Nike's security team actively patches detection vectors. The system must be designed for maintainability — selectors, headers, and stealth configurations must be easily updatable without architectural changes.

### Payment Regulation (EU DSP2 / 3D Secure 2.0)

- **Strong Customer Authentication (SCA):** French banking regulations under DSP2 mandate biometric or multi-factor authentication for online transactions. This manifests as 3D Secure 2.0 iframe injection during checkout.
- **Implication:** The checkout flow cannot be 100% automated. When 3DS is triggered, the system detects the iframe, pauses execution, alerts the operator via TUI, and times out after 120 seconds. **v1 simplification:** no automatic resume logic — if the operator misses the 120s window, the bot fails that account; the operator can retry that account manually.
- **Payment Providers:** Nike France uses Adyen as primary payment gateway with PayPal (via Braintree) as alternative. Both may trigger 3DS depending on bank policies and transaction risk scoring.

### Multi-Domain Session Management

Nike's authentication and checkout span multiple cookie domains that must all be valid simultaneously:

| Domain | Critical Cookies | Purpose |
|--------|-----------------|---------|
| `.nike.com` | `_abck`, `bm_sv`, `ak_bmsc`, `CONSUMERCHOICE`, `NIKE_COMMERCE_COUNTRY` | Akamai validation, locale, commerce context |
| `accounts.nike.com` | `sid`, `did`, `cf_clearance`, `KP_UIDz` | Authentication session, Cloudflare clearance |
| `api.nike.com` | `KP_UIDz`, `KP_UIDz-ssn` | API access tokens |
| `.paypal.com` | `d_id`, `cf_clearance`, `enforce_policy` | PayPal session (if used) |

All cookies must be captured during login and injected into Playwright browser contexts before checkout. Cookie expiration varies — `sid` lasts ~1 hour, `cf_clearance` ~1 year, `_abck` ~1 day.

### Proxy Requirements

- **Residential proxies only** — datacenter IPs (AWS, GCP, OVH) are blocklisted by Akamai's ASN database.
- **French geolocation** — IP must resolve to France for `/fr/` market targeting. Geolocation cookie (`geoloc=cc=FR,rc=IDF`) must match.
- **Per-account isolation** — each account must use a dedicated proxy to prevent cross-account correlation by Nike's systems.
- **Rotation capability** — proxies must support session-based rotation for login vs. checkout phases.

## CLI Tool / Distributable Product Requirements

### Project-Type Overview

This is an extension of an existing TypeScript monorepo (`nike-release-checker`) that already provides SDK + CLI packages for Nike product feed monitoring. The bot extension adds a new `nike-bot` binary (v1.0 via `npm install -g`, v1.1 via SEA binary) that wraps the existing SDK for non-dev users.

### Distribution Channels (v1.0 and v1.1)

| Version | Channel | Installation |
|---------|---------|--------------|
| v1.0 | npm global | `npm install -g @nike-release-checker/bot` (user must have Node.js) |
| v1.0 | Manual install script | `curl -fsSL https://...install.sh \| bash` — installs Node.js + bot + Playwright browsers |
| v1.1 | GitHub Releases | Download `nike-bot-v1.1.0-macos-universal.dmg` / `nike-bot-v1.1.0-windows-x64.exe` — SEA binary, no Node.js required |
| v1.1 | Homebrew (tentative) | `brew install nike-bot` (if community tap accepted) |

### Command Structure

All commands exposed via single `nike-bot` binary. CLI built on Ink (React for terminals) with interactive wizard prompts, not argparse-style commands.

| Command | Description |
|---------|-------------|
| `nike-bot init` | Interactive wizard: configure accounts, cards, addresses, capture sessions, run dry-run |
| `nike-bot drops` | Interactive drop manager: list upcoming drops, configure SKU/sizes/accounts filter per drop |
| `nike-bot run` | Launch TUI dashboard with all configured drops. Auto-warmup pre-drop, execute at drop time. |
| `nike-bot accounts` | Session status dashboard + refresh expired sessions |
| `nike-bot report` | Show reports from previous drops (reads report-*.csv files) |
| `nike-bot update-selectors` | Pull latest selectors from community GitHub repo (if Nike DOM changes) |

Legacy developer commands (`import-accounts`, `login-all`, `dry-run`, `start`) remain available under `nike-bot dev <subcommand>` for power users.

### Configuration Schema (v2 — CSV-first)

**1. Global bot config (`bot.config.yaml`)** — unchanged from v1.

**2. CSV Config Files (replaces accounts.json):**

```csv
# accounts.csv
account_id,email,password,proxy_url,country,preferred_sizes
kev_001,user1@mail.com,pass1,http://u:p@proxy1.com:8080,FR,"42;42.5;43"
kev_002,user2@mail.com,pass2,http://u:p@proxy2.com:8080,FR,"42;43"
```

```csv
# cards.csv — encrypted at rest in SQLite
account_id,card_number,expiry,cvv,holder_name
kev_001,4111...1111,12/27,123,Kevin Dupont
```

```csv
# addresses.csv
account_id,street,city,zip,country,phone
kev_001,"10 rue de la Paix",Paris,75002,FR,+33600000000
```

```csv
# drop.csv — user edits this before each drop
sku,sizes,accounts_filter
AH7389-106,"42;42.5;43",all
IQ7604-101,"40;41",kev_001;kev_002;kev_005
```

**3. Report CSV (generated post-drop):**

```csv
# report-2026-04-24-100015.csv
account_id,status,sku,size,order_number,timestamp,error_reason,duration_ms
kev_001,COP,AH7389-106,42.5,A1B2C3,2026-04-24T10:00:22Z,,22341
kev_002,SOLD_OUT,AH7389-106,,,,"stock_depleted_at_payment",28104
```

**Join key for all CSV files: `account_id`.**

### Output Formats

- **TUI Dashboard:** Ink-based multi-pane terminal UI with real-time per-account rows, countdown timers, emojis, progress bars. Primary user interface during drops.
- **Report CSV:** Post-drop, one file per drop. User opens in Excel.
- **Log files:** JSON-structured log entries in `./logs/` for debugging. Not the primary user-facing output.

## Project Scoping & Phased Development

### MVP Strategy & Philosophy

**MVP Approach:** Problem-Solving MVP — the product's value is binary. It either cops the pair or it doesn't. No polish needed beyond what proves life. The MVP must prove one thing: **a non-dev reseller can install, configure 50 accounts, and successfully place an order on a real SNKRS drop faster than a human can — in under 10 minutes of setup time.**

**Resource Requirements:** Single developer (Jopad), TypeScript/Node.js expertise, Playwright knowledge, access to residential French proxies for dev testing, 1-5 Nike accounts for testing.

### v1.0 MVP Feature Set (P0 — 2-3 weeks)

**Core User Journeys Supported:** Journey 1 (Setup), 2 (Happy Path), 3 (Failure Scenarios — simplified), 4 (Warmup), 5 (Maintenance) — all with zero-terminal UX.

**Must-Have Capabilities (P0):**

| Capability | Description | Rationale | Epic |
|------------|-------------|-----------|------|
| Wizard onboarding | `nike-bot init` interactive wizard — configures accounts, cards, addresses, runs dry-run | North Star: Kevin completes setup without commands | Epic 9 |
| CSV-first config | `accounts.csv`, `cards.csv`, `addresses.csv`, `drop.csv` parsed and validated | Natural format for reseller community | Epic 10 |
| Cards encrypted at rest | SQLite + AES-256 for `cards.csv` data | Security requirement | Epic 10 |
| TUI Dashboard live | Ink dashboard with per-account live status, emojis, animations | Kevin's anxiety manager during drop | Epic 11 |
| Pre-drop warmup mode | Countdown + session validation + DNS/slug pre-resolution | Competitive speed advantage | Epic 11 |
| Batch session capture | Parallel Playwright auth for 10-50 accounts | Scale requirement | Epic 2 (extend) |
| Report CSV generator | Post-drop CSV report for Excel | Kevin reviews in his native tool | Epic 11 |
| Playwright Stealth checkout | Full checkout flow (already implemented Epics 1-8) | Core cop engine | Epics 1-8 |

### v1.1 Release (P1 — 1 week)

| Capability | Description | Rationale |
|------------|-------------|-----------|
| Auto-installer | Bundled Node.js + Playwright + Chromium | Removes Node.js install blocker |
| SEA binary | Node.js Single Executable for macOS universal + Windows x64 | True double-click experience |
| Gatekeeper bypass docs | `FIRST_LAUNCH.md` with screenshots for macOS + Windows SmartScreen | Budget constraint (no code signing) |

### Explicitly OUT of v1 Scope

- **SMTP / IMAP email integration** — too complex, user gets Nike order emails natively
- **Phone push notifications** — complexity > value for v1
- **Discord / Telegram integration** — deferred to v2
- **GUI desktop app (Tauri / Electron / Python)** — deferred to v4
- **Sophisticated 3DS auto-resume** — v1 does detect + alert + timeout only (stories 5-5, 5-6 simplified)
- **Daemon mode (Epic 7)** — deferred to v3 SaaS cloud (replaced by TUI foreground execution)
- **Auto screenshots** — user takes own screenshots
- **Multi-country support** — France only in v1
- **Webhook notifications** — terminal logs + TUI sufficient
- **Size fallback logic** — target sizes only, no automatic alternatives
- **Dashboard / web UI** — TUI is the UI
- **API-based carting (TLS impersonation)** — Playwright only in v1
- **Proxy health monitoring** — user responsibility in v1
- **Mass account registration / creation** — user provides pre-existing accounts

### Post-MVP Roadmap

**v2 (Growth):** Discord/Telegram bot for remote control, proxy bundling, cookie auto-refresh, multi-slug simultaneous monitoring, size fallback logic.

**v3 (Expansion / SaaS Cloud):** Server-side daemon execution, 100+ parallel checkouts, auth + billing, multi-tenant isolation, API-based carting research, smart drop prediction.

**v4 (GUI if market validated):** Tauri desktop app, drag-and-drop account management, visual drop editor, in-app analytics dashboard.

### Risk Mitigation Strategy

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Non-dev user abandons during install | High | Critical — zero users | Auto-installer in v1.1, detailed FIRST_LAUNCH.md, Discord community support |
| Playwright Stealth detected by Akamai | Medium | Critical — checkout blocked | Externalize stealth config for rapid updates. Monitor community patches. Dry-run before live drops. |
| Nike DOM/selector changes | Medium | High — checkout flow breaks | All selectors in external config. Dry-run validates. `nike-bot update-selectors` pulls community patches. |
| Cookie expiration during long idle | High | Medium — must re-login | Pre-drop warmup validates sessions. TUI maintenance dashboard surfaces expired sessions. |
| 30-second checkout target too aggressive | Low | Medium — orders fail on hyper-limited | Pre-drop warmup shaves 2-3s. Profile each step in logs. API carting research in v3. |
| Nike changes checkout flow | Low | Critical — rewrite of checkout module | Modular checkout steps. Only affected step needs update. Community contributes patches. |
| Nike implements CAPTCHA on checkout | Medium | High — blocks automation | Playwright Stealth may handle Turnstile. Fallback: manual CAPTCHA solve via TUI alert (v2). |
| CSV format confusion for non-dev | Medium | Medium — onboarding drop-off | Wizard `nike-bot init` generates sample CSVs. Schema validation with human-readable errors. |
| SEA binary packaging issues (macOS) | High | High — blocks v1.1 | Budget 3-5 days for Gatekeeper + ad-hoc signing + universal binary. Start experiments early. |
| Solo developer scope creep | Medium | Medium — delays v1 | Strict split v1.0/v1.1. Features beyond P0/P1 explicitly deferred. |

## Epic Summary (v2 additions)

Three new epics are introduced in v2 to deliver the distributable-product layer on top of the existing Epics 1-8 (already implemented in `packages/bot/src/`). Full stories, acceptance criteria, and sequencing live in `_bmad-output/planning-artifacts/epics.md`.

| Epic | Title | v1 Target | Covered FRs |
|------|-------|-----------|-------------|
| **Epic 9** | Distribution & Onboarding Non-Dev | v1.1 | FR42-FR47 |
| **Epic 10** | CSV-First Config System | v1.0 | FR48-FR52 |
| **Epic 11** | TUI Dashboard Live | v1.0 | FR53-FR55 |

**Existing epics impacted:**
- **Epic 2 (Accounts):** extend Story 2.2 for parallel batch session capture
- **Epic 1 (Foundation):** extend Story 1.3 config loader for CSV support
- **Epic 5 (Logging):** add story for `report.csv` export
- **Epic 7 (Daemon):** `[DEFERRED v3]` — code remains but not wired into `nike-bot` v1 binary

**Build sequence:** Epic 10 first (foundation for everything else), then Epic 9 + Epic 11 in parallel, then v1.1 SEA binary packaging (Epic 9 completion).

## Functional Requirements

### Account Management (Epic 2 — existing, extended)

- **FR1:** Operator can import multiple Nike account configurations from a CSV file, including credentials, proxy, country, and preferred sizes *(v2: CSV replaces JSON)*
- **FR2:** Operator can view the list of all configured accounts with their current session status (valid, expired, or missing) via TUI dashboard
- **FR3:** Operator can authenticate all configured accounts in a single batch operation, capturing session cookies across all required Nike domains
- **FR4:** Operator can authenticate a single specific account by `account_id`
- **FR5:** Operator can clear all stored sessions and cookies for all accounts or a specific account
- **FR6:** System validates proxy connectivity for each account during import

### Session Management

- **FR7:** System captures and persists authenticated session cookies across `nike.com`, `accounts.nike.com`, `api.nike.com`, and payment provider domains during login
- **FR8:** System loads persisted cookies into isolated Playwright browser contexts before checkout execution
- **FR9:** System validates session freshness before initiating checkout and surfaces expired sessions to the operator in the TUI
- **FR10:** System performs 2-step Nike login flow (email submission → password submission) via Playwright Stealth on `accounts.nike.com`

### Product Monitoring & Trigger

- **FR11:** System monitors target product availability by SKU (preferred) or slug using the existing SDK's Product Feed API polling
- **FR12:** System detects stock status transitions for target sizes on the configured market (France)
- **FR13:** System triggers checkout execution automatically when target product becomes available in at least one specified size
- **FR14:** Operator can configure polling interval for Product Feed checks
- **FR15:** Operator can specify target drops via `drop.csv` file (sku, sizes, accounts_filter columns)

### Checkout Automation

- **FR16:** System navigates to the target product page and selects an available target size from the size grid
- **FR17:** System clicks the purchase button to add the selected size to cart
- **FR18:** System navigates to the Nike France checkout page (`/fr/checkout`)
- **FR19:** System completes the shipping step by confirming the pre-saved address and clicking "save and continue"
- **FR20:** System completes the payment step by confirming the pre-saved payment method and clicking continue
- **FR21:** System completes the order review step by submitting the order
- **FR22:** System executes the full checkout flow (FR16–FR21) independently for each configured account in parallel
- **FR23:** Operator can run the full checkout flow in dry-run mode that stops before order submission

### Anti-Detection & Stealth

- **FR24:** System launches each account's checkout in a separate Playwright Stealth browser context with dedicated proxy
- **FR25:** System masks browser automation signals (`navigator.webdriver`, canvas fingerprint, WebGL renderer)
- **FR26:** System injects pre-captured cookies into each browser context before navigation
- **FR27:** System ensures no cross-contamination of cookies, storage, or network state between account contexts
- **FR28:** System configures browser locale, language, and geolocation headers consistent with the target market (French IP, `fr-FR` language)

### Error Handling & Diagnostics

- **FR29:** System detects when a product becomes unavailable during checkout ("sold out") and logs the failure with elapsed time
- **FR30:** System detects Akamai/Cloudflare blocks (HTTP 403, challenge pages) and logs the failure with the affected account and proxy
- **FR31:** System detects 3D Secure iframe injection during payment, pauses checkout execution, and logs an urgent alert to TUI
- **FR32:** *(v1 simplified)* System times out the paused account after 120 seconds if 3DS validation not completed. No automatic resume in v1. Manual retry path: TUI final summary screen exposes a "Retry failed accounts" action that re-runs the checkout pipeline for selected `account_id`s against the same SKU, using fresh proxy rotation.
- **FR33:** System classifies each checkout attempt outcome (success, sold out, blocked, 3DS triggered, timeout, unknown error) and records it distinctly in report CSV
- **FR34:** System logs each checkout step with timestamp, account ID, step name, duration, and outcome

### Bot Operations & Configuration (existing)

- **FR35:** Operator can configure the bot via a YAML configuration file (`bot.config.yaml`: polling interval, market, default sizes, proxy settings, stealth options, log file path)
- **FR36:** `[DEFERRED v3]` Operator can start the bot in headless daemon mode that runs as a background process. **Not in scope for v1 — do not implement.** Existing Epic 7 code remains as-is but is not wired into the v1 `nike-bot` binary.
- **FR37:** `[DEFERRED v3]` System writes a PID file when running as daemon for process management. **Not in scope for v1 — do not implement.**
- **FR38:** System writes structured JSON log entries to a log file in addition to TUI output
- **FR39:** System provides a TUI dashboard with live per-account progress during checkout execution
- **FR40:** Operator can check the status of configured accounts and session health via TUI
- **FR41:** All selectors used for Nike page interaction are stored in an external configuration file, updatable via `nike-bot update-selectors`

### Distribution & Onboarding (v2 — NEW — Epic 9)

- **FR42:** System provides an `nike-bot init` wizard that walks a non-dev user through account import (via native OS file picker for macOS, manual path entry with tab-autocomplete for Windows — terminal drag-drop is offered as an optional path but not required), session capture, and dry-run validation
- **FR43:** *(v1.1)* System distributes as SEA (Node.js Single Executable Application) binary for macOS universal (ARM+x64) and Windows x64, downloadable from GitHub Releases
- **FR44:** *(v1.1)* System bundles Playwright + Chromium in the installer, requiring zero additional dependency installation by the user
- **FR45:** *(v1.0)* System provides a one-line install script (`curl ... | bash`) that installs Node.js, the bot, and Playwright browsers on macOS and Linux
- **FR46:** System ships a `FIRST_LAUNCH.md` document with step-by-step Gatekeeper (macOS) and SmartScreen (Windows) bypass instructions, with screenshots
- **FR47:** Wizard auto-generates sample CSV templates (`accounts.csv`, `cards.csv`, `addresses.csv`, `drop.csv`) in a user-chosen folder, with inline schema documentation as CSV comments

### CSV-First Config System (v2 — NEW — Epic 10)

- **FR48:** System loads `accounts.csv` with schema: `account_id, email, password, proxy_url, country, preferred_sizes`. Validates all required columns present, detects duplicate `account_id`, reports row-level errors with human-readable messages.
- **FR49:** System loads `cards.csv` with schema: `account_id, card_number, expiry, cvv, holder_name`. Encrypts card data at rest in local SQLite database using AES-256 with user-derived passphrase.
- **FR50:** System loads `addresses.csv` with schema: `account_id, street, city, zip, country, phone`. Joins on `account_id` with accounts.
- **FR51:** System loads `drop.csv` with schema: `sku, sizes, accounts_filter` where `accounts_filter` is either `all` (meaning every `account_id` present in `accounts.csv` that has session status `valid` at the moment of execution) or a `;`-separated list of explicit `account_id`s. Used by `nike-bot run` to determine active drops.
- **FR52:** System generates a `report-YYYY-MM-DD-HHMMSS.csv` after each drop execution with schema: `account_id, status, sku, size, order_number, timestamp, error_reason, duration_ms`

### TUI Dashboard Live (v2 — NEW — Epic 11)

- **FR53:** System provides a live TUI dashboard (Ink-based) during drop execution showing per-account status rows with icons (`✓ COP`, `⏳ WAIT`, `✗ FAIL`, `🔄 RETRY`), current step label, elapsed time, and result details
- **FR54:** System provides a **pre-drop warmup mode** that, at a user-configured lead time before drop (default: 5 minutes), begins SDK polling, pre-resolves the product slug, validates session freshness for all active accounts, and pre-launches Playwright contexts with cookies injected. Warmup transitions seamlessly into drop execution at T=0.
- **FR55:** System displays a final summary screen post-drop with aggregated counts (total accounts, cops, failures by category) and auto-saves the report CSV to a user-chosen folder

## Non-Functional Requirements

### Performance

- **NFR1:** End-to-end checkout time (stock detection → order submission) must complete in under 30 seconds for a single account
- **NFR2:** Parallel checkout execution for 5 accounts must complete within 35 seconds (near-constant time due to parallel execution, +5s overhead for context spawning)
- **NFR3:** Product Feed polling must detect stock transitions within one polling interval (configurable, default 5 seconds, default 2 seconds during warmup mode)
- **NFR4:** Playwright browser context launch (with cookie injection and proxy configuration) must complete in under 5 seconds per context
- **NFR5:** Each checkout step (size selection, add to cart, shipping, payment, review) must complete in under 8 seconds individually
- **NFR21:** Batch session capture for 50 accounts must complete in under 3 minutes (parallel, max 10 concurrent browser contexts)
- **NFR22:** TUI dashboard must render frame updates at minimum 2 FPS during active drop execution (no perceived freeze)

### Security

- **NFR6:** Nike account credentials stored in `accounts.csv` must never be logged in plaintext to terminal output or log files (logger must mask `password` column)
- **NFR7:** Session cookie files must be stored with restricted file permissions (owner read/write only, 600)
- **NFR8:** Proxy credentials (username/password in proxy URLs) must be masked in all log output
- **NFR9:** The bot configuration file and CSV credential files should be excluded from version control via `.gitignore` templates shipped with the bot
- **NFR10:** No credentials or session data transmitted to any third-party service (all data stays local)
- **NFR23:** Payment card data from `cards.csv` must be encrypted at rest in a local SQLite database using AES-256 with a user-derived passphrase; never stored in plaintext on disk

### Reliability

- **NFR11:** System must run continuously for 24+ hours across multiple drop sessions without memory leaks, crashes, or zombie processes (foreground TUI mode in v1; daemon deferred to v3)
- **NFR12:** A failure in one account's checkout must not affect other accounts' checkout execution (fault isolation)
- **NFR13:** Unexpected errors during checkout must be caught, logged, and not crash the main process or TUI
- **NFR14:** System must gracefully handle network timeouts (proxy failure, Nike server delays) with configurable timeout thresholds
- **NFR15:** System must handle Playwright browser context crashes without terminating the TUI dashboard
- **NFR24:** If the TUI dashboard crashes, report CSV must still be generated from persisted state (no data loss)

### Usability (NEW — v2)

- **NFR25:** A non-dev user with Excel familiarity must complete the `nike-bot init` wizard from first launch to successful dry-run in under 10 minutes, without consulting external documentation
- **NFR26:** All CSV schema errors must be reported with row number, column name, and a human-readable suggested fix (e.g., "Row 3: column 'expiry' expected format MM/YY, got '2027-12'")
- **NFR27:** TUI dashboard must be readable in 80x24 terminal (standard default) without horizontal scroll or truncated account rows
- **NFR28:** First-launch Gatekeeper/SmartScreen bypass flow must be documented with annotated screenshots for both macOS and Windows

### Integration

- **NFR16:** Bot module must consume the existing SDK as a dependency via its public API — no internal/private API usage
- **NFR17:** Bot must not modify any existing files in `packages/sdk/` or the core CLI
- **NFR18:** Bot must follow the existing project's TypeScript configuration (strict mode, ESM modules, build toolchain)
- **NFR19:** Bot must be installable via the existing monorepo's package manager without conflicts with existing dependencies
- **NFR20:** Playwright and stealth plugin versions must be pinned to avoid breaking changes from upstream updates

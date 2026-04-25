# Story 18.2: Subscription Tiers via Stripe Checkout (Solo/Pro/Enterprise)

Status: backlog

## Story

As a SaaS customer,
I want to self-serve subscribe to a tier via `POST /v1/billing/subscribe` that returns a Stripe Checkout URL,
So that I can pay with a card and unlock my tier's account / drop limits without operator intervention. (FR72, NFR40)

## Acceptance Criteria

**Given** a Stripe customer exists for the requesting customer (Story 18.1)
**When** the customer hits `POST /v1/billing/subscribe` with body `{ tier: 'solo' | 'pro' | 'enterprise' }`
**Then** the API resolves the tier to the corresponding Stripe Product ID (`nrc_solo`, `nrc_pro`, `nrc_enterprise`) and creates a Stripe Checkout Session via `stripe.checkout.sessions.create({ mode: 'subscription', customer: stripe_customer_id, line_items: [{ price: <tier_price_id>, quantity: 1 }], success_url, cancel_url })` with an idempotency key `subscribe:<customer_id>:<tier>:<YYYY-MM-DD>`
**And** the response returns `{ checkout_url, session_id }` (HTTP 200) — the customer redirects their browser to `checkout_url` to complete payment
**And** the `enterprise` tier rejects self-serve subscribe with `{ code: 'CONTACT_SALES', message: 'Enterprise tier requires custom contract — email sales@...' }` and HTTP 422
**And** if the customer is already subscribed to a tier, the response is HTTP 409 `{ code: 'ALREADY_SUBSCRIBED', current_tier: '...' }` and the customer is directed to the upgrade endpoint (`POST /v1/billing/upgrade` — separate, not in this story)
**And** Stripe Products and Prices are provisioned via a one-time `npm run billing:bootstrap` script that idempotently `stripe.products.create` + `stripe.prices.create` for each tier with metadata `{ tier, max_accounts, max_drops_concurrent, fee_per_cop_cents }`
**And** integration tests verify all three tier paths (solo happy, pro happy, enterprise rejection) plus the already-subscribed path

## Tasks / Subtasks

### Task 1: Tier definition module (AC: tier metadata source of truth)

- **File:** `packages/api/src/billing/tiers.ts` (new)
- Single source of truth:
  ```ts
  export interface TierDefinition {
    id: 'solo' | 'pro' | 'enterprise'
    productId: string         // Stripe Product ID (resolved from env or DB)
    monthlyPriceCents: number
    maxNikeAccounts: number
    maxConcurrentDrops: number | null
    countriesAllowed: number  // -1 for unlimited
    feePerCopCents: number
    selfServe: boolean
  }
  export const TIERS: Record<TierDefinition['id'], TierDefinition> = {
    solo: {
      id: 'solo', productId: 'prod_nrc_solo', monthlyPriceCents: 2900,
      maxNikeAccounts: 5, maxConcurrentDrops: 1, countriesAllowed: 1,
      feePerCopCents: 200, selfServe: true,
    },
    pro: {
      id: 'pro', productId: 'prod_nrc_pro', monthlyPriceCents: 9900,
      maxNikeAccounts: 25, maxConcurrentDrops: 5, countriesAllowed: 3,
      feePerCopCents: 300, selfServe: true,
    },
    enterprise: {
      id: 'enterprise', productId: 'prod_nrc_enterprise', monthlyPriceCents: 0,
      maxNikeAccounts: -1, maxConcurrentDrops: null, countriesAllowed: -1,
      feePerCopCents: 0, selfServe: false,
    },
  }
  ```

### Task 2: Bootstrap script for Stripe products + prices (AC: idempotent provisioning)

- **File:** `packages/api/scripts/bootstrap-billing.ts` (new)
- Run via `npm run billing:bootstrap`
- For each tier in `TIERS`:
  ```ts
  const product = await stripe.products.create(
    { id: tier.productId, name: `NRC ${tier.id}`, metadata: {...} },
    { idempotencyKey: `bootstrap-product:${tier.productId}` },
  )
  const price = await stripe.prices.create(
    { product: product.id, unit_amount: tier.monthlyPriceCents, currency: 'usd', recurring: { interval: 'month' } },
    { idempotencyKey: `bootstrap-price:${tier.productId}:monthly` },
  )
  // Persist price.id back to a `billing_prices` table or a config file consumed by Story 18.2 endpoint
  ```
- Outputs the resolved Price IDs (writes them to `packages/api/src/billing/.priceIds.json` ignored by git, loaded at runtime)

### Task 3: `/v1/billing/subscribe` endpoint (AC: Checkout Session created)

- **File:** `packages/api/src/routes/billing.ts` (new)
- Handler:
  ```ts
  fastify.post('/v1/billing/subscribe', async (req, reply) => {
    const { tier } = parseBody(req.body, SubscribeBodySchema)
    const customer = await customerRepo.findById(req.customer.id)
    if (customer.tier !== 'none') {
      return reply.code(409).send({ code: 'ALREADY_SUBSCRIBED', current_tier: customer.tier })
    }
    const tierDef = TIERS[tier]
    if (!tierDef.selfServe) {
      return reply.code(422).send({ code: 'CONTACT_SALES', message: '...' })
    }
    const priceId = priceIdRegistry.lookup(tier, 'monthly')
    const today = new Date().toISOString().slice(0, 10)
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.stripe_customer_id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/billing/cancel`,
      metadata: { customer_id: customer.id, tier },
    }, { idempotencyKey: `subscribe:${customer.id}:${tier}:${today}` })
    return reply.send({ checkout_url: session.url, session_id: session.id })
  })
  ```
- Uses `stripe.checkout.sessions.create` (Stripe API: https://docs.stripe.com/api/checkout/sessions/create)

### Task 4: Tier transition is webhook-driven, not endpoint-driven (AC: subscribe ≠ activate)

- **File:** `packages/api/src/routes/billing.ts` (continue)
- Important: the `subscribe` endpoint does **not** flip `customers.tier` from `none` to the chosen tier. That flip happens when Story 18.4's webhook handler receives `customer.subscription.created` from Stripe (after the customer completes payment).
- Why: customer might abandon Checkout. We only count them as subscribed when payment confirms.
- Document this in the response body: `"Note: tier will be activated once payment completes (typically < 30s after Checkout submission)."`

### Task 5: `enterprise` tier path (AC: 422 with sales contact)

- **File:** `packages/api/src/routes/billing.ts` (continue)
- Same handler, branch on `tier === 'enterprise'` → `reply.code(422).send({ code: 'CONTACT_SALES', message: 'Enterprise tier requires a custom contract — email sales@<our-domain>' })`
- No Stripe call for enterprise — onboarded manually by sales

### Task 6: Tests (AC: happy paths + rejections)

- **File:** `packages/api/src/routes/billing.test.ts` (new, integration)
  - Use `stripe-mock` (configured to return mock `checkout.sessions.create` responses with deterministic URLs)
  - Test 1: POST `{tier:'solo'}` for a customer with `tier='none'` → assert 200, response includes `checkout_url`
  - Test 2: POST `{tier:'pro'}` → same assertion with pro Price ID
  - Test 3: POST `{tier:'enterprise'}` → assert 422 with `code: 'CONTACT_SALES'`
  - Test 4: POST for already-subscribed customer → assert 409
  - Test 5: Inspect mock request log → assert idempotency key matches `subscribe:<customer_id>:<tier>:<YYYY-MM-DD>`
- **File:** `packages/api/scripts/bootstrap-billing.test.ts` (new, unit)
  - Mock Stripe SDK → run bootstrap → assert each tier triggered both `products.create` and `prices.create` with idempotency keys

## Dev Notes

### Stripe Checkout vs. PaymentIntent

Chose Stripe Checkout (hosted payment page) over PaymentIntent because:
- Zero PCI scope — Stripe hosts the card form
- Built-in support for SCA / 3DS (EU regulation)
- Mobile-friendly out of the box
- We don't have a frontend yet — Checkout works as a redirect from API responses

PaymentIntent would be needed only if we built a custom payment UI (deferred to v4).

Reference: https://docs.stripe.com/api/checkout/sessions/create

### Why a Bootstrap Script vs. Auto-Provisioning at Boot

Auto-provisioning at server boot is dangerous: a deploy bug could create duplicate Stripe Products in production. The bootstrap script is run **once per environment** by an operator, output is committed to env config (Price IDs), and the runtime path only reads — never writes — Stripe Products/Prices. Idempotency keys protect against accidental re-runs.

### Tier Limits Enforcement (Story 18.5)

This story does **not** enforce tier limits (e.g. Solo can only have 5 nike_accounts). That's Story 18.5's job. Story 18.2 only handles the subscribe transaction; the activated tier limits become enforceable once `customer.subscription.created` webhook fires (Story 18.4) and `customers.tier` is set.

### Pricing Justification

Per PRD business model section:
- Solo: $29/mo + $2/cop — entry tier for Kevin-style indie resellers
- Pro: $99/mo + $3/cop — semi-pro 25-account operations
- Enterprise: custom — large reseller groups, agencies

The per-cop fee (Story 18.3) is the variable revenue layer. Subscription is the floor.

### Idempotency Key Design — Daily Window

`subscribe:<customer_id>:<tier>:<YYYY-MM-DD>` allows a customer to retry subscribe within a day without creating duplicate Checkout Sessions. After 24 h the key rotates (next day) so a customer can re-attempt if they abandoned a session and want a fresh one. This balances safety with user agency.

Stripe idempotency keys have a 24-hour TTL anyway (https://docs.stripe.com/api/idempotent_requests), so the daily key matches.

### Project Structure Notes

New files:
```
packages/api/src/billing/tiers.ts
packages/api/src/routes/billing.ts
packages/api/src/routes/billing.test.ts
packages/api/scripts/bootstrap-billing.ts
packages/api/scripts/bootstrap-billing.test.ts
```

Generated (gitignored):
```
packages/api/src/billing/.priceIds.json
```

### References

- Epics: Story 18.2 derived from skeleton (was implicit in Stripe Customer story)
- PRD: Business model section (pricing tiers), NFR40 (idempotency)
- V3_MIGRATION_PLAN.md Phase 5: Stripe Customer + Subscription provisioning
- Stripe API: `stripe.checkout.sessions.create` — https://docs.stripe.com/api/checkout/sessions/create
- Stripe API: `stripe.products.create` — https://docs.stripe.com/api/products/create
- Stripe API: `stripe.prices.create` — https://docs.stripe.com/api/prices/create
- Depends on: Story 18.1 (Stripe customer exists)
- Enables: Story 18.4 (webhook activates tier), Story 18.5 (tier limit enforcement)

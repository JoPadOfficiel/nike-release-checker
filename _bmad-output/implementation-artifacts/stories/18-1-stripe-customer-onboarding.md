# Story 18.1: Stripe Customer Provisioning on Signup

Status: backlog

## Story

As a SaaS customer,
I want a Stripe customer record created automatically when I sign up via `POST /v1/account`,
So that I can later subscribe to a tier or be charged for usage without a separate provisioning step. (NFR40)

## Acceptance Criteria

**Given** a prospective customer hits `POST /v1/account` with `{ email, company_name?, country }`
**When** the API handler validates the request and inserts a row in `customers`
**Then** the handler calls `stripe.customers.create({ email, name: company_name, metadata: { customer_id, country } })` with an idempotency key derived from the customer email (`signup:<sha256(email)>`)
**And** the returned `stripe_customer_id` is persisted in `customers.stripe_customer_id` (column added by this story's migration)
**And** if the Stripe API returns an error other than idempotency-replay (network timeout, invalid email), the customer row is rolled back and the API returns `502 Bad Gateway` with `{ code: 'BILLING_PROVIDER_UNAVAILABLE' }`
**And** if the idempotency key matches an existing Stripe customer (replay-safe), the existing `stripe_customer_id` is reused — no duplicate Stripe customer is created (NFR40 idempotency principle applied at provisioning, not just webhook)
**And** subscription is **not** created at this step — that's a separate `POST /v1/billing/subscribe` call (Story 18.2)
**And** integration test against Stripe test-mode verifies: happy path, replay safety, network-error rollback

## Tasks / Subtasks

### Task 1: Migration — add `stripe_customer_id` to `customers` (AC: schema)

- **File:** `packages/api/src/db/migrations/019_stripe_customer.sql` (new)
- DDL:
  ```sql
  ALTER TABLE customers
    ADD COLUMN stripe_customer_id TEXT UNIQUE,
    ADD COLUMN tier TEXT NOT NULL DEFAULT 'none' CHECK (tier IN ('none','solo','pro','enterprise')),
    ADD COLUMN cop_count_mtd INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN unpaid BOOLEAN NOT NULL DEFAULT false;
  CREATE INDEX idx_customers_stripe ON customers(stripe_customer_id);
  ```
- `tier='none'` indicates no active subscription (signup complete, not subscribed yet)
- `cop_count_mtd` for Story 18.3 per-cop accounting
- `unpaid` flag toggled by Story 18.4 webhook handler

### Task 2: `StripeClient` wrapper (AC: idempotency built-in)

- **File:** `packages/api/src/billing/stripeClient.ts` (new)
- Thin wrapper around the official `stripe` Node SDK that injects idempotency keys by default:
  ```ts
  import Stripe from 'stripe'
  export class StripeClient {
    constructor(private stripe: Stripe) {}
    createCustomer(args: {
      email: string
      name?: string
      metadata: Record<string, string>
      idempotencyKey: string
    }): Promise<Stripe.Customer> {
      return this.stripe.customers.create(
        { email: args.email, name: args.name, metadata: args.metadata },
        { idempotencyKey: args.idempotencyKey },
      )
    }
  }
  export function createStripeClient(secretKey: string): StripeClient {
    return new StripeClient(new Stripe(secretKey, { apiVersion: '2024-12-18.acacia' }))
  }
  ```
- All mutating Stripe calls **must** route through this wrapper to enforce the idempotency-key convention

### Task 3: Signup route handler with Stripe call (AC: provisioning happens in transaction)

- **File:** `packages/api/src/routes/account.ts` (new)
- Endpoint: `POST /v1/account` body `{ email, company_name?, country }`
- Flow:
  ```ts
  const customerId = randomUUID()
  const idempotencyKey = `signup:${createHash('sha256').update(body.email).digest('hex')}`

  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO customers (id, email, company_name, country) VALUES ($1,$2,$3,$4)`,
                    [customerId, body.email, body.company_name, body.country])
    let stripeCustomer
    try {
      stripeCustomer = await stripeClient.createCustomer({
        email: body.email,
        name: body.company_name,
        metadata: { customer_id: customerId, country: body.country },
        idempotencyKey,
      })
    } catch (err) {
      throw new BillingProviderUnavailableError(err)
    }
    await tx.query(`UPDATE customers SET stripe_customer_id = $1 WHERE id = $2`,
                    [stripeCustomer.id, customerId])
  })
  ```
- Stripe call is **inside** the DB transaction so any failure rolls back the customer row
- `BillingProviderUnavailableError` mapped to HTTP 502 by error middleware

### Task 4: Idempotency-replay handling (AC: existing Stripe customer reused)

- **File:** `packages/api/src/billing/stripeClient.ts` (continue)
- When Stripe returns an idempotency-replayed response, the SDK's response object has identical `id` to the original — no special handling needed in the wrapper (the SDK transparently returns the cached response)
- However, if a customer-row insert succeeded before but the previous DB transaction did not commit (rare crash mid-transaction), the next signup attempt with the same email will:
  1. Try to insert into `customers` → fails on `email UNIQUE` constraint (assumes constraint exists from Epic 16)
  2. Handler catches uniqueness violation, returns `409 Conflict` with `{ code: 'EMAIL_ALREADY_REGISTERED' }`
- The Stripe-side idempotency key prevents Stripe duplicate even if step 1 races

### Task 5: API key generation (AC: customer can call other endpoints after signup)

- **File:** `packages/api/src/routes/account.ts` (continue)
- After successful signup, generate an API key (`nrc_<32-byte base62>`) and insert into `api_keys` table
- Response body:
  ```json
  {
    "customer_id": "...",
    "api_key": "nrc_...",
    "stripe_customer_id": "cus_..."
  }
  ```
- API key shown **once** at signup; never retrievable later (force regeneration if lost)

### Task 6: Tests (AC: happy path, replay, error rollback)

- **File:** `packages/api/src/routes/account.test.ts` (new, integration)
  - Use `stripe-mock` (https://github.com/stripe/stripe-mock) Docker container or Stripe test mode
  - Test 1: POST with new email → assert 201, `stripe_customer_id` populated, customer row exists
  - Test 2: POST same email twice → assert second returns 409 (DB constraint catches before Stripe is hit again, but if it weren't, the idempotency key would catch it)
  - Test 3: Configure Stripe mock to return 500 → assert 502 returned, no customer row exists in DB (transaction rolled back)
  - Test 4: Verify idempotency key sent to Stripe by inspecting mock request log
- **File:** `packages/api/src/billing/stripeClient.test.ts` (new, unit)
  - Mock `Stripe` SDK → assert `createCustomer` passes through `idempotencyKey` option
  - Assert API version pinned to `2024-12-18.acacia`

## Dev Notes

### Stripe Idempotency Key Strategy

NFR40 requires Stripe interactions to be idempotent. Stripe's idempotency mechanism: pass `idempotencyKey` option to any mutating call; Stripe caches the response for 24 h keyed on the idempotency key + API key + endpoint. Replays return the cached response without re-executing the side effect.

**Key derivation per operation:**
- Customer creation: `signup:<sha256(email)>` — same email always yields same key
- Subscription creation (Story 18.2): `subscribe:<customer_id>:<tier>:<timestamp_day>` — daily window prevents double-subscribe
- Usage record (Story 18.3): `usage:<order_number>` — internal cop ID is the natural idempotency anchor

Reference: https://docs.stripe.com/api/idempotent_requests

### Why Pin Stripe API Version

`apiVersion: '2024-12-18.acacia'` pins the Stripe API behavior to a known shape. Stripe will not change the response format for a pinned version, so our parsing code is stable across SDK upgrades. Update this constant deliberately when migrating to a newer Stripe API surface — it requires re-testing all integrations.

Stripe SDK reference: `stripe.customers.create` — https://docs.stripe.com/api/customers/create

### Why Stripe Call Inside DB Transaction

A common anti-pattern is "create local row → call external service → update local row with external ID". If the external call fails, the local row is orphaned. Wrapping in a transaction means a failed Stripe call rolls back the customer row, leaving no orphan. Cost: the DB transaction holds a row lock for the duration of the Stripe call (typically < 1 s). Acceptable at signup volume.

If Stripe latency becomes a concern (high signup rate), switch to outbox pattern: insert customer row + outbox event in same transaction; async worker picks up outbox event and calls Stripe; updates customer row. Defer this until measured.

### Email Uniqueness Constraint

This story assumes Epic 16 Story 16.1 added `customers.email UNIQUE`. If not, add it here as an additional ALTER. Prevents two customers signing up with the same email and racing on Stripe customer creation.

### Test-Mode vs. Live-Mode

All tests run against Stripe test mode (`sk_test_...`). Live-mode keys (`sk_live_...`) are only set in production secrets. Integration tests verify the wrapper passes the idempotency key correctly; the actual Stripe-side dedup is covered by Stripe's own SLAs.

### Project Structure Notes

New files:
```
packages/api/src/db/migrations/019_stripe_customer.sql
packages/api/src/billing/stripeClient.ts
packages/api/src/billing/stripeClient.test.ts
packages/api/src/routes/account.ts
packages/api/src/routes/account.test.ts
```

### References

- Epics: Story 18.1 acceptance criteria
- PRD: NFR40 (Stripe webhook idempotency — applied to provisioning here for consistency)
- V3_MIGRATION_PLAN.md Phase 5: Stripe Customer + Subscription provisioning
- Stripe API: `stripe.customers.create` — https://docs.stripe.com/api/customers/create
- Stripe Idempotency: https://docs.stripe.com/api/idempotent_requests
- Depends on: Epic 16 Story 16.1 (customers table)
- Enables: Story 18.2 (subscription), Story 18.3 (per-cop billing), Story 18.4 (webhook handler)

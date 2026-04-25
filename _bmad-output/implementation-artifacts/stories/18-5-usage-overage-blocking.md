# Story 18.5: Tier-Limit Enforcement and Overage Blocking

Status: backlog

## Story

As a SaaS platform operator,
I want new drops blocked with HTTP 402 Payment Required when a customer exceeds their tier's account/concurrent-drop limits or has unpaid invoices, with soft warnings at 80%,
So that resources are protected and customers are nudged to upgrade or settle their bill before they hit a hard wall mid-drop. (FR72, NFR40)

## Acceptance Criteria

**Given** a customer has tier limits derived from `TIERS[customer.tier]` (Story 18.2) and an `unpaid` flag from Story 18.4
**When** the customer attempts `POST /v1/drops` (Story 17.1) or `POST /v1/accounts` (Story 16) and any of the following are true — exceeded `maxNikeAccounts`, exceeded `maxConcurrentDrops`, or `unpaid=true`
**Then** the API returns HTTP 402 Payment Required with body `{ code, message, current, limit, upgrade_url }`:
- `EXCEEDED_NIKE_ACCOUNTS` if adding the account would exceed `maxNikeAccounts`
- `EXCEEDED_CONCURRENT_DROPS` if adding the drop would exceed `maxConcurrentDrops`
- `SUBSCRIPTION_UNPAID` if `unpaid=true` (with upgrade_url pointing to billing portal)
**And** soft-warning at 80% of any limit emits an in-band response header `X-Tier-Warning: <code>:<current>/<limit>` on the successful response, but does NOT block
**And** soft-warning is also logged to a `tier_warnings` table (customer_id, code, current, limit, occurred_at) for the deferred email-notification feature (v3.2)
**And** customers on `tier='none'` (signed up but not subscribed) are blocked from creating drops with `code: 'NO_ACTIVE_SUBSCRIPTION'`
**And** Enterprise tier (limits = `null`/`-1`) bypasses all limit checks but still respects `unpaid=true`
**And** integration tests cover: hit limit → 402, 80% threshold → warning header, unpaid → 402 regardless of usage, enterprise bypass

## Tasks / Subtasks

### Task 1: `TierEnforcer` middleware module (AC: centralized check)

- **File:** `packages/api/src/billing/tierEnforcer.ts` (new)
- Public API:
  ```ts
  export type EnforceResult =
    | { allowed: true; warning?: { code: string; current: number; limit: number } }
    | { allowed: false; code: string; current: number; limit: number; upgrade_url: string }

  export interface TierEnforcer {
    canAddNikeAccount(customerId: string): Promise<EnforceResult>
    canCreateDrop(customerId: string): Promise<EnforceResult>
    requirePaid(customerId: string): Promise<EnforceResult>
  }
  ```
- Each method:
  1. Loads customer (`tier`, `unpaid`, `cop_count_mtd`)
  2. If `tier === 'none'` → block with `NO_ACTIVE_SUBSCRIPTION`
  3. If `unpaid === true` → block with `SUBSCRIPTION_UNPAID`
  4. Resolves `TIERS[tier]` for limits
  5. Counts current usage (separate query depending on resource)
  6. Returns `EnforceResult` with optional 80% warning when within bounds

### Task 2: Resource-counting queries (AC: accurate current vs. limit)

- **File:** `packages/api/src/billing/tierEnforcer.ts` (continue)
- For accounts:
  ```sql
  SELECT count(*) FROM nike_accounts WHERE customer_id = $1;
  ```
- For drops (concurrent = drops in `SCHEDULED|ARMED|ACTIVE`):
  ```sql
  SELECT count(*) FROM drops WHERE customer_id = $1 AND state IN ('SCHEDULED','ARMED','ACTIVE');
  ```
- Compare `current + 1 > limit` (because the request is to ADD one more) → block

### Task 3: Wire enforcer into `POST /v1/drops` (AC: blocked drops never reach DB)

- **File:** `packages/api/src/routes/drops.ts` (edit — Story 17.1 file)
- Before insert:
  ```ts
  const result = await tierEnforcer.canCreateDrop(req.customer.id)
  if (!result.allowed) {
    return reply.code(402).send({
      code: result.code,
      message: messageFor(result.code),
      current: result.current,
      limit: result.limit,
      upgrade_url: result.upgrade_url,
    })
  }
  if (result.warning) {
    reply.header('X-Tier-Warning', `${result.warning.code}:${result.warning.current}/${result.warning.limit}`)
  }
  // ... existing insert logic
  ```

### Task 4: Wire enforcer into `POST /v1/accounts` (AC: account add blocked at limit)

- **File:** `packages/api/src/routes/accounts.ts` (edit — Epic 15 Story 15.3 file; if not yet created, this story creates a stub)
- Same pattern with `tierEnforcer.canAddNikeAccount`
- Block code: `EXCEEDED_NIKE_ACCOUNTS`

### Task 5: Soft-warning logging table (AC: tier_warnings persisted)

- **File:** `packages/api/src/db/migrations/022_tier_warnings.sql` (new)
- DDL:
  ```sql
  CREATE TABLE tier_warnings (
    id BIGSERIAL PRIMARY KEY,
    customer_id UUID NOT NULL REFERENCES customers(id),
    code TEXT NOT NULL,
    current_value INTEGER NOT NULL,
    limit_value INTEGER NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_tier_warnings_customer_recent
    ON tier_warnings(customer_id, occurred_at DESC);
  ```
- `tierEnforcer` writes a row whenever `result.warning` is set
- v3.2 future: a daily job scans this table and emails customers approaching their limits (deferred — log only for now)

### Task 6: `upgrade_url` resolver (AC: contextual upgrade link)

- **File:** `packages/api/src/billing/upgradeUrlResolver.ts` (new)
- Returns the appropriate upgrade target depending on current tier:
  ```ts
  export function resolveUpgradeUrl(currentTier: TierId | 'none', blockReason: string): string {
    const base = `${env.APP_URL}/billing`
    if (blockReason === 'SUBSCRIPTION_UNPAID') return `${base}/portal`  // Stripe billing portal for card update
    if (currentTier === 'none' || currentTier === 'solo') return `${base}/upgrade?to=pro`
    if (currentTier === 'pro') return `${base}/contact-sales`  // Pro → Enterprise
    return base
  }
  ```
- The Stripe Billing Portal (https://docs.stripe.com/api/customer_portal/sessions/create) provides customers a self-serve URL to update payment methods. A separate small route `POST /v1/billing/portal` returns a fresh portal URL (out of scope for this story but referenced by the upgrade flow).

### Task 7: Tests (AC: each block path + warning + enterprise bypass)

- **File:** `packages/api/src/billing/tierEnforcer.test.ts` (new)
  - Solo customer with 5 accounts → `canAddNikeAccount` returns `allowed: false, code: 'EXCEEDED_NIKE_ACCOUNTS', current: 5, limit: 5`
  - Solo with 4 accounts → allowed with `warning.code: 'NIKE_ACCOUNTS_NEAR_LIMIT'` (since 4/5 = 80%)
  - Solo with 3 accounts → allowed, no warning
  - Pro customer with 1 active drop → `canCreateDrop` allowed (limit 5)
  - Pro with 5 active drops → blocked
  - Customer with `unpaid=true` → all enforce methods return `SUBSCRIPTION_UNPAID` regardless of usage
  - Enterprise tier → all checks pass even at extreme usage; but `unpaid=true` still blocks
  - Customer with `tier='none'` → blocked with `NO_ACTIVE_SUBSCRIPTION`
- **File:** `packages/api/src/routes/drops.test.ts` (edit — Story 17.1 file)
  - POST `/v1/drops` for Solo at limit → assert HTTP 402, body matches schema
  - POST at 80% threshold → assert HTTP 201 + `X-Tier-Warning` header present
  - Assert `tier_warnings` row inserted on warning path

## Dev Notes

### HTTP 402 Payment Required — Why and When

HTTP 402 is the canonical "you need to pay more" status. Browsers don't have built-in handling (unlike 401 → login redirect), but for an API it's semantically correct and tooling-friendly. The body always carries the structured `code` so client SDKs can branch on it.

Reference: RFC 9110 §15.5.2 — https://datatracker.ietf.org/doc/html/rfc9110#name-402-payment-required

### Race Condition: Limit Check vs. Insert

Naive: `if (count < limit) { insert }` races between concurrent requests. Two simultaneous adds at limit-1 each pass the check then both insert, exceeding the limit by 1.

Mitigation for v3.1: accept the race (max overshoot = concurrent request count, typically 1-2). Customers don't notice a 1-account overshoot; ops sees it in the next bill cycle.

Mitigation for v3.2: use Postgres advisory lock per customer for the duration of the check + insert, OR a CHECK constraint with a count subquery (slow). Defer until measured impact.

### Soft Warning at 80%

`80%` chosen because it's the standard SaaS warning threshold (AWS, Datadog, Sentry all use it). Implementation:
```ts
const ratio = current / limit
const warning = ratio >= 0.8 && ratio < 1.0
  ? { code: codeForResource(resource), current, limit }
  : undefined
```

For limits like `1` (Solo concurrent drops), 80% = 0.8 → never triggers. That's fine; the warning is most useful for Pro-tier 25-account scenarios.

### Email Notifications Deferred

The original epic mentions email at limit thresholds. Deferred to v3.2 because:
- Need transactional email provider integration (Postmark / Resend)
- Need email templates and i18n
- Need user preferences (opt-out)
- Out of scope for billing MVP

For v3.1, `tier_warnings` table is the data source — when email infrastructure lands, a daily job replays warnings and sends digests.

### Enterprise Tier — Special Case

`maxNikeAccounts: -1`, `maxConcurrentDrops: null` mean unlimited. Enforcer short-circuits these to `allowed: true` without counting:
```ts
if (limit === null || limit === -1) return { allowed: true }
```

But `unpaid=true` still blocks Enterprise — bills must be paid regardless of contract. (Enterprise typically pays via wire transfer, so payment_failed events differ — but the `unpaid` flag is set manually by ops in that case.)

### Stripe Billing Portal Integration

For the `SUBSCRIPTION_UNPAID` block, the `upgrade_url` points to a Stripe-hosted billing portal where the customer can update their payment method without us building a UI. Endpoint: `POST /v1/billing/portal` calls `stripe.billingPortal.sessions.create({ customer: stripe_customer_id, return_url })` and returns the portal URL.

This portal session is out of scope for this story but explicitly named so the upgrade_url resolver compiles. Add as a small follow-up task in Story 18.4's billing route file.

Reference: https://docs.stripe.com/api/customer_portal/sessions/create

### Project Structure Notes

New files:
```
packages/api/src/db/migrations/022_tier_warnings.sql
packages/api/src/billing/tierEnforcer.ts
packages/api/src/billing/tierEnforcer.test.ts
packages/api/src/billing/upgradeUrlResolver.ts
```

Modified:
- `packages/api/src/routes/drops.ts` — call enforcer before insert (Story 17.1)
- `packages/api/src/routes/accounts.ts` — call enforcer before insert (Epic 15 Story 15.3)

### References

- Epics: Story 18.5 derived from billing skeleton (was implicit in Stripe story)
- PRD: FR72 (REST API tier behavior), Business model section (tier limits), NFR40 (no double-charging cascades from unpaid handling)
- V3_MIGRATION_PLAN.md Phase 5: Per-tier rate-limiting (rate limits) and tier limits enforced together
- Stripe Billing Portal: https://docs.stripe.com/api/customer_portal/sessions/create
- HTTP 402 RFC: https://datatracker.ietf.org/doc/html/rfc9110#name-402-payment-required
- Depends on: Story 18.1 (customer.tier, unpaid columns), Story 18.2 (TIERS definitions), Story 18.4 (unpaid flag set by webhook), Story 17.1 (drops table)
- Defers to v3.2: email notifications consuming `tier_warnings` table

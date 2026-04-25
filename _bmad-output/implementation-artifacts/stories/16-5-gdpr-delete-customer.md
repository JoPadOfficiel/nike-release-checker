# Story 16.5: GDPR `DELETE /v1/account` (Soft-Delete + 30-Day Hard-Purge)

Status: backlog

## Story

As a B2B customer,
I want a single `DELETE /v1/account` endpoint that purges all my data — Nike accounts, cards, addresses, drops, runs, orders, webhooks, deliveries, audit log — within 30 days,
so that I can exercise my GDPR right-to-erasure with one API call and the platform meets NFR33 (24 h PII purge) and the legal "within 30 days" SLA.

## Acceptance Criteria

**Given** an authenticated customer (Story 15.2) with active data in every tenant table
**When** they call `DELETE /v1/account` with header `X-Confirm-Delete: yes` and body `{ reason?: string }`
**Then** the gateway:
  1. Refuses with HTTP 409 if any of the customer's drops are in `state ∈ {ACTIVE, SCHEDULED}` (must `DELETE /v1/drops/{id}` first or wait for completion);
  2. Sets `customers.deleted_at = now()` (soft-delete) and revokes every `api_keys` row (`revoked_at = now()`);
  3. Immediately purges all PII-bearing rows in tenant-owned tables that resolve to encrypted PII (`nike_accounts.*_encrypted`, `cards.*_encrypted`, `addresses.phone_encrypted`, `webhook_deliveries.payload_json` containing customer data) within 24 h via a background job (NFR33);
  4. Schedules a hard-purge job at `now() + 30 days` that removes the `customers` row itself, cascading to remaining child rows;
  5. Writes an `audit_log` row `action='customer.delete', actor=req.apiKeyId, payload_redacted_json={ reason, scheduled_purge_at }` with `customer_id = req.customerId` (the audit row survives because `audit_log.customer_id` uses `ON DELETE SET NULL` per Story 16.1);
  6. Returns HTTP 202 `{ deleted_at, scheduled_purge_at }`
**And** subsequent API calls with the customer's old token return HTTP 401 `auth-revoked` (Story 15.2 contract — keys are revoked)
**And** during the 30-day grace window, a `POST /v1/account/restore` endpoint can undo the soft-delete IF the hard-purge job has not yet run (clears `customers.deleted_at`, un-revokes API keys); after hard-purge the customer is gone irrecoverably
**And** the per-customer DEK is zeroized in cache (Story 16.2 `invalidateDek`) immediately on soft-delete and the wrapped DEK is overwritten with random bytes during hard-purge so any DB backup taken AFTER hard-purge cannot decrypt residual ciphertext (defense in depth)
**And** orders are NOT purged — instead, `customer_id` is nulled and `nike_order_number + total_amount_cents + currency + created_at` are preserved as anonymized billing-reconciliation rows (NFR33 explicitly allows this)

## Tasks / Subtasks

### Task 1: Migration `0007_orders_customer_nullable.sql` (AC: anonymized billing rows)

```sql
ALTER TABLE orders ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE orders DROP CONSTRAINT orders_customer_id_fkey;
ALTER TABLE orders ADD CONSTRAINT orders_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
```

(Story 16.1 had `ON DELETE CASCADE`; this story relaxes for orders only.)

### Task 2: `customers.findById` excludes soft-deleted (AC: 401 after delete)

Update Story 15.2 auth path: when looking up the customer behind an API key, treat `customers.deleted_at IS NOT NULL` as "revoked". The `api_keys.revoked_at` flip in this story belt-and-braces the same outcome.

### Task 3: PII purge service `src/services/gdpr/purgePii.ts` (AC: 24 h immediate purge)

```typescript
export async function purgePii(customerId: string) {
  await db.tx(async (tx) => {
    // 1. Hard-delete tables whose entire content is PII (cards, addresses, nike_accounts, webhooks)
    await tx.cards.deleteByCustomer(customerId)
    await tx.addresses.deleteByCustomer(customerId)
    await tx.nikeAccounts.deleteByCustomer(customerId)
    await tx.webhooks.deleteByCustomer(customerId)            // cascades webhook_deliveries
    // 2. Drops + drop_runs: keep IDs for audit, but null/erase PII columns
    await tx.drops.anonymize(customerId)                       // sku/sizes preserved (not PII), customer_id stays for FK to soft-deleted row
    // 3. Audit log: redact payload_redacted_json to remove any residual PII while keeping action history
    await tx.auditLog.redactCustomerPayloads(customerId)
    // 4. Zeroize the wrapped DEK on customers row (so even DB backup post-purge is unrecoverable for this customer)
    await tx.customers.scrambleDekWrapped(customerId)
  })
  invalidateDek(customerId)
}
```

`scrambleDekWrapped` overwrites `dek_wrapped` and `dek_salt` with `randomBytes(...)` of the same length.

### Task 4: Hard-purge cron `src/workers/gdprPurger.ts` (AC: 30-day removal)

```typescript
async function tick() {
  const due = await db.customers.findDueForHardPurge() // WHERE deleted_at <= now() - INTERVAL '30 days'
  for (const c of due) {
    await db.tx(async (tx) => {
      // Orders: detach (set customer_id=NULL) before customer is removed (FK is ON DELETE SET NULL)
      // Audit log: same (FK is ON DELETE SET NULL)
      await tx.customers.delete(c.id) // cascades to api_keys, remaining drops, drop_runs
    })
    log.info({ customer_id: c.id }, 'gdpr_hard_purge_complete')
  }
}
setInterval(tick, 60 * 60 * 1000) // hourly
```

The cron lives in the same worker process as the webhook dispatcher (Story 15.5).

### Task 5: REST endpoints `src/routes/account/gdpr.ts` (AC: delete + restore)

```typescript
app.delete('/v1/account', { config: { rateLimit: false } }, async (req, reply) => {
  if (req.headers['x-confirm-delete'] !== 'yes')
    return reply.code(400).send(problem('confirmation-required', 400))
  if (await drops.hasActiveOrScheduled(req.customerId!))
    return reply.code(409).send(problem('drops-in-flight', 409))

  const deletedAt = new Date()
  const purgeAt   = new Date(deletedAt.getTime() + 30 * 24 * 3600 * 1000)
  await db.tx(async (tx) => {
    await tx.customers.softDelete(req.customerId!, deletedAt)
    await tx.apiKeys.revokeAllForCustomer(req.customerId!)
  })
  await audit.log(req, 'customer.delete', req.customerId!, {
    reason: req.body?.reason ?? null, scheduled_purge_at: purgeAt.toISOString(),
  })
  // Schedule the immediate PII purge as a background job (24 h SLA)
  void purgePii(req.customerId!).catch((err) => log.error({ err }, 'pii_purge_failed'))
  invalidateDek(req.customerId!)
  reply.code(202).send({ deleted_at: deletedAt.toISOString(), scheduled_purge_at: purgeAt.toISOString() })
})

app.post('/v1/account/restore', { /* requires alternative auth — recovery token, out of scope for v3.0 */ },
  async (req, reply) => {
    // For v3.0: restore is admin-only via internal tooling. Endpoint stub returns 501.
    return reply.code(501).send(problem('not-implemented', 501, 'Self-serve restore is admin-only in v3.0'))
  })
```

(Note: the restore self-service path is deferred to v3.1; v3.0 ships the soft-delete window mechanism so admins can manually undo via DB if needed.)

### Task 6: Tests `src/services/gdpr/gdpr.test.ts` (AC: end-to-end + edge cases)

- Happy path: insert customer with full data → DELETE → 202; subsequent token use → 401; PII tables empty for this customer; audit row remains; orders preserved with `customer_id = NULL`.
- Active drop blocks delete → 409; cancel the drop → DELETE succeeds.
- Missing `X-Confirm-Delete` header → 400.
- After soft-delete, `getDek(customerId)` cache is invalidated (next call would attempt re-derive but the customer is gone — assert function throws "unknown customer").
- Hard-purge cron with mocked clock advanced by 31 days removes the customer row; `dek_wrapped` is scrambled before customer-row removal (verify by snapshotting `dek_wrapped` between soft-delete and hard-purge).
- Cross-customer probe: deleting customer A leaves customer B's data fully intact (count rows before/after).
- Audit log row for `customer.delete` survives hard-purge with `customer_id = NULL`.

## Dev Notes

### Why two-phase (24 h purge + 30 d hard-purge)

NFR33 requires PII purge within 24 h — that's the immediate `purgePii` step. The 30-day soft-delete window is a customer-protection mechanism (accidental DELETE recoverable by ops within the window) AND a billing-reconciliation buffer (Stripe disputes referencing prior cops can still be answered). The trade-off is that for 30 days, anonymized rows (drops, drop_runs, orders with nulled customer_id) and the empty `customers` row continue to exist — those contain no PII so are GDPR-compliant.

### DEK scramble timing

The wrapped DEK is overwritten right BEFORE the customer row removal (Task 4 last step before delete) so:
- During the 30-day window, the DEK is already invalidated in cache (Task 3) but `dek_wrapped` is intact — this is the only reversibility path for the soft-delete window.
- After hard-purge, `dek_wrapped` is random bytes — even if a DB backup taken at T+25d is restored at T+45d, no decryption of any residual ciphertext is possible (because `purgePii` ran at T+24h, the only ciphertext that would survive is in audit log payloads, which are also redacted in Task 3).

### Anonymized order rows are GDPR-permitted

Per GDPR Recital 26 + Article 4(1), data that "does not relate to an identified or identifiable natural person" is out of scope. Orders post-purge contain only `nike_order_number`, `total_amount_cents`, `currency`, `created_at` — none of which can re-identify the customer. We document this in our DPA. The `nike_order_number` could in theory be subpoena'd at Nike to re-link, but that is beyond our control and not GDPR personal data on our side.

### Restore deferral

Self-serve restore needs an out-of-band auth mechanism (the API key was revoked during delete). Email magic link is the obvious choice but requires email infrastructure (transactional sending, deliverability) that v3.0 doesn't have yet. Admin-tooling-only restore satisfies the "soft-delete window" intent without shipping new auth surface.

### Project Structure Notes

Files created:

- `packages/api/migrations/0007_orders_customer_nullable.sql`
- `packages/api/src/services/gdpr/purgePii.ts`
- `packages/api/src/services/gdpr/gdpr.test.ts`
- `packages/api/src/workers/gdprPurger.ts`
- `packages/api/src/routes/account/gdpr.ts`

Files modified:

- `packages/api/src/db/customers.ts` — add `softDelete`, `findDueForHardPurge`, `scrambleDekWrapped`, `delete`
- `packages/api/src/db/apiKeys.ts` — add `revokeAllForCustomer`
- `packages/api/src/db/orders.ts` — `anonymize` method (no-op currently; orders already keep customer_id nullable)
- `packages/api/src/db/auditLog.ts` — add `redactCustomerPayloads(customerId)`
- `packages/api/src/plugins/auth.ts` — treat `customers.deleted_at IS NOT NULL` as revoked (Task 2)
- `packages/api/src/workers/index.ts` — start `gdprPurger` alongside webhook dispatcher
- `packages/api/src/app.ts` — register `gdprRoutes`

### References

- PRD: `_bmad-output/planning-artifacts/prd.md` — FR75, NFR33 (GDPR vault, 24 h purge, anonymized billing rows), NFR39 (audit log)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — v3 §"Security Model" (DEK rotation re-encrypts; same machinery applies to scramble), §"Multi-Tenant Data Model"
- Migration: `docs/V3_MIGRATION_PLAN.md` — Phase 5 deliverable "GDPR delete-my-data + DEK rotation endpoints"
- Epics: `_bmad-output/planning-artifacts/epics.md` — Story 16.5

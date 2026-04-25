# Story 16.4: Nike Account Credential Storage (Encrypted Multi-Tenant)

Status: done

## Story

As a B2B customer,
I want to register Nike accounts (email + password + proxy + session) via REST and have all sensitive fields encrypted at rest with my per-customer DEK,
so that the bot can drive checkouts on my behalf while a database leak or a cross-customer probe cannot expose credentials, proxy URLs, or warm browser sessions.

## Acceptance Criteria

**Given** an authenticated customer (Story 15.2) and a provisioned per-customer DEK (Story 16.2)
**When** they call `POST /v1/account/nike-accounts` with body `{ email, password, country, proxy_url?, preferred_sizes? }`
**Then** the gateway encrypts `email`, `password`, and `proxy_url` independently with AES-256-GCM under the customer's DEK and inserts a row into `nike_accounts`; uniqueness across `(customer_id, email_encrypted)` is enforced via a deterministic envelope (HMAC-SHA256(dek, email) stored alongside or applied as a partial UNIQUE INDEX on a derived column) so a customer cannot accidentally register the same Nike email twice
**And** `GET /v1/account/nike-accounts/:id` returns metadata `{ id, country, email_masked: "j***@gmail.com", session_status, last_login_at, preferred_sizes, created_at }` — password, full email, and proxy_url are NEVER returned
**And** `GET /v1/account/nike-accounts` lists the same metadata, paginated, customer-scoped
**And** `PATCH /v1/account/nike-accounts/:id` accepts `{ password?, proxy_url?, preferred_sizes? }` for rotation and re-encrypts the changed fields; `email` is NOT mutable (delete + recreate to change)
**And** `DELETE /v1/account/nike-accounts/:id` is rejected with HTTP 409 if the account is currently referenced by an in-flight `drop_run` (`state IN ('PENDING','RUNNING')`); otherwise hard-deletes the row
**And** internally, the worker pool retrieves plaintext via `nikeAccounts.loadForWorker(accountId, customerId)` which returns `{ email, password, proxy_url, country, preferred_sizes, session_snapshot? }` and decrypts the session snapshot blob (encrypted JSON of cookies + Akamai `_abck` + KPSDK token) for cold-start session restore
**And** `nikeAccounts.persistSessionSnapshot(accountId, customerId, snapshot)` re-encrypts and writes back `session_snapshot_encrypted` after each successful drop run; the snapshot includes nothing in plaintext on disk

## Tasks / Subtasks

### Task 1: Email-uniqueness deterministic envelope (AC: dedupe per customer)

Add migration `0006_nike_accounts_email_lookup.sql`:

```sql
ALTER TABLE nike_accounts ADD COLUMN email_lookup BYTEA NOT NULL DEFAULT '\x00';
ALTER TABLE nike_accounts ALTER COLUMN email_lookup DROP DEFAULT;
DROP INDEX IF EXISTS nike_accounts_customer_id_email_encrypted;  -- the original UNIQUE doesn't work (random IV per row)
CREATE UNIQUE INDEX nike_accounts_customer_email_lookup_idx ON nike_accounts(customer_id, email_lookup);
```

`email_lookup = HMAC-SHA256(dek, lowercase(email))` is deterministic (same email → same blob) but unguessable without the DEK. Stored alongside the random-IV `email_encrypted`.

### Task 2: Nike accounts repository `src/db/nikeAccounts.ts` (AC: tenant-scoped CRUD + worker access)

```typescript
export async function create(customerId: string, input: CreateNikeAccountInput) {
  const dek = await getDek(customerId)
  const emailLower = input.email.trim().toLowerCase()
  const row = {
    customer_id: customerId,
    country: input.country,
    email_encrypted:    encryptField(emailLower, dek),
    email_lookup:       hmacSha256(dek, emailLower),
    password_encrypted: encryptField(input.password, dek),
    proxy_url_encrypted: input.proxy_url ? encryptField(input.proxy_url, dek) : null,
    preferred_sizes: input.preferred_sizes ?? [],
  }
  try {
    const id = await db.nikeAccounts.insert(row)
    return toMeta(id, row, dek)
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('nike_account_already_registered')
    throw e
  }
}

export async function loadForWorker(id: string, customerId: string): Promise<NikeAccountPlaintext> {
  const row = await db.nikeAccounts.findEncrypted(id, customerId)
  if (!row) throw new Error('not found')
  const dek = await getDek(customerId)
  return {
    email:      decryptField(row.email_encrypted, dek),
    password:   decryptField(row.password_encrypted, dek),
    proxy_url:  row.proxy_url_encrypted ? decryptField(row.proxy_url_encrypted, dek) : null,
    country:    row.country,
    preferred_sizes: row.preferred_sizes,
    session_snapshot: row.session_snapshot_encrypted
      ? JSON.parse(decryptField(row.session_snapshot_encrypted, dek))
      : null,
  }
}

export async function persistSessionSnapshot(id: string, customerId: string, snapshot: object) {
  const dek = await getDek(customerId)
  const blob = encryptField(JSON.stringify(snapshot), dek)
  await db.nikeAccounts.updateSessionSnapshot(id, customerId, blob)
}
```

### Task 3: Email masking helper `src/services/nikeAccounts/mask.ts` (AC: email_masked output)

`maskEmail("john.smith@gmail.com")` → `"j***@gmail.com"` (first char + 3 stars + `@domain`). Used by metadata responses.

### Task 4: REST routes `src/routes/account/nikeAccounts.ts` (AC: 4 endpoints)

```typescript
app.post('/v1/account/nike-accounts', { schema: { body: CreateBody, response: { 201: NikeAccountMetaSchema } } },
  async (req, reply) => {
    const meta = await nikeAccounts.create(req.customerId!, req.body)
    await audit.log(req, 'nike_account.create', meta.id, { country: meta.country })
    reply.code(201).header('Location', `/v1/account/nike-accounts/${meta.id}`).send(meta)
  })

app.get('/v1/account/nike-accounts/:id', async (req, reply) => { /* tenant-scoped meta read */ })
app.get('/v1/account/nike-accounts',     async (req) => { /* paginated meta list */ })
app.patch('/v1/account/nike-accounts/:id', { schema: { body: PatchBody } }, async (req, reply) => {
  await nikeAccounts.update(req.params.id, req.customerId!, req.body)
  await audit.log(req, 'nike_account.update', req.params.id)
  reply.code(204).send()
})
app.delete('/v1/account/nike-accounts/:id', async (req, reply) => {
  if (await dropRuns.hasInFlight(req.params.id)) return reply.code(409).send(problem('account-in-use', 409))
  await nikeAccounts.remove(req.params.id, req.customerId!)
  await audit.log(req, 'nike_account.delete', req.params.id)
  reply.code(204).send()
})
```

### Task 5: Tests `src/services/nikeAccounts/nikeAccounts.test.ts` (AC: matrix)

- POST + GET happy path; metadata response asserts NO `password`, `email_encrypted`, `proxy_url`, full `email` keys appear (string-search).
- POST same email twice for the same customer → 409 (deterministic `email_lookup` index hit).
- POST same email for two different customers → both succeed (different DEK → different HMAC).
- `loadForWorker` round-trips all fields.
- `persistSessionSnapshot` then `loadForWorker` returns the same snapshot object.
- Cross-tenant `loadForWorker(idA, customerB)` → throws (row not found via tenant-scoped query).
- DELETE with an in-flight `drop_run` → 409; without → 204.
- PATCH password rotates the ciphertext (different blob even when the new password equals the old — IV randomness).

### Task 6: ESLint guard (AC: workers-only access to plaintext)

Add an ESLint rule (or simple grep CI check) that flags any import of `loadForWorker` from outside `packages/api/src/workers/` or `packages/api/src/services/nikeAccounts/` (the function's own file).

## Dev Notes

### Email uniqueness without leaking the email

Per architecture v3 §"Multi-Tenant Data Model" the `(customer_id, email_encrypted)` UNIQUE constraint listed on the `nike_accounts` table sketch cannot be enforced as written — encryption uses a fresh IV per row so two encryptions of the same email yield different ciphertexts. The deterministic HMAC envelope (`email_lookup`) provides a stable unique-key while keeping the email itself confidential. The HMAC key is the per-customer DEK, so cross-customer `email_lookup` collisions cannot be exploited (they'd require knowing both DEKs).

### Session snapshot shape

The blob is opaque JSON owned by Epic 14 (KPSDK bootstrap) and the v2 stealth context factory. Expected fields: `cookies[]`, `localStorage{}`, `kpsdk: { ct, v, expiresAt }`, `userAgent`, `viewport`. We treat it as opaque bytes from the vault's perspective — only encrypt + decrypt, never parse.

### Why no soft-delete

A deleted Nike account's credentials are sensitive; soft-delete would leave decryptable rows around indefinitely. NFR33 mandates GDPR purge within 24 h. Hard-delete on DELETE keeps the deletion semantics simple.

### Project Structure Notes

Files created:

- `packages/api/migrations/0006_nike_accounts_email_lookup.sql`
- `packages/api/src/db/nikeAccounts.ts`
- `packages/api/src/services/nikeAccounts/mask.ts`
- `packages/api/src/services/nikeAccounts/nikeAccounts.test.ts`
- `packages/api/src/routes/account/nikeAccounts.ts`

Files modified:

- `packages/api/src/app.ts` — register `nikeAccountsRoutes`
- `packages/api/src/db/dropRuns.ts` — add `hasInFlight(nikeAccountId)` helper

### References

- PRD: `_bmad-output/planning-artifacts/prd.md` — FR75 (Nike account credentials encrypted multi-tenant), NFR32, NFR33
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — v3 §"Multi-Tenant Data Model" (`nike_accounts` columns), §"Worker Pool Topology" (session restore from Account Vault), §"Security Model"
- Migration: `docs/V3_MIGRATION_PLAN.md` — Phase 5 deliverable "`POST /v1/accounts` endpoint accepting Nike credentials, encrypting before storage"
- Epics: `_bmad-output/planning-artifacts/epics.md` — Story 16.2 (account credentials encryption at rest)

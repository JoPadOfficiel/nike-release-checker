# Story 15.2: API-Key Bearer Authentication Middleware

Status: done

## Story

As a B2B customer,
I want to authenticate every API call with a per-customer API key in the `Authorization` header,
so that my drops and account data are scoped to my customer record and other customers cannot read or run them.

## Acceptance Criteria

**Given** a customer row exists in `api_keys` with `key_id="k_abc"`, `secret_hash=argon2id(<secret>)`, `customer_id="c_123"`, `revoked_at=null`
**When** the customer sends `Authorization: Bearer nrc_k_abc_<secret>` to any `/v1/*` endpoint
**Then** the middleware parses the header, looks up `key_id`, verifies the secret with `argon2.verify`, injects `request.customerId = "c_123"` and `request.apiKeyId = "k_abc"` into the request context, and calls `next()`
**And** every subsequent log line for this request includes `customer_id: "c_123"` (Story 15.1 logger field)
**And** missing or malformed `Authorization` header → HTTP 401 RFC 9457 problem-detail `{ type: ".../auth-missing", title: "Authentication required", status: 401 }` with `WWW-Authenticate: Bearer realm="api"`
**And** valid format but unknown `key_id` or wrong secret → HTTP 401 with `{ type: ".../auth-invalid", title: "Invalid credentials", status: 401 }`; constant-time comparison; identical response shape for unknown-key and bad-secret to prevent enumeration
**And** valid credentials but `api_keys.revoked_at IS NOT NULL` → HTTP 403 `{ type: ".../auth-revoked", title: "API key revoked", status: 403 }`
**And** `/healthz` and `/docs/*` remain anonymous; all other routes are auth-required by default (deny-by-default)

## Tasks / Subtasks

### Task 1: `api_keys` schema (AC: lookup table)

Add to the migration in Story 16.1, but stub the table here so 15.2 is testable in isolation:

```sql
CREATE TABLE api_keys (
  key_id        TEXT PRIMARY KEY,            -- e.g., "k_abc" (random, 12 chars base32)
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  secret_hash   TEXT NOT NULL,                -- argon2id hash of the bearer secret
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX api_keys_customer_id_idx ON api_keys(customer_id);
```

The token format is `nrc_<key_id>_<secret>` where `<secret>` is 32 random base32 chars displayed once at creation.

### Task 2: Auth plugin `src/plugins/auth.ts` (AC: parse, verify, inject context)

```typescript
import argon2 from 'argon2'

declare module 'fastify' {
  interface FastifyRequest {
    customerId?: string
    apiKeyId?: string
  }
}

const TOKEN_RE = /^nrc_([a-z0-9]{6,16})_([a-z0-9]{24,64})$/i

export async function authPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.config?.auth === 'anonymous') return
    const header = req.headers.authorization ?? ''
    const m = header.match(/^Bearer\s+(.+)$/i)
    if (!m) return reply.code(401).header('WWW-Authenticate', 'Bearer realm="api"').send(problem('auth-missing', 401))
    const tok = m[1].match(TOKEN_RE)
    if (!tok) return reply.code(401).send(problem('auth-invalid', 401))
    const [, keyId, secret] = tok
    const row = await db.apiKeys.findByKeyId(keyId)
    const ok = row ? await argon2.verify(row.secret_hash, secret) : await argon2.verify(DUMMY_HASH, 'never-matches')
    if (!row || !ok) return reply.code(401).send(problem('auth-invalid', 401))
    if (row.revoked_at) return reply.code(403).send(problem('auth-revoked', 403))
    req.customerId = row.customer_id
    req.apiKeyId = row.key_id
    await db.apiKeys.touchLastUsed(row.key_id) // fire-and-forget acceptable
  })
}
```

`DUMMY_HASH` is a precomputed argon2id hash used to keep response timing constant for unknown `key_id` (defends against enumeration).

### Task 3: Mark routes anonymous explicitly (AC: deny-by-default)

`/healthz` and `/docs/*` set `config: { auth: 'anonymous' }` on registration. All future routes inherit auth-required.

### Task 4: Logger child binding (AC: `customer_id` in NDJSON)

Extend the request-id plugin (Story 15.1) so when `req.customerId` is set, `req.log = req.log.child({ customer_id: req.customerId })`. Every subsequent `req.log.info/warn/error` includes the field.

### Task 5: Tests `src/plugins/auth.test.ts` (AC: all five auth outcomes)

Use Fastify `inject()` against an app that registers a stub `/v1/ping` returning `{ customerId: req.customerId }`:

- No `Authorization` header → 401, `WWW-Authenticate` present.
- `Authorization: Bearer garbage` → 401 `auth-invalid`.
- `Authorization: Bearer nrc_unknown_xxx` → 401 `auth-invalid`, response time within ±10 ms of valid-secret-but-wrong path (constant-time check).
- Valid token → 200, body returns the expected `customerId`.
- Token whose row has `revoked_at = now()` → 403 `auth-revoked`.
- `/healthz` with no auth header → 200 (anonymous bypass).

## Dev Notes

### Token shape rationale

`nrc_<keyId>_<secret>` puts the lookup key (`keyId`) in plain text so the server can do a single indexed DB lookup, then verifies the secret with argon2id (slow on purpose — defeats brute force). This is the same scheme used by Stripe (`sk_live_<id>_<secret>`) and GitHub (`ghp_<...>`). The `nrc_` prefix lets secret scanners (GitHub, GitGuardian) detect leaked keys.

### Storage

Per architecture v3 §"Security Model": API keys are "generated server-side, displayed once, stored as `argon2id` hash in `customers.api_key_hash`". This story refines that — we move from a single column to a dedicated `api_keys` table so customers can have multiple keys with rotation/revocation. The customer-self-service listing endpoint (Story 15.6) reads from this table.

### Project Structure Notes

Files created:

- `packages/api/src/plugins/auth.ts`
- `packages/api/src/plugins/auth.test.ts`
- `packages/api/src/db/apiKeys.ts` — repository with `findByKeyId`, `touchLastUsed`

Files modified:

- `packages/api/src/app.ts` — register `authPlugin` after `requestIdPlugin`
- `packages/api/src/plugins/requestId.ts` — add `customer_id` child binding (Task 4)
- `packages/api/src/routes/health.ts` — set `config.auth = 'anonymous'`

### References

- PRD: `_bmad-output/planning-artifacts/prd.md` — FR72 (bearer-token auth), NFR32 (per-customer isolation)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — v3 §"Security Model" (Customer API keys), §"Multi-Tenant Data Model"
- Migration: `docs/V3_MIGRATION_PLAN.md` — Phase 4 (single hardcoded token), Phase 5 (multi-customer)

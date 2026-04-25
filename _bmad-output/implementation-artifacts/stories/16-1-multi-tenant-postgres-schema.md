# Story 16.1: Multi-Tenant Postgres Schema + Migrations

Status: done

## Story

As the platform team,
I want a versioned Postgres migration suite that creates every table required by Epics 15-18 with tenant-isolation foreign keys baked in,
so that all subsequent v3 stories have a stable, audited schema to write against and so cross-tenant leakage is structurally hard.

## Acceptance Criteria

**Given** a fresh Postgres 16 database with the `pgcrypto` extension available
**When** I run `npm run -w @nike-release-checker/api migrate`
**Then** all v3 tables are created in dependency order: `customers → api_keys, nike_accounts, addresses, cards, drops, webhooks → drop_runs → orders → webhook_deliveries → audit_log`
**And** every tenant-owned table has a `customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE` column with an index on `customer_id`
**And** every cascade chain is verifiable: deleting a `customers` row removes all its `nike_accounts`, `cards`, `addresses`, `drops`, `drop_runs`, `orders`, `webhooks`, `webhook_deliveries`, `api_keys` rows in the same transaction
**And** `audit_log.customer_id` is `NULLABLE` (system events have no customer) but has `ON DELETE SET NULL` so audit history survives customer deletion (NFR39 12-month retention)
**And** every encrypted column is typed `BYTEA` and named with the `_encrypted` suffix; cleartext-companion columns (`brand`, `last4`, `country`) sit alongside for non-sensitive lookups
**And** the migration is idempotent: re-running `migrate` on an already-migrated DB is a no-op (uses a `schema_migrations` tracking table)
**And** `npm run -w @nike-release-checker/api migrate:rollback` reverses the last migration cleanly (round-trip test in CI)

## Tasks / Subtasks

### Task 1: Choose + wire migration tool (AC: idempotent runner)

- Add dep `node-pg-migrate@^7` (battle-tested, plain SQL or JS migrations, supports up/down).
- Scripts in `packages/api/package.json`: `migrate` (`node-pg-migrate up`), `migrate:rollback` (`node-pg-migrate down 1`), `migrate:create` (`node-pg-migrate create`).
- Migrations live at `packages/api/migrations/` with naming `NNNN_<slug>.{js,sql}`.
- DB connection from `process.env.DATABASE_URL`.

### Task 2: `0001_customers_and_api_keys.sql` (AC: customers + auth tables)

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE customers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                CITEXT NOT NULL UNIQUE,
  stripe_customer_id   TEXT UNIQUE,
  tier                 TEXT NOT NULL DEFAULT 'solo' CHECK (tier IN ('solo','pro','enterprise')),
  dek_wrapped          BYTEA NOT NULL,                     -- KMS-wrapped per-customer DEK (Story 16.2)
  default_currency     TEXT NOT NULL DEFAULT 'USD',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);

CREATE TABLE api_keys (
  key_id        TEXT PRIMARY KEY,
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  secret_hash   TEXT NOT NULL,
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX api_keys_customer_id_idx ON api_keys(customer_id);
```

### Task 3: `0002_nike_accounts_cards_addresses.sql` (AC: vault tables)

```sql
CREATE TABLE nike_accounts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id              UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  country                  TEXT NOT NULL,
  email_encrypted          BYTEA NOT NULL,
  password_encrypted       BYTEA NOT NULL,
  proxy_url_encrypted      BYTEA,
  preferred_sizes          JSONB NOT NULL DEFAULT '[]'::jsonb,
  session_snapshot_encrypted BYTEA,
  session_status           TEXT NOT NULL DEFAULT 'unknown',
  last_login_at            TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, email_encrypted)
);
CREATE INDEX nike_accounts_customer_id_idx ON nike_accounts(customer_id);

CREATE TABLE cards (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id            UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  nike_account_id        UUID REFERENCES nike_accounts(id) ON DELETE SET NULL,
  holder_name_encrypted  BYTEA NOT NULL,
  card_number_encrypted  BYTEA NOT NULL,
  expiry_encrypted       BYTEA NOT NULL,
  cvv_encrypted          BYTEA NOT NULL,
  brand                  TEXT NOT NULL,        -- "visa","mastercard" — non-sensitive
  last4                  TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cards_customer_id_idx ON cards(customer_id);

CREATE TABLE addresses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  nike_account_id UUID REFERENCES nike_accounts(id) ON DELETE SET NULL,
  country         TEXT NOT NULL,
  street          TEXT NOT NULL,
  city            TEXT NOT NULL,
  zip             TEXT NOT NULL,
  phone_encrypted BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX addresses_customer_id_idx ON addresses(customer_id);
```

### Task 4: `0003_drops_runs_orders.sql` (AC: drop tables)

```sql
CREATE TABLE drops (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  country            TEXT NOT NULL,
  sku                TEXT NOT NULL,
  sizes_json         JSONB NOT NULL,
  max_accounts       INTEGER NOT NULL CHECK (max_accounts BETWEEN 1 AND 500),
  payment_method_id  TEXT,
  scheduled_at       TIMESTAMPTZ,
  state              TEXT NOT NULL DEFAULT 'DRAFT'
                       CHECK (state IN ('DRAFT','SCHEDULED','ACTIVE','COMPLETED','FAILED','CANCELLED')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ
);
CREATE INDEX drops_customer_id_idx ON drops(customer_id);
CREATE INDEX drops_state_idx       ON drops(state) WHERE state IN ('SCHEDULED','ACTIVE');

CREATE TABLE drop_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id         UUID NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,  -- denormalized
  nike_account_id UUID NOT NULL REFERENCES nike_accounts(id) ON DELETE RESTRICT,
  state           TEXT NOT NULL DEFAULT 'PENDING',
  order_number    TEXT,
  error_reason    TEXT,
  retry_attempt   INTEGER NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);
CREATE INDEX drop_runs_drop_id_idx     ON drop_runs(drop_id);
CREATE INDEX drop_runs_customer_id_idx ON drop_runs(customer_id);

CREATE TABLE orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_run_id         UUID NOT NULL REFERENCES drop_runs(id) ON DELETE CASCADE,
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  nike_order_number   TEXT NOT NULL UNIQUE,
  total_amount_cents  INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'confirmed',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_id_created_at_idx ON orders(customer_id, created_at DESC);
```

### Task 5: `0004_webhooks_and_audit.sql` (AC: webhook + audit tables)

Schema bodies as described in Story 15.5 (Task 1) and:

```sql
CREATE TABLE audit_log (
  id                    BIGSERIAL PRIMARY KEY,
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,
  actor                 TEXT,                    -- api_key_id or 'system'
  action                TEXT NOT NULL,           -- "drop.create","drop.run","customer.delete"...
  resource_type         TEXT NOT NULL,
  resource_id           TEXT,
  payload_redacted_json JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_customer_created_idx ON audit_log(customer_id, created_at DESC);
```

### Task 6: Migration tests `migrations/migrations.test.ts` (AC: idempotency, cascade)

Spin a disposable Postgres via `testcontainers` (or a CI-provided `DATABASE_URL`):

- Run `migrate` twice → second run is a no-op, no errors.
- Run `migrate` then `migrate:rollback 4` then `migrate` → schema identical (compare `pg_dump --schema-only` snapshots).
- Insert a `customers` row + 1 row in each child table; `DELETE FROM customers WHERE id=$1` → all child rows removed in the same TX (assert via `SELECT count(*)`).
- Cross-tenant probe: customer A's `nike_account` is NOT visible in `SELECT * FROM nike_accounts WHERE customer_id = $B`. (Functional check; row-level security policies are out of scope for this story — tenant scoping enforced in app layer per architecture v3 Security Model.)
- Constraint check: insert a `drops` row with `state='WEIRD'` → fails the CHECK constraint.

### Task 7: Documentation comment block (AC: schema discoverability)

At the top of each migration SQL file, add a banner comment with: filename, story reference, summary of tables, the cascade graph in ASCII. Helps reviewers and future authors.

## Dev Notes

### Why a single Story for the schema

The architecture v3 §"Multi-Tenant Data Model" lists 9 tables. Splitting into 9 stories would force each downstream story (15.x, 16.x, 17.x, 18.x) to either depend on multiple schema stories or stub the missing tables locally. One atomic schema story unblocks every downstream story at once.

### `customer_id` denormalization

`drop_runs.customer_id` and `orders.customer_id` are denormalized (could be reached via `drop_runs → drops → customer_id`). The denormalization buys two things: (1) every tenant-scoped query reads `customer_id` directly without a join — keeps repository code uniform; (2) row-level security policies (when added in v3.x) attach to a single column on every table.

### `dek_wrapped` lives on `customers`

Per architecture v3 §"Security Model" the per-customer DEK is wrapped by the KMS master key. The wrapped blob is stored on the customers row so a single row read is enough to begin decryption work. Story 16.2 owns the unwrap path.

### `audit_log` not partitioned (yet)

12-month retention at expected v3.0 volume (< 100 cops/day across all customers) yields ~36 500 audit rows/yr. No partitioning needed until volume reaches ~10M/yr. Add a partition-by-month migration when that becomes a problem.

### Project Structure Notes

Files created:

- `packages/api/migrations/0001_customers_and_api_keys.sql`
- `packages/api/migrations/0002_nike_accounts_cards_addresses.sql`
- `packages/api/migrations/0003_drops_runs_orders.sql`
- `packages/api/migrations/0004_webhooks_and_audit.sql`
- `packages/api/migrations/migrations.test.ts`
- `packages/api/migrations/README.md` (lists migrations + invariants — not user docs, dev-internal)

Files modified:

- `packages/api/package.json` — add `pg`, `node-pg-migrate`, `testcontainers` (devDep); add migration scripts.

### References

- Architecture: `_bmad-output/planning-artifacts/architecture.md` — v3 §"Multi-Tenant Data Model" (table list), §"Security Model" (DEK storage)
- PRD: `_bmad-output/planning-artifacts/prd.md` — FR75 (multi-tenant vault), NFR32 (tenant isolation), NFR39 (audit log retention)
- Migration: `docs/V3_MIGRATION_PLAN.md` — Phase 4 deploys subset (`drops`, `drop_runs`, `orders`); Phase 5 deploys remainder. This story ships the full schema in one shot — Phase 4 simply uses the subset.
- Epics: `_bmad-output/planning-artifacts/epics.md` — Story 16.1

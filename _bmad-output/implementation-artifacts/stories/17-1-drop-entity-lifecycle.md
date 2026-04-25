# Story 17.1: Drop Entity + Lifecycle State Machine

Status: backlog

## Story

As a SaaS platform operator,
I want a first-class `Drop` entity with an explicit, audited lifecycle state machine,
So that customer drops can be queried, scheduled, and surfaced through the REST API as a multi-tenant primitive instead of an implicit TUI session. (FR72, NFR39)

## Acceptance Criteria

**Given** the multi-tenant Postgres schema (Epic 16) is deployed
**When** a customer creates a drop via `POST /v1/drops` (Epic 15 Story 15.2)
**Then** a row is inserted in the `drops` table with `state = 'DRAFT'`, a UUID `id`, `customer_id`, `sku`, `country`, `sizes[]`, `accounts_filter`, `fire_at` (nullable for DRAFT), and `created_at`
**And** state transitions are guarded — only the following are valid: `DRAFT → SCHEDULED`, `SCHEDULED → ARMED`, `ARMED → ACTIVE`, `ACTIVE → COMPLETED`, `* → ARCHIVED` (terminal), `SCHEDULED → CANCELLED`, `ARMED → CANCELLED`
**And** every state transition writes a row in `drop_state_audit` (drop_id, from_state, to_state, actor, reason, occurred_at) for the immutable 12-month audit trail (NFR39)
**And** an invalid transition (e.g. `DRAFT → ACTIVE`) throws `InvalidDropTransitionError` and is rejected at the service layer before the SQL fires
**And** the `drops.state` column has a SQL `CHECK` constraint enumerating all valid values, enforced at the database level as a defence-in-depth backstop
**And** unit tests cover every legal transition, every illegal transition rejection, and the audit-row write-through

## Tasks / Subtasks

### Task 1: Postgres migration for `drops` + `drop_state_audit` (AC: schema, CHECK constraint)

- **File:** `packages/api/src/db/migrations/017_drops.sql` (new)
- DDL:
  ```sql
  CREATE TYPE drop_state AS ENUM (
    'DRAFT', 'SCHEDULED', 'ARMED', 'ACTIVE',
    'COMPLETED', 'CANCELLED', 'ARCHIVED'
  );

  CREATE TABLE drops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id),
    sku TEXT NOT NULL,
    country CHAR(2) NOT NULL,
    sizes TEXT[] NOT NULL,
    accounts_filter JSONB NOT NULL,
    fire_at TIMESTAMPTZ,
    state drop_state NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (state IN ('DRAFT','SCHEDULED','ARMED','ACTIVE','COMPLETED','CANCELLED','ARCHIVED'))
  );
  CREATE INDEX idx_drops_customer_state ON drops(customer_id, state);
  CREATE INDEX idx_drops_scheduler ON drops(state, fire_at) WHERE state IN ('SCHEDULED','ARMED');

  CREATE TABLE drop_state_audit (
    id BIGSERIAL PRIMARY KEY,
    drop_id UUID NOT NULL REFERENCES drops(id),
    from_state drop_state,
    to_state drop_state NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_drop_audit_drop ON drop_state_audit(drop_id, occurred_at);
  ```

### Task 2: `DropStateMachine` module (AC: guarded transitions, error class)

- **File:** `packages/api/src/drops/dropStateMachine.ts` (new)
- Public API:
  ```ts
  export type DropState =
    | 'DRAFT' | 'SCHEDULED' | 'ARMED' | 'ACTIVE'
    | 'COMPLETED' | 'CANCELLED' | 'ARCHIVED'

  export class InvalidDropTransitionError extends Error {
    constructor(public from: DropState, public to: DropState) {
      super(`Invalid drop transition: ${from} -> ${to}`)
    }
  }

  const ALLOWED: Record<DropState, DropState[]> = {
    DRAFT:     ['SCHEDULED', 'CANCELLED', 'ARCHIVED'],
    SCHEDULED: ['ARMED', 'CANCELLED', 'ARCHIVED'],
    ARMED:     ['ACTIVE', 'CANCELLED', 'ARCHIVED'],
    ACTIVE:    ['COMPLETED', 'ARCHIVED'],
    COMPLETED: ['ARCHIVED'],
    CANCELLED: ['ARCHIVED'],
    ARCHIVED:  [],
  }

  export function assertTransition(from: DropState, to: DropState): void {
    if (!ALLOWED[from].includes(to)) throw new InvalidDropTransitionError(from, to)
  }
  ```

### Task 3: `DropRepository.transitionState` (AC: audit row written atomically)

- **File:** `packages/api/src/drops/dropRepository.ts` (new or edit)
- Method:
  ```ts
  async transitionState(
    dropId: string,
    to: DropState,
    actor: string,
    reason?: string,
    tx?: PoolClient,
  ): Promise<Drop>
  ```
- Implementation: open transaction → `SELECT state FROM drops WHERE id=$1 FOR UPDATE` → `assertTransition(currentState, to)` → `UPDATE drops SET state=$2, updated_at=now() WHERE id=$1` → `INSERT INTO drop_state_audit (drop_id, from_state, to_state, actor, reason)` → commit
- If `tx` passed, reuse the caller's transaction (composable with scheduler — Story 17.2)

### Task 4: REST surface — `POST /v1/drops` creates DRAFT (AC: API entrypoint)

- **File:** `packages/api/src/routes/drops.ts` (new)
- Endpoint: `POST /v1/drops` body `{ sku, country, sizes, accounts_filter, fire_at? }`
- Auth: bearer token → resolves `customer_id` (Epic 15 Story 15.1)
- Validation via valibot schema (sku non-empty, country ISO-2, sizes non-empty array, fire_at ISO timestamp if present)
- Insert row with `state='DRAFT'`; if `fire_at` supplied, follow up with `transitionState(id, 'SCHEDULED', actor='customer:'+customerId)`
- Returns `201 Created` with the full `Drop` payload

### Task 5: Tests (AC: every transition, audit write, CHECK constraint)

- **File:** `packages/api/src/drops/dropStateMachine.test.ts` (new)
  - Every legal transition asserts no throw
  - Every illegal transition asserts `InvalidDropTransitionError`
  - `ARCHIVED` is terminal — every onward transition throws
- **File:** `packages/api/src/drops/dropRepository.test.ts` (new, integration)
  - Use a Postgres test container (testcontainers-node) or local docker via the existing API test harness
  - Insert `DRAFT` drop → `transitionState(..., 'SCHEDULED')` → assert row state and audit row both written in one transaction (verify by raw SQL)
  - Attempt `DRAFT → ACTIVE` → expect throw, no DB changes
  - Force `state='INVALID'` via raw SQL → expect Postgres CHECK constraint violation (defence-in-depth)

### Task 6: Wire-up smoke test in route layer

- **File:** `packages/api/src/routes/drops.test.ts` (new)
- Spin up Fastify in test mode → `POST /v1/drops` with valid body → assert 201, drop persisted with `state='DRAFT'`
- Assert the response shape matches the `DropResponseSchema` valibot type

## Dev Notes

### Lifecycle Rationale

- **DRAFT** — created via API but no fire_at yet; customer iterating on config
- **SCHEDULED** — fire_at set, scheduler will pick it up
- **ARMED** — T-5 minutes; warmup pipeline begins (Story 17.5 ports the v2 warmup)
- **ACTIVE** — T=0; worker pool dispatches drop_runs
- **COMPLETED** — all drop_runs reached terminal state
- **CANCELLED** — customer or system aborted before ACTIVE
- **ARCHIVED** — soft-delete; row kept for audit/billing reconciliation but excluded from default queries

### Why a CHECK Constraint AND Application Guards

- Application guards (`assertTransition`) provide rich error semantics + tests
- CHECK constraint at the DB level catches bypass attempts (raw SQL via psql, ORM bypass, future microservice writing without going through the repository)
- Defence-in-depth — both layers must agree, neither alone is sufficient

### Audit Trail Compliance (NFR39)

The `drop_state_audit` table is **append-only** by convention. No `DELETE` or `UPDATE` privileges granted to the application role. A nightly job archives rows older than 12 months to cold storage (S3 + Glacier) to satisfy the 12-month retention requirement without unbounded growth.

### Actor Field Format

- `customer:<customer_id>` — customer-initiated via API
- `scheduler:tick` — scheduler promoted SCHEDULED → ARMED
- `scheduler:fire` — scheduler promoted ARMED → ACTIVE
- `worker:<worker_id>` — worker pool reported all runs done → COMPLETED
- `system:cleanup` — archival job

### Project Structure Notes

New files:
```
packages/api/src/db/migrations/017_drops.sql
packages/api/src/drops/dropStateMachine.ts
packages/api/src/drops/dropStateMachine.test.ts
packages/api/src/drops/dropRepository.ts
packages/api/src/drops/dropRepository.test.ts
packages/api/src/routes/drops.ts
packages/api/src/routes/drops.test.ts
```

### References

- Epics: Story 17.1 acceptance criteria
- PRD: FR72 (REST API surface), NFR39 (12-month audit log)
- Architecture: Multi-tenant data model section
- V3_MIGRATION_PLAN.md Phase 4: Postgres schema for `drops` deployed
- Depends on: Epic 16 Story 16.1 (customers table)
- Enables: Story 17.2 (scheduler), Story 17.3 (drop_runs), Epic 15 Story 15.2 (REST endpoints)

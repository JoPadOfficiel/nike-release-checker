# Story 16.3: Card Vault — AES-256-GCM Per-Field Encryption (Multi-Tenant)

Status: done

## Story

As a B2B customer,
I want my saved Nike payment cards stored encrypted in the multi-tenant database with my own per-customer DEK and never returned in plaintext over the wire,
so that a database leak does not expose my PAN/CVV/expiry, a cross-customer probe cannot decrypt them, and the platform stays out of PCI-DSS scope.

## Acceptance Criteria

**Given** an authenticated customer (Story 15.2) and a provisioned per-customer DEK (Story 16.2)
**When** they call `POST /v1/account/cards` with body `{ holder_name, card_number, expiry, cvv, brand?, last4? }`
**Then** the gateway derives the per-customer DEK, encrypts each of `holder_name`, `card_number`, `expiry`, `cvv` independently with AES-256-GCM (fresh 12-byte IV per field, 16-byte auth tag, ciphertext stored as `iv || ciphertext || tag` BYTEA), and inserts the row into `cards`
**And** `brand` and `last4` are computed server-side from the input PAN if not provided (Luhn-validated; `brand ∈ {visa, mastercard, amex, discover}` via IIN prefix), and stored in cleartext columns for non-sensitive lookup (e.g., "ending in 1234" UI strings)
**And** `GET /v1/account/cards/:id` returns metadata only `{ id, brand, last4, holder_name_masked: "John D.", expiry_month: "MM", expiry_year_yy: "YY", created_at }` — PAN and CVV are NEVER returned and the response body is asserted to contain none of `card_number`, `cvv`, `card_number_encrypted`, or `cvv_encrypted` keys
**And** `GET /v1/account/cards` lists the same metadata-only shape, paginated
**And** `DELETE /v1/account/cards/:id` hard-deletes the row (cards are not soft-deleted — a removed card is gone)
**And** internally, the worker pool (Epic 17) retrieves plaintext via `cards.getPlaintextForWorker(cardId, customerId)` which re-derives the DEK and returns the four cleartext fields; this method is NOT wired to any HTTP route and is unit-tested separately
**And** every card mutation emits an audit-log row (NFR39) with `action ∈ {card.create, card.delete}` and `payload_redacted_json` containing `last4` only — never PAN or CVV

## Tasks / Subtasks

### Task 1: Field encryption primitives `src/crypto/fieldCrypto.ts` (AC: AES-256-GCM)

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LEN = 12
const TAG_LEN = 16

export function encryptField(plaintext: string, dek: Buffer): Buffer {
  if (dek.length !== 32) throw new Error('dek must be 32 bytes')
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', dek, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, enc, tag])  // packed: iv || ct || tag
}

export function decryptField(blob: Buffer, dek: Buffer): string {
  const iv  = blob.subarray(0, IV_LEN)
  const tag = blob.subarray(blob.length - TAG_LEN)
  const ct  = blob.subarray(IV_LEN, blob.length - TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', dek, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
```

A new IV is generated per field per encrypt call — IV reuse with the same key is catastrophic for GCM, so this is unit-tested.

### Task 2: PAN helpers `src/services/cards/panUtils.ts` (AC: Luhn, brand, last4)

- `isLuhnValid(pan: string): boolean`
- `inferBrand(pan: string): 'visa'|'mastercard'|'amex'|'discover'|'unknown'` (IIN prefix table)
- `last4(pan: string): string` returning the trailing 4 digits
- `maskHolder(name: string): string` returning `"John D."` (first name + first initial of surname)

### Task 3: Cards repository `src/db/cards.ts` (AC: tenant-scoped CRUD)

```typescript
export async function create(customerId: string, input: CreateCardInput): Promise<CardMeta> {
  if (!isLuhnValid(input.card_number)) throw badRequest('invalid_card_number')
  const dek = await getDek(customerId)
  const row = {
    customer_id: customerId,
    holder_name_encrypted:  encryptField(input.holder_name, dek),
    card_number_encrypted:  encryptField(input.card_number, dek),
    expiry_encrypted:       encryptField(input.expiry, dek),
    cvv_encrypted:          encryptField(input.cvv, dek),
    brand: input.brand ?? inferBrand(input.card_number),
    last4: input.last4 ?? last4(input.card_number),
  }
  const id = await db.cards.insert(row)
  return toMeta(id, row)
}

export async function getMetadata(id: string, customerId: string): Promise<CardMeta | null> { /* ... tenant-scoped ... */ }
export async function listMetadata(customerId: string, cursor, limit): Promise<Page<CardMeta>> { /* ... */ }
export async function remove(id: string, customerId: string): Promise<boolean> { /* tenant-scoped DELETE */ }

export async function getPlaintextForWorker(id: string, customerId: string): Promise<CardPlaintext> {
  const row = await db.cards.findEncrypted(id, customerId)
  if (!row) throw new Error('not found')
  const dek = await getDek(customerId)
  return {
    holder_name: decryptField(row.holder_name_encrypted, dek),
    card_number: decryptField(row.card_number_encrypted, dek),
    expiry:      decryptField(row.expiry_encrypted, dek),
    cvv:         decryptField(row.cvv_encrypted, dek),
  }
}
```

`CardMeta` shape excludes any `*_encrypted` field — the type system prevents leakage through the REST layer.

### Task 4: REST routes `src/routes/account/cards.ts` (AC: 4 endpoints, metadata-only)

```typescript
app.post('/v1/account/cards', { schema: { body: CreateCardBody, response: { 201: CardMetaSchema } } },
  async (req, reply) => {
    const meta = await cards.create(req.customerId!, req.body)
    await audit.log(req, 'card.create', meta.id, { last4: meta.last4 })
    reply.code(201).header('Location', `/v1/account/cards/${meta.id}`).send(meta)
  })

app.get('/v1/account/cards/:id', { schema: { response: { 200: CardMetaSchema } } },
  async (req, reply) => {
    const m = await cards.getMetadata(req.params.id, req.customerId!)
    if (!m) return reply.code(404).send(problem('not-found', 404))
    return m
  })

app.get('/v1/account/cards', async (req) =>
  cards.listMetadata(req.customerId!, req.query.cursor, req.query.limit ?? 50))

app.delete('/v1/account/cards/:id', async (req, reply) => {
  const ok = await cards.remove(req.params.id, req.customerId!)
  if (!ok) return reply.code(404).send(problem('not-found', 404))
  await audit.log(req, 'card.delete', req.params.id)
  reply.code(204).send()
})
```

`CardMetaSchema` defined with TypeBox; PAN/CVV fields are not declared so Fastify response validation strips them if leaked accidentally.

### Task 5: Tests `src/services/cards/cards.test.ts` (AC: leakage matrix)

- Create + GET round-trip via worker path: plaintext fields restored exactly.
- Encrypted blob is non-deterministic across two encrypts of the same plaintext (IV randomness check).
- Decrypting customer A's `card_number_encrypted` with customer B's DEK throws (cross-tenant isolation cryptographic check).
- Tampered blob (flip a byte in `ct`) → `decryptField` throws auth-tag-mismatch.
- `POST /v1/account/cards` → response body string-search asserts NONE of `card_number`, `cvv`, `_encrypted` substrings appear.
- `GET /v1/account/cards/:id` of another customer's card id → 404 (no leak).
- Audit log row written with `last4` only; full PAN never appears in any logger output (search the test process stdout).
- Luhn-invalid PAN → 400 `invalid_card_number`.

## Dev Notes

### PCI-DSS posture

We technically store PAN, so we are in PCI scope. The mitigations are: (1) PAN is encrypted at rest with a per-customer DEK derived through HSM-backed KMS; (2) PAN is never logged, never returned over the wire, never exported via `/v1/account/*`; (3) the only egress path is the worker→Adyen iframe submission, which itself encrypts client-side. Production deployment requires SAQ-D filing — that is a deployment/ops concern, not a code concern, and is documented in `docs/V3_MIGRATION_PLAN.md` Phase 5 security checkpoint. Long-term we should move to tokenized cards (Adyen vault) and store only Adyen tokens — that work is v3.x scope, not v3.0.

### Why per-field encryption

Per-row encryption (one ciphertext for the whole row) would be one IV/tag pair instead of four — saves ~80 bytes per card. We chose per-field because: (a) consistency with v2 Story 10.2 schema; (b) lets us decrypt only `holder_name` for display purposes if a future product feature wants it without exposing PAN; (c) limits blast radius of any decryption bug to a single field.

### Worker access pattern

`getPlaintextForWorker` is the single chokepoint. Code review checklist item: any caller of this function MUST be in `packages/api/src/workers/` or in a clearly-marked checkout pipeline path, never in a route handler. Linter rule (custom ESLint) flags imports of this function from `src/routes/`.

### Project Structure Notes

Files created:

- `packages/api/src/crypto/fieldCrypto.ts`
- `packages/api/src/services/cards/panUtils.ts`
- `packages/api/src/services/cards/cards.test.ts`
- `packages/api/src/db/cards.ts`
- `packages/api/src/routes/account/cards.ts`

Files modified:

- `packages/api/src/app.ts` — register `cardsRoutes` under `accountRoutes`
- `packages/api/src/services/audit.ts` — accept extra metadata param

### References

- PRD: `_bmad-output/planning-artifacts/prd.md` — FR75 (card vault multi-tenant), NFR32 (tenant isolation), NFR33 (GDPR vault)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — v3 §"Multi-Tenant Data Model" (`cards` table), §"Security Model" (Per-customer KMS DEK)
- v2 baseline: `_bmad-output/implementation-artifacts/stories/10-2-cards-csv-encrypted.md` — same crypto primitives, different key derivation (passphrase → KMS)
- Epics: `_bmad-output/planning-artifacts/epics.md` — Story 16.3 ("Card vault encryption — multi-tenant port of v2 Story 10.2")

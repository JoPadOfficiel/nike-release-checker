# Story 16.2: Per-Customer Encryption Key (Master KMS + HKDF Derivation)

Status: done

## Story

As the platform team,
I want every customer to have a unique 32-byte data encryption key (DEK) derived from a master KMS key plus a per-customer salt via HKDF,
so that card and credential ciphertexts are cryptographically isolated per customer (NFR32) and so a leaked DEK or a single-customer compromise cannot decrypt any other customer's data.

## Acceptance Criteria

**Given** a master key handle exists in the cloud KMS (AWS KMS / GCP Cloud KMS) referenced by `process.env.MASTER_KMS_KEY_ID`
**When** a new customer row is created
**Then** the system generates a 32-byte random `customer_salt`, derives `DEK = HKDF-SHA256(ikm = kms.decrypt(masterKeyId, fixedInfo='nike-bot-dek-v1'), salt = customer_salt, info = customer_id, length = 32)`, encrypts the DEK with the master key (`kms.encrypt`), and stores the wrapped blob in `customers.dek_wrapped`; the salt is stored in `customers.dek_salt`
**And** the plaintext DEK is NEVER persisted on disk, in a log, in an env var, or in any cache backed by disk
**And** at request time, a worker calls `getDek(customerId)` which: reads `dek_wrapped + dek_salt` from Postgres, calls `kms.decrypt` to unwrap, runs HKDF, returns a `Buffer`; the Buffer is held in memory only for the duration of the request and zeroed (`buf.fill(0)`) when released
**And** an in-process LRU cache (max 1 000 entries, TTL 5 min) is acceptable for performance; the cache is per-process memory only and is invalidated on `rotateDek(customerId)` (Story 16.5)
**And** a cross-customer probe test asserts `getDek(customerA) !== getDek(customerB)` and that re-deriving with the wrong salt fails to decrypt any ciphertext encrypted with the right one
**And** in `NODE_ENV=test`, a `LocalKmsStub` is wired (deterministic, no cloud call) so unit tests run offline; production wires `AwsKmsAdapter`

## Tasks / Subtasks

### Task 1: KMS adapter interface `src/crypto/kms.ts` (AC: pluggable provider)

```typescript
export interface KmsAdapter {
  encrypt(plaintext: Buffer): Promise<Buffer>      // returns wrapped blob
  decrypt(wrapped: Buffer): Promise<Buffer>        // returns plaintext
  generateDataKey(): Promise<{ plaintext: Buffer; wrapped: Buffer }> // 32-byte CSPRNG, wrapped by master
}
```

Implementations:

- `src/crypto/kms.aws.ts` — wraps `@aws-sdk/client-kms` `Encrypt`/`Decrypt`/`GenerateDataKey` (KeySpec=AES_256).
- `src/crypto/kms.local.ts` — for tests: `encrypt = aes-gcm with a fixed local 32-byte key`, `decrypt` reverses, `generateDataKey` returns `randomBytes(32)` wrapped.
- Factory `getKms()`: returns AWS in prod, Local in test (`NODE_ENV` switch).

### Task 2: DEK derivation `src/crypto/dek.ts` (AC: HKDF + zeroize)

```typescript
import { hkdfSync, randomBytes } from 'node:crypto'

const HKDF_INFO_PREFIX = Buffer.from('nike-bot-dek-v1:', 'utf8')

export async function provisionDek(customerId: string): Promise<{ dek_wrapped: Buffer; dek_salt: Buffer }> {
  const kms = getKms()
  // generate per-customer salt
  const dek_salt = randomBytes(32)
  // generate the IKM via KMS (single round-trip; the IKM is itself a wrapped data key)
  const { plaintext: ikm, wrapped: dek_wrapped_ikm } = await kms.generateDataKey()
  try {
    // derive the DEK (we never store the derived DEK; we re-derive on demand)
    // Storing the wrapped IKM gives us re-derivability without a second KMS call later
    return { dek_wrapped: dek_wrapped_ikm, dek_salt }
  } finally {
    ikm.fill(0)
  }
}

export async function deriveDek(dek_wrapped: Buffer, dek_salt: Buffer, customerId: string): Promise<Buffer> {
  const kms = getKms()
  const ikm = await kms.decrypt(dek_wrapped)
  try {
    const info = Buffer.concat([HKDF_INFO_PREFIX, Buffer.from(customerId, 'utf8')])
    const dek = Buffer.from(hkdfSync('sha256', ikm, dek_salt, info, 32))
    return dek
  } finally {
    ikm.fill(0)
  }
}
```

`Buffer.fill(0)` is best-effort zeroize (Node's buffer pool may keep a copy); accept the residual risk per architecture v3 Security Model threat-model exclusions.

### Task 3: Migration: add `dek_salt` to `customers` (AC: salt persistence)

Migration `0005_customer_dek_salt.sql`:

```sql
ALTER TABLE customers ADD COLUMN dek_salt BYTEA NOT NULL DEFAULT '\x00';
-- For pre-existing customers in dev DBs: backfill via the provision script (no production data yet)
ALTER TABLE customers ALTER COLUMN dek_salt DROP DEFAULT;
```

(Story 16.1 already created `customers.dek_wrapped`; this migration adds the companion salt column.)

### Task 4: `getDek` cache `src/crypto/dekCache.ts` (AC: LRU + invalidate)

```typescript
const cache = new LRUCache<string, Buffer>({
  max: 1000,
  ttl: 5 * 60 * 1000,
  dispose: (buf) => buf.fill(0),
})

export async function getDek(customerId: string): Promise<Buffer> {
  const hit = cache.get(customerId)
  if (hit) return hit
  const row = await db.customers.findById(customerId)
  if (!row) throw new Error('unknown customer')
  const dek = await deriveDek(row.dek_wrapped, row.dek_salt, customerId)
  cache.set(customerId, dek)
  return dek
}

export function invalidateDek(customerId: string) {
  cache.delete(customerId) // dispose() zeroes the buffer
}
```

`getDek` returns the cached buffer (do NOT clone — callers must NOT mutate it; document the contract).

### Task 5: Wire into customer creation (AC: provision-on-create)

Update `customers` repository `create()` to call `provisionDek(customerId)` and persist `dek_wrapped + dek_salt` in the same transaction as the customer row insert.

### Task 6: Tests `src/crypto/dek.test.ts` (AC: isolation, zeroize, cache)

- Provision two customers; `deriveDek(A_wrapped, A_salt, A_id)` and `deriveDek(B_wrapped, B_salt, B_id)` produce different 32-byte buffers.
- Encrypt a string with customer A's DEK; decrypting it with customer B's DEK throws AEAD auth error.
- Encrypt with `deriveDek(A_wrapped, B_salt, A_id)` (mixed inputs) → decrypt with the correct salt fails (proves salt is in the KDF input).
- `getDek` second call within TTL hits cache; `invalidateDek` forces re-derivation.
- LRU `dispose` is called when an entry is evicted; assert the buffer's bytes are zeroed.
- `KmsAdapter` swap: same provision/derive flow against `LocalKmsStub` and against an in-memory mock of `AwsKmsAdapter` (mocked SDK) yields equivalent results.

## Dev Notes

### Envelope encryption rationale

The cloud KMS master key never leaves the HSM. We wrap a per-customer 32-byte IKM (Initial Keying Material) with KMS once at customer creation; thereafter every read path decrypts the IKM via KMS, then HKDFs to the DEK locally. This keeps KMS round-trips at one per `getDek` cache miss (~one per customer per 5 min), which scales.

### Why HKDF on top of a KMS data key

Two reasons: (1) the salt + info parameters bind the derived DEK to the customer_id — even if two customers somehow ended up with the same wrapped IKM, their DEKs would differ; (2) HKDF lets us derive multiple sub-keys from the same IKM in the future (e.g., a separate DEK for cards vs. webhook secrets) without additional KMS calls — change the `info` string.

### Buffer zeroize is best-effort

Node's V8 GC and buffer pooling mean we can't guarantee zeroize. We accept this — the threat we defend against is at-rest disk dump, not RAM scraping. Per architecture v3 §"Threat model exclusions": "we do not defend against a customer leaking their own cards / Nike credentials. We do defend against a customer reading another customer's data."

### KMS provider abstraction

We use AWS today but the interface lets us swap to GCP, Vault, or self-hosted KMS by implementing the three-method `KmsAdapter`. Same interface used by the test stub keeps unit tests offline (CI doesn't need cloud creds).

### Project Structure Notes

Files created:

- `packages/api/src/crypto/kms.ts` — interface
- `packages/api/src/crypto/kms.aws.ts` — AWS adapter
- `packages/api/src/crypto/kms.local.ts` — test stub
- `packages/api/src/crypto/dek.ts` — provision + derive
- `packages/api/src/crypto/dekCache.ts` — LRU cache + invalidate
- `packages/api/src/crypto/dek.test.ts`
- `packages/api/migrations/0005_customer_dek_salt.sql`

Files modified:

- `packages/api/src/db/customers.ts` — `create()` now provisions DEK
- `packages/api/package.json` — add `@aws-sdk/client-kms`, `lru-cache`

### References

- PRD: `_bmad-output/planning-artifacts/prd.md` — FR75 (per-customer DEK), NFR32 (tenant isolation), NFR33 (DEK rotation)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — v3 §"Security Model" (Per-customer KMS DEK, envelope encryption), §"Multi-Tenant Data Model" (`customers.dek_wrapped`)
- Migration: `docs/V3_MIGRATION_PLAN.md` — Phase 5 deliverable "Per-customer DEK derivation via cloud KMS"
- Epics: `_bmad-output/planning-artifacts/epics.md` — Story 16.1 (DEK derivation per customer_id via KMS, wrapped by master key)

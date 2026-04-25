# Story 15.3: Per-Tier Rate Limiting (Redis Sliding Window)

Status: done

## Story

As the platform team,
I want a per-customer rate limit enforced at the gateway based on the customer's subscription tier (Solo 60 req/min, Pro 600 req/min, Enterprise unlimited),
so that a single customer cannot exhaust shared worker capacity and so the platform can monetize tiered throughput.

## Acceptance Criteria

**Given** customer `c_123` has `tier="solo"` and has already issued 60 successful requests in the past 60 seconds
**When** the customer sends a 61st request within that window
**Then** the gateway responds HTTP 429 RFC 9457 problem-detail `{ type: ".../rate-limited", title: "Too Many Requests", status: 429, detail: "Solo tier allows 60 req/min" }`
**And** the response includes headers `Retry-After: <seconds>`, `X-RateLimit-Limit: 60`, `X-RateLimit-Remaining: 0`, `X-RateLimit-Reset: <unix-epoch-when-window-rolls>`
**And** every successful response (2xx, 4xx other than 429) also includes the three `X-RateLimit-*` headers reflecting current usage (NFR38)
**And** the limit is `tier=pro → 600/min`, `tier=enterprise → unlimited` (no headers, no enforcement)
**And** the counter is implemented as a Redis sliding-window log (sorted set keyed by `ratelimit:c_123:<minute>`); accuracy is exact within the 60-second window
**And** if Redis is unreachable, the middleware fails OPEN (allow + log warning) — availability beats accuracy (NFR36)

## Tasks / Subtasks

### Task 1: Redis client wiring (AC: shared connection)

- Add dep `ioredis@^5`. Create `packages/api/src/db/redis.ts` exporting a singleton `Redis` client. URL from `process.env.REDIS_URL` (default `redis://localhost:6379`).
- On startup, ping Redis once; log success / failure but do not crash on failure (fail-open contract).

### Task 2: Tier resolver (AC: read tier from `customers` table)

- `src/services/customerTier.ts`: `getTier(customerId): Promise<'solo' | 'pro' | 'enterprise'>`. Reads `customers.tier`. Cache in-memory (LRU, max 10 000 entries, TTL 60 s) — tier changes are rare and a 60 s lag is acceptable.

### Task 3: Sliding-window middleware `src/plugins/rateLimit.ts` (AC: 429, headers, fail-open)

```typescript
const LIMITS = { solo: 60, pro: 600, enterprise: Infinity } as const
const WINDOW_MS = 60_000

export async function rateLimitPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.customerId) return // /healthz, /docs
    const tier = await getTier(req.customerId)
    const limit = LIMITS[tier]
    if (limit === Infinity) return
    const key = `ratelimit:${req.customerId}`
    const now = Date.now()
    const cutoff = now - WINDOW_MS
    let count: number
    try {
      const pipe = redis.multi()
      pipe.zremrangebyscore(key, 0, cutoff)
      pipe.zadd(key, now, `${now}-${randomUUID()}`)
      pipe.zcard(key)
      pipe.pexpire(key, WINDOW_MS)
      const res = await pipe.exec()
      count = res?.[2]?.[1] as number
    } catch (err) {
      req.log.warn({ err: String(err) }, 'rate_limit_redis_unavailable')
      return // fail open
    }
    const remaining = Math.max(0, limit - count)
    const reset = Math.ceil((now + WINDOW_MS) / 1000)
    reply.header('X-RateLimit-Limit', String(limit))
    reply.header('X-RateLimit-Remaining', String(remaining))
    reply.header('X-RateLimit-Reset', String(reset))
    if (count > limit) {
      const retryAfter = Math.ceil(WINDOW_MS / 1000)
      reply.header('Retry-After', String(retryAfter))
      return reply.code(429).send(problem('rate-limited', 429, `${tier} tier allows ${limit} req/min`))
    }
  })
}
```

### Task 4: Register middleware after auth (AC: enforced post-auth)

In `app.ts`, plugin order: `requestId → auth → rateLimit → routes`. Anonymous routes skip both auth and rate-limit (no `customerId` to key on).

### Task 5: Tests `src/plugins/rateLimit.test.ts` (AC: behaviour matrix)

Use `ioredis-mock` for in-memory Redis:

- Solo customer: 60 requests succeed, 61st returns 429 with `Retry-After`.
- All responses include the three `X-RateLimit-*` headers.
- Pro customer: 600 succeed, 601 returns 429.
- Enterprise customer: 10 000 requests succeed, no headers emitted, no 429.
- Window roll: at `now + 60 001 ms` the counter resets (mock `Date.now`).
- Redis throws on `multi.exec()` → request still succeeds (fail-open), warning logged once.

## Dev Notes

### Sliding-window choice

Fixed-window counters (e.g., `INCR ratelimit:c_123:202604241200`) are 50 % cheaper but allow burst-at-boundary (e.g., 60 req at 12:00:59 + 60 req at 12:01:00 = 120 req in one second). Sorted-set sliding-window is exact at the cost of one extra `ZREMRANGEBYSCORE` per request — acceptable for the volumes we expect at v3 launch (< 100 RPS aggregate).

### Why fail-open

Per NFR36, REST API availability ≥ 99.5 % monthly. Redis going down for 5 min would burn 0.0017 % of the monthly budget if we fail-open and 100 % of API calls if we fail-closed. The trade-off is documented and the warning log line is alertable so ops sees the outage.

### Header name precedence

GitHub uses `X-RateLimit-*`, Stripe uses no headers, Twitter uses `x-rate-limit-*`. Our PRD (NFR38) explicitly mandates `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` — this matches GitHub's convention which most SDK ecosystems already understand.

### Project Structure Notes

Files created:

- `packages/api/src/db/redis.ts`
- `packages/api/src/services/customerTier.ts`
- `packages/api/src/plugins/rateLimit.ts`
- `packages/api/src/plugins/rateLimit.test.ts`

Files modified:

- `packages/api/src/app.ts` — register `rateLimitPlugin` after `authPlugin`
- `packages/api/package.json` — add `ioredis`, `ioredis-mock` (devDep)

### References

- PRD: `_bmad-output/planning-artifacts/prd.md` — FR73 (per-tier rate limit), NFR38 (`X-RateLimit-*` headers)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — v3 §"Component Responsibilities" (API Gateway → NFR36, NFR38)
- Migration: `docs/V3_MIGRATION_PLAN.md` — Phase 5 deliverable "Per-tier rate-limiting middleware"

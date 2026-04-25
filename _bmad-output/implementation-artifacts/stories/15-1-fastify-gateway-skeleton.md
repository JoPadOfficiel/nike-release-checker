# Story 15.1: Fastify Gateway Skeleton (`packages/api`)

Status: done

## Story

As the platform team,
I want a Fastify HTTP server scaffolded at `packages/api/` with health, request-id, structured logging and OpenAPI auto-doc,
so that every subsequent v3 REST story has a uniform place to register routes, middleware and schemas.

## Acceptance Criteria

**Given** a fresh checkout of the monorepo
**When** I run `npm run -w @nike-release-checker/api dev`
**Then** a Fastify server listens on `process.env.PORT` (default `8080`) and `GET /healthz` returns `{ status: "ok", uptime, version }` with HTTP 200
**And** every request gets a `request-id` (UUID v4) injected into the `req.id` context and echoed back as `X-Request-Id` response header (incoming `X-Request-Id` is preserved if valid)
**And** every request emits a structured NDJSON log line `{ level, ts, request_id, method, path, status, duration_ms, customer_id? }` via the existing logger pattern (Epic 1)
**And** `GET /docs/openapi.json` returns a valid OpenAPI 3.1 document auto-generated from registered route schemas (initially: only `/healthz`)
**And** unhandled errors are caught by a global error handler returning RFC 9457 problem-detail JSON `{ type, title, status, detail, request_id }` and never leak stack traces in production mode
**And** the server gracefully shuts down on `SIGTERM` / `SIGINT` (drain in-flight requests, max 30 s)

## Tasks / Subtasks

### Task 1: Scaffold `packages/api/` workspace (AC: package boots)

- Create `packages/api/package.json` with `"name": "@nike-release-checker/api"`, `"type": "module"`, scripts `dev` (`tsx watch src/index.ts`), `build` (`tsc -p tsconfig.build.json`), `start` (`node dist/index.js`), `test` (`node --test`).
- Add deps: `fastify@^5`, `@fastify/swagger`, `@fastify/swagger-ui`, `pino`, `uuid`. Pin to exact minor.
- Add devDeps: `@types/node`, `tsx`, `typescript@5.9.3` (match monorepo).
- Register the workspace in root `package.json` `workspaces` array.
- Mirror `packages/bot/tsconfig.json` (NodeNext ESM, strict).

### Task 2: Implement bootstrap `src/index.ts` (AC: server listens, graceful shutdown)

```typescript
import Fastify from 'fastify'
import { buildApp } from './app.js'

const port = Number(process.env.PORT ?? 8080)
const app = await buildApp()
await app.listen({ port, host: '0.0.0.0' })

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close()
    process.exit(0)
  })
}
```

`buildApp()` lives in `src/app.ts` and returns a `FastifyInstance` (testable in isolation).

### Task 3: Request-ID + structured logging middleware (AC: request-id echo, NDJSON logs)

Create `src/plugins/requestId.ts`:

- `onRequest` hook: read incoming `X-Request-Id` header; if absent or not RFC4122 UUID, generate `randomUUID()`. Set `req.id`.
- `onSend` hook: set response header `X-Request-Id` to `req.id`.
- Pino logger configured with `genReqId: () => existing or generated`, `serializers.req` redacting `authorization` header, `serializers.res` capturing `statusCode`. Output: NDJSON to stdout.

### Task 4: OpenAPI 3.1 auto-doc (AC: `/docs/openapi.json` returns valid spec)

- Register `@fastify/swagger` with `openapi: { openapi: '3.1.0', info: { title: 'Nike Bot API', version: '0.1.0' } }`.
- Register `@fastify/swagger-ui` at `/docs` (Swagger UI HTML).
- Expose raw spec at `/docs/openapi.json` via `app.swagger()`.

### Task 5: Health route + global error handler (AC: `/healthz`, RFC 9457 errors)

- `src/routes/health.ts` registers `GET /healthz` with response schema `{ status, uptime, version }`. `version` reads `process.env.APP_VERSION ?? package.json#version`.
- `src/plugins/errorHandler.ts` sets `app.setErrorHandler` to convert any thrown error into RFC 9457 problem-detail JSON. In `NODE_ENV=production`, `detail` and `stack` are omitted; only `title` and `status` survive.

### Task 6: Tests (AC: end-to-end smoke)

Create `src/app.test.ts` using `node --test` + Fastify's `inject()`:

- `GET /healthz` → 200, body has `status: "ok"`.
- `GET /healthz` with custom `X-Request-Id: <uuid>` → response echoes the same UUID.
- `GET /healthz` with invalid `X-Request-Id` → response uses a fresh UUID.
- `GET /docs/openapi.json` → 200, body parses as JSON, `openapi` field starts with `3.1`.
- A route that throws → 500 with RFC 9457 shape, no stack in prod mode.

## Dev Notes

### Why Fastify

Per architecture v3 §"Component Responsibilities" and PRD FR72, the gateway is "Fastify or Express". Fastify wins for: built-in JSON-schema validation, native OpenAPI plugin, lower per-request overhead (matters for NFR36 99.5 % availability budget), and request-scoped logger child via Pino which slots straight into the v1/v2 NDJSON convention.

### Logger continuity

The v1/v2 bot already emits NDJSON via its own logger. The API service uses Pino (also NDJSON) so log aggregation downstream (Loki, Datadog, etc.) treats both the same. The only mandatory new field for v3 is `customer_id`, added by the auth middleware in Story 15.2.

### Project Structure Notes

Files created (all NEW — `packages/api/` does not yet exist):

- `packages/api/package.json`
- `packages/api/tsconfig.json`, `packages/api/tsconfig.build.json`
- `packages/api/src/index.ts` — process bootstrap
- `packages/api/src/app.ts` — `buildApp()` factory
- `packages/api/src/plugins/requestId.ts`
- `packages/api/src/plugins/errorHandler.ts`
- `packages/api/src/routes/health.ts`
- `packages/api/src/app.test.ts`

Files modified:

- Root `package.json` — add `packages/api` to workspaces.

### References

- PRD: `_bmad-output/planning-artifacts/prd.md` — FR72 (REST surface), NFR36 (≥ 99.5 % availability)
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — v3 §"System Topology", §"Component Responsibilities" (API Gateway row)
- Migration: `docs/V3_MIGRATION_PLAN.md` — Phase 4 deliverables
- Epics: `_bmad-output/planning-artifacts/epics.md` — Story 15.1

# Story 17.4: WebSocket Event Stream for Drop Progress

Status: backlog

## Story

As a SaaS customer integrating the API,
I want a WebSocket endpoint at `/v1/drops/:id/events` that streams drop lifecycle and per-run events in real time,
So that I can build a live dashboard or trigger downstream automations without polling. (FR72, FR74, NFR37)

## Acceptance Criteria

**Given** a customer holds a valid API key and owns drop `:id`
**When** the customer opens a WebSocket to `wss://api.<our-domain>/v1/drops/:id/events?api_key=...`
**Then** the server authenticates the bearer token (query string OR initial JSON message `{ "type": "auth", "token": "..." }`), verifies the customer owns the drop (404 if mismatch, 401 if invalid key), and accepts the connection
**And** the server immediately replays the current drop state as event `drop.snapshot` (drop fields + per-run states) so the client doesn't need to call `GET /v1/drops/:id` separately
**And** subsequent events stream as JSON lines: `drop.armed`, `drop.activated`, `drop.completed`, `drop.cancelled`, `account.copping`, `account.cop`, `account.fail`, `account.skipped` — each with `{ event, drop_id, run_id?, account_id?, timestamp, data }`
**And** the stream is **backpressure-aware** — if the client's send buffer exceeds 1 MB, the server drops the connection with code `1013` (try again later) instead of accumulating unbounded memory
**And** ping/pong heartbeat every 30 s; missed pong → close connection
**And** integration test verifies: auth via query string, auth via initial message, snapshot replay, live event delivery, ownership 404, buffer overflow disconnect

## Tasks / Subtasks

### Task 1: WS route registration with `@fastify/websocket` (AC: endpoint exists)

- **File:** `packages/api/src/routes/dropEvents.ts` (new)
- Register: `fastify.register(websocket); fastify.get('/v1/drops/:id/events', { websocket: true }, handler)`
- Inside handler: extract `api_key` from query string OR await first message for `{type:'auth',token:...}` (1 s timeout, then close)
- Resolve customer_id from key → `SELECT id, customer_id FROM drops WHERE id = $1` → if no row OR `customer_id !== authedCustomerId` → close with code `4404` (custom: not found / not yours)

### Task 2: Snapshot replay on connect (AC: drop.snapshot event)

- **File:** `packages/api/src/routes/dropEvents.ts` (continue)
- After auth + ownership check:
  ```ts
  const drop = await dropRepo.findById(dropId)
  const runs = await dropRunRepo.listByDrop(dropId)
  socket.send(JSON.stringify({
    event: 'drop.snapshot',
    drop_id: dropId,
    timestamp: new Date().toISOString(),
    data: { drop, runs },
  }))
  ```

### Task 3: Internal event bus subscription (AC: live events forwarded)

- **File:** `packages/api/src/events/dropEventBus.ts` (new)
- Lightweight in-process `EventEmitter` keyed by `drop_id`:
  ```ts
  export interface DropEventBus {
    publish(dropId: string, event: DropEvent): void
    subscribe(dropId: string, cb: (event: DropEvent) => void): () => void
  }
  ```
- `dropRepository.transitionState`, `dropRunRepository.finalize`, and `dropRunRepository.leaseNext` all call `bus.publish(dropId, ...)` after writing to the DB
- WS handler subscribes on connect, forwards every event to `socket.send(JSON.stringify(event))`, unsubscribes on close
- For multi-instance deployments (v3.2+) — replace in-process EventEmitter with Redis pub/sub. Interface stays the same; only the implementation swaps.

### Task 4: Backpressure handling (AC: drop connection on > 1 MB buffer)

- **File:** `packages/api/src/routes/dropEvents.ts` (continue)
- Check `socket.bufferedAmount` before each `send()`:
  ```ts
  if (socket.bufferedAmount > 1_048_576) {
    logger.warn({ dropId, bufferedBytes: socket.bufferedAmount }, 'ws.backpressure.disconnect')
    socket.close(1013, 'try again later')
    return
  }
  ```
- Buffered amount > 1 MB indicates the client is too slow to consume — protect server memory

### Task 5: Heartbeat ping/pong (AC: 30 s ping, missed pong → close)

- **File:** `packages/api/src/routes/dropEvents.ts` (continue)
- `setInterval(() => socket.ping(), 30_000)` per connection
- Track `lastPongAt`; on `socket.on('pong', () => lastPongAt = Date.now())`
- Every 30 s tick → if `Date.now() - lastPongAt > 60_000` → `socket.close(1011, 'pong timeout')` and clear interval
- Cleanup all timers + bus subscription on `socket.on('close', ...)`

### Task 6: Tests (AC: auth, snapshot, live events, 404, buffer overflow)

- **File:** `packages/api/src/routes/dropEvents.test.ts` (new, integration)
  - Use `ws` library client → connect with `?api_key=...` → assert receives `drop.snapshot` first
  - Connect without query-string token → send `{type:'auth',token:...}` → assert connection upgraded
  - Connect to a drop owned by a different customer → assert close code 4404
  - Connect to valid drop → trigger `dropRunRepo.finalize(...,'COP',...)` in another transaction → assert client receives `account.cop` event within 100 ms (NFR37: 30 s SLA but test for 100 ms in process)
  - Mock backpressure by stubbing `socket.bufferedAmount = 2_000_000` → assert close code 1013

### Task 7: Event taxonomy documentation

- **File:** `packages/api/src/events/dropEventTaxonomy.ts` (new)
- Exported TS types so OpenAPI generator (Story 15.6) can derive the published webhook + WS event schemas:
  ```ts
  export type DropEvent =
    | { event: 'drop.snapshot'; drop_id: string; timestamp: string; data: { drop: Drop; runs: DropRun[] } }
    | { event: 'drop.armed'; drop_id: string; timestamp: string; data: { fire_at: string } }
    | { event: 'drop.activated'; drop_id: string; timestamp: string; data: { run_count: number } }
    | { event: 'drop.completed'; drop_id: string; timestamp: string; data: { cops: number; fails: number; skipped: number } }
    | { event: 'drop.cancelled'; drop_id: string; timestamp: string; data: { reason: string } }
    | { event: 'account.copping'; drop_id: string; run_id: string; account_id: string; timestamp: string; data: { worker_id: string; attempt: number } }
    | { event: 'account.cop'; drop_id: string; run_id: string; account_id: string; timestamp: string; data: { order_number: string; duration_ms: number } }
    | { event: 'account.fail'; drop_id: string; run_id: string; account_id: string; timestamp: string; data: { classification: string; reason: string; attempt: number; will_retry: boolean } }
    | { event: 'account.skipped'; drop_id: string; run_id: string; account_id: string; timestamp: string; data: { reason: string } }
  ```

## Dev Notes

### WebSocket vs. Server-Sent Events vs. Long Polling

Chose WebSocket because:
- Bidirectional auth message support (query-string token can leak in proxy logs; initial message is preferred for production)
- Standard browser support without polyfills
- Lower per-event overhead than SSE for high-frequency events (50 accounts × multiple events)

SSE was a reasonable alternative but lacks the auth message pattern.

### Backpressure Strategy

Closing on > 1 MB buffered is aggressive but necessary for a multi-tenant service. A slow client should not be allowed to consume server memory indefinitely — they reconnect and replay via `drop.snapshot`. The 1 MB threshold accommodates ~10k events of average size 100 bytes, which is far more than any single drop produces (50 accounts × ~10 events = 500 events).

### Event Bus — In-Process vs. Distributed

v3.1 uses in-process `EventEmitter`. This works because Phase 5 starts with a single API node + worker pool dispatching back to the same node. When the API horizontally scales (v3.2+), the bus must move to Redis pub/sub or NATS so any API node can fan out events to clients connected to any other node. Interface (`publish`/`subscribe`) is designed to be implementation-agnostic.

### Webhook Parity (Epic 15 Story 15.5)

The same event taxonomy feeds both the WS stream (this story) and the webhook delivery worker (Story 15.5). Customers choose: pull via WS (real-time, requires connection) or push via webhook (best-effort, requires public endpoint). Both consume from the same `DropEventBus`.

### Auth via Query String — Security Note

Browser `WebSocket` API does not support custom headers. So query-string auth is the pragmatic option. Mitigations:
- TLS-only (`wss://`) — token never on wire in plaintext
- Token logged at API gateway must be redacted (regex strip `api_key=...`)
- Customers can use the initial-message pattern from server-side clients (Node, Python) to avoid the query string entirely

### Project Structure Notes

New files:
```
packages/api/src/routes/dropEvents.ts
packages/api/src/routes/dropEvents.test.ts
packages/api/src/events/dropEventBus.ts
packages/api/src/events/dropEventTaxonomy.ts
```

Modified:
- `packages/api/src/drops/dropRepository.ts` — call `bus.publish` after each transition
- `packages/api/src/drops/dropRunRepository.ts` — call `bus.publish` after lease + finalize

### References

- Epics: Story 17.4 derived from skeleton (was implicit in Epic 17 promotion)
- PRD: FR72 (REST surface includes WS for live drops), FR74 (event delivery), NFR37 (30 s delivery SLA)
- Architecture: Worker pool topology — events flow worker → bus → WS client
- Depends on: Story 17.1 (drop state transitions emit events), Story 17.3 (run lifecycle emits events)
- Parallel with: Epic 15 Story 15.5 (webhook delivery — same event source)

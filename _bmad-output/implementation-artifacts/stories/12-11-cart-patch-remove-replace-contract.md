# Story 12.11: Nike PATCH cart op:remove and op:replace contract discovery

Status: done

## Story

As a v3 SaaS bot operator,
I want `NikeCartApi.removeItem()` and `NikeCartApi.setQuantity()` to send the exact JSON Patch body shape that Nike's cart API accepts,
So that item removal and quantity updates return 200 OK instead of 400 FIELD_INVALID.

## Background

Story 12.10 delivered the `page.evaluate(() => fetch())` transport pivot. Live tests confirmed:
- `initVisitor` → 200 OK
- `getCart` → 200 OK
- `addItem` → 200 OK

But `removeItem` and `setQuantity` both returned 400. The POC script needed to discover the correct contract through systematic live testing against Nike FR.

## Discovery POC

Script: `packages/bot/scripts/poc-cart-mutations.ts` (12 remove variants) + `packages/bot/scripts/poc-setquantity-round2.ts` (11 setQuantity variants)

Account: `candid_audio`, PDP: `https://www.nike.com/fr/t/chaussure-air-force-1-07-pour-ojDkV4tL/CW2288-111`

Results saved in: `packages/bot/scripts/poc-cart-mutations-results.json`

## Acceptance Criteria

**Given** a cart with at least one item
**When** `removeItem(itemId)` is called
**Then** Nike returns 200 OK and the item is no longer in the cart

**Given** a cart with at least one item
**When** `setQuantity(itemId, skuId, newQty)` is called
**Then** Nike returns 200 OK and the item quantity is updated

## Discovered Contract — removeItem

Nike's cart API uses a **non-standard JSON Patch shape**. The `path` targets the collection, and `value` carries the item selector:

```json
[{ "op": "remove", "path": "/items", "value": { "id": "<itemId>" } }]
```

Live capture: `PATCH https://api.nike.com/buy/carts/v2/FR/NIKE/NIKECOM?modifiers=VALIDATELIMITS,VALIDATEAVAILABILITY`

Response: `200 OK` — cart returned with `"items": []` (item removed). Independently verified via subsequent `GET /buy/carts/v2/FR/NIKE/NIKECOM`.

### All Rejected removeItem Variants (12 tested)

| Payload | Response |
|---|---|
| `[{op:remove, path:/items/{id}}]` (pure RFC 6902) | 400 MISSING_REQUIRED (value required) |
| `[{op:remove, path:/items/{id}, value:null}]` | 400 FIELD_INVALID |
| `[{op:remove, path:/items/{id}, value:""}]` | 400 FIELD_INVALID |
| `[{op:remove, path:/items/{id}, value:{}}]` | 400 FIELD_INVALID |
| `[{op:remove, path:/items/{id}, value:{...fullItem}}]` | 400 FIELD_INVALID |
| `[{op:remove, path:/items, value:"<id>"}]` (string) | 400 FIELD_INVALID |
| `[{op:remove, path:/items, value:["<id>"]}]` (array) | 400 FIELD_INVALID |
| `[{op:remove, path:/items/0}]` (by index) | 400 MISSING_REQUIRED |
| `[{op:remove, path:/items/0, value:null}]` | 400 FIELD_INVALID |
| `[{op:remove, path:/items/{id}, value:{itemId}}]` | 400 FIELD_INVALID |
| `[{op:replace, path:/items, value:[]}]` | 400 FIELD_INVALID |
| `[{op:remove, path:/items, value:[id]}]` | 400 FIELD_INVALID |

## Discovered Contract — setQuantity

```json
[{ "op": "replace", "path": "/items", "value": { "id": "<itemId>", "skuId": "<skuId>", "quantity": <N> } }]
```

`skuId` is **required** — Nike returns `400 MISSING_REQUIRED` if omitted.

This required a signature change: `setQuantity(itemId, skuId, quantity)` (was `setQuantity(itemId, quantity)`).

### All Rejected setQuantity Variants (11 tested)

| Payload | Response |
|---|---|
| `[{op:replace, path:/items/{id}/quantity, value:2}]` | 400 FIELD_INVALID |
| `[{op:replace, path:/items/{id}/quantity, value:"2"}]` | 400 FIELD_INVALID |
| `[{op:replace, path:/items/{id}, value:{quantity:2}}]` | 400 FIELD_INVALID |
| `[{op:replace, path:/items/{id}, value:{...fullItem, quantity:2}}]` | 400 FIELD_INVALID |
| `[{op:replace, path:/items, value:{id,quantity}}]` (no skuId) | 400 MISSING_REQUIRED (skuId) |
| `[{op:merge, path:/items/{id}, value:{quantity:2}}]` | 400 FIELD_INVALID |
| `[{op:merge, path:/items, value:{id,quantity}}]` | 400 FIELD_INVALID |
| `[{op:update, path:/items/{id}, value:{quantity:2}}]` | 400 FIELD_INVALID |
| `[{op:patch, path:/items/{id}, value:{quantity:2}}]` | 400 FIELD_INVALID |
| `[{op:add, path:/items/{id}, value:{quantity:2}}]` | 400 FIELD_INVALID |
| `[{op:merge, path:/, value:{items:[{id,quantity}]}}]` | 400 MISSING_REQUIRED (visitorId) |

### Alternatives that also return 200 but NOT used

- `[{op:add, path:/items, value:{skuId, quantity, itemData}}]` — 200 OK but acts as *upsert* (may create new item if quantity limit reached), does not use existing item ID
- `[remove + add]` two-op transaction — 200 OK but creates new item ID each time (not stable)

The `op:replace, path:/items, value:{id,skuId,quantity}` is the most correct: it updates the existing item in-place, preserving the item ID.

## Implementation Changes

### `packages/bot/src/checkout/api/cartApi.ts`

- `removeItem(itemId)`: changed from `op:remove path:/items/{id} value:null` to `op:remove path:/items value:{id}`
- `setQuantity(itemId, skuId, quantity)`: changed signature (added `skuId` param), changed from `op:replace path:/items/{id}/quantity value:N` to `op:replace path:/items value:{id,skuId,quantity}`
- Removed `escapeJsonPointer()` helper (no longer needed — item IDs go in `value`, not `path`)

### `packages/bot/src/checkout/api/cartApi.test.ts`

Updated 7 tests for `removeItem` and `setQuantity` suites to match new contracts. 44/44 tests pass.

## Key Insight

Nike's cart API uses a **reversed JSON Patch convention** for item-level mutations:
- RFC 6902 standard: `path` encodes the selector (e.g. `/items/abc123`), no selector in `value`
- Nike's API: `path` targets the collection (`/items`), `value` carries `{id}` as selector

This pattern is consistent across both `removeItem` and `setQuantity`. The `op:add` that works for `addItem` also targets `/items` with a value object — Nike's entire cart mutation API follows this collection-level pattern.

// Drop event taxonomy — Story 17.4
// Canonical TypeScript union for all WebSocket / webhook drop events.
// The OpenAPI generator (Story 15.6) derives published schemas from this file.

import type { DropRow } from '../db/drops.ts'
import type { DropRun } from '../drops/dropRunRepository.ts'

export type DropEvent =
  | {
      event: 'drop.snapshot'
      drop_id: string
      timestamp: string
      data: { drop: DropRow; runs: DropRun[] }
    }
  | {
      event: 'drop.armed'
      drop_id: string
      timestamp: string
      data: { fire_at: string }
    }
  | {
      event: 'drop.activated'
      drop_id: string
      timestamp: string
      data: { run_count: number }
    }
  | {
      event: 'drop.completed'
      drop_id: string
      timestamp: string
      data: { cops: number; fails: number; skipped: number }
    }
  | {
      event: 'drop.cancelled'
      drop_id: string
      timestamp: string
      data: { reason: string }
    }
  | {
      event: 'account.copping'
      drop_id: string
      run_id: string
      account_id: string
      timestamp: string
      data: { worker_id: string; attempt: number }
    }
  | {
      event: 'account.cop'
      drop_id: string
      run_id: string
      account_id: string
      timestamp: string
      data: { order_number: string; duration_ms: number }
    }
  | {
      event: 'account.fail'
      drop_id: string
      run_id: string
      account_id: string
      timestamp: string
      data: {
        classification: string
        reason: string
        attempt: number
        will_retry: boolean
      }
    }
  | {
      event: 'account.skipped'
      drop_id: string
      run_id: string
      account_id: string
      timestamp: string
      data: { reason: string }
    }

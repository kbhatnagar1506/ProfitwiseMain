/**
 * Canonical AR/AP status helpers.
 *
 * This is the SINGLE source of truth for:
 *   1. statusFromOutstanding() — derives 'open' | 'partially_paid' | 'paid' from numbers
 *   2. writeStatusChange()     — atomically updates cash_events AND writes to ar_ap_status_log
 *
 * All 6 backend write paths import from here. No other file may hardcode status strings
 * or update cash_events.status without going through writeStatusChange().
 *
 * OVERDUE NOTE: 'overdue' is NOT stored in cash_events.status. It is a time-relative
 * concept computed at query time:
 *   CASE WHEN display_status = 'open' AND expected_date < CURRENT_DATE THEN 'overdue'
 *        ELSE display_status END
 */

import type { PoolClient } from "pg"

/** Tolerance for floating-point rounding — treats < $0.01 as fully paid. */
export const EPS = 0.01

export type ArApStatus = "open" | "partially_paid" | "paid"

export type StatusChangeTrigger =
  | "user"
  | "waterfall"
  | "llm"
  | "qbo_sync"
  | "waterfall_unmatch"
  | "mark_paid"
  | "mark_unpaid"
  | "apply_match"
  | "split_match"
  | "unmatch"

/**
 * Derive the canonical status string from outstanding amount and original amount.
 * Uses EPS tolerance so $0.009 rounds to 'paid', preventing infinite "Open" states
 * from floating-point arithmetic.
 */
export function statusFromOutstanding(
  outstanding: number,
  originalAmount: number
): ArApStatus {
  if (outstanding <= EPS) return "paid"
  if (originalAmount <= EPS) return "paid"          // $0 events are always paid
  if (outstanding < originalAmount - EPS) return "partially_paid"
  return "open"
}

export interface WriteStatusChangeOpts {
  cashEventId: string
  userId: string
  fromStatus: string
  toStatus: string
  fromOutstanding: number
  toOutstanding: number
  triggeredBy: StatusChangeTrigger
  attributionId?: string | null
  /** When true, sets last_reconciled_at = NOW() regardless of toStatus. */
  forceReconciledAt?: boolean
}

/**
 * Atomically:
 *   1. Updates cash_events (outstanding_amount, status, last_reconciled_at, updated_at)
 *   2. Inserts a row into ar_ap_status_log for full audit trail
 *
 * Must be called within a database transaction (client passed in).
 * Never call this outside a withTransaction() block.
 */
export async function writeStatusChange(
  client: PoolClient,
  opts: WriteStatusChangeOpts
): Promise<void> {
  await client.query(
    `UPDATE cash_events
     SET outstanding_amount = $1,
         status             = $2,
         last_reconciled_at = CASE
           WHEN $2 IN ('paid', 'partially_paid') OR $5 = true THEN NOW()
           ELSE last_reconciled_at
         END,
         updated_at = NOW()
     WHERE id = $3 AND user_id = $4`,
    [
      opts.toOutstanding,
      opts.toStatus,
      opts.cashEventId,
      opts.userId,
      opts.forceReconciledAt ?? false,
    ]
  )

  if (opts.fromStatus !== opts.toStatus || Math.abs(opts.fromOutstanding - opts.toOutstanding) > EPS) {
    await client.query(
      `INSERT INTO ar_ap_status_log
       (cash_event_id, user_id, from_status, to_status,
        from_outstanding, to_outstanding, triggered_by, attribution_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        opts.cashEventId,
        opts.userId,
        opts.fromStatus,
        opts.toStatus,
        opts.fromOutstanding,
        opts.toOutstanding,
        opts.triggeredBy,
        opts.attributionId ?? null,
      ]
    )
  }
}

/**
 * Read the current status row from cash_events WITH a row-level lock.
 * Use this inside a transaction before any UPDATE to prevent race conditions.
 *
 * Returns null if no matching row found.
 */
export async function lockCashEvent(
  client: PoolClient,
  cashEventId: string,
  userId: string
): Promise<{
  id: string
  status: ArApStatus
  outstanding_amount: string
  amount: string
} | null> {
  const result = await client.query<{
    id: string
    status: ArApStatus
    outstanding_amount: string
    amount: string
  }>(
    `SELECT id, status, outstanding_amount, amount
     FROM cash_events
     WHERE id = $1 AND user_id = $2
     FOR UPDATE`,
    [cashEventId, userId]
  )
  return result.rows[0] ?? null
}

/**
 * Read and lock a cash_event by entity_id + event_type (used in apply-match).
 * Returns the first matching row, locked for update.
 */
export async function lockCashEventByEntity(
  client: PoolClient,
  userId: string,
  entityId: string,
  eventType: "ar" | "ap"
): Promise<{
  id: string
  status: ArApStatus
  outstanding_amount: string
  amount: string
} | null> {
  const result = await client.query<{
    id: string
    status: ArApStatus
    outstanding_amount: string
    amount: string
  }>(
    `SELECT id, status, outstanding_amount, amount
     FROM cash_events
     WHERE user_id = $1 AND entity_id = $2 AND event_type = $3
     FOR UPDATE
     LIMIT 1`,
    [userId, entityId, eventType]
  )
  return result.rows[0] ?? null
}

import { query, runInTransaction } from "./db"
import type { Stage4Suggestion } from "./reconciliation-stage4-suggestions"

export type ReviewQueueItem = {
  id: string
  movement_id: string
  remaining_cash: number
  status: "pending" | "resolved" | "rejected"
  candidate_payload: unknown
  resolution: {
    suggestions?: Stage4Suggestion[]
    reason?: string
    resolved_at?: string
    rejected_at?: string
  }
  created_at: string
  updated_at: string
}

export type ReviewQueueSummary = {
  pending_count: number
  pending_amount: number
  resolved_count: number
  rejected_count: number
  suggested_count: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function suggestionsFromResolution(resolution: unknown): Stage4Suggestion[] {
  if (!resolution || typeof resolution !== "object") return []
  const maybe = (resolution as Record<string, unknown>).suggestions
  if (!Array.isArray(maybe)) return []
  return maybe as Stage4Suggestion[]
}

export function isTerminalReviewQueueStatus(status: "pending" | "resolved" | "rejected"): boolean {
  return status !== "pending"
}

export async function fetchReviewQueue(userId: string, includeRecent = true): Promise<{ summary: ReviewQueueSummary; items: ReviewQueueItem[] }> {
  const { rows: summaryRows } = await query<{
    pending_count: string
    pending_amount: string
    resolved_count: string
    rejected_count: string
    suggested_count: string
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),0)::text AS pending_count,
       COALESCE(SUM(CASE WHEN status = 'pending' THEN remaining_cash::float ELSE 0 END),0)::text AS pending_amount,
       COALESCE(SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END),0)::text AS resolved_count,
       COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END),0)::text AS rejected_count,
       COALESCE(SUM(CASE WHEN status = 'pending' AND jsonb_array_length(COALESCE(resolution->'suggestions','[]'::jsonb)) > 0 THEN 1 ELSE 0 END),0)::text AS suggested_count
     FROM reconciliation_review_queue
     WHERE user_id = $1`,
    [userId],
  )

  const itemQuery = includeRecent
    ? `SELECT id::text, movement_id::text, remaining_cash::text, status, candidate_payload, resolution, created_at::text, updated_at::text
       FROM reconciliation_review_queue
       WHERE user_id = $1 AND status IN ('pending','resolved','rejected')
       ORDER BY created_at DESC
       LIMIT 150`
    : `SELECT id::text, movement_id::text, remaining_cash::text, status, candidate_payload, resolution, created_at::text, updated_at::text
       FROM reconciliation_review_queue
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 150`
  const { rows } = await query<{
    id: string
    movement_id: string
    remaining_cash: string
    status: "pending" | "resolved" | "rejected"
    candidate_payload: unknown
    resolution: unknown
    created_at: string
    updated_at: string
  }>(itemQuery, [userId])

  const summaryRow = summaryRows[0]
  const summary: ReviewQueueSummary = {
    pending_count: parseInt(summaryRow?.pending_count ?? "0", 10) || 0,
    pending_amount: round2(parseFloat(summaryRow?.pending_amount ?? "0") || 0),
    resolved_count: parseInt(summaryRow?.resolved_count ?? "0", 10) || 0,
    rejected_count: parseInt(summaryRow?.rejected_count ?? "0", 10) || 0,
    suggested_count: parseInt(summaryRow?.suggested_count ?? "0", 10) || 0,
  }

  const items: ReviewQueueItem[] = rows.map((r) => ({
    id: r.id,
    movement_id: r.movement_id,
    remaining_cash: round2(parseFloat(r.remaining_cash) || 0),
    status: r.status,
    candidate_payload: r.candidate_payload,
    resolution: (r.resolution && typeof r.resolution === "object" ? r.resolution : {}) as ReviewQueueItem["resolution"],
    created_at: r.created_at,
    updated_at: r.updated_at,
  }))
  return { summary, items }
}

export async function resolveReviewQueueItem(input: {
  userId: string
  queueId: string
  action: "accept" | "reject"
  selectedEventIds?: string[]
  reason?: string
}): Promise<{ ok: boolean; status: "resolved" | "rejected" | "pending"; applied_count: number }> {
  const { userId, queueId, action, selectedEventIds, reason } = input
  const { rows } = await query<{
    id: string
    movement_id: string
    remaining_cash: string
    status: "pending" | "resolved" | "rejected"
    resolution: unknown
  }>(
    `SELECT id::text, movement_id::text, remaining_cash::text, status, resolution
     FROM reconciliation_review_queue
     WHERE user_id = $1 AND id = $2
     LIMIT 1`,
    [userId, queueId],
  )
  const row = rows[0]
  if (!row) throw new Error("Review queue item not found")
  if (isTerminalReviewQueueStatus(row.status)) {
    return { ok: true, status: row.status, applied_count: 0 }
  }

  if (action === "reject") {
    await query(
      `UPDATE reconciliation_review_queue
       SET status = 'rejected',
           resolution = COALESCE(resolution,'{}'::jsonb) || jsonb_build_object(
             'reason', $3::text,
             'rejected_at', NOW()
           ),
           updated_at = NOW()
       WHERE user_id = $1 AND id = $2`,
      [userId, queueId, reason ?? "rejected_by_user"],
    )
    return { ok: true, status: "rejected", applied_count: 0 }
  }

  const suggestions = suggestionsFromResolution(row.resolution)
  const selected = suggestions.filter((s) => (selectedEventIds && selectedEventIds.length > 0 ? selectedEventIds.includes(s.event_id) : true))
  if (selected.length === 0) {
    throw new Error("No suggestions available to accept")
  }

  const toApply = selected.slice(0, 5)
  let appliedCount = 0
  await runInTransaction(async (client) => {
    for (const s of toApply) {
      const gross = round2(Math.max(0, s.allocation_plan.gross_amount))
      const net = round2(Math.max(0, s.allocation_plan.net_amount))
      const fee = round2(Math.max(0, s.allocation_plan.fee_amount))
      if (gross <= 0.01 || net < 0) continue

      await client.query(
        `INSERT INTO movement_attributions (
           user_id, movement_id, component_type, entity_id, reference_id,
           gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,
        [
          userId,
          row.movement_id,
          s.allocation_plan.component_type,
          s.entity_id,
          s.event_id,
          gross,
          net,
          s.confidence,
          "llm",
          JSON.stringify({
            stage: 4,
            match_method: "review_queue_accept",
            suggested_reasoning: s.reasoning,
            fee_amount: fee,
            expected_date: null,
            reconcile_at: new Date().toISOString(),
          }),
          null,
          null,
        ],
      )

      if (fee > 0.01) {
        await client.query(
          `INSERT INTO movement_attributions (
             user_id, movement_id, component_type, entity_id, reference_id,
             gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id
           ) VALUES ($1,$2,'fee',$3,$4,0,$5,$6,'llm',$7::jsonb,$8::jsonb,$9)`,
          [
            userId,
            row.movement_id,
            "fee://processor",
            s.event_id,
            -fee,
            s.confidence,
            JSON.stringify({
              stage: 4,
              match_method: "review_queue_accept",
              fee_amount: fee,
              reconcile_at: new Date().toISOString(),
            }),
            null,
            null,
          ],
        )
      }

      await client.query(
        `UPDATE cash_events
         SET outstanding_amount = GREATEST(0, COALESCE(outstanding_amount::float, amount::float) - $2::float),
             status = CASE
               WHEN GREATEST(0, COALESCE(outstanding_amount::float, amount::float) - $2::float) <= 0.01 THEN 'paid'
               WHEN GREATEST(0, COALESCE(outstanding_amount::float, amount::float) - $2::float) < amount::float THEN 'partially_paid'
               ELSE 'open'
             END,
             last_reconciled_at = NOW(),
             updated_at = NOW()
         WHERE user_id = $1 AND id = $3`,
        [userId, gross, s.event_id],
      )
      appliedCount += 1
    }

    await client.query(
      `UPDATE reconciliation_review_queue
       SET status = 'resolved',
           resolution = COALESCE(resolution,'{}'::jsonb) || jsonb_build_object(
             'resolved_at', NOW(),
             'accepted_event_ids', $3::jsonb,
             'applied_count', $4::int,
             'decision_reason', $5::text
           ),
           updated_at = NOW()
       WHERE user_id = $1 AND id = $2`,
      [userId, queueId, JSON.stringify(toApply.map((s) => s.event_id)), appliedCount, reason ?? "accepted_by_user"],
    )
  })

  return { ok: true, status: "resolved", applied_count: appliedCount }
}

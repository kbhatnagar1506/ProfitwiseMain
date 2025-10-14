import { query, runInTransaction } from "./db"
import {
  buildStage4CandidatePayload,
  fetchStage4EntityCorrelationMap,
  fetchStage4GhostGaps,
  fetchStage4VelocityStats,
} from "./reconciliation-stage4-payload"

type MovementResidualRow = {
  id: string
  user_id: string
  date: string
  direction: "inflow" | "outflow"
  amount: string
  movement_type: string | null
  counterparty: string | null
  counterparty_entity_id: string | null
  raw_description: string | null
  available_cash: string
}

type OpenCashEventRow = {
  id: string
  user_id: string
  entity_id: string
  event_type: "ar" | "ap"
  amount: string
  outstanding_amount: string
  expected_date: string
  metadata: Record<string, unknown> | null
}

type ReconciliationDraftAttribution = {
  movement_id: string
  component_type: "ar" | "ap" | "fee"
  entity_id: string
  gross_amount: number
  net_amount: number
  metadata: Record<string, unknown>
}

type WaterfallOptions = {
  dryRun?: boolean
  minAiReviewAmount?: number
}

export type WaterfallResult = {
  scanned_movements: number
  attributed_rows: number
  exact_matches: number
  fee_matches: number
  fifo_full_matches: number
  fifo_partial_matches: number
  unresolved_count: number
  unresolved_amount: number
  updated_events: number
  dry_run: boolean
}

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

function normalizeEntityName(name: string | null | undefined): string {
  if (!name) return ""
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").trim()
}

function statusFromOutstanding(outstanding: number, amount: number): "open" | "partially_paid" | "paid" {
  if (outstanding <= 0.01) return "paid"
  if (outstanding < amount) return "partially_paid"
  return "open"
}

function isLikelyProcessorMovement(m: MovementResidualRow): boolean {
  const hay = `${m.counterparty ?? ""} ${m.raw_description ?? ""} ${m.movement_type ?? ""}`.toLowerCase()
  return hay.includes("stripe") || hay.includes("shopify") || hay.includes("processor")
}

export async function fetchUnallocatedMovementCash(userId: string): Promise<(MovementResidualRow & { available_cash_num: number; amount_num: number })[]> {
  const { rows } = await query<MovementResidualRow>(
    `SELECT
       m.id,
       m.user_id,
       m.date::text AS date,
       m.direction,
       m.amount::text AS amount,
       m.movement_type,
       m.counterparty,
       m.counterparty_entity_id::text,
       m.raw_description,
       (ABS(m.amount::float) - COALESCE(SUM(ABS(a.net_amount::float)), 0))::text AS available_cash
     FROM movements m
     LEFT JOIN movement_attributions a
       ON a.movement_id = m.id AND a.user_id = m.user_id
     WHERE m.user_id = $1
       AND m.duplicate_of IS NULL
     GROUP BY m.id
     HAVING (ABS(m.amount::float) - COALESCE(SUM(ABS(a.net_amount::float)), 0)) > 0.01
     ORDER BY m.date ASC`,
    [userId],
  )
  return rows.map((r) => ({
    ...r,
    amount_num: Math.abs(parseFloat(r.amount) || 0),
    available_cash_num: Math.max(0, parseFloat(r.available_cash) || 0),
  }))
}

async function fetchOpenCashEventsForWaterfall(userId: string): Promise<(OpenCashEventRow & { amount_num: number; outstanding_num: number; canonical_name: string })[]> {
  const { rows } = await query<OpenCashEventRow>(
    `SELECT id, user_id, entity_id, event_type, amount::text, COALESCE(outstanding_amount, amount)::text AS outstanding_amount,
            expected_date::text AS expected_date, metadata
     FROM cash_events
     WHERE user_id = $1
       AND event_type IN ('ar', 'ap')
       AND COALESCE(outstanding_amount::float, amount::float) > 0.01
       AND COALESCE(status, 'open') <> 'paid'
     ORDER BY expected_date ASC`,
    [userId],
  )
  return rows.map((r) => {
    const md = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>
    const canonical = typeof md.canonical_name === "string"
      ? md.canonical_name
      : typeof md.customer_name === "string"
        ? md.customer_name
        : typeof md.vendor_name === "string"
          ? md.vendor_name
          : ""
    return {
      ...r,
      amount_num: parseFloat(r.amount) || 0,
      outstanding_num: parseFloat(r.outstanding_amount) || parseFloat(r.amount) || 0,
      canonical_name: canonical,
    }
  })
}

export async function runReconciliationWaterfall(userId: string, options: WaterfallOptions = {}): Promise<WaterfallResult> {
  const dryRun = options.dryRun === true
  const minAiReviewAmount = options.minAiReviewAmount ?? 1000

  const movements = await fetchUnallocatedMovementCash(userId)
  const openEvents = await fetchOpenCashEventsForWaterfall(userId)
  const [entityCorrelationMap, ghostByEventId, velocityByEntityEvent] = await Promise.all([
    fetchStage4EntityCorrelationMap(userId),
    fetchStage4GhostGaps(userId),
    fetchStage4VelocityStats(userId),
  ])
  const attributions: ReconciliationDraftAttribution[] = []
  const reviewQueue: { movement_id: string; remaining_cash: number; candidate_event_ids: string[]; candidate_payload: unknown }[] = []
  const touchedEventIds = new Set<string>()

  let exactMatches = 0
  let feeMatches = 0
  let fifoFull = 0
  let fifoPartial = 0
  let unresolvedAmount = 0
  let unresolvedCount = 0

  for (const movement of movements) {
    let remainingCash = movement.available_cash_num
    if (remainingCash <= 0.01) continue
    const isInflow = movement.direction === "inflow"
    const targetType: "ar" | "ap" = isInflow ? "ar" : "ap"
    const movementNameNorm = normalizeEntityName(movement.counterparty)
    const movementEntityId = movement.counterparty_entity_id

    const entityEvents = openEvents
      .filter((e) => e.event_type === targetType && e.outstanding_num > 0.01)
      .filter((e) => {
        const idMatch = Boolean(movementEntityId && movementEntityId === e.entity_id)
        const nameMatch = movementNameNorm.length > 0 && movementNameNorm === normalizeEntityName(e.canonical_name)
        return idMatch || nameMatch
      })
      .sort((a, b) => a.expected_date.localeCompare(b.expected_date))

    // Stage 1: exact 1:1
    const exact = entityEvents.find((e) => Math.abs(e.outstanding_num - remainingCash) <= 0.01)
    if (exact) {
      attributions.push({
        movement_id: movement.id,
        component_type: targetType,
        entity_id: exact.entity_id,
        gross_amount: r2(remainingCash),
        net_amount: r2(remainingCash),
        metadata: { fee_amount: 0, match_method: "waterfall_exact", stage: 1, reconcile_at: new Date().toISOString() },
      })
      exact.outstanding_num = 0
      touchedEventIds.add(exact.id)
      exactMatches++
      continue
    }

    // Stage 2: fee-aware AR
    if (isInflow) {
      const feeMatch = entityEvents.find((e) => {
        if (e.outstanding_num <= remainingCash) return false
        const impliedFee = (e.outstanding_num - remainingCash) / e.outstanding_num
        return impliedFee >= 0.01 && impliedFee <= 0.05
      })
      if (feeMatch) {
        const fee = r2(feeMatch.outstanding_num - remainingCash)
        attributions.push({
          movement_id: movement.id,
          component_type: "ar",
          entity_id: feeMatch.entity_id,
          gross_amount: r2(feeMatch.outstanding_num),
          net_amount: r2(remainingCash),
          metadata: { fee_amount: fee, match_method: "waterfall_fee_aware", stage: 2, reconcile_at: new Date().toISOString() },
        })
        if (fee > 0.01) {
          attributions.push({
            movement_id: movement.id,
            component_type: "fee",
            entity_id: "fee://processor",
            gross_amount: 0,
            net_amount: -fee,
            metadata: { fee_amount: fee, match_method: "waterfall_fee_aware", stage: 2, reconcile_at: new Date().toISOString() },
          })
        }
        feeMatch.outstanding_num = 0
        touchedEventIds.add(feeMatch.id)
        feeMatches++
        continue
      }
    }

    // Stage 3: FIFO bulk/partial
    if (entityEvents.length > 0) {
      for (const ev of entityEvents) {
        if (remainingCash <= 0.01) break
        if (ev.outstanding_num <= 0.01) continue

        const feeRate = isInflow && isLikelyProcessorMovement(movement) ? 0.03 : 0
        const grossPurchasingPower = feeRate > 0 ? remainingCash / (1 - feeRate) : remainingCash

        if (grossPurchasingPower + 0.01 >= ev.outstanding_num) {
          const grossApplied = ev.outstanding_num
          const netApplied = feeRate > 0 ? grossApplied * (1 - feeRate) : grossApplied
          const fee = grossApplied - netApplied

          attributions.push({
            movement_id: movement.id,
            component_type: targetType,
            entity_id: ev.entity_id,
            gross_amount: r2(grossApplied),
            net_amount: r2(netApplied),
            metadata: { fee_amount: r2(fee), match_method: "waterfall_fifo_full", stage: 3, reconcile_at: new Date().toISOString() },
          })
          if (fee > 0.01) {
            attributions.push({
              movement_id: movement.id,
              component_type: "fee",
              entity_id: "fee://processor",
              gross_amount: 0,
              net_amount: -r2(fee),
              metadata: { fee_amount: r2(fee), match_method: "waterfall_fifo_full", stage: 3, reconcile_at: new Date().toISOString() },
            })
          }
          remainingCash = Math.max(0, remainingCash - netApplied)
          ev.outstanding_num = 0
          touchedEventIds.add(ev.id)
          fifoFull++
        } else {
          const grossApplied = grossPurchasingPower
          const netApplied = remainingCash
          const fee = grossApplied - netApplied
          attributions.push({
            movement_id: movement.id,
            component_type: targetType,
            entity_id: ev.entity_id,
            gross_amount: r2(grossApplied),
            net_amount: r2(netApplied),
            metadata: { fee_amount: r2(fee), match_method: "waterfall_fifo_partial", stage: 3, reconcile_at: new Date().toISOString() },
          })
          if (fee > 0.01) {
            attributions.push({
              movement_id: movement.id,
              component_type: "fee",
              entity_id: "fee://processor",
              gross_amount: 0,
              net_amount: -r2(fee),
              metadata: { fee_amount: r2(fee), match_method: "waterfall_fifo_partial", stage: 3, reconcile_at: new Date().toISOString() },
            })
          }
          ev.outstanding_num = Math.max(0, ev.outstanding_num - grossApplied)
          touchedEventIds.add(ev.id)
          remainingCash = 0
          fifoPartial++
        }
      }
    }

    // Stage 4 queue
    if (remainingCash > 0.01) {
      unresolvedCount++
      unresolvedAmount += remainingCash
      if (remainingCash >= minAiReviewAmount) {
        const candidates = openEvents
          .filter((e) => e.event_type === targetType && e.outstanding_num > 0.01)
          .sort((a, b) => a.expected_date.localeCompare(b.expected_date))
          .slice(0, 10)
        const candidatePayload = buildStage4CandidatePayload({
          movement,
          remainingCash,
          targetType,
          candidates,
          entityMap: entityCorrelationMap,
          ghostByEventId,
          velocityByEntityEvent,
        })
        reviewQueue.push({
          movement_id: movement.id,
          remaining_cash: r2(remainingCash),
          candidate_event_ids: candidates.map((c) => c.id),
          candidate_payload: candidatePayload,
        })
      }
    }
  }

  if (!dryRun) {
    await runInTransaction(async (client) => {
      for (const a of attributions) {
        await client.query(
          `INSERT INTO movement_attributions (
             user_id, movement_id, component_type, entity_id, reference_id,
             gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,
          [
            userId,
            a.movement_id,
            a.component_type,
            a.entity_id,
            null,
            a.gross_amount,
            a.net_amount,
            0.92,
            "model",
            JSON.stringify(a.metadata),
            null,
            null,
          ],
        )
      }

      for (const e of openEvents) {
        if (!touchedEventIds.has(e.id)) continue
        const nextOutstanding = r2(Math.max(0, e.outstanding_num))
        const nextStatus = statusFromOutstanding(nextOutstanding, e.amount_num)
        await client.query(
          `UPDATE cash_events
           SET outstanding_amount = $2,
               status = $3,
               last_reconciled_at = NOW(),
               updated_at = NOW()
           WHERE id = $1`,
          [e.id, nextOutstanding, nextStatus],
        )
      }

      for (const r of reviewQueue) {
        await client.query(
          `INSERT INTO reconciliation_review_queue (
             user_id, movement_id, remaining_cash, candidate_event_ids, candidate_payload, status, resolution, updated_at
           )
           VALUES ($1,$2,$3,$4::text[],$5::jsonb,'pending','{}'::jsonb,NOW())
           ON CONFLICT (user_id, movement_id, status)
           DO UPDATE SET
             remaining_cash = EXCLUDED.remaining_cash,
             candidate_event_ids = EXCLUDED.candidate_event_ids,
             candidate_payload = EXCLUDED.candidate_payload,
             updated_at = NOW()`,
          [userId, r.movement_id, r.remaining_cash, r.candidate_event_ids, JSON.stringify(r.candidate_payload)],
        )
      }
    })
  }

  return {
    scanned_movements: movements.length,
    attributed_rows: attributions.length,
    exact_matches: exactMatches,
    fee_matches: feeMatches,
    fifo_full_matches: fifoFull,
    fifo_partial_matches: fifoPartial,
    unresolved_count: unresolvedCount,
    unresolved_amount: r2(unresolvedAmount),
    updated_events: touchedEventIds.size,
    dry_run: dryRun,
  }
}

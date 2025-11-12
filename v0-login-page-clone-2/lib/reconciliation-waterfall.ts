/**
 * 4-stage reconciliation: deterministic Stages 1–3 in memory, Stage 4 flags large leftovers for review.
 * Expectation: cash_events (outstanding_amount). Reality: movements + movement_attributions.
 */

import type { PoolClient } from "pg"
import { ensureMovementsSchema, query, withTransaction } from "./db"
import { resolveReconciliationBankLabelsForMatch } from "./display-name-resolve"
import { insertAttributionWithClient, type CreateAttributionOpts } from "./attribution-persist"
import type { CashEventRow } from "./cash-events-build"
import { namesMatch } from "./ar-payment-match"

const EPS = 0.01
const STAGE4_REVIEW_THRESHOLD = 1000

export function normalizeEntityName(name: string | null | undefined): string {
  if (!name) return ""
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").trim()
}

export type MovementWithAvailableCash = {
  id: string
  user_id: string
  direction: "inflow" | "outflow"
  amount: number
  date: string
  movement_type: string
  counterparty: string | null
  counterparty_entity_id: string | null
  raw_description: string | null
  metadata: Record<string, unknown>
  available_cash: number
}

type MutableCashEvent = CashEventRow & {
  outstanding_amount: number
  status: "open" | "partially_paid" | "paid"
  amount: number
}

function statusFromOutstanding(outstanding: number, grossAmount: number): "open" | "partially_paid" | "paid" {
  if (outstanding <= EPS) return "paid"
  if (outstanding < grossAmount - EPS) return "partially_paid"
  return "open"
}

/** Sum of abs(net) on all attribution lines for the movement (AR + fee + AP + …) = explained bank cash. */
export async function fetchMovementsWithAvailableCash(userId: string): Promise<MovementWithAvailableCash[]> {
  await ensureMovementsSchema()
  const { rows } = await query<
    MovementWithAvailableCash & { amount: string; available_cash: string; metadata: unknown }
  >(
    `SELECT m.id, m.user_id, m.direction, m.amount::float, m.date::text, m.movement_type,
            m.counterparty, m.counterparty_entity_id::text AS counterparty_entity_id, m.raw_description, m.metadata,
            (ABS(m.amount::float) - COALESCE(allocated.allocated_sum, 0))::float AS available_cash
     FROM movements m
     LEFT JOIN (
       SELECT movement_id,
              SUM(ABS(net_amount::float)) AS allocated_sum
       FROM movement_attributions
       WHERE user_id = $1::uuid
       GROUP BY movement_id
     ) allocated ON allocated.movement_id = m.id
     WHERE m.user_id = $1::uuid AND m.duplicate_of IS NULL
       AND (ABS(m.amount::float) - COALESCE(allocated.allocated_sum, 0)) > $2
     ORDER BY m.date ASC`,
    [userId, EPS],
  )
  return rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    direction: r.direction as "inflow" | "outflow",
    amount: parseFloat(String(r.amount)),
    date: r.date,
    movement_type: r.movement_type,
    counterparty: r.counterparty,
    counterparty_entity_id: r.counterparty_entity_id,
    raw_description: r.raw_description,
    metadata: (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>,
    available_cash: parseFloat(String(r.available_cash)),
  }))
}

function isProcessorLikeMovement(m: MovementWithAvailableCash): boolean {
  if (m.movement_type === "processor_payout") return true
  const raw = (m.raw_description ?? "").toLowerCase()
  return raw.includes("stripe") || raw.includes("shopify") || raw.includes("square")
}

function matchesEntity(
  event: MutableCashEvent,
  movement: MovementWithAvailableCash,
  entityNormByUuid: Map<string, string>,
  resolvedBankDisplayName: string | null,
): boolean {
  const md = (event.metadata && typeof event.metadata === "object" ? event.metadata : {}) as Record<string, unknown>
  const graphEntityId = typeof md.graph_entity_id === "string" ? md.graph_entity_id : null
  if (graphEntityId && movement.counterparty_entity_id && graphEntityId === movement.counterparty_entity_id) {
    return true
  }
  const canonical =
    typeof md.canonical_name === "string"
      ? md.canonical_name
      : typeof md.customer_name === "string"
        ? md.customer_name
        : typeof md.vendor_name === "string"
          ? md.vendor_name
          : null
  const cn = normalizeEntityName(canonical)
  const bankLabel = resolvedBankDisplayName ?? movement.counterparty
  const cp = normalizeEntityName(bankLabel)
  if (cn && cp && cn === cp) return true
  if (movement.counterparty_entity_id) {
    const entNorm = entityNormByUuid.get(movement.counterparty_entity_id)
    if (entNorm && cn && entNorm === cn) return true
  }
  if (graphEntityId) {
    const eventEntNorm = entityNormByUuid.get(graphEntityId)
    if (eventEntNorm && cp && eventEntNorm === cp) return true
  }
  // Fuzzy: bank/Plaid strings almost never equal invoice vendor/customer strings (runtime WF_SUMMARY showed nCand=0 for all).
  if (canonical) {
    if (namesMatch(canonical, bankLabel)) return true
    if (namesMatch(canonical, movement.raw_description)) return true
  }
  return false
}

async function loadEntityNormByUuid(userId: string): Promise<Map<string, string>> {
  const { rows } = await query<{ id: string; canonical_name: string }>(
    `SELECT id::text, canonical_name FROM entities WHERE user_id = $1::uuid`,
    [userId],
  )
  const m = new Map<string, string>()
  for (const r of rows) {
    m.set(r.id, normalizeEntityName(r.canonical_name))
  }
  return m
}

async function loadOpenCashEvents(userId: string): Promise<MutableCashEvent[]> {
  await ensureMovementsSchema()
  const { rows } = await query<
    CashEventRow & {
      amount: string
      outstanding_amount: string | null
      expected_date: string
    }
  >(
    `SELECT id, user_id, entity_id, event_type, amount::float, outstanding_amount::float, status,
            probability::float, expected_date::text, source, movement_id, attribution_id, metadata
     FROM cash_events
     WHERE user_id = $1::uuid
       AND event_type IN ('ar', 'ap')
       AND COALESCE(outstanding_amount, amount) > $2
     ORDER BY expected_date ASC`,
    [userId, EPS],
  )
  return rows.map((r) => {
    const gross = parseFloat(String(r.amount))
    const out =
      r.outstanding_amount != null && r.outstanding_amount !== ""
        ? parseFloat(String(r.outstanding_amount))
        : gross
    const st = (r.status as MutableCashEvent["status"]) ?? statusFromOutstanding(out, gross)
    return {
      ...r,
      amount: gross,
      outstanding_amount: out,
      status: st,
      probability: parseFloat(String(r.probability)),
      expected_date: (r.expected_date as string).slice(0, 10),
      metadata: (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>,
    }
  })
}

export type ReconciliationWaterfallResult = {
  movementsProcessed: number
  attributionsCreated: number
  cashEventsUpdated: number
  stage4Queued: number
}

/**
 * Run Stages 1–3 deterministically; Stage 4 records review hints on movements (no auto LLM apply).
 */
export async function runReconciliationWaterfall(userId: string): Promise<ReconciliationWaterfallResult> {
  await ensureMovementsSchema()
  const entityNormByUuid = await loadEntityNormByUuid(userId)
  const eventById = new Map<string, MutableCashEvent>()
  for (const e of await loadOpenCashEvents(userId)) {
    eventById.set(e.id, e)
  }
  const movements = await fetchMovementsWithAvailableCash(userId)

  /** Bank-first labels (Plaid merchant_tags) for matching to invoices/bills — not entity-first display names. */
  const displayNameByMovement = await resolveReconciliationBankLabelsForMatch(
    movements.map((m) => ({
      movement_id: m.id,
      user_id: userId,
      counterparty:
        (typeof m.metadata?.counterparty === "string" ? m.metadata.counterparty : null) ?? m.counterparty,
      counterparty_entity_id: m.counterparty_entity_id,
    })),
  )

  const pendingAttributions: CreateAttributionOpts[] = []
  const touchedEventIds = new Set<string>()
  const stage4Reviews: { movementId: string; remainingCash: number }[] = []
  let stage4Queued = 0

  // #region agent log
  const debugWf = {
    openEvents: eventById.size,
    movementsIn: movements.length,
    hitS1: 0,
    hitS2: 0,
    hitS3: 0,
    zeroCandidates: 0,
    stage4NoCand: 0,
    stage4HadCand: 0,
    samples: [] as Array<{
      m: string
      dir: string
      rem: number
      nCand: number
      s1MinGap: number | null
      outcome: string
    }>,
  }
  // #endregion

  const filterForMovement = (m: MovementWithAvailableCash): MutableCashEvent[] => {
    const target: "ar" | "ap" = m.direction === "inflow" ? "ar" : "ap"
    const resolvedBank = displayNameByMovement.get(m.id)?.display_name ?? null
    return [...eventById.values()].filter(
      (e) =>
        e.event_type === target &&
        e.outstanding_amount > EPS &&
        matchesEntity(e, m, entityNormByUuid, resolvedBank),
    )
  }

  for (const movement of movements) {
    let remainingCash = movement.available_cash
    if (remainingCash <= EPS) continue

    const isInflow = movement.direction === "inflow"
    const targetType = isInflow ? "ar" : "ap"
    let entityEvents = filterForMovement(movement).sort(
      (a, b) => a.expected_date.localeCompare(b.expected_date),
    )

    // #region agent log
    const nCand = entityEvents.length
    let s1MinGap: number | null = null
    if (nCand > 0) {
      for (const ev of entityEvents) {
        const g = Math.abs(ev.outstanding_amount - remainingCash)
        if (s1MinGap === null || g < s1MinGap) s1MinGap = g
      }
    } else {
      debugWf.zeroCandidates++
    }
    let wfOutcome = "none"
    // #endregion

    const pushAttr = (opts: CreateAttributionOpts) => {
      pendingAttributions.push(opts)
    }

    // --- Stage 1: exact match ---
    const exactMatch = entityEvents.find((e) => Math.abs(e.outstanding_amount - remainingCash) < EPS)
    if (exactMatch) {
      // #region agent log
      debugWf.hitS1++
      wfOutcome = "s1"
      // #endregion
      pushAttr({
        userId,
        movementId: movement.id,
        component_type: targetType,
        entity_id: exactMatch.entity_id,
        reference_id:
          targetType === "ar"
            ? (exactMatch.metadata?.invoice_id as string) ?? null
            : (exactMatch.metadata?.bill_id as string) ?? null,
        gross_amount: exactMatch.outstanding_amount,
        net_amount: remainingCash,
        confidence: 0.92,
        source: "rule",
        metadata: {
          fee_amount: 0,
          match_method: "exact",
          waterfall_stage: "sniper",
        },
      })
      exactMatch.outstanding_amount = 0
      exactMatch.status = "paid"
      touchedEventIds.add(exactMatch.id)
      continue
    }

    // --- Stage 2: processor fee band (AR inflow only) ---
    if (isInflow) {
      const feeMatch = entityEvents.find((e) => {
        if (e.outstanding_amount <= EPS) return false
        const impliedFee = (e.outstanding_amount - remainingCash) / e.outstanding_amount
        return impliedFee > 0.01 && impliedFee <= 0.05
      })
      if (feeMatch) {
        // #region agent log
        debugWf.hitS2++
        wfOutcome = "s2"
        // #endregion
        const gross = feeMatch.outstanding_amount
        const net = remainingCash
        const feeAmt = Math.max(0, gross - net)
        pushAttr({
          userId,
          movementId: movement.id,
          component_type: "ar",
          entity_id: feeMatch.entity_id,
          reference_id: (feeMatch.metadata?.invoice_id as string) ?? null,
          gross_amount: gross,
          net_amount: net,
          confidence: 0.88,
          source: "rule",
          metadata: {
            fee_amount: feeAmt,
            match_method: "tolerance",
            waterfall_stage: "processor",
          },
        })
        if (feeAmt > EPS) {
          const processor = isProcessorLikeMovement(movement) ? "stripe" : "processor"
          pushAttr({
            userId,
            movementId: movement.id,
            component_type: "fee",
            entity_id: `fee://${processor}`,
            reference_id: null,
            gross_amount: 0,
            net_amount: -feeAmt,
            confidence: 0.88,
            source: "rule",
            metadata: {
              fee_amount: feeAmt,
              match_method: "tolerance",
              waterfall_stage: "processor_fee",
            },
          })
        }
        feeMatch.outstanding_amount = 0
        feeMatch.status = "paid"
        touchedEventIds.add(feeMatch.id)
        continue
      }
    }

    // --- Stage 3: FIFO ---
    const feeAssumed =
      isInflow && isProcessorLikeMovement(movement) && targetType === "ar" ? 0.03 : 0
    entityEvents = entityEvents.filter((e) => e.outstanding_amount > EPS)
    let fifoTouched = false
    for (const event of entityEvents) {
      if (remainingCash <= EPS) break

      const purchasingPower = feeAssumed > 0 ? remainingCash / (1 - feeAssumed) : remainingCash

      if (purchasingPower + EPS >= event.outstanding_amount) {
        const gross = event.outstanding_amount
        const netApplied = feeAssumed > 0 ? gross * (1 - feeAssumed) : gross
        const feeAmt = Math.max(0, gross - netApplied)
        pushAttr({
          userId,
          movementId: movement.id,
          component_type: targetType,
          entity_id: event.entity_id,
          reference_id:
            targetType === "ar"
              ? (event.metadata?.invoice_id as string) ?? null
              : (event.metadata?.bill_id as string) ?? null,
          gross_amount: gross,
          net_amount: netApplied,
          confidence: 0.82,
          source: "rule",
          metadata: {
            fee_amount: feeAmt,
            match_method: "tolerance",
            waterfall_stage: "fifo",
          },
        })
        if (feeAmt > EPS && targetType === "ar") {
          const processor = isProcessorLikeMovement(movement) ? "stripe" : "processor"
          pushAttr({
            userId,
            movementId: movement.id,
            component_type: "fee",
            entity_id: `fee://${processor}`,
            reference_id: null,
            gross_amount: 0,
            net_amount: -feeAmt,
            confidence: 0.82,
            source: "rule",
            metadata: {
              fee_amount: feeAmt,
              match_method: "tolerance",
              waterfall_stage: "fifo_fee",
            },
          })
        }
        remainingCash -= netApplied
        event.outstanding_amount = 0
        event.status = "paid"
        touchedEventIds.add(event.id)
        fifoTouched = true
      } else {
        const grossApplied = feeAssumed > 0 ? remainingCash / (1 - feeAssumed) : remainingCash
        const feeAmt = Math.max(0, grossApplied - remainingCash)
        pushAttr({
          userId,
          movementId: movement.id,
          component_type: targetType,
          entity_id: event.entity_id,
          reference_id:
            targetType === "ar"
              ? (event.metadata?.invoice_id as string) ?? null
              : (event.metadata?.bill_id as string) ?? null,
          gross_amount: grossApplied,
          net_amount: remainingCash,
          confidence: 0.8,
          source: "rule",
          metadata: {
            fee_amount: feeAmt,
            match_method: "tolerance",
            waterfall_stage: "fifo_partial",
          },
        })
        if (feeAmt > EPS && targetType === "ar") {
          const processor = isProcessorLikeMovement(movement) ? "stripe" : "processor"
          pushAttr({
            userId,
            movementId: movement.id,
            component_type: "fee",
            entity_id: `fee://${processor}`,
            reference_id: null,
            gross_amount: 0,
            net_amount: -feeAmt,
            confidence: 0.8,
            source: "rule",
            metadata: {
              fee_amount: feeAmt,
              match_method: "tolerance",
              waterfall_stage: "fifo_partial_fee",
            },
          })
        }
        event.outstanding_amount -= grossApplied
        event.status = statusFromOutstanding(event.outstanding_amount, event.amount)
        touchedEventIds.add(event.id)
        remainingCash = 0
        fifoTouched = true
        break
      }
    }
    // #region agent log
    if (fifoTouched) {
      debugWf.hitS3++
      wfOutcome = wfOutcome === "none" ? "s3" : wfOutcome
    }
    // #endregion

    // --- Stage 4: large leftover (metadata written in same transaction as attributions) ---
    if (remainingCash > STAGE4_REVIEW_THRESHOLD) {
      stage4Queued += 1
      stage4Reviews.push({ movementId: movement.id, remainingCash })
      // #region agent log
      if (nCand === 0) debugWf.stage4NoCand++
      else debugWf.stage4HadCand++
      if (debugWf.samples.length < 18) {
        debugWf.samples.push({
          m: movement.id.slice(0, 8),
          dir: movement.direction,
          rem: Math.round(remainingCash * 100) / 100,
          nCand,
          s1MinGap: s1MinGap == null ? null : Math.round(s1MinGap * 100) / 100,
          outcome: wfOutcome,
        })
      }
      // #endregion
    }
  }

  // #region agent log
  // Heroku (and other hosts): localhost ingest is unavailable — emit one grep-friendly JSON line for `heroku logs`.
  console.log(
    "[reconciliation-waterfall:debug]",
    JSON.stringify({
      sessionId: "fee5c4",
      hypothesisId: "WF_SUMMARY",
      location: "reconciliation-waterfall.ts:runReconciliationWaterfall",
      message: "waterfall_stage_counts",
      data: debugWf,
      timestamp: Date.now(),
    }),
  )
  // #endregion

  if (pendingAttributions.length === 0 && touchedEventIds.size === 0 && stage4Reviews.length === 0) {
    return {
      movementsProcessed: movements.length,
      attributionsCreated: 0,
      cashEventsUpdated: 0,
      stage4Queued,
    }
  }

  return withTransaction(async (client: PoolClient) => {
    for (const opts of pendingAttributions) {
      await insertAttributionWithClient(client, opts)
    }
    for (const id of touchedEventIds) {
      const ev = eventById.get(id)
      if (!ev) continue
      const st = statusFromOutstanding(ev.outstanding_amount, ev.amount)
      await client.query(
        `UPDATE cash_events SET outstanding_amount = $2, status = $3, last_reconciled_at = NOW(), updated_at = NOW()
         WHERE id = $1::uuid AND user_id = $4::uuid`,
        [ev.id, ev.outstanding_amount, st, userId],
      )
    }
    for (const s of stage4Reviews) {
      await client.query(
        `UPDATE movements
         SET metadata = COALESCE(metadata, '{}'::jsonb) ||
           jsonb_build_object(
             'reconciliation_waterfall_review',
             jsonb_build_object(
               'remaining_cash', $2::float,
               'queued_at', to_jsonb(NOW()::text),
               'threshold', $3::float
             )
           )
         WHERE id = $1::uuid`,
        [s.movementId, s.remainingCash, STAGE4_REVIEW_THRESHOLD],
      )
    }
    return {
      movementsProcessed: movements.length,
      attributionsCreated: pendingAttributions.length,
      cashEventsUpdated: touchedEventIds.size,
      stage4Queued,
    }
  })
}

/** Movements flagged by Stage 4 for LLM / batch review (see `batchLLMMatch` in reconciliation-llm-match). */
export async function getMovementsPendingWaterfallReview(userId: string): Promise<
  Array<{
    movement_id: string
    amount: number
    date: string
    counterparty: string | null
    raw_description: string | null
    direction: "inflow" | "outflow"
    remaining_cash: number
  }>
> {
  await ensureMovementsSchema()
  const { rows } = await query<{
    id: string
    direction: string
    amount: string
    date: string
    counterparty: string | null
    raw_description: string | null
    metadata: unknown
  }>(
    `SELECT id, direction, amount::float, date::text, counterparty, raw_description, metadata
     FROM movements
     WHERE user_id = $1::uuid
       AND duplicate_of IS NULL
       AND metadata ? 'reconciliation_waterfall_review'`,
    [userId],
  )
  return rows.map((r) => {
    const md = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>
    const rev =
      md.reconciliation_waterfall_review && typeof md.reconciliation_waterfall_review === "object"
        ? (md.reconciliation_waterfall_review as { remaining_cash?: number })
        : {}
    return {
      movement_id: r.id,
      amount: Math.abs(parseFloat(String(r.amount))),
      date: r.date,
      counterparty: r.counterparty,
      raw_description: r.raw_description,
      direction: r.direction as "inflow" | "outflow",
      remaining_cash: typeof rev.remaining_cash === "number" ? rev.remaining_cash : 0,
    }
  })
}

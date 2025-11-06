import { query, runInTransaction } from "./db"

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
  matched_by_id: number
  matched_by_name: number
  matched_by_amount_date: number
  fee_inferred_count: number
  candidate_none_count: number
  dry_run: boolean
}

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

function normalizeEntityName(name: string | null | undefined): string {
  if (!name) return ""
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").trim()
}

function normalizeEntityText(name: string | null | undefined): string {
  if (!name) return ""
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
}

function tokenizeMeaningful(name: string | null | undefined): string[] {
  if (!name) return []
  const stopWords = new Set(["llc", "inc", "co", "corp", "ltd", "the", "and"])
  return normalizeEntityText(name)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stopWords.has(t))
}

function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`)
  const db = new Date(`${b}T00:00:00Z`)
  return Math.round((db.getTime() - da.getTime()) / 86400000)
}

function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalizeEntityText(a)
  const nb = normalizeEntityText(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const compactA = normalizeEntityName(a)
  const compactB = normalizeEntityName(b)
  if (compactA && compactB && (compactA.includes(compactB) || compactB.includes(compactA))) return 0.85

  const ta = tokenizeMeaningful(a)
  const tb = tokenizeMeaningful(b)
  if (ta.length === 0 || tb.length === 0) return 0
  const setB = new Set(tb)
  const overlap = ta.filter((t) => setB.has(t)).length
  return overlap / Math.max(ta.length, tb.length)
}

function amountProximity(availableCash: number, outstanding: number): number {
  if (outstanding <= 0) return 0
  const relDiff = Math.abs(availableCash - outstanding) / outstanding
  return Math.max(0, 1 - Math.min(1, relDiff))
}

function dateProximity(movementDate: string, expectedDate: string): number {
  const delta = Math.abs(daysBetween(movementDate.slice(0, 10), expectedDate.slice(0, 10)))
  return Math.max(0, 1 - Math.min(1, delta / 30))
}

type CandidateTier = "id" | "name" | "amount_date"
type ScoredCandidate = {
  event: OpenCashEventRow & { amount_num: number; outstanding_num: number; canonical_name: string }
  score: number
  tier: CandidateTier
}

function scoreCandidate(
  movement: MovementResidualRow & { available_cash_num: number },
  event: OpenCashEventRow & { outstanding_num: number; canonical_name: string },
  movementEntityId: string | null,
): { score: number; tier: CandidateTier } {
  const idMatch = Boolean(movementEntityId && movementEntityId === event.entity_id)
  const nameScore = Math.max(
    nameSimilarity(movement.counterparty, event.canonical_name),
    nameSimilarity(movement.raw_description, event.canonical_name),
  )
  const amountScore = amountProximity(movement.available_cash_num, event.outstanding_num)
  const dtScore = dateProximity(movement.date, event.expected_date)

  const score = (idMatch ? 0.55 : 0) + 0.3 * nameScore + 0.1 * amountScore + 0.05 * dtScore
  if (idMatch) return { score, tier: "id" }
  if (nameScore >= 0.67) return { score, tier: "name" }
  return { score, tier: "amount_date" }
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
  const attributions: ReconciliationDraftAttribution[] = []
  const reviewQueue: { movement_id: string; remaining_cash: number; candidate_event_ids: string[]; candidate_payload: unknown[] }[] = []
  const touchedEventIds = new Set<string>()

  let exactMatches = 0
  let feeMatches = 0
  let fifoFull = 0
  let fifoPartial = 0
  let matchedById = 0
  let matchedByName = 0
  let matchedByAmountDate = 0
  let feeInferredCount = 0
  let candidateNoneCount = 0
  let unresolvedAmount = 0
  let unresolvedCount = 0

  for (const movement of movements) {
    let remainingCash = movement.available_cash_num
    if (remainingCash <= 0.01) continue
    const isInflow = movement.direction === "inflow"
    const targetType: "ar" | "ap" = isInflow ? "ar" : "ap"
    const movementEntityId = movement.counterparty_entity_id

    const scoredCandidates: ScoredCandidate[] = openEvents
      .filter((e) => e.event_type === targetType && e.outstanding_num > 0.01)
      .map((e) => {
        const { score, tier } = scoreCandidate(movement, e, movementEntityId)
        return { event: e, score, tier }
      })
      .filter((c) => {
        if (c.tier === "amount_date") return c.score >= 0.82
        return c.score >= 0.75
      })
      .sort((a, b) => b.score - a.score || a.event.expected_date.localeCompare(b.event.expected_date))

    if (scoredCandidates.length === 0) {
      candidateNoneCount++
      unresolvedCount++
      unresolvedAmount += remainingCash
      continue
    }

    const entityEvents = scoredCandidates
      .map((c) => c.event)
      .sort((a, b) => a.expected_date.localeCompare(b.expected_date))

    // Stage 1: exact 1:1
    const exact = entityEvents.find((e) => Math.abs(e.outstanding_num - remainingCash) <= 0.01)
    if (exact) {
      const exactCandidate = scoredCandidates.find((c) => c.event.id === exact.id)
      if (exactCandidate?.tier === "id") matchedById++
      else if (exactCandidate?.tier === "name") matchedByName++
      else matchedByAmountDate++
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
      const processorLikely = isLikelyProcessorMovement(movement)
      const feeMatch = entityEvents.find((e) => {
        if (!processorLikely) return false
        if (e.outstanding_num <= remainingCash) return false
        const impliedFee = (e.outstanding_num - remainingCash) / e.outstanding_num
        return impliedFee >= 0.01 && impliedFee <= 0.05
      })
      if (feeMatch) {
        const feeCandidate = scoredCandidates.find((c) => c.event.id === feeMatch.id)
        if (feeCandidate?.tier === "id") matchedById++
        else if (feeCandidate?.tier === "name") matchedByName++
        else matchedByAmountDate++
        const fee = r2(feeMatch.outstanding_num - remainingCash)
        feeInferredCount++
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
          const fifoCandidate = scoredCandidates.find((c) => c.event.id === ev.id)
          if (fifoCandidate?.tier === "id") matchedById++
          else if (fifoCandidate?.tier === "name") matchedByName++
          else matchedByAmountDate++
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
          const fifoCandidate = scoredCandidates.find((c) => c.event.id === ev.id)
          if (fifoCandidate?.tier === "id") matchedById++
          else if (fifoCandidate?.tier === "name") matchedByName++
          else matchedByAmountDate++
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
        reviewQueue.push({
          movement_id: movement.id,
          remaining_cash: r2(remainingCash),
          candidate_event_ids: candidates.map((c) => c.id),
          candidate_payload: candidates.map((c) => ({
            id: c.id,
            entity_id: c.entity_id,
            canonical_name: c.canonical_name,
            expected_date: c.expected_date,
            outstanding_amount: r2(c.outstanding_num),
            event_type: c.event_type,
          })),
        })
      }
    }
  }

  if (!dryRun) {
    await runInTransaction(async (client) => {
      for (const a of attributions) {
        const idempotencyKey = `${a.movement_id}|${a.entity_id}|${a.component_type}|${String(a.metadata.stage ?? "0")}|${r2(a.gross_amount).toFixed(2)}|${r2(a.net_amount).toFixed(2)}`
        const metadataWithKey = { ...a.metadata, idempotency_key: idempotencyKey }
        await client.query(
          `INSERT INTO movement_attributions (
             user_id, movement_id, component_type, entity_id, reference_id,
             gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id
           )
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12
           WHERE NOT EXISTS (
             SELECT 1 FROM movement_attributions x
             WHERE x.user_id = $1
               AND x.movement_id = $2
               AND COALESCE(x.metadata->>'idempotency_key', '') = $13
           )`,
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
            JSON.stringify(metadataWithKey),
            null,
            null,
            idempotencyKey,
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
    matched_by_id: matchedById,
    matched_by_name: matchedByName,
    matched_by_amount_date: matchedByAmountDate,
    fee_inferred_count: feeInferredCount,
    candidate_none_count: candidateNoneCount,
    dry_run: dryRun,
  }
}

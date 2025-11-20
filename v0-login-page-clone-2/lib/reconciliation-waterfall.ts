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

// Economic class filtering for reconciliation
// AR-eligible: movements that can match to invoices (customer receipts)
const AR_ELIGIBLE_CLASSES = new Set<string | null>([
  "customer_receipt",
  "refund",
  // Note: settlement_in/processor_payout are excluded - they aggregate multiple payments
  null, // Allow untagged movements to still attempt matching
])

// AP-eligible: movements that can match to bills (vendor payments)
const AP_ELIGIBLE_CLASSES = new Set<string | null>([
  "vendor_payment",
  "payroll",
  "tax",
  "debt_payment",
  null, // Allow untagged movements to still attempt matching
])

// Excluded from AR/AP reconciliation entirely
const EXCLUDED_FROM_RECON = new Set<string>([
  "transfer",
  "owner_contribution",
  "owner_draw",
  "bank_fee",
  "bank_fee_refund",
  "interest",
  "opening_balance",
  "account_verification",
  "system_adjustment",
  "processor_fee",
  "processor_payout",
  "settlement_in",
  "settlement_adjustment",
])

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
  // From movement_tags JOIN
  economic_class: string | null
  tag_data: Record<string, unknown> | null
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
    MovementWithAvailableCash & { amount: string; available_cash: string; metadata: unknown; tag_data: unknown }
  >(
    `SELECT m.id, m.user_id, m.direction, m.amount::float, m.date::text, m.movement_type,
            m.counterparty, m.counterparty_entity_id::text AS counterparty_entity_id, m.raw_description, m.metadata,
            mt.economic_class, mt.tag_data,
            (ABS(m.amount::float) - COALESCE(allocated.allocated_sum, 0))::float AS available_cash
     FROM movements m
     LEFT JOIN movement_tags mt ON mt.movement_id = m.id
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
    economic_class: r.economic_class ?? null,
    tag_data: (r.tag_data && typeof r.tag_data === "object" ? r.tag_data : null) as Record<string, unknown> | null,
  }))
}

function isProcessorLikeMovement(m: MovementWithAvailableCash): boolean {
  if (m.movement_type === "processor_payout") return true
  const raw = (m.raw_description ?? "").toLowerCase()
  return /\bstripe\b/i.test(raw) || /\bshopify\b/i.test(raw) || /\bsquare\b/i.test(raw)
}

function matchesEntity(
  event: MutableCashEvent,
  movement: MovementWithAvailableCash,
  entityNormByUuid: Map<string, string>,
  resolvedBankDisplayName: string | null,
  movementEntityCanonicalRaw: Map<string, string>,
): boolean {
  const md = (event.metadata && typeof event.metadata === "object" ? event.metadata : {}) as Record<string, unknown>
  const graphEntityId = typeof md.graph_entity_id === "string" ? md.graph_entity_id : null
  if (graphEntityId && movement.counterparty_entity_id && graphEntityId === movement.counterparty_entity_id) {
    return true
  }
  const customerName = typeof md.customer_name === "string" ? md.customer_name : null
  const canonical =
    typeof md.canonical_name === "string"
      ? md.canonical_name
      : customerName
        ? customerName
        : typeof md.vendor_name === "string"
          ? md.vendor_name
          : null
  const cn = normalizeEntityName(canonical)
  const bankLabel = resolvedBankDisplayName ?? movement.counterparty
  const cp = normalizeEntityName(bankLabel)
  if (cn && cp && cn === cp) return true
  if (cn.length >= 4 && cp.length >= 4 && (cn.includes(cp) || cp.includes(cn))) return true
  
  // Extract organization name from parentheses in customer name
  // Handles cases where bank shows org name but invoice is under contact name
  if (customerName) {
    const orgMatch = customerName.match(/\(([^)]+)\)/)
    if (orgMatch) {
      const orgName = normalizeEntityName(orgMatch[1])
      if (orgName && cp && orgName.length >= 3 && (orgName.includes(cp) || cp.includes(orgName))) {
        return true
      }
      // Also check against raw description for org name
      const rawDesc = normalizeEntityName(movement.raw_description)
      if (orgName && rawDesc && orgName.length >= 3 && (rawDesc.includes(orgName) || orgName.includes(rawDesc.slice(0, 20)))) {
        return true
      }
      // Check if bank label or raw description contains the org name
      if (orgName && orgName.length >= 4) {
        const bankLabelNorm = normalizeEntityName(bankLabel)
        if (bankLabelNorm && bankLabelNorm.includes(orgName)) {
          return true
        }
      }
      // Handle abbreviations (e.g., abbreviated state/city names matching full names)
      // Extract significant words from org name and check if they appear in bank label
      const orgWords = (orgMatch[1] || "").toLowerCase().split(/\s+/).filter(w => w.length >= 4)
      const bankLabelLower = (bankLabel || "").toLowerCase()
      const rawDescLower = (movement.raw_description || "").toLowerCase()
      for (const word of orgWords) {
        if (bankLabelLower.includes(word) || rawDescLower.includes(word)) {
          return true
        }
      }
    }
  }
  
  // Also try matching raw description against customer name's org
  // This catches cases where counterparty is null but raw_description has the org name
  const rawDescNorm = normalizeEntityName(movement.raw_description)
  if (customerName && rawDescNorm) {
    const orgMatch = customerName.match(/\(([^)]+)\)/)
    if (orgMatch) {
      const orgName = normalizeEntityName(orgMatch[1])
      if (orgName && orgName.length >= 4 && rawDescNorm.includes(orgName)) {
        return true
      }
      // Also check significant words from org name
      const orgWords = (orgMatch[1] || "").toLowerCase().split(/\s+/).filter(w => w.length >= 4)
      for (const word of orgWords) {
        if (rawDescNorm.includes(word.replace(/[^a-z0-9]/g, ""))) {
          return true
        }
      }
    }
  }
  
  if (movement.counterparty_entity_id) {
    const entNorm = entityNormByUuid.get(movement.counterparty_entity_id)
    if (entNorm && cn && entNorm === cn) return true
    const rawEnt = movementEntityCanonicalRaw.get(movement.counterparty_entity_id)
    if (rawEnt) {
      if (canonical && namesMatch(rawEnt, canonical)) return true
      if (customerName && namesMatch(rawEnt, customerName)) return true
      if (namesMatch(rawEnt, bankLabel)) return true
    }
  }
  if (graphEntityId) {
    const eventEntNorm = entityNormByUuid.get(graphEntityId)
    if (eventEntNorm && cp && eventEntNorm === cp) return true
  }
  if (customerName) {
    if (namesMatch(customerName, bankLabel)) return true
    if (namesMatch(customerName, movement.raw_description)) return true
  }
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

/** Raw `entities.canonical_name` for movement counterparty IDs — used with `namesMatch` when compact norm differs. */
async function loadEntityCanonicalRawForIds(userId: string, entityIds: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  if (entityIds.length === 0) return m
  const { rows } = await query<{ id: string; canonical_name: string }>(
    `SELECT id::text, canonical_name FROM entities WHERE user_id = $1::uuid AND id = ANY($2::uuid[])`,
    [userId, entityIds],
  )
  for (const r of rows) {
    if (r.canonical_name?.trim()) m.set(r.id, r.canonical_name.trim())
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
     ORDER BY expected_date ASC`,
    [userId],
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
  const distinctCounterpartyEntityIds = [
    ...new Set(movements.map((m) => m.counterparty_entity_id).filter((id): id is string => Boolean(id))),
  ]
  const movementEntityCanonicalRaw = await loadEntityCanonicalRawForIds(userId, distinctCounterpartyEntityIds)

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
    evAr: 0,
    evAp: 0,
    mInflow: 0,
    mOutflow: 0,
    hitS0: 0, // Stage 0: direct link matches
    hitS1: 0,
    hitS2: 0,
    hitS3: 0,
    zeroCandidates: 0,
    /** H-A: no cash_event of target type (ar/ap) with outstanding — direction pool empty */
    zeroByNoType: 0,
    /** H-B: events of that type exist but matchesEntity filtered all */
    zeroByEntityOnly: 0,
    /** H-D: among zeroByEntityOnly, bank label used for match was empty */
    zeroCandNullBankLabel: 0,
    /** Movements excluded by economic_class filter */
    excludedByEconClass: 0,
    /** Movements skipped due to wrong economic_class for direction */
    skippedWrongEconClass: 0,
    stage4NoCand: 0,
    stage4HadCand: 0,
    samples: [] as Array<{
      m: string
      dir: string
      rem: number
      nCand: number
      s1MinGap: number | null
      outcome: string
      econClass: string | null
    }>,
  }
  for (const e of eventById.values()) {
    if (e.event_type === "ar") debugWf.evAr++
    else if (e.event_type === "ap") debugWf.evAp++
  }
  for (const m of movements) {
    if (m.direction === "inflow") debugWf.mInflow++
    else debugWf.mOutflow++
  }
  // #endregion

  const filterForMovement = (m: MovementWithAvailableCash): MutableCashEvent[] => {
    const econ = m.economic_class

    // Skip movements that should never match AR/AP (transfers, owner activity, fees, etc.)
    if (econ && EXCLUDED_FROM_RECON.has(econ)) {
      return []
    }

    const target: "ar" | "ap" = m.direction === "inflow" ? "ar" : "ap"

    // Validate economic class matches direction
    if (target === "ar" && econ && !AR_ELIGIBLE_CLASSES.has(econ)) {
      return []
    }
    if (target === "ap" && econ && !AP_ELIGIBLE_CLASSES.has(econ)) {
      return []
    }

    const resolvedBank = displayNameByMovement.get(m.id)?.display_name ?? null
    return [...eventById.values()].filter(
      (e) =>
        e.event_type === target &&
        (e.outstanding_amount > EPS || e.status === "paid") &&
        matchesEntity(e, m, entityNormByUuid, resolvedBank, movementEntityCanonicalRaw),
    )
  }

  for (const movement of movements) {
    let remainingCash = movement.available_cash
    if (remainingCash <= EPS) continue

    const econ = movement.economic_class

    // Track movements excluded by economic class
    if (econ && EXCLUDED_FROM_RECON.has(econ)) {
      debugWf.excludedByEconClass++
      continue
    }

    const resolvedBankForMove =
      displayNameByMovement.get(movement.id)?.display_name ?? null
    const isInflow = movement.direction === "inflow"
    const targetType = isInflow ? "ar" : "ap"

    // Track movements with wrong economic class for their direction
    if (targetType === "ar" && econ && !AR_ELIGIBLE_CLASSES.has(econ)) {
      debugWf.skippedWrongEconClass++
      continue
    }
    if (targetType === "ap" && econ && !AP_ELIGIBLE_CLASSES.has(econ)) {
      debugWf.skippedWrongEconClass++
      continue
    }

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
      const byTypeOnly = [...eventById.values()].filter(
        (e) => e.event_type === targetType && e.outstanding_amount > EPS,
      )
      if (byTypeOnly.length === 0) {
        debugWf.zeroByNoType++
      } else {
        debugWf.zeroByEntityOnly++
        if (!resolvedBankForMove || String(resolvedBankForMove).trim() === "") {
          debugWf.zeroCandNullBankLabel++
        }
      }
    }
    let wfOutcome = "none"
    // #endregion

    const pushAttr = (opts: CreateAttributionOpts) => {
      pendingAttributions.push(opts)
    }

    // --- Handle processor_payout as settlement (skip AR/AP matching) ---
    // Processor payouts aggregate multiple charges minus fees, so they shouldn't match to single invoices
    if (econ === "processor_payout") {
      pushAttr({
        userId,
        movementId: movement.id,
        component_type: "settlement",
        entity_id: `settlement://processor/${movement.counterparty ?? "unknown"}`,
        reference_id: null,
        gross_amount: remainingCash,
        net_amount: remainingCash,
        confidence: 0.85,
        source: "rule",
        metadata: {
          waterfall_stage: "processor_settlement",
          match_method: "settlement_classification",
          requires_decomposition: true,
          economic_class: econ,
        },
      })
      wfOutcome = "settlement"
      continue
    }

    // --- Stage 0: Direct link from tag_data (invoice_id or bill_id) ---
    // Highest confidence match when movement has pre-linked document ID
    const tagData = movement.tag_data as { invoice_id?: string; bill_id?: string; customer_id?: string; vendor_id?: string } | null
    let directLinkMatch: MutableCashEvent | undefined

    if (tagData) {
      if (isInflow && tagData.invoice_id) {
        // Find cash_event with matching invoice_id in metadata
        directLinkMatch = [...eventById.values()].find(
          (e) =>
            e.event_type === "ar" &&
            (e.outstanding_amount > EPS || e.status === "paid") &&
            e.metadata?.invoice_id === tagData.invoice_id,
        )
      } else if (!isInflow && tagData.bill_id) {
        // Find cash_event with matching bill_id in metadata
        directLinkMatch = [...eventById.values()].find(
          (e) =>
            e.event_type === "ap" &&
            (e.outstanding_amount > EPS || e.status === "paid") &&
            e.metadata?.bill_id === tagData.bill_id,
        )
      }
    }

    if (directLinkMatch) {
      const isHistoricalDirectLink = directLinkMatch.status === "paid"
      const matchAmount = isHistoricalDirectLink ? directLinkMatch.amount : directLinkMatch.outstanding_amount
      // #region agent log
      debugWf.hitS0++
      wfOutcome = "s0"
      // #endregion
      pushAttr({
        userId,
        movementId: movement.id,
        component_type: targetType,
        entity_id: directLinkMatch.entity_id,
        reference_id:
          targetType === "ar"
            ? (directLinkMatch.metadata?.invoice_id as string) ?? null
            : (directLinkMatch.metadata?.bill_id as string) ?? null,
        gross_amount: matchAmount,
        net_amount: remainingCash,
        confidence: 0.98, // Highest confidence for direct link
        source: "rule",
        metadata: {
          fee_amount: Math.max(0, matchAmount - remainingCash),
          match_method: "direct_link",
          waterfall_stage: isHistoricalDirectLink ? "direct_link_historical" : "direct_link",
          is_historical_reconciliation: isHistoricalDirectLink,
          linked_via: tagData?.invoice_id ? "invoice_id" : "bill_id",
        },
      })
      // Handle fee if there's a difference (processor fee)
      const feeAmount = Math.max(0, matchAmount - remainingCash)
      if (feeAmount > EPS && targetType === "ar") {
        const processor = isProcessorLikeMovement(movement) ? "stripe" : "processor"
        pushAttr({
          userId,
          movementId: movement.id,
          component_type: "fee",
          entity_id: `fee://${processor}`,
          reference_id: null,
          gross_amount: 0,
          net_amount: -feeAmount,
          confidence: 0.98,
          source: "rule",
          metadata: {
            fee_amount: feeAmount,
            match_method: "direct_link",
            waterfall_stage: isHistoricalDirectLink ? "direct_link_fee_historical" : "direct_link_fee",
            is_historical_reconciliation: isHistoricalDirectLink,
          },
        })
      }
      if (!isHistoricalDirectLink) {
        directLinkMatch.outstanding_amount = 0
        directLinkMatch.status = "paid"
      }
      touchedEventIds.add(directLinkMatch.id)
      continue
    }

    // --- Stage 1: exact match (including processor fee-aware match for inflows) ---
    // For paid events, we match by gross amount (historical reconciliation)
    let exactMatch = entityEvents.find((e) => {
      const matchAmount = e.status === "paid" ? e.amount : e.outstanding_amount
      return Math.abs(matchAmount - remainingCash) < EPS
    })
    let s1FeeAmount = 0
    let isHistoricalMatch = false
    if (!exactMatch && isInflow && isProcessorLikeMovement(movement) && targetType === "ar") {
      exactMatch = entityEvents.find((e) => {
        const matchAmount = e.status === "paid" ? e.amount : e.outstanding_amount
        if (matchAmount <= EPS) return false
        const impliedFee = (matchAmount - remainingCash) / matchAmount
        return impliedFee >= 0 && impliedFee <= 0.08
      })
      if (exactMatch) {
        const matchAmount = exactMatch.status === "paid" ? exactMatch.amount : exactMatch.outstanding_amount
        s1FeeAmount = Math.max(0, matchAmount - remainingCash)
      }
    }
    if (exactMatch) {
      isHistoricalMatch = exactMatch.status === "paid"
      const matchAmount = isHistoricalMatch ? exactMatch.amount : exactMatch.outstanding_amount
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
        gross_amount: matchAmount,
        net_amount: remainingCash,
        confidence: s1FeeAmount > EPS ? 0.90 : 0.92,
        source: "rule",
        metadata: {
          fee_amount: s1FeeAmount,
          match_method: s1FeeAmount > EPS ? "exact_with_fee" : "exact",
          waterfall_stage: isHistoricalMatch ? "sniper_historical" : "sniper",
          is_historical_reconciliation: isHistoricalMatch,
        },
      })
      if (s1FeeAmount > EPS && targetType === "ar") {
        const processor = isProcessorLikeMovement(movement) ? "stripe" : "processor"
        pushAttr({
          userId,
          movementId: movement.id,
          component_type: "fee",
          entity_id: `fee://${processor}`,
          reference_id: null,
          gross_amount: 0,
          net_amount: -s1FeeAmount,
          confidence: 0.90,
          source: "rule",
          metadata: {
            fee_amount: s1FeeAmount,
            match_method: "exact_with_fee",
            waterfall_stage: isHistoricalMatch ? "sniper_fee_historical" : "sniper_fee",
            is_historical_reconciliation: isHistoricalMatch,
          },
        })
      }
      if (!isHistoricalMatch) {
        exactMatch.outstanding_amount = 0
        exactMatch.status = "paid"
      }
      touchedEventIds.add(exactMatch.id)
      continue
    }

    // --- Stage 2: processor fee band (AR inflow only) ---
    if (isInflow) {
      const feeMatch = entityEvents.find((e) => {
        const matchAmount = e.status === "paid" ? e.amount : e.outstanding_amount
        if (matchAmount <= EPS) return false
        const impliedFee = (matchAmount - remainingCash) / matchAmount
        return impliedFee > 0.01 && impliedFee <= 0.05
      })
      if (feeMatch) {
        const isHistoricalFeeMatch = feeMatch.status === "paid"
        // #region agent log
        debugWf.hitS2++
        wfOutcome = "s2"
        // #endregion
        const gross = isHistoricalFeeMatch ? feeMatch.amount : feeMatch.outstanding_amount
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
            waterfall_stage: isHistoricalFeeMatch ? "processor_historical" : "processor",
            is_historical_reconciliation: isHistoricalFeeMatch,
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
              waterfall_stage: isHistoricalFeeMatch ? "processor_fee_historical" : "processor_fee",
              is_historical_reconciliation: isHistoricalFeeMatch,
            },
          })
        }
        if (!isHistoricalFeeMatch) {
          feeMatch.outstanding_amount = 0
          feeMatch.status = "paid"
        }
        touchedEventIds.add(feeMatch.id)
        continue
      }
    }

    // --- Stage 3: FIFO ---
    // Prioritize open events first, then paid events for historical matching
    const feeAssumed =
      isInflow && isProcessorLikeMovement(movement) && targetType === "ar" ? 0.03 : 0
    const openEvents = entityEvents.filter((e) => e.status !== "paid" && e.outstanding_amount > EPS)
    const paidEvents = entityEvents.filter((e) => e.status === "paid")
    const sortedEvents = [...openEvents, ...paidEvents]
    let fifoTouched = false
    for (const event of sortedEvents) {
      if (remainingCash <= EPS) break

      const isHistoricalFifo = event.status === "paid"
      const eventAmount = isHistoricalFifo ? event.amount : event.outstanding_amount
      if (eventAmount <= EPS) continue

      const purchasingPower = feeAssumed > 0 ? remainingCash / (1 - feeAssumed) : remainingCash

      if (purchasingPower + EPS >= eventAmount) {
        const gross = eventAmount
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
            waterfall_stage: isHistoricalFifo ? "fifo_historical" : "fifo",
            is_historical_reconciliation: isHistoricalFifo,
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
              waterfall_stage: isHistoricalFifo ? "fifo_fee_historical" : "fifo_fee",
              is_historical_reconciliation: isHistoricalFifo,
            },
          })
        }
        remainingCash -= netApplied
        if (!isHistoricalFifo) {
          event.outstanding_amount = 0
          event.status = "paid"
        }
        touchedEventIds.add(event.id)
        fifoTouched = true
      } else {
        const rawGross = feeAssumed > 0 ? remainingCash / (1 - feeAssumed) : remainingCash
        const grossApplied = Math.min(rawGross, eventAmount)
        const netApplied = feeAssumed > 0 ? grossApplied * (1 - feeAssumed) : grossApplied
        const feeAmt = Math.max(0, grossApplied - netApplied)
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
          net_amount: netApplied,
          confidence: 0.8,
          source: "rule",
          metadata: {
            fee_amount: feeAmt,
            match_method: "tolerance",
            waterfall_stage: isHistoricalFifo ? "fifo_partial_historical" : "fifo_partial",
            is_historical_reconciliation: isHistoricalFifo,
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
              waterfall_stage: isHistoricalFifo ? "fifo_partial_fee_historical" : "fifo_partial_fee",
              is_historical_reconciliation: isHistoricalFifo,
            },
          })
        }
        remainingCash -= netApplied
        if (!isHistoricalFifo) {
          event.outstanding_amount -= grossApplied
          event.status = statusFromOutstanding(event.outstanding_amount, event.amount)
        }
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
          econClass: movement.economic_class,
        })
      }
      // #endregion
    }
  }

  // #region agent log
  // Heroku (and other hosts): localhost ingest is unavailable — emit one grep-friendly JSON line for `heroku logs`.
  const wfPayload = {
    sessionId: "fee5c4",
    hypothesisId: "WF_SUMMARY",
    location: "reconciliation-waterfall.ts:runReconciliationWaterfall",
    message: "waterfall_stage_counts",
    data: debugWf,
    timestamp: Date.now(),
  }
  console.log("[reconciliation-waterfall:debug]", JSON.stringify(wfPayload))
  fetch("http://127.0.0.1:7242/ingest/b0bb6c9e-7e1d-4674-9db3-ac21c3d4fa72", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "fee5c4" },
    body: JSON.stringify({
      sessionId: "fee5c4",
      hypothesisId: "WF_BREAKDOWN",
      location: "reconciliation-waterfall.ts:runReconciliationWaterfall",
      message: "zeroCand_split",
      data: {
        evAr: debugWf.evAr,
        evAp: debugWf.evAp,
        mInflow: debugWf.mInflow,
        mOutflow: debugWf.mOutflow,
        zeroByNoType: debugWf.zeroByNoType,
        zeroByEntityOnly: debugWf.zeroByEntityOnly,
        zeroCandNullBankLabel: debugWf.zeroCandNullBankLabel,
        openEvents: debugWf.openEvents,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {})
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
    // D4: Clear stale Stage 4 review metadata from previous runs
    await client.query(
      `UPDATE movements SET metadata = metadata - 'reconciliation_waterfall_review'
       WHERE user_id = $1::uuid AND metadata ? 'reconciliation_waterfall_review'`,
      [userId],
    )

    // D5: Delete previous waterfall attributions to ensure idempotency on re-run
    await client.query(
      `DELETE FROM movement_attributions
       WHERE user_id = $1 AND source = 'rule'
         AND metadata->>'waterfall_stage' IS NOT NULL`,
      [userId],
    )

    // D6: Re-load cash events inside transaction to avoid TOCTOU race.
    // Outstanding amounts may have changed since the initial load if a concurrent
    // waterfall was committed. Rebuild eventById from fresh data inside the txn.
    eventById.clear()
    for (const e of await loadOpenCashEvents(userId)) {
      eventById.set(e.id, e)
    }

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

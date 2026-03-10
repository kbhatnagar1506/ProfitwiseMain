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
import { safeParseFloat } from "./utils"
import { writeStatusChange } from "./ar-ap-status"
import { bulkWriteAuditLog, type AuditLogEntry } from "./reconciliation-audit-log"
import { buildSyncConfidenceBreakdown, breakdownToEnvelope } from "./confidence-scoring"

const EPS = 0.01
const STAGE4_REVIEW_THRESHOLD = 1000

// ─── Phase 2: Category-Based Matching ────────────────────────────────────────
// Map economic_class to a broad category bucket for confidence scoring.
// Movements in different category buckets get a confidence penalty.
const ECON_CLASS_CATEGORY: Record<string, string> = {
  product_sale: "product",
  services: "services",
  payroll: "payroll",
  consulting: "services",
  contractor: "services",
  software_subscription: "software",
  marketing: "marketing",
  advertising: "marketing",
  supplies: "supplies",
  equipment: "equipment",
  rent: "real_estate",
  utilities: "utilities",
  insurance: "insurance",
  raw_materials: "raw_materials",
  wholesale: "wholesale",
}

const CATEGORY_CONFIDENCE_BOOST = 0.05
const CATEGORY_CONFIDENCE_PENALTY = 0.10

/** Return confidence adjustment based on movement economic_class vs event category metadata. */
function computeCategoryConfidenceAdjust(
  movementEconClass: string | null | undefined,
  eventMetadata: Record<string, unknown> | undefined
): { adjustment: number; movCategory: string | null; eventCategory: string | null } {
  if (!movementEconClass || !eventMetadata) return { adjustment: 0, movCategory: null, eventCategory: null }
  const movCategory = ECON_CLASS_CATEGORY[movementEconClass] ?? null
  const eventCategory = (eventMetadata.category as string | null) ?? null
  if (!movCategory || !eventCategory) return { adjustment: 0, movCategory, eventCategory }
  if (movCategory === eventCategory) return { adjustment: CATEGORY_CONFIDENCE_BOOST, movCategory, eventCategory }
  return { adjustment: -CATEGORY_CONFIDENCE_PENALTY, movCategory, eventCategory }
}
// ─────────────────────────────────────────────────────────────────────────────

// LLM-based semantic entity matching
const LLM_API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const LLM_API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const LLM_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

async function validateEntityMatchWithLLM(
  bankDescription: string,
  entityName: string,
  invoiceAmount: number,
  bankAmount: number
): Promise<boolean> {
  if (!LLM_API_KEY) return true // Fallback to fuzzy match if no LLM
  
  try {
    const prompt = `Does this bank transaction semantically match this invoice?

Bank Description: "${bankDescription}"
Invoice Entity: "${entityName}"
Bank Amount: $${bankAmount.toFixed(2)}
Invoice Amount: $${invoiceAmount.toFixed(2)}

Rules:
- Bank description MUST semantically match the entity name
- Different vendors/organizations = NO MATCH (e.g., "Spread The Love Foods" ≠ "High Brew")
- Same vendor with name variations = YES (e.g., "ABC Corp" = "ABC")
- Amount within 5% = acceptable
- Amount mismatch + name mismatch = NO MATCH

Respond with only "YES" or "NO".`

    const res = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) return true // Fallback on error
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const response = data.choices?.[0]?.message?.content?.trim().toUpperCase() ?? ""
    return response.includes("YES")
  } catch (e) {
    console.warn("[LLM-Entity-Match] Error:", e instanceof Error ? e.message : String(e))
    return true // Fallback to fuzzy match on error
  }
}

/**
 * Validate attributions using LLM semantic matching.
 * Filters out false positives where bank description doesn't match entity name.
 */
async function validateAttributionsWithLLM(
  attributions: CreateAttributionOpts[],
  movements: Map<string, { raw_description: string | null; counterparty: string | null; amount: number }>,
  invoices: Map<string, { customer_name: string; amount_due: number }>,
  bills: Map<string, { vendor_name: string; amount_due: number }>
): Promise<CreateAttributionOpts[]> {
  if (!LLM_API_KEY) return attributions // Skip if no LLM
  
  const validated: CreateAttributionOpts[] = []
  
  for (const attr of attributions) {
    const movement = movements.get(attr.movementId)
    if (!movement) {
      validated.push(attr)
      continue
    }
    
    const bankDesc = movement.raw_description || movement.counterparty || "Unknown"
    let entityName = ""
    let invoiceAmount = 0
    
    if (attr.component_type === "ar") {
      const invoice = invoices.get(attr.reference_id ?? "")
      if (!invoice) {
        validated.push(attr)
        continue
      }
      entityName = invoice.customer_name
      invoiceAmount = invoice.amount_due
    } else if (attr.component_type === "ap") {
      const bill = bills.get(attr.reference_id ?? "")
      if (!bill) {
        validated.push(attr)
        continue
      }
      entityName = bill.vendor_name
      invoiceAmount = bill.amount_due
    } else {
      validated.push(attr)
      continue
    }
    
    // Use LLM to validate semantic match
    const isValid = await validateEntityMatchWithLLM(
      bankDesc,
      entityName,
      invoiceAmount,
      movement.amount
    )
    
    if (isValid) {
      validated.push(attr)
    } else {
      console.log(`[LLM-Validation] Rejected match: "${bankDesc}" → "${entityName}" ($${movement.amount.toFixed(2)})`)
    }
  }
  
  return validated
}

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
  if (grossAmount <= EPS) return "paid" // $0 events are always considered paid
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
            (m.amount::float - COALESCE(allocated.allocated_sum, 0))::float AS available_cash
     FROM movements m
     LEFT JOIN LATERAL (
       SELECT economic_class, tag_data, cashflow_bucket
       FROM movement_tags WHERE movement_id = m.id AND user_id = m.user_id LIMIT 1
     ) mt ON true
     LEFT JOIN (
       SELECT movement_id,
              SUM(net_amount::float) FILTER (WHERE component_type != 'fee') AS allocated_sum
       FROM movement_attributions
       WHERE user_id = $1::uuid
       GROUP BY movement_id
     ) allocated ON allocated.movement_id = m.id
    WHERE m.user_id = $1::uuid AND m.duplicate_of IS NULL
      AND (m.amount::float - COALESCE(allocated.allocated_sum, 0)) > $2
    ORDER BY m.date ASC, m.id ASC`,
    [userId, EPS],
  )
  return rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    direction: r.direction as "inflow" | "outflow",
    amount: safeParseFloat(r.amount),
    date: r.date,
    movement_type: r.movement_type,
    counterparty: r.counterparty,
    counterparty_entity_id: r.counterparty_entity_id,
    raw_description: r.raw_description,
    metadata: (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>,
    available_cash: safeParseFloat(r.available_cash),
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
  // Require minimum 8 chars for substring matching to reduce false positives
  if (cn.length >= 8 && cp.length >= 8 && (cn.includes(cp) || cp.includes(cn))) return true
  
  // Extract organization name from parentheses in customer name
  // Handles cases where bank shows org name but invoice is under contact name
  if (customerName) {
    const orgMatch = customerName.match(/\(([^)]+)\)/)
    if (orgMatch) {
      const orgName = normalizeEntityName(orgMatch[1])
      if (orgName && cp && orgName.length >= 8 && (orgName.includes(cp) || cp.includes(orgName))) {
        return true
      }
      // Also check against raw description for org name
      const rawDesc = normalizeEntityName(movement.raw_description)
      if (orgName && rawDesc && orgName.length >= 8 && (rawDesc.includes(orgName) || orgName.includes(rawDesc.slice(0, 20)))) {
        return true
      }
      // Check if bank label or raw description contains the org name
      if (orgName && orgName.length >= 6) {
        const bankLabelNorm = normalizeEntityName(bankLabel)
        if (bankLabelNorm && bankLabelNorm.includes(orgName)) {
          return true
        }
      }
      // Handle abbreviations (e.g., abbreviated state/city names matching full names)
      // Extract significant words from org name and check if they appear in bank label
      const ENTITY_STOPWORDS = new Set(["city","team","west","east","north","south","tech","data","home","care","blue","state","food","foods","group","sports","sport"])
      const orgWords = (orgMatch[1] || "").toLowerCase().split(/\s+/).filter(w => w.length >= 5 && !ENTITY_STOPWORDS.has(w))
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
      const orgWords2 = (orgMatch[1] || "").toLowerCase().split(/\s+/).filter(w => w.length >= 5 && !new Set(["city","team","west","east","north","south","tech","data","home","care","blue","state","food","foods","group","sports","sport"]).has(w))
      for (const word of orgWords2) {
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
     ORDER BY expected_date ASC, id ASC`,
    [userId],
  )
  return parseCashEventRows(rows)
}

async function loadOpenCashEventsWithLock(userId: string, client: PoolClient): Promise<MutableCashEvent[]> {
  const { rows } = await client.query<
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
     ORDER BY expected_date ASC, id ASC
     FOR UPDATE`,
    [userId],
  )
  return parseCashEventRows(rows)
}

function parseCashEventRows(rows: Array<CashEventRow & { amount: string; outstanding_amount: string | null; expected_date: string }>): MutableCashEvent[] {
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
  const originalStatusById = new Map<string, string>()
  const originalOutstandingById = new Map<string, number>()
  for (const e of await loadOpenCashEvents(userId)) {
    eventById.set(e.id, e)
    originalStatusById.set(e.id, e.status)
    originalOutstandingById.set(e.id, e.outstanding_amount)
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

  // Track paid events that have been matched in this run to prevent re-matching
  const usedPaidEventIds = new Set<string>()

  // ─── Phase 3: Anti-Greedy-Sweep Guards ──────────────────────────────────────
  // Per-movement match counters to prevent one movement from consuming many
  // unrelated invoices/bills across different entities.
  const MAX_MATCHES_PER_MOVEMENT = 3
  const MAX_PARTIAL_MATCHES_PER_MOVEMENT = 1
  const matchCountByMovement = new Map<string, number>()      // total AR/AP matches
  const partialCountByMovement = new Map<string, number>()    // partial matches only
  const matchedEntityByMovement = new Map<string, string>()   // first matched entity per movement

  function getMovementMatchCount(movId: string): number {
    return matchCountByMovement.get(movId) ?? 0
  }
  function getMovementPartialCount(movId: string): number {
    return partialCountByMovement.get(movId) ?? 0
  }
  function getMovementFirstEntity(movId: string): string | undefined {
    return matchedEntityByMovement.get(movId)
  }
  function recordMovementMatch(movId: string, entityId: string, isPartial: boolean): void {
    matchCountByMovement.set(movId, (matchCountByMovement.get(movId) ?? 0) + 1)
    if (isPartial) partialCountByMovement.set(movId, (partialCountByMovement.get(movId) ?? 0) + 1)
    if (!matchedEntityByMovement.has(movId)) matchedEntityByMovement.set(movId, entityId)
  }

  /** Get confidence penalty for Nth match on same movement. */
  function getMatchCountPenalty(matchCount: number): number {
    if (matchCount === 0) return 0        // 1st match: no penalty
    if (matchCount === 1) return -0.05    // 2nd match: -0.05
    if (matchCount === 2) return -0.10    // 3rd match: -0.10
    return -99                            // 4th+: reject
  }
  // ────────────────────────────────────────────────────────────────────────────

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
        (e.outstanding_amount > EPS || (e.status === "paid" && !usedPaidEventIds.has(e.id))) &&
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
      (a, b) => a.expected_date.localeCompare(b.expected_date) || a.id.localeCompare(b.id),
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

    const pushAttr = (opts: CreateAttributionOpts, matchedEventId?: string) => {
      if (matchedEventId && opts.metadata) {
        (opts.metadata as Record<string, unknown>).matched_event_id = matchedEventId
      }
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
      }, directLinkMatch.id)
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
      } else {
        // Mark this paid event as used so it won't be matched again in this run
        usedPaidEventIds.add(directLinkMatch.id)
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
      }, exactMatch.id)
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
      } else {
        // Mark this paid event as used so it won't be matched again in this run
        usedPaidEventIds.add(exactMatch.id)
      }
      touchedEventIds.add(exactMatch.id)
      continue
    }

    // --- Stage 2: processor fee band (AR inflow only, processor-like movements) ---
    if (isInflow && isProcessorLikeMovement(movement)) {
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
        }, feeMatch.id)
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
        } else {
          // Mark this paid event as used so it won't be matched again in this run
          usedPaidEventIds.add(feeMatch.id)
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

      // ─── Phase 3: Greedy Sweep Guards ──
      const currentMatchCount = getMovementMatchCount(movement.id)
      const currentPartialCount = getMovementPartialCount(movement.id)
      const firstMatchedEntity = getMovementFirstEntity(movement.id)

      // Reject if over match limit
      if (currentMatchCount >= MAX_MATCHES_PER_MOVEMENT) break

      // Enforce one-entity-per-movement: reject cross-entity matches
      if (firstMatchedEntity && firstMatchedEntity !== event.entity_id) {
        // Different entity — skip to avoid cross-entity contamination
        continue
      }

      // Reject if partial match limit reached (partial = movement < event amount)
      const wouldBePartial = (feeAssumed > 0 ? remainingCash / (1 - feeAssumed) : remainingCash) + EPS < eventAmount
      if (wouldBePartial && currentPartialCount >= MAX_PARTIAL_MATCHES_PER_MOVEMENT) break

      // Apply count-based confidence penalty
      const countPenalty = getMatchCountPenalty(currentMatchCount)
      if (countPenalty <= -99) break  // 4th+ match — hard reject
      // ────────────────────────────────────

      const purchasingPower = feeAssumed > 0 ? remainingCash / (1 - feeAssumed) : remainingCash

      if (purchasingPower + EPS >= eventAmount) {
        const gross = eventAmount
        const netApplied = feeAssumed > 0 ? gross * (1 - feeAssumed) : gross
        const feeAmt = Math.max(0, gross - netApplied)
        const catAdj = computeCategoryConfidenceAdjust(econ, event.metadata)
        const fifoConfidence = Math.min(0.92, Math.max(0.50, 0.82 + catAdj.adjustment + countPenalty))
        // Phase 7: Build confidence breakdown for JSONB storage
        const entityNameForConf = (event.metadata?.customer_name ?? event.metadata?.vendor_name ?? event.entity_id ?? "") as string
        const fifoBreakdown = buildSyncConfidenceBreakdown({
          movementAmount: movement.amount,
          targetAmount: gross,
          bankDescription: resolvedBankForMove ?? "",
          entityName: entityNameForConf,
          movementDate: movement.date ?? null,
          invoiceDueDate: event.expected_date ?? null,
          categoryAdjustment: catAdj.adjustment,
          matchSequenceIndex: currentMatchCount,
          waterfallStage: isHistoricalFifo ? "fifo_historical" : "fifo",
          matchMethod: "tolerance",
        })
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
          confidence: fifoConfidence,
          source: "rule",
          metadata: {
            fee_amount: feeAmt,
            match_method: "tolerance",
            waterfall_stage: isHistoricalFifo ? "fifo_historical" : "fifo",
            is_historical_reconciliation: isHistoricalFifo,
            category_adjustment: catAdj.adjustment !== 0 ? catAdj : undefined,
            match_sequence: currentMatchCount + 1,
          },
          confidenceEnvelope: breakdownToEnvelope(fifoBreakdown) as any,
          category: catAdj.movCategory ?? undefined,
        }, event.id)
        recordMovementMatch(movement.id, event.entity_id, false)
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
        } else {
          // Mark this paid event as used so it won't be matched again in this run
          usedPaidEventIds.add(event.id)
        }
        touchedEventIds.add(event.id)
        fifoTouched = true
      } else {
        const rawGross = feeAssumed > 0 ? remainingCash / (1 - feeAssumed) : remainingCash
        const grossApplied = Math.min(rawGross, eventAmount)
        const netApplied = feeAssumed > 0 ? grossApplied * (1 - feeAssumed) : grossApplied
        const feeAmt = Math.max(0, grossApplied - netApplied)
        const catAdjPartial = computeCategoryConfidenceAdjust(econ, event.metadata)
        const fifoPartialConf = Math.min(0.90, Math.max(0.50, 0.80 + catAdjPartial.adjustment + countPenalty))
        // Phase 7: Build confidence breakdown for partial match
        const entityNameForPartial = (event.metadata?.customer_name ?? event.metadata?.vendor_name ?? event.entity_id ?? "") as string
        const fifoPartialBreakdown = buildSyncConfidenceBreakdown({
          movementAmount: movement.amount,
          targetAmount: eventAmount,
          bankDescription: resolvedBankForMove ?? "",
          entityName: entityNameForPartial,
          movementDate: movement.date ?? null,
          invoiceDueDate: event.expected_date ?? null,
          categoryAdjustment: catAdjPartial.adjustment,
          matchSequenceIndex: currentMatchCount,
          waterfallStage: isHistoricalFifo ? "fifo_partial_historical" : "fifo_partial",
          matchMethod: "tolerance",
        })
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
          confidence: fifoPartialConf,
          source: "rule",
          metadata: {
            fee_amount: feeAmt,
            match_method: "tolerance",
            waterfall_stage: isHistoricalFifo ? "fifo_partial_historical" : "fifo_partial",
            is_historical_reconciliation: isHistoricalFifo,
            category_adjustment: catAdjPartial.adjustment !== 0 ? catAdjPartial : undefined,
            match_sequence: currentMatchCount + 1,
          },
          confidenceEnvelope: breakdownToEnvelope(fifoPartialBreakdown) as any,
          category: catAdjPartial.movCategory ?? undefined,
        }, event.id)
        recordMovementMatch(movement.id, event.entity_id, true)
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
          event.outstanding_amount = Math.max(0, event.outstanding_amount - grossApplied)
          event.status = statusFromOutstanding(event.outstanding_amount, event.amount)
        } else {
          // Mark this paid event as used so it won't be matched again in this run
          usedPaidEventIds.add(event.id)
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
  // Emit one grep-friendly JSON line for logs
  const wfPayload = {
    hypothesisId: "WF_SUMMARY",
    location: "reconciliation-waterfall.ts:runReconciliationWaterfall",
    message: "waterfall_stage_counts",
    data: debugWf,
    timestamp: Date.now(),
  }
  console.log("[reconciliation-waterfall:debug]", JSON.stringify(wfPayload))
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
    // #region agent log - hypothesis D: wrap queries to find the failing one
    try {
      // D4: Clear stale Stage 4 review metadata from previous runs
      await client.query(
        `UPDATE movements SET metadata = metadata - 'reconciliation_waterfall_review'
         WHERE user_id = $1::uuid AND metadata ? 'reconciliation_waterfall_review'`,
        [userId],
      )
      console.log("[waterfall] D4 query succeeded");
    } catch (err) {
      console.error("[waterfall] D4 query failed:", err instanceof Error ? err.message : String(err));
      throw err;
    }

    try {
      // D5: Delete previous waterfall attributions to ensure idempotency on re-run
      await client.query(
        `DELETE FROM movement_attributions
         WHERE user_id = $1 AND source = 'rule'
           AND metadata->>'waterfall_stage' IS NOT NULL`,
        [userId],
      )
      console.log("[waterfall] D5 query succeeded");
    } catch (err) {
      console.error("[waterfall] D5 query failed:", err instanceof Error ? err.message : String(err));
      throw err;
    }

    try {
      // D6: Re-load cash events inside transaction to avoid TOCTOU race.
      // Outstanding amounts may have changed since the initial load if a concurrent
      // waterfall was committed. Rebuild eventById from fresh data inside the txn.
      // Re-load cash events with row-level locking to prevent concurrent modification
      eventById.clear()
      for (const e of await loadOpenCashEventsWithLock(userId, client)) {
        eventById.set(e.id, e)
      }
      console.log("[waterfall] D6 query succeeded");
    } catch (err) {
      console.error("[waterfall] D6 query failed:", err instanceof Error ? err.message : String(err));
      throw err;
    }
    // #endregion

    // D7: Replay pending attributions against fresh cash events to compute correct outstanding amounts.
    // Use specific matched_event_id to avoid corrupting sibling events for the same entity.
    for (const opts of pendingAttributions) {
      if (opts.component_type !== 'ar' && opts.component_type !== 'ap') continue
      const eventId = (opts.metadata as Record<string, unknown>)?.matched_event_id as string | undefined
      if (eventId) {
        const ev = eventById.get(eventId)
        if (ev) {
          ev.outstanding_amount = Math.max(0, ev.outstanding_amount - opts.gross_amount)
          ev.status = statusFromOutstanding(ev.outstanding_amount, ev.amount)
          touchedEventIds.add(ev.id)
        }
      } else {
        const matchedEvents = [...eventById.values()].filter(e => e.entity_id === opts.entity_id)
        for (const ev of matchedEvents) {
          ev.outstanding_amount = Math.max(0, ev.outstanding_amount - opts.gross_amount)
          ev.status = statusFromOutstanding(ev.outstanding_amount, ev.amount)
          touchedEventIds.add(ev.id)
        }
      }
    }

    // #region agent log - hypothesis D: wrap insertAttributionWithClient
    for (let i = 0; i < pendingAttributions.length; i++) {
      const opts = pendingAttributions[i];
      try {
        await insertAttributionWithClient(client, opts)
        console.log(`[waterfall] insertAttributionWithClient ${i}/${pendingAttributions.length} succeeded`);
      } catch (err) {
        console.error(`[waterfall] insertAttributionWithClient ${i}/${pendingAttributions.length} failed:`, err instanceof Error ? err.message : String(err));
        console.error(`[waterfall] Failed attribution opts:`, { movementId: opts.movementId, componentType: opts.component_type, entityId: opts.entity_id });
        throw err;
      }
    }
    // #endregion

    // Write audit log entries for all pending attributions (best-effort, never blocks)
    const auditEntries: AuditLogEntry[] = pendingAttributions
      .filter((opts) => opts.component_type === "ar" || opts.component_type === "ap")
      .map((opts) => {
        const meta = opts.metadata as Record<string, unknown> | undefined
        return {
          userId,
          movementId: opts.movementId,
          matchMethod: String(meta?.match_method ?? "waterfall"),
          waterfallStage: meta?.waterfall_stage ? String(meta.waterfall_stage) : null,
          confidence: typeof opts.confidence === "number" ? opts.confidence : null,
          entityId: opts.entity_id ?? null,
          referenceId: opts.reference_id ?? null,
          amountMatched: typeof opts.gross_amount === "number" ? opts.gross_amount : null,
          semanticValid: null,
          crossEntityFlag: false,
        }
      })
    await bulkWriteAuditLog(client, userId, auditEntries)
    for (const id of touchedEventIds) {
      const ev = eventById.get(id)
      if (!ev) continue
      const originalStatus = originalStatusById.get(id)
      const originalOutstanding = originalOutstandingById.get(id)
      if (!originalStatus || originalOutstanding === undefined) continue
      
      const newStatus = statusFromOutstanding(ev.outstanding_amount, ev.amount)
      // Only log if status actually changed
      if (newStatus !== originalStatus || Math.abs(ev.outstanding_amount - originalOutstanding) > EPS) {
        await writeStatusChange(client, {
          cashEventId: ev.id,
          userId,
          fromStatus: originalStatus,
          toStatus: newStatus,
          fromOutstanding: originalOutstanding,
          toOutstanding: ev.outstanding_amount,
          triggeredBy: "waterfall",
          attributionId: null,
        })
      }
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
      amount: parseFloat(String(r.amount)),
      date: r.date,
      counterparty: r.counterparty,
      raw_description: r.raw_description,
      direction: r.direction as "inflow" | "outflow",
      remaining_cash: typeof rev.remaining_cash === "number" ? rev.remaining_cash : 0,
    }
  })
}

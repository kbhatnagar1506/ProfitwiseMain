// ─── Phase 1: Structural Tagging Engine ─────────────────────────────
//
// Reads canonical movements + entity graph + account data + families
// and produces MovementTag objects.
//
// Three tagging levels:
//   Level 1: Deterministic — transfer, bank fee, interest, refund, verification, opening balance
//   Level 2: Identity-aware — customer receipt, vendor payment, owner, processor
//   Level 3: Inference — cogs vs opex, recurrence, anomaly, first-seen counterparty

import { query, ensureMovementsSchema } from "@/lib/db"
import { log } from "@/lib/logger"
import { toMovementClass, computeStatePolicy, computeStateScope } from "@/lib/movement-types"
import type {
  CanonicalMovement,
  MovementTag,
  EconomicClass,
  CashflowBucket,
  CounterpartyRole,
  ReviewReason,
  UnresolvedImpact,
  OwnerDependency,
  WorkingCapitalSignals,
  SignalConfidence,
} from "@/lib/movement-types"

// ─── Entity context loaded from DB ──────────────────────────────────

type EntityRow = {
  id: string
  entity_type: string
  canonical_name: string
  confidence: number
}

type FamilyRow = {
  family_key: string
  dominant_type: string
  occurrence_count: number
}

type TagContext = {
  entities: Map<string, EntityRow>
  families: Map<string, FamilyRow>
  allCounterparties: Set<string>
  amountStats: { mean: number; stddev: number }
}

async function loadTagContext(userId: string, movements: CanonicalMovement[]): Promise<TagContext> {
  const entityRows = await query<EntityRow>(
    `SELECT id, entity_type, canonical_name, confidence FROM entities WHERE user_id = $1`,
    [userId]
  ).then((r) => r.rows)

  const entityMap = new Map<string, EntityRow>()
  for (const e of entityRows) {
    entityMap.set(e.id, e)
  }

  const familyRows = await query<FamilyRow>(
    `SELECT family_key, dominant_type, occurrence_count FROM movement_families WHERE user_id = $1`,
    [userId]
  ).then((r) => r.rows)

  const familyMap = new Map<string, FamilyRow>()
  for (const f of familyRows) {
    familyMap.set(f.family_key, f)
  }

  const allCp = new Set<string>()
  const amounts: number[] = []
  for (const m of movements) {
    const cp = (m.metadata?.counterparty as string) ?? null
    if (cp) allCp.add(cp.toLowerCase())
    amounts.push(m.amount)
  }

  const mean = amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0
  const variance = amounts.length > 1
    ? amounts.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (amounts.length - 1)
    : 0
  const stddev = Math.sqrt(variance)

  return { entities: entityMap, families: familyMap, allCounterparties: allCp, amountStats: { mean, stddev } }
}

// ─── Level 1: Deterministic tagging ─────────────────────────────────

type BaseTag = {
  economic_class: EconomicClass
  cashflow_bucket: CashflowBucket
  counterparty_role: CounterpartyRole
  is_operating: boolean
  is_financing: boolean
  is_investing: boolean
  is_owner_related: boolean
  hits_pnl: boolean
  hits_working_capital: boolean
}

const CLASS_TO_BASE: Record<string, BaseTag> = {
  internal_transfer: {
    economic_class: "transfer", cashflow_bucket: "transfer", counterparty_role: "bank",
    is_operating: false, is_financing: false, is_investing: false, is_owner_related: false,
    hits_pnl: false, hits_working_capital: false,
  },
  bank_fee: {
    economic_class: "bank_fee", cashflow_bucket: "opex_out", counterparty_role: "bank",
    is_operating: true, is_financing: false, is_investing: false, is_owner_related: false,
    hits_pnl: true, hits_working_capital: true,
  },
  interest: {
    economic_class: "interest", cashflow_bucket: "opex_out", counterparty_role: "bank",
    is_operating: true, is_financing: false, is_investing: false, is_owner_related: false,
    hits_pnl: true, hits_working_capital: false,
  },
  refund: {
    economic_class: "refund", cashflow_bucket: "contra_revenue", counterparty_role: "customer",
    is_operating: true, is_financing: false, is_investing: false, is_owner_related: false,
    hits_pnl: true, hits_working_capital: true,
  },
  bank_fee_refund: {
    economic_class: "bank_fee_refund", cashflow_bucket: "opex_out", counterparty_role: "bank",
    is_operating: true, is_financing: false, is_investing: false, is_owner_related: false,
    hits_pnl: true, hits_working_capital: true,
  },
  merchant_deposit: {
    economic_class: "processor_payout", cashflow_bucket: "settlement", counterparty_role: "processor",
    is_operating: false, is_financing: false, is_investing: false, is_owner_related: false,
    hits_pnl: false, hits_working_capital: false,
  },
  opening_balance: {
    economic_class: "opening_balance", cashflow_bucket: "unknown", counterparty_role: "bank",
    is_operating: false, is_financing: false, is_investing: false, is_owner_related: false,
    hits_pnl: false, hits_working_capital: false,
  },
  processor_fee: {
    economic_class: "processor_fee", cashflow_bucket: "settlement", counterparty_role: "processor",
    is_operating: true, is_financing: false, is_investing: false, is_owner_related: false,
    hits_pnl: true, hits_working_capital: false,
  },
  processor_payout: {
    economic_class: "processor_payout", cashflow_bucket: "settlement", counterparty_role: "processor",
    is_operating: false, is_financing: false, is_investing: false, is_owner_related: false,
    hits_pnl: false, hits_working_capital: false,
  },
  credit_card_payment: {
    economic_class: "debt_payment", cashflow_bucket: "financing_out", counterparty_role: "bank",
    is_operating: false, is_financing: true, is_investing: false, is_owner_related: false,
    hits_pnl: false, hits_working_capital: true,
  },
  owner_contribution: {
    economic_class: "owner_contribution", cashflow_bucket: "financing_in", counterparty_role: "owner",
    is_operating: false, is_financing: true, is_investing: false, is_owner_related: true,
    hits_pnl: false, hits_working_capital: false,
  },
  owner_draw: {
    economic_class: "owner_draw", cashflow_bucket: "financing_out", counterparty_role: "owner",
    is_operating: false, is_financing: true, is_investing: false, is_owner_related: true,
    hits_pnl: false, hits_working_capital: false,
  },
}

function tagLevel1(m: CanonicalMovement): BaseTag | null {
  const base = CLASS_TO_BASE[m.movement_class]
  if (!base) return null

  const tag = { ...base }

  if (m.movement_class === "interest") {
    tag.cashflow_bucket = m.direction === "inflow" ? "revenue_in" : "opex_out"
  }
  if (m.movement_class === "refund") {
    if (m.direction === "outflow") {
      tag.cashflow_bucket = "contra_revenue"
      tag.counterparty_role = "customer"
    } else {
      tag.cashflow_bucket = "opex_out"
      tag.counterparty_role = "vendor"
    }
  }
  if (m.movement_class === "bank_fee_refund") {
    tag.cashflow_bucket = "opex_out"
  }
  if (m.movement_class === "opening_balance") {
    if (m.movement_type_detail === "account_verification") {
      tag.economic_class = "account_verification"
    } else if (m.movement_type_detail === "balance_adjustment") {
      tag.economic_class = "system_adjustment"
    }
  }

  return tag
}

// ─── Level 2: Identity-aware tagging ────────────────────────────────

const ENTITY_TYPE_TO_ROLE: Record<string, CounterpartyRole> = {
  customer: "customer",
  vendor: "vendor",
  owner: "owner",
  employee: "employee",
  processor: "processor",
  bank_account: "bank",
  tax_authority: "tax_authority",
  lender: "lender",
  internal: "bank",
  unknown: "unknown",
}

function tagLevel2(m: CanonicalMovement, ctx: TagContext): BaseTag {
  const detail = m.movement_type_detail

  if (m.movement_class === "customer_cash_in") {
    return {
      economic_class: "customer_receipt",
      cashflow_bucket: "revenue_in",
      counterparty_role: resolveRole(m, ctx, "customer"),
      is_operating: true, is_financing: false, is_investing: false, is_owner_related: false,
      hits_pnl: true, hits_working_capital: true,
    }
  }

  if (m.movement_class === "vendor_cash_out") {
    const role = resolveRole(m, ctx, "vendor")
    let eclass: EconomicClass = "vendor_payment"
    let bucket: CashflowBucket = "opex_out"

    if (detail === "cash_out_payroll") {
      eclass = "payroll"
    } else if (detail === "cash_out_tax") {
      eclass = "tax"
      return {
        economic_class: eclass, cashflow_bucket: "opex_out",
        counterparty_role: "tax_authority",
        is_operating: true, is_financing: false, is_investing: false, is_owner_related: false,
        hits_pnl: true, hits_working_capital: true,
      }
    }

    if (role === "employee") {
      eclass = "payroll"
    }

    return {
      economic_class: eclass, cashflow_bucket: bucket, counterparty_role: role,
      is_operating: true, is_financing: false, is_investing: false, is_owner_related: false,
      hits_pnl: true, hits_working_capital: true,
    }
  }

  if (m.movement_class === "unknown") {
    const role = resolveRole(m, ctx, "unknown")
    const isLoan = detail === "loan_funding" || detail === "loan_principal_payment"
    if (isLoan) {
      return {
        economic_class: "debt_payment",
        cashflow_bucket: m.direction === "inflow" ? "financing_in" : "financing_out",
        counterparty_role: role === "unknown" ? "lender" : role,
        is_operating: false, is_financing: true, is_investing: false, is_owner_related: false,
        hits_pnl: false, hits_working_capital: false,
      }
    }

    return {
      economic_class: "unknown",
      cashflow_bucket: "unknown",
      counterparty_role: role,
      is_operating: false, is_financing: false, is_investing: false, is_owner_related: false,
      hits_pnl: false, hits_working_capital: false,
    }
  }

  return {
    economic_class: "unknown", cashflow_bucket: "unknown", counterparty_role: "unknown",
    is_operating: false, is_financing: false, is_investing: false, is_owner_related: false,
    hits_pnl: false, hits_working_capital: false,
  }
}

function resolveRole(m: CanonicalMovement, ctx: TagContext, fallback: CounterpartyRole): CounterpartyRole {
  if (m.entity_id) {
    const entity = ctx.entities.get(m.entity_id)
    if (entity) {
      return ENTITY_TYPE_TO_ROLE[entity.entity_type] ?? fallback
    }
  }

  const cpEntityType = m.metadata?.counterparty_entity_type as string | undefined
  if (cpEntityType) {
    return ENTITY_TYPE_TO_ROLE[cpEntityType] ?? fallback
  }

  return fallback
}

// ─── Level 3: Inference — recurrence, anomaly, first-seen ───────────

function familyKeyFromMovement(m: CanonicalMovement): string {
  const desc = (m.raw_description ?? "").toLowerCase().replace(/\d{4,}/g, "NNNNN").replace(/\s+/g, " ").trim().slice(0, 40)
  const accountName = (m.metadata?.cash_account_name as string) ?? (m.account_id ?? "?")
  return `${m.direction}|${accountName}|${desc}`
}

type InferenceFlags = {
  recurrence_family_id: string | null
  is_recurring: boolean
  is_anomaly: boolean
  is_large_outlier: boolean
  is_first_seen_counterparty: boolean
}

function tagLevel3(
  m: CanonicalMovement,
  ctx: TagContext,
  seenCounterparties: Set<string>,
): InferenceFlags {
  const key = familyKeyFromMovement(m)
  const family = ctx.families.get(key)

  const is_recurring = family ? family.occurrence_count >= 3 : false
  const recurrence_family_id = family ? family.family_key : null

  const { mean, stddev } = ctx.amountStats
  const is_large_outlier = stddev > 0 && m.amount > mean + 3 * stddev
  const is_anomaly = stddev > 0 && m.amount > mean + 2.5 * stddev

  const cp = (m.metadata?.counterparty as string) ?? null
  let is_first_seen_counterparty = false
  if (cp) {
    const cpKey = cp.toLowerCase()
    if (!seenCounterparties.has(cpKey)) {
      is_first_seen_counterparty = true
      seenCounterparties.add(cpKey)
    }
  }

  return { recurrence_family_id, is_recurring, is_anomaly, is_large_outlier, is_first_seen_counterparty }
}

// ─── Link IDs from metadata ─────────────────────────────────────────

function extractLinkIds(m: CanonicalMovement, base: BaseTag): {
  customer_id: string | null
  vendor_id: string | null
  processor_id: string | null
  order_id: string | null
  invoice_id: string | null
  bill_id: string | null
} {
  const md = m.metadata ?? {}
  return {
    customer_id: base.counterparty_role === "customer" ? (m.entity_id ?? null) : null,
    vendor_id: base.counterparty_role === "vendor" ? (m.entity_id ?? null) : null,
    processor_id: base.counterparty_role === "processor" ? (m.entity_id ?? null) : null,
    order_id: (md.order_id as string) ?? null,
    invoice_id: (md.invoice_id as string) ?? null,
    bill_id: (md.bill_id as string) ?? null,
  }
}

// ─── Main: Tag all movements for a user ─────────────────────────────

export async function tagMovements(userId: string): Promise<{
  tags: MovementTag[]
  stats: { total: number; deterministic: number; identity_aware: number; inferred: number; recurring: number; anomalies: number; first_seen: number; policy_include: number; policy_provisional: number; policy_exclude: number }
  unresolved_impact: UnresolvedImpact
  owner_dependency: OwnerDependency
  working_capital: WorkingCapitalSignals
}> {
  await ensureMovementsSchema()

  const movements = await query<CanonicalMovement & { movement_type: string }>(
    `SELECT m.id, m.user_id, m.date AS occurred_at, m.direction, m.amount::float,
            m.currency, m.raw_description, m.movement_type,
            m.counterparty_entity_id AS entity_id, m.cash_account_id AS account_id,
            m.pnl_eligible, m.confidence, m.review_needed AS needs_review,
            m.provenance, m.coalesced_group_id, m.metadata
     FROM movements m WHERE m.user_id = $1
     ORDER BY m.date DESC`,
    [userId]
  ).then((r) => r.rows.map((row) => {
    const conf = (row.confidence as unknown as Record<string, number>) ?? {}
    const md = (row.metadata ?? {}) as Record<string, unknown>
    return {
      ...row,
      amount: typeof row.amount === "string" ? parseFloat(row.amount) : row.amount,
      movement_class: "unknown",
      movement_type_detail: row.movement_type ?? "unknown",
      source_record_ids: [],
      confidence: conf.score ?? 0,
      evidence_strength: conf.evidence_strength ?? 0,
      review_reasons: (Array.isArray(md.review_reasons) ? md.review_reasons : []) as ReviewReason[],
      metadata: { ...md, cash_account_name: row.account_id },
    } as CanonicalMovement
  }))

  const ctx = await loadTagContext(userId, movements)

  const tags: MovementTag[] = []
  const seenCounterparties = new Set<string>()
  const stats = { total: 0, deterministic: 0, identity_aware: 0, inferred: 0, recurring: 0, anomalies: 0, first_seen: 0, policy_include: 0, policy_provisional: 0, policy_exclude: 0 }

  for (const m of movements) {
    // DB stores movement_type, not movement_class — map it
    (m as { movement_class: string }).movement_class = toMovementClass(m.movement_type_detail)

    stats.total++

    // Level 1: deterministic
    let base = tagLevel1(m)
    if (base) {
      stats.deterministic++
    } else {
      // Level 2: identity-aware
      base = tagLevel2(m, ctx)
      stats.identity_aware++
    }

    // Level 3: inference
    const inference = tagLevel3(m, ctx, seenCounterparties)
    stats.inferred++
    if (inference.is_recurring) stats.recurring++
    if (inference.is_anomaly) stats.anomalies++
    if (inference.is_first_seen_counterparty) stats.first_seen++

    const links = extractLinkIds(m, base)

    const policy = computeStatePolicy(m.confidence, m.evidence_strength, m.needs_review)
    const scope = computeStateScope(base.economic_class, base.cashflow_bucket, base.hits_working_capital)

    tags.push({
      movement_id: m.id,

      economic_class: base.economic_class,
      cashflow_bucket: base.cashflow_bucket,
      counterparty_role: base.counterparty_role,

      is_operating: base.is_operating,
      is_financing: base.is_financing,
      is_investing: base.is_investing,
      is_owner_related: base.is_owner_related,
      hits_pnl: base.hits_pnl,
      hits_working_capital: base.hits_working_capital,

      state_scope: scope,
      state_inclusion_policy: policy,
      classification_confidence: m.confidence,
      evidence_strength: m.evidence_strength,
      needs_review: m.needs_review,
      review_reasons: m.review_reasons,

      entity_id: m.entity_id,
      customer_id: links.customer_id,
      vendor_id: links.vendor_id,
      processor_id: links.processor_id,
      account_id: m.account_id,
      order_id: links.order_id,
      invoice_id: links.invoice_id,
      bill_id: links.bill_id,

      recurrence_family_id: inference.recurrence_family_id,
      is_recurring: inference.is_recurring,
      is_anomaly: inference.is_anomaly,
      is_large_outlier: inference.is_large_outlier,
      is_first_seen_counterparty: inference.is_first_seen_counterparty,
    })

    if (policy === "include") stats.policy_include++
    else if (policy === "include_provisional") stats.policy_provisional++
    else stats.policy_exclude++
  }

  // ─── Derived metrics ──────────────────────────────────────────────
  const unresolved_impact = computeUnresolvedImpact(movements, tags)
  const owner_dependency = computeOwnerDependency(movements, tags)
  const working_capital = computeWorkingCapitalSignals(movements, tags)

  // Persist tags
  await persistTags(userId, tags)

  log("movements.tag.done", { userId, ...stats, unresolved: unresolved_impact, owner_dep: owner_dependency.owner_dependency_ratio }, "movements")
  return { tags, stats, unresolved_impact, owner_dependency, working_capital }
}

// ─── Persist tags to DB ─────────────────────────────────────────────

async function persistTags(userId: string, tags: MovementTag[]): Promise<void> {
  if (tags.length === 0) return

  await query("DELETE FROM movement_tags WHERE movement_id IN (SELECT id FROM movements WHERE user_id = $1)", [userId])

  const BATCH_SIZE = 50
  for (let i = 0; i < tags.length; i += BATCH_SIZE) {
    const batch = tags.slice(i, i + BATCH_SIZE)
    const values: string[] = []
    const params: unknown[] = []
    let idx = 0

    for (const t of batch) {
      const offsets = Array.from({ length: 5 }, (_, k) => `$${idx + k + 1}`)
      values.push(`(${offsets.join(", ")})`)
      params.push(
        t.movement_id,
        t.economic_class,
        t.cashflow_bucket,
        t.counterparty_role,
        JSON.stringify({
          state_scope: t.state_scope,
          state_inclusion_policy: t.state_inclusion_policy,
          is_operating: t.is_operating,
          is_financing: t.is_financing,
          is_investing: t.is_investing,
          is_owner_related: t.is_owner_related,
          hits_pnl: t.hits_pnl,
          hits_working_capital: t.hits_working_capital,
          classification_confidence: t.classification_confidence,
          evidence_strength: t.evidence_strength,
          needs_review: t.needs_review,
          review_reasons: t.review_reasons,
          entity_id: t.entity_id,
          customer_id: t.customer_id,
          vendor_id: t.vendor_id,
          processor_id: t.processor_id,
          account_id: t.account_id,
          order_id: t.order_id,
          invoice_id: t.invoice_id,
          bill_id: t.bill_id,
          recurrence_family_id: t.recurrence_family_id,
          is_recurring: t.is_recurring,
          is_anomaly: t.is_anomaly,
          is_large_outlier: t.is_large_outlier,
          is_first_seen_counterparty: t.is_first_seen_counterparty,
        }),
      )
      idx += 5
    }

    await query(
      `INSERT INTO movement_tags (movement_id, economic_class, cashflow_bucket, counterparty_role, tag_data)
       VALUES ${values.join(", ")}
       ON CONFLICT (movement_id) DO UPDATE SET
         economic_class = EXCLUDED.economic_class,
         cashflow_bucket = EXCLUDED.cashflow_bucket,
         counterparty_role = EXCLUDED.counterparty_role,
         tag_data = EXCLUDED.tag_data,
         updated_at = NOW()`,
      params,
    )
  }
}

// ─── Derived: Unresolved Impact (unknown = risk) ────────────────────

function computeUnresolvedImpact(movements: CanonicalMovement[], tags: MovementTag[]): UnresolvedImpact {
  let unresolvedIn = 0
  let unresolvedOut = 0
  let count = 0
  let operatingExposure = 0
  let totalInflow = 0
  let operatingInflow = 0
  let last30dCash = 0
  let unresolvedLast30d = 0

  const now = Date.now()
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000

  for (let i = 0; i < movements.length; i++) {
    const m = movements[i]
    const t = tags[i]
    const ts = new Date(m.occurred_at).getTime()
    const isRecent = !isNaN(ts) && (now - ts) <= thirtyDaysMs

    if (m.direction === "inflow") {
      totalInflow += m.amount
      if (t.state_scope.affects_operating_performance) operatingInflow += m.amount
    }
    if (isRecent) last30dCash += m.amount

    if (t.economic_class !== "unknown") continue

    count++
    if (m.direction === "inflow") unresolvedIn += m.amount
    else unresolvedOut += m.amount
    if (m.amount > 500) operatingExposure += m.amount
    if (isRecent) unresolvedLast30d += m.amount
  }

  const r2 = (n: number) => Math.round(n * 100) / 100
  const pct = (num: number, den: number) => den > 0 ? Math.round((num / den) * 1000) / 10 : 0

  return {
    unresolved_inflow_total: r2(unresolvedIn),
    unresolved_outflow_total: r2(unresolvedOut),
    unresolved_count: count,
    unresolved_operating_exposure: r2(operatingExposure),
    unresolved_pct_of_inflows: pct(unresolvedIn, totalInflow),
    unresolved_pct_of_operating_inflows: pct(unresolvedIn, operatingInflow),
    unresolved_pct_of_last_30d: pct(unresolvedLast30d, last30dCash),
  }
}

// ─── Derived: Owner Dependency ──────────────────────────────────────

function computeOwnerDependency(movements: CanonicalMovement[], tags: MovementTag[]): OwnerDependency {
  let ownerInflowTotal = 0
  let ownerDrawTotal = 0
  let totalInflow = 0
  let contributionCount = 0
  let drawCount = 0

  for (let i = 0; i < movements.length; i++) {
    const m = movements[i]
    const t = tags[i]

    if (m.direction === "inflow" && t.state_inclusion_policy !== "exclude_and_review") {
      totalInflow += m.amount
    }

    if (t.economic_class === "owner_contribution") {
      ownerInflowTotal += m.amount
      contributionCount++
    }
    if (t.economic_class === "owner_draw") {
      ownerDrawTotal += m.amount
      drawCount++
    }
  }

  const ratio = totalInflow > 0 ? ownerInflowTotal / totalInflow : 0

  return {
    owner_inflow_total: Math.round(ownerInflowTotal * 100) / 100,
    total_inflow: Math.round(totalInflow * 100) / 100,
    owner_dependency_ratio: Math.round(ratio * 1000) / 1000,
    owner_draw_total: Math.round(ownerDrawTotal * 100) / 100,
    net_owner_flow: Math.round((ownerInflowTotal - ownerDrawTotal) * 100) / 100,
    contribution_count: contributionCount,
    draw_count: drawCount,
  }
}

// ─── Derived: Working Capital Signals ───────────────────────────────

function computeWorkingCapitalSignals(movements: CanonicalMovement[], tags: MovementTag[]): WorkingCapitalSignals {
  const settlementDates: number[] = []
  const customerReceiptDates: number[] = []
  const inflowDates: number[] = []
  const outflowDates: number[] = []

  for (let i = 0; i < movements.length; i++) {
    const m = movements[i]
    const t = tags[i]
    if (t.state_inclusion_policy === "exclude_and_review") continue

    const ts = new Date(m.occurred_at).getTime()
    if (isNaN(ts)) continue

    if (t.cashflow_bucket === "settlement") settlementDates.push(ts)
    if (t.economic_class === "customer_receipt") customerReceiptDates.push(ts)
    if (m.direction === "inflow" && t.state_scope.affects_revenue) inflowDates.push(ts)
    if (m.direction === "outflow" && t.state_scope.affects_spend) outflowDates.push(ts)
  }

  const sortAsc = (a: number, b: number) => a - b
  settlementDates.sort(sortAsc)
  customerReceiptDates.sort(sortAsc)
  inflowDates.sort(sortAsc)
  outflowDates.sort(sortAsc)

  const allDates = [...inflowDates, ...outflowDates, ...settlementDates]
  const dataSpanDays = allDates.length >= 2
    ? Math.round((Math.max(...allDates) - Math.min(...allDates)) / (1000 * 60 * 60 * 24))
    : 0

  const minSample = Math.min(inflowDates.length, outflowDates.length, settlementDates.length)
  const confidence: SignalConfidence =
    dataSpanDays >= 60 && minSample >= 10 ? "high" :
    dataSpanDays >= 30 && minSample >= 5 ? "medium" :
    minSample >= 3 ? "low" : "insufficient_data"

  const avgSettlementLag = computeAvgLag(customerReceiptDates, settlementDates)
  const inflowCadence = computeCadence(inflowDates)
  const outflowCadence = computeCadence(outflowDates)
  const inflowRegularity = computeRegularity(inflowDates)
  const outflowRegularity = computeRegularity(outflowDates)

  return {
    avg_settlement_lag_days: avgSettlementLag,
    avg_inflow_cadence_days: inflowCadence,
    avg_outflow_cadence_days: outflowCadence,
    inflow_regularity: inflowRegularity,
    outflow_regularity: outflowRegularity,
    confidence,
    sample_sizes: { settlements: settlementDates.length, revenue_inflows: inflowDates.length, spend_outflows: outflowDates.length },
    data_span_days: dataSpanDays,
  }
}

function computeAvgLag(receiptDates: number[], settlementDates: number[]): number | null {
  if (receiptDates.length < 2 || settlementDates.length < 2) return null

  const lags: number[] = []
  for (const sd of settlementDates) {
    let closest: number | null = null
    for (const rd of receiptDates) {
      if (rd <= sd) closest = rd
      else break
    }
    if (closest !== null) {
      lags.push((sd - closest) / (1000 * 60 * 60 * 24))
    }
  }
  if (lags.length === 0) return null
  return Math.round((lags.reduce((a, b) => a + b, 0) / lags.length) * 10) / 10
}

function computeCadence(dates: number[]): number | null {
  if (dates.length < 3) return null
  const gaps: number[] = []
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24))
  }
  return Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10
}

function computeRegularity(dates: number[]): number {
  if (dates.length < 3) return 0
  const gaps: number[] = []
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24))
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  if (mean === 0) return 0
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length
  const cv = Math.sqrt(variance) / mean
  return Math.round(Math.max(0, 1 - cv) * 100) / 100
}

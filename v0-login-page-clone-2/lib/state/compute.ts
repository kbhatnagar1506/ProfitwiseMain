// ─── State Computation Engine ────────────────────────────────────────
//
// Reads MovementTag[] (from frozen schema) and produces the 3 core state
// objects + 5 transition detectors.
//
// CORE PRIMITIVE: economic_class (not cashflow_bucket). Bucket is derived.
//
// Rules:
//   - Only tags with state_inclusion_policy !== "exclude_and_review" enter state
//   - EXCEPTION: contra revenue (refunds) ALWAYS included — a refund is a refund
//   - StateScope gates which metric domain each movement affects
//   - Settlement NEVER enters revenue or spend
//   - Provisional movements are counted but tracked separately

import type { MovementTag, CanonicalMovement } from "@/lib/movement-types"

function isRevenueInflow(ec: string): boolean {
  return ec === "customer_receipt" || ec === "settlement_in"
}
function isContraRevenue(ec: string): boolean {
  return ec === "refund"
}
function isOpexOut(ec: string): boolean {
  return ["vendor_payment", "payroll", "bank_fee", "processor_fee", "tax"].includes(ec)
}
function isSettlement(ec: string): boolean {
  return ec === "processor_payout" || ec === "settlement_adjustment"
}
function isTransfer(ec: string): boolean {
  return ec === "transfer"
}
import type { RevenueState, SpendState, LiquidityState, TransitionSignal, SeverityBand, AccountCash, SpendBreakdownEntry, LiquidityRegime, SettlementLagSignal } from "./types"
import { CONCENTRATION, concentrationLabelFromPct, concentrationAdverb } from "./constants"
import { normalizeAccountDisplayName } from "@/lib/alias-normalize"

type TaggedMovement = CanonicalMovement & { tag: MovementTag }

function parseDate(s: string): number {
  const d = new Date(s)
  return isNaN(d.getTime()) ? 0 : d.getTime()
}

function daysBetween(a: string, b: string): number {
  const ta = parseDate(a)
  const tb = parseDate(b)
  if (!ta || !tb) return 0
  return Math.round((tb - ta) / (24 * 60 * 60 * 1000))
}

const SUPPLIER_PATTERNS = [
  /\b(wholesale|supply|inventory|material|shipping|freight|fulfillment|warehouse|merchandise|product\s*cost)\b/i,
  /\b(usps|ups|fedex|dhl|shipstation|shipbob|flexport|amazon\s*ship)\b/i,
]

const r2 = (n: number) => Math.round(n * 100) / 100
const pct1 = (n: number, d: number) => d > 0 ? Math.round((n / d) * 1000) / 10 : 0

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Revenue State ──────────────────────────────────────────────────

export function computeRevenueState(
  movements: TaggedMovement[],
  periodStart: string,
  periodEnd: string,
): RevenueState {
  let grossRevenue = 0
  let recurringRevenue = 0
  let contraRevenue = 0
  let provisionalRevenue = 0
  let excludedRevenue = 0

  const customerTotals = new Map<string, { name: string; total: number; count: number }>()

  for (const m of movements) {
    const t = m.tag
    if (!t.state_scope.affects_revenue) continue

    const ec = t.economic_class
    const isContra = isContraRevenue(ec)
    const isRevIn = isRevenueInflow(ec)

    // Contra revenue (refunds) always included — they MUST reduce net revenue
    if (isContra) {
      contraRevenue += m.amount
      continue
    }

    if (t.state_inclusion_policy === "exclude_and_review") {
      if (isRevIn) excludedRevenue += m.amount
      continue
    }

    if (isRevIn) {
      grossRevenue += m.amount
      if (t.is_recurring) recurringRevenue += m.amount
      if (t.state_inclusion_policy === "include_provisional") provisionalRevenue += m.amount

      const key = m.entity_id ?? m.raw_description ?? "unknown"
      const existing = customerTotals.get(key)
      if (existing) {
        existing.total += m.amount
        existing.count++
      } else {
        const name = (m.metadata?.counterparty as string) ?? key
        customerTotals.set(key, { name, total: m.amount, count: 1 })
      }
    }
  }

  const netRevenue = grossRevenue - contraRevenue
  const repeatRevenueRatio = grossRevenue > 0 ? recurringRevenue / grossRevenue : 0
  const customerEntries = [...customerTotals.entries()].sort((a, b) => b[1].total - a[1].total)
  const customerCount = customerEntries.length
  const avgReceipt = customerCount > 0 ? grossRevenue / customerEntries.reduce((s, [, c]) => s + c.count, 0) : 0
  const topCustomerPct = customerCount > 0 && grossRevenue > 0 ? customerEntries[0][1].total / grossRevenue : 0

  let hhi = 0
  for (const [, c] of customerEntries) {
    const share = grossRevenue > 0 ? c.total / grossRevenue : 0
    hhi += share * share
  }

  return {
    period_start: periodStart,
    period_end: periodEnd,
    gross_revenue: r2(grossRevenue),
    contra_revenue: r2(contraRevenue),
    net_revenue: r2(netRevenue),
    customer_count: customerCount,
    avg_receipt: r2(avgReceipt),
    top_customer_pct: pct1(topCustomerPct, 1),
    concentration_index: Math.round(hhi * 1000) / 1000,
    repeat_revenue_ratio: Math.round(repeatRevenueRatio * 1000) / 1000,
    revenue_by_customer: customerEntries.slice(0, 10).map(([key, c]) => ({
      entity_id: UUID_RE.test(key) ? key : null,
      name: c.name,
      total: r2(c.total),
      count: c.count,
    })),
    provisional_revenue: r2(provisionalRevenue),
    excluded_revenue: r2(excludedRevenue),
  }
}

// ─── Spend State ────────────────────────────────────────────────────

export function computeSpendState(
  movements: TaggedMovement[],
  periodStart: string,
  periodEnd: string,
): SpendState {
  let totalOpex = 0
  let totalCogs = 0
  let directCostCandidates = 0
  let payroll = 0
  let vendorPayments = 0
  let bankFees = 0
  let taxes = 0
  let processorFees = 0
  let provisionalSpend = 0
  let excludedSpend = 0
  let recurringObligations = 0
  let recurringObligationCount = 0
  let recurringFixedContractual = 0
  let recurringSoft = 0
  let recurringDiscretionary = 0
  let nonRecurringSpend = 0

  const vendorTotals = new Map<string, { name: string; total: number; count: number }>()

  function isDirectCostCandidate(m: TaggedMovement): boolean {
    const desc = (m.raw_description ?? "").toLowerCase()
    const cp = ((m.metadata?.counterparty as string) ?? "").toLowerCase()
    const combined = `${desc} ${cp}`
    return SUPPLIER_PATTERNS.some((p) => p.test(combined))
  }

  for (const m of movements) {
    const t = m.tag
    if (!t.state_scope.affects_spend) continue

    if (t.state_inclusion_policy === "exclude_and_review") {
      excludedSpend += m.amount
      continue
    }

    if (t.state_inclusion_policy === "include_provisional") provisionalSpend += m.amount

  if (isOpexOut(t.economic_class)) totalOpex += m.amount
  if (t.cashflow_bucket === "cogs_out") totalCogs += m.amount

    if (t.economic_class === "vendor_payment") {
      vendorPayments += m.amount
      if (t.is_recurring || isDirectCostCandidate(m)) directCostCandidates += m.amount
    }

    switch (t.economic_class) {
      case "payroll": payroll += m.amount; break
      case "bank_fee": case "bank_fee_refund": bankFees += m.amount; break
      case "tax": taxes += m.amount; break
      case "processor_fee": processorFees += m.amount; break
    }

    if (t.is_recurring) {
      recurringObligations += m.amount
      recurringObligationCount++
      const ec = t.economic_class
      if (ec === "payroll" || ec === "bank_fee" || ec === "bank_fee_refund" || ec === "tax" || ec === "processor_fee") {
        recurringFixedContractual += m.amount
      } else if (ec === "vendor_payment") {
        recurringSoft += m.amount
      } else {
        recurringDiscretionary += m.amount
      }
    } else {
      nonRecurringSpend += m.amount
    }

    if (t.counterparty_role === "vendor" || t.counterparty_role === "employee" || t.counterparty_role === "processor") {
      const key = m.entity_id ?? m.raw_description ?? "unknown"
      const existing = vendorTotals.get(key)
      if (existing) {
        existing.total += m.amount
        existing.count++
      } else {
        const name = (m.metadata?.counterparty as string) ?? key
        vendorTotals.set(key, { name, total: m.amount, count: 1 })
      }
    }
  }

  const totalSpend = totalOpex + totalCogs
  const vendorEntries = [...vendorTotals.entries()].sort((a, b) => b[1].total - a[1].total)
  const vendorCount = vendorEntries.length
  const avgPayment = vendorCount > 0 ? totalSpend / vendorEntries.reduce((s, [, v]) => s + v.count, 0) : 0
  const topVendorPct = vendorCount > 0 && totalSpend > 0 ? vendorEntries[0][1].total / totalSpend : 0

  let supplierHHI = 0
  for (const [, v] of vendorEntries) {
    const share = totalSpend > 0 ? v.total / totalSpend : 0
    supplierHHI += share * share
  }

  const spendByVendor: SpendBreakdownEntry[] = vendorEntries.slice(0, 10).map(([key, v]) => ({
    entity_id: UUID_RE.test(key) ? key : null,
    name: v.name,
    total: r2(v.total),
    count: v.count,
    pct_of_spend: pct1(v.total, totalSpend),
  }))

  return {
    period_start: periodStart,
    period_end: periodEnd,
    total_opex: r2(totalOpex),
    total_cogs: r2(totalCogs),
    direct_cost_candidates: r2(directCostCandidates),
    total_spend: r2(totalSpend),
    payroll: r2(payroll),
    vendor_payments: r2(vendorPayments),
    bank_fees: r2(bankFees),
    taxes: r2(taxes),
    processor_fees: r2(processorFees),
    recurring_obligations: r2(recurringObligations),
    recurring_obligation_count: recurringObligationCount,
    recurring_fixed_contractual: r2(recurringFixedContractual),
    recurring_soft: r2(recurringSoft),
    recurring_discretionary: r2(recurringDiscretionary),
    non_recurring_spend: r2(nonRecurringSpend),
    vendor_count: vendorCount,
    avg_payment: r2(avgPayment),
    top_vendor_pct: pct1(topVendorPct, 1),
    supplier_concentration_index: Math.round(supplierHHI * 1000) / 1000,
    spend_by_vendor: spendByVendor,
    provisional_spend: r2(provisionalSpend),
    excluded_spend: r2(excludedSpend),
  }
}

// ─── Settlement Lag (days between customer payment and settlement) ───

function computeSettlementLag(movements: TaggedMovement[]): SettlementLagSignal {
  const receiptDates: number[] = []
  const settlementEntries: { date: string }[] = []

  for (const m of movements) {
    const t = m.tag
    if (!t.state_scope.affects_revenue && !t.state_scope.affects_liquidity) continue
    if (t.state_inclusion_policy === "exclude_and_review") continue

    const d = m.occurred_at
    if (!d) continue

    if (isRevenueInflow(t.economic_class)) {
      const ts = parseDate(d)
      if (ts) receiptDates.push(ts)
    }
    if (isSettlement(t.economic_class) && m.direction === "inflow") {
      settlementEntries.push({ date: d })
    }
  }

  receiptDates.sort((a, b) => a - b)

  const lags: number[] = []
  for (const s of settlementEntries) {
    const settleTs = parseDate(s.date)
    if (!settleTs) continue
    const priorReceipts = receiptDates.filter((r) => r < settleTs)
    if (priorReceipts.length === 0) continue
    const lastReceipt = priorReceipts[priorReceipts.length - 1]
    const lag = Math.round((settleTs - lastReceipt) / (24 * 60 * 60 * 1000))
    if (lag >= 0 && lag <= 365) lags.push(lag)
  }

  const n = lags.length
  const avg = n > 0 ? lags.reduce((a, b) => a + b, 0) / n : 0
  const confidence: SettlementLagSignal["confidence"] =
    n >= 20 ? "high" : n >= 10 ? "medium" : n >= 3 ? "low" : "insufficient"

  return {
    avg_settlement_lag_days: Math.round(avg * 10) / 10,
    sample_count: n,
    confidence,
  }
}

// ─── Liquidity State ────────────────────────────────────────────────

export function computeLiquidityState(
  movements: TaggedMovement[],
  periodStart: string,
  periodEnd: string,
): LiquidityState {
  let totalIn = 0, totalOut = 0
  let opIn = 0, opOut = 0
  let finIn = 0, finOut = 0
  let settleIn = 0, settleOut = 0
  let ownerIn = 0, ownerOut = 0
  let excludedCash = 0
  let transferVolume = 0
  let transferCount = 0

  const accountFlows = new Map<string, AccountCash>()

  for (const m of movements) {
    const t = m.tag
    if (!t.state_scope.affects_liquidity) {
      if (isTransfer(t.economic_class)) {
        transferVolume += m.amount
        transferCount++
      }
      continue
    }

    if (t.state_inclusion_policy === "exclude_and_review") {
      excludedCash += m.amount
      continue
    }

    const amt = m.amount
    const isIn = m.direction === "inflow"

    if (isIn) totalIn += amt; else totalOut += amt

    if (t.is_operating && t.state_scope.affects_operating_performance) {
      if (isIn) opIn += amt; else opOut += amt
    }
    if (t.is_financing) {
      if (isIn) finIn += amt; else finOut += amt
    }
    if (isSettlement(t.economic_class)) {
      if (isIn) settleIn += amt; else settleOut += amt
    }
    if (t.is_owner_related) {
      if (isIn) ownerIn += amt; else ownerOut += amt
    }

    // account_id from DB is the account name; when unresolved use explicit label
    const acctName = (m.account_id && String(m.account_id).trim()) || null
    const acctKey = acctName ?? "__external_unknown__"
    const acctType = (m.metadata?.account_type as string) ?? ""
    const acctSubtype = (m.metadata?.account_subtype as string) ?? null
    const displayName = normalizeAccountDisplayName(acctName, acctType, acctSubtype)
    let acctEntry = accountFlows.get(acctKey)
    if (!acctEntry) {
      acctEntry = {
        account_id: acctKey,
        account_name: displayName,
        account_type: acctType,
        net_flow: 0, inflows: 0, outflows: 0, movement_count: 0,
      }
      accountFlows.set(acctKey, acctEntry)
    }
    acctEntry.movement_count++
    if (isIn) { acctEntry.inflows += amt } else { acctEntry.outflows += amt }
    acctEntry.net_flow = r2(acctEntry.inflows - acctEntry.outflows)
  }

  const cashByAccount = [...accountFlows.values()]
    .map((a) => ({ ...a, inflows: r2(a.inflows), outflows: r2(a.outflows), net_flow: r2(a.net_flow) }))
    .sort((a, b) => b.net_flow - a.net_flow)

  const totalFlow = totalIn + totalOut
  const transferDependencyRatio = totalFlow > 0 ? transferVolume / totalFlow : 0
  const ownerSupportRatio = totalIn > 0 ? ownerIn / totalIn : 0
  const operatingDependencyRatio = totalIn > 0 ? opIn / totalIn : 0
  const opRatio = totalIn > 0 ? (opIn - opOut) / totalIn : 0
  const liquidityRegime: LiquidityRegime = opRatio > 0.4 ? "strong" : opRatio >= 0.2 ? "stable" : "tightening"

  const settlementLag = computeSettlementLag(movements)

  // Calculate derived cash position metrics
  const periodDays = Math.max(1, daysBetween(periodStart, periodEnd))
  const avgDailyOutflow = totalOut / periodDays
  const netCashFlow = totalIn - totalOut
  
  // Burn rate: monthly operating outflow (what it costs to run the business)
  // Use operating outflows as the "burn" since that's what sustains the business
  // Ensure we have at least 7 days of data for a meaningful monthly projection
  const effectivePeriodDays = Math.max(7, periodDays)
  const monthlyBurnRate = (opOut / effectivePeriodDays) * 30
  
  // For starting/ending cash, we derive from net flows
  // Since we don't have actual bank balances here, we use the largest account's net flow as a proxy
  // In production, this should be fetched from Plaid balances
  const largestAccountBalance = cashByAccount.length > 0 
    ? Math.max(...cashByAccount.map(a => Math.abs(a.net_flow)))
    : 0
  
  // Estimate ending cash as the sum of positive net flows (money that came in and stayed)
  const endingCash = cashByAccount.reduce((sum, a) => sum + Math.max(0, a.net_flow), 0)
  const startingCash = endingCash - netCashFlow
  
  // Runway: how many days until cash runs out at current operating burn rate
  // Use daily operating burn (not total outflows which includes one-time items)
  const dailyOperatingBurn = opOut / effectivePeriodDays
  const runwayDays = dailyOperatingBurn > 0 && endingCash > 0
    ? Math.round(endingCash / dailyOperatingBurn)
    : null

  const bankAccountCount = cashByAccount.filter(a => a.account_id !== "__external_unknown__").length

  return {
    period_start: periodStart,
    period_end: periodEnd,
    total_inflows: r2(totalIn),
    total_outflows: r2(totalOut),
    period_net_cash_flow: r2(netCashFlow),
    operating_inflows: r2(opIn),
    operating_outflows: r2(opOut),
    net_operating: r2(opIn - opOut),
    financing_inflows: r2(finIn),
    financing_outflows: r2(finOut),
    net_financing: r2(finIn - finOut),
    settlement_inflows: r2(settleIn),
    settlement_outflows: r2(settleOut),
    net_settlement: r2(settleIn - settleOut),
    settlement_lag: settlementLag,
    owner_inflows: r2(ownerIn),
    owner_outflows: r2(ownerOut),
    net_owner: r2(ownerIn - ownerOut),
    cash_by_account: cashByAccount,
    transfer_dependency_ratio: Math.round(transferDependencyRatio * 1000) / 1000,
    owner_support_ratio: Math.round(ownerSupportRatio * 1000) / 1000,
    operating_dependency_ratio: Math.round(operatingDependencyRatio * 1000) / 1000,
    liquidity_regime: liquidityRegime,
    excluded_cash: r2(excludedCash),
    // New derived fields
    starting_cash: r2(startingCash),
    ending_cash: r2(endingCash),
    avg_daily_outflow: r2(avgDailyOutflow),
    burn_rate: r2(monthlyBurnRate),
    runway_days: runwayDays,
    bank_account_count: bankAccountCount,
    largest_account_balance: r2(largestAccountBalance),
    transfer_count: transferCount,
  }
}

// ─── State Confidence ───────────────────────────────────────────────
//
// Confidence must reflect excluded, unresolved, provisional, and low-confidence exposure.
// Never return 100% when excluded or unresolved exists.

function computeAreaConfidence(
  total: number,
  excluded: number,
  unresolved: number,
  provisional: number,
  lowConfAmount: number,
): number {
  if (total <= 0) return 100
  const exclShare = excluded / total
  const unrevShare = unresolved / total
  const provShare = provisional / total
  const lowShare = lowConfAmount / total
  const penalty = Math.min(1, exclShare * 0.5 + unrevShare * 0.4 + provShare * 0.15 + lowShare * 0.25)
  let conf = 1 - penalty
  if ((excluded > 0 || unresolved > 0) && conf >= 0.99) conf = 0.99
  return Math.round(conf * 1000) / 10
}

export function computeStateConfidence(
  movements: TaggedMovement[],
): { revenue_confidence: number; spend_confidence: number; liquidity_confidence: number } {
  let revTotal = 0, revExcluded = 0, revUnresolved = 0, revProvisional = 0, revLowConf = 0
  let spendTotal = 0, spendExcluded = 0, spendUnresolved = 0, spendProvisional = 0, spendLowConf = 0
  let liqTotal = 0, liqExcluded = 0, liqUnresolved = 0, liqProvisional = 0, liqLowConf = 0

  for (const m of movements) {
    const t = m.tag
    const conf = (t.classification_confidence ?? m.confidence ?? 0)
    const isLowConf = conf < 0.7
    const amt = m.amount

    if (t.state_scope.affects_revenue) {
      revTotal += amt
      if (t.state_inclusion_policy === "exclude_and_review") revExcluded += amt
      if (t.economic_class === "unknown") revUnresolved += amt
      if (t.state_inclusion_policy === "include_provisional") revProvisional += amt
      if (isLowConf) revLowConf += amt
    }
    if (t.state_scope.affects_spend) {
      spendTotal += amt
      if (t.state_inclusion_policy === "exclude_and_review") spendExcluded += amt
      if (t.economic_class === "unknown") spendUnresolved += amt
      if (t.state_inclusion_policy === "include_provisional") spendProvisional += amt
      if (isLowConf) spendLowConf += amt
    }
    if (t.state_scope.affects_liquidity) {
      liqTotal += amt
      if (t.state_inclusion_policy === "exclude_and_review") { liqExcluded += amt; liqUnresolved += amt }
      else if (t.economic_class === "unknown") liqUnresolved += amt
      if (t.state_inclusion_policy === "include_provisional") liqProvisional += amt
      if (isLowConf) liqLowConf += amt
    }
  }

  return {
    revenue_confidence: computeAreaConfidence(revTotal, revExcluded, revUnresolved, revProvisional, revLowConf),
    spend_confidence: computeAreaConfidence(spendTotal, spendExcluded, spendUnresolved, spendProvisional, spendLowConf),
    liquidity_confidence: computeAreaConfidence(liqTotal, liqExcluded, liqUnresolved, liqProvisional, liqLowConf),
  }
}

// ─── Severity Bands ─────────────────────────────────────────────────

function concentrationBand(topPct: number): SeverityBand {
  const band = concentrationLabelFromPct(topPct)
  return band === "critical" ? "critical" : band === "high" ? "high" : band === "moderate" ? "moderate" : "low"
}

function ownerBand(ownerPct: number): SeverityBand {
  if (ownerPct > 40) return "critical"
  if (ownerPct > 25) return "high"
  if (ownerPct > 10) return "elevated"
  if (ownerPct > 3) return "moderate"
  return "low"
}

function liquidityBand(netRatio: number): SeverityBand {
  if (netRatio < -0.1) return "critical"
  if (netRatio < 0) return "high"
  if (netRatio < 0.05) return "elevated"
  if (netRatio < 0.15) return "moderate"
  return "low"
}

function spendSpikeBand(ratio: number): SeverityBand {
  if (ratio > 2.0) return "critical"
  if (ratio > 1.5) return "high"
  if (ratio > 1.25) return "elevated"
  if (ratio > 1.1) return "moderate"
  return "low"
}

function settlementBand(settlePct: number): SeverityBand {
  if (settlePct < 5) return "low"
  if (settlePct < 15) return "moderate"
  if (settlePct < 30) return "elevated"
  if (settlePct < 50) return "high"
  return "critical"
}

function bandTransitioned(current: SeverityBand, previous: SeverityBand | null): boolean {
  if (!previous) return false
  return current !== previous
}

function bandDirection(current: SeverityBand, previous: SeverityBand | null): string {
  if (!previous || current === previous) return ""
  const order: SeverityBand[] = ["low", "moderate", "elevated", "high", "critical"]
  return order.indexOf(current) > order.indexOf(previous) ? "worsened" : "improved"
}

export type TransitionContext = {
  prior: { revenue_state: RevenueState; spend_state: SpendState; liquidity_state: LiquidityState } | null
  rolling: { revenue_state: RevenueState; spend_state: SpendState; liquidity_state: LiquidityState }[]
}

// ─── Transition Detectors ───────────────────────────────────────────

export function detectTransitions(
  revenue: RevenueState,
  spend: SpendState,
  liquidity: LiquidityState,
  ctx?: TransitionContext | null,
): TransitionSignal[] {
  const prior = ctx?.prior ?? null
  const rolling = ctx?.rolling ?? []
  const previousRevenue = prior?.revenue_state ?? null
  const previousSpend = prior?.spend_state ?? null
  const previousLiquidity = prior?.liquidity_state ?? null

  const signals: TransitionSignal[] = []

  // Rolling baseline for spend (mean of last N periods)
  const rollingSpendMean =
    rolling.length > 0
      ? rolling.reduce((s, r) => s + r.spend_state.total_spend, 0) / rolling.length
      : null
  const rollingSpendStd =
    rolling.length >= 3 && rollingSpendMean !== null
      ? Math.sqrt(
          rolling.reduce((s, r) => s + Math.pow(r.spend_state.total_spend - rollingSpendMean, 2), 0) / rolling.length
        )
      : null
  const spendBaseline = rollingSpendMean ?? previousSpend?.total_spend ?? spend.total_spend

  // 1. Revenue concentration
  const concCurrent = concentrationBand(revenue.top_customer_pct)
  const concPrev = previousRevenue ? concentrationBand(previousRevenue.top_customer_pct) : null
  const concTransitioned = bandTransitioned(concCurrent, concPrev)
  const concDir = bandDirection(concCurrent, concPrev)
  signals.push({
    signal: "revenue_concentration",
    severity: concCurrent === "critical" || concCurrent === "high" ? "critical" : concCurrent === "moderate" ? "warning" : "info",
    description: concTransitioned && concPrev
      ? `Concentration ${concDir}: ${concPrev} → ${concCurrent} (top customer ${revenue.top_customer_pct}%)`
      : `Concentration is ${concCurrent} (top customer ${revenue.top_customer_pct}%)`,
    current_band: concCurrent,
    previous_band: concPrev,
    current_state: concCurrent,
    previous_state: concPrev,
    regime_change: !!concTransitioned,
    current_value: revenue.top_customer_pct,
    previous_value: previousRevenue?.top_customer_pct ?? null,
    threshold: 50,
    triggered: concTransitioned || concCurrent === "high" || concCurrent === "critical",
  })

  // 2. Abnormal outflow spike (uses rolling baseline when available)
  const spendRatio = spendBaseline > 0 ? spend.total_spend / spendBaseline : 1
  const spikeCurrent = spendSpikeBand(spendRatio)
  const prevSpendRatio = previousSpend && spendBaseline > 0 ? previousSpend.total_spend / spendBaseline : 1
  const spikePrev = previousSpend ? spendSpikeBand(prevSpendRatio) : null
  const spikeTransitioned = previousSpend && bandTransitioned(spikeCurrent, spikePrev)
  const outsideVarianceBand =
    rollingSpendStd !== null && rollingSpendMean !== null && rollingSpendMean > 0
      ? Math.abs(spend.total_spend - rollingSpendMean) > 2 * rollingSpendStd
      : false
  signals.push({
    signal: "abnormal_outflow_spike",
    severity:
      outsideVarianceBand ? "warning"
      : spikeCurrent === "critical" || spikeCurrent === "high" ? "critical"
      : spikeCurrent === "elevated" ? "warning"
      : "info",
    description: spikeTransitioned
      ? `Spend moved from ${spikePrev ?? "stable"} → ${spikeCurrent} (${Math.round(spendRatio * 100)}% of ${rolling.length > 0 ? "rolling avg" : "prior"})`
      : outsideVarianceBand
        ? `Spend outside normal range (${Math.round(spendRatio * 100)}% of rolling avg, 2σ band)`
        : spikeCurrent !== "low"
          ? `Spend spike ${spikeCurrent} — ${Math.round(spendRatio * 100)}% of baseline`
          : `Spend is stable at ${Math.round(spendRatio * 100)}% of baseline`,
    current_band: spikeCurrent,
    previous_band: spikePrev,
    current_state: spikeCurrent,
    previous_state: spikePrev,
    regime_change: !!spikeTransitioned || !!outsideVarianceBand,
    current_value: Math.round(spendRatio * 100),
    previous_value: previousSpend ? Math.round(prevSpendRatio * 100) : 100,
    threshold: 150,
    triggered: spikeCurrent !== "low" || !!outsideVarianceBand,
  })

  // 3. Owner support dependency
  const ownerPct = liquidity.owner_support_ratio * 100
  const ownerCurrent = ownerBand(ownerPct)
  const prevOwnerPct = previousLiquidity ? previousLiquidity.owner_support_ratio * 100 : null
  const ownerPrev = prevOwnerPct !== null ? ownerBand(prevOwnerPct) : null
  const ownerTransitioned = bandTransitioned(ownerCurrent, ownerPrev)
  const ownerDir = bandDirection(ownerCurrent, ownerPrev)
  signals.push({
    signal: "owner_dependency",
    severity: ownerCurrent === "critical" || ownerCurrent === "high" ? "critical" : ownerCurrent === "elevated" ? "warning" : "info",
    description: ownerTransitioned && ownerPrev
      ? `Owner support ${ownerDir}: ${ownerPrev} → ${ownerCurrent} (${Math.round(ownerPct)}% of inflows)`
      : `Owner support is ${ownerCurrent} (${Math.round(ownerPct)}% of inflows)`,
    current_band: ownerCurrent,
    previous_band: ownerPrev,
    current_state: ownerCurrent,
    previous_state: ownerPrev,
    regime_change: !!ownerTransitioned,
    current_value: Math.round(ownerPct),
    previous_value: prevOwnerPct !== null ? Math.round(prevOwnerPct) : null,
    threshold: 25,
    triggered: ownerTransitioned || ownerCurrent === "high" || ownerCurrent === "critical",
  })

  // 4. Liquidity regime (strong / stable / tightening) — the real transition
  const prevRegime = previousLiquidity?.liquidity_regime ?? null
  const regimeChanged = prevRegime !== null && liquidity.liquidity_regime !== prevRegime
  const regimeLabel = (r: LiquidityRegime) => r === "strong" ? "strong" : r === "stable" ? "stable" : "tightening"
  signals.push({
    signal: "liquidity_regime",
    severity: liquidity.liquidity_regime === "tightening" ? "warning" : liquidity.liquidity_regime === "strong" ? "info" : "info",
    description: regimeChanged && prevRegime
      ? `Liquidity moved from ${regimeLabel(prevRegime)} → ${regimeLabel(liquidity.liquidity_regime)}`
      : `Liquidity is ${regimeLabel(liquidity.liquidity_regime)} (operating surplus ${Math.round((liquidity.net_operating / (liquidity.total_inflows || 1)) * 100)}% of inflows)`,
    current_band: liquidity.liquidity_regime === "strong" ? "low" : liquidity.liquidity_regime === "stable" ? "moderate" : "elevated",
    previous_band: prevRegime ? (prevRegime === "strong" ? "low" : prevRegime === "stable" ? "moderate" : "elevated") : null,
    current_state: regimeLabel(liquidity.liquidity_regime),
    previous_state: prevRegime ? regimeLabel(prevRegime) : null,
    regime_change: !!regimeChanged,
    current_value: Math.round((liquidity.net_operating / (liquidity.total_inflows || 1)) * 100),
    previous_value: previousLiquidity && previousLiquidity.total_inflows > 0
      ? Math.round((previousLiquidity.net_operating / previousLiquidity.total_inflows) * 100) : null,
    threshold: 20,
    triggered: regimeChanged || liquidity.liquidity_regime === "tightening",
  })

  // 5. Settlement lag change (time dimension)
  const lagNow = liquidity.settlement_lag?.avg_settlement_lag_days ?? 0
  const lagPrev = (previousLiquidity as LiquidityState & { settlement_lag?: { avg_settlement_lag_days: number } })?.settlement_lag?.avg_settlement_lag_days ?? null
  const lagIncreased = lagPrev !== null && lagNow > lagPrev * 1.2
  if (liquidity.settlement_lag?.confidence !== "insufficient" && lagNow > 0) {
    signals.push({
      signal: "settlement_lag",
      severity: lagIncreased ? "warning" : "info",
      description: lagIncreased && lagPrev !== null
        ? `Settlement lag increased: ${lagPrev.toFixed(1)}d → ${lagNow.toFixed(1)}d (customer payment to bank)`
        : `Avg settlement lag: ${lagNow.toFixed(1)} days (customer payment → bank)`,
      current_band: lagNow > 14 ? "elevated" : lagNow > 7 ? "moderate" : "low",
      previous_band: lagPrev !== null ? (lagPrev > 14 ? "elevated" : lagPrev > 7 ? "moderate" : "low") : null,
      current_state: `${lagNow.toFixed(1)}d`,
      previous_state: lagPrev !== null ? `${lagPrev.toFixed(1)}d` : null,
      regime_change: !!lagIncreased,
      current_value: Math.round(lagNow * 10) / 10,
      previous_value: lagPrev,
      threshold: 7,
      triggered: !!lagIncreased,
    })
  }

  // 6. Settlement drag (volume %)
  const settlePct = liquidity.total_inflows > 0
    ? (liquidity.settlement_inflows / liquidity.total_inflows) * 100 : 0
  const settleCurrent = settlementBand(settlePct)
  const prevSettlePct = previousLiquidity && previousLiquidity.total_inflows > 0
    ? (previousLiquidity.settlement_inflows / previousLiquidity.total_inflows) * 100 : null
  const settlePrev = prevSettlePct !== null ? settlementBand(prevSettlePct) : null
  const settleTransitioned = bandTransitioned(settleCurrent, settlePrev)
  const settleDir = bandDirection(settleCurrent, settlePrev)
  signals.push({
    signal: "settlement_drag",
    severity: settleTransitioned ? "warning" : "info",
    description: settleTransitioned && settlePrev
      ? `Settlement ${settleDir}: ${settlePrev} → ${settleCurrent} (${Math.round(settlePct)}% of inflows)`
      : `Settlement is ${settleCurrent} (${Math.round(settlePct)}% of inflows)`,
    current_band: settleCurrent,
    previous_band: settlePrev,
    current_state: settleCurrent,
    previous_state: settlePrev,
    regime_change: !!settleTransitioned,
    current_value: Math.round(settlePct),
    previous_value: prevSettlePct !== null ? Math.round(prevSettlePct) : null,
    threshold: 30,
    triggered: settleTransitioned,
  })

  // 7. Operating dependency (killer metric)
  const opDepPct = liquidity.operating_dependency_ratio * 100
  const opBand = opDepPct >= 80 ? "low" : opDepPct >= 60 ? "moderate" : opDepPct >= 40 ? "elevated" : "high"
  const prevOpPct = previousLiquidity ? previousLiquidity.operating_dependency_ratio * 100 : null
  const prevOpBand = prevOpPct !== null ? (prevOpPct >= 80 ? "low" : prevOpPct >= 60 ? "moderate" : prevOpPct >= 40 ? "elevated" : "high") : null
  signals.push({
    signal: "operating_dependency",
    severity: opDepPct < 50 ? "warning" : "info",
    description: `Business is ${Math.round(opDepPct)}% operating-driven, ${Math.round(100 - opDepPct)}% supported by non-operating flows`,
    current_band: opBand,
    previous_band: prevOpBand,
    current_state: `${Math.round(opDepPct)}% operating`,
    previous_state: prevOpPct !== null ? `${Math.round(prevOpPct)}% operating` : null,
    regime_change: prevOpBand !== null && opBand !== prevOpBand,
    current_value: Math.round(opDepPct),
    previous_value: prevOpPct !== null ? Math.round(prevOpPct) : null,
    threshold: 60,
    triggered: opDepPct < 60,
  })

  return signals
}

// ─── Insight Block ───────────────────────────────────────────────────

export function computeInsightBlock(
  revenue: RevenueState,
  spend: SpendState,
  liquidity: LiquidityState,
): string {
  const parts: string[] = []

  const concBand = concentrationLabelFromPct(revenue.top_customer_pct)
  const concLabel = concentrationAdverb(concBand)
  const top2 = revenue.revenue_by_customer.slice(0, 2).reduce((s, c) => s + c.total, 0)
  const top2Pct = revenue.gross_revenue > 0 ? Math.round((top2 / revenue.gross_revenue) * 100) : 0
  parts.push(`Revenue is ${concLabel} concentrated, with top ${revenue.revenue_by_customer.length >= 2 ? "2" : "1"} customer${revenue.revenue_by_customer.length >= 2 ? "s" : ""} contributing ~${top2Pct}%.`)

  const opPct = Math.round(liquidity.operating_dependency_ratio * 100)
  const transferPct = Math.round(liquidity.transfer_dependency_ratio * 100)
  if (opPct >= 70) {
    parts.push(`Cash flow is strong and primarily operating-driven (${opPct}%).`)
  } else if (opPct >= 50) {
    parts.push(`Cash flow is ${opPct}% operating-driven.`)
  } else {
    parts.push(`Cash flow is ${100 - opPct}% supported by non-operating flows.`)
  }
  if (transferPct > 15) {
    parts.push(`Liquidity movement included significant treasury reshuffling (~${transferPct}% internal transfers).`)
  }

  const vendorBand = concentrationLabelFromPct(spend.top_vendor_pct)
  const vendorConc = concentrationAdverb(vendorBand)
  parts.push(`Vendor spend is ${vendorConc} concentrated, with the top supplier accounting for ${Math.round(spend.top_vendor_pct)}% of costs.`)

  if (revenue.repeat_revenue_ratio >= 0.5) {
    parts.push(`${Math.round(revenue.repeat_revenue_ratio * 100)}% of revenue is repeat.`)
  }

  if (liquidity.settlement_lag?.confidence !== "insufficient" && liquidity.settlement_lag.avg_settlement_lag_days > 0) {
    parts.push(`Settlement lag averages ${liquidity.settlement_lag.avg_settlement_lag_days.toFixed(1)} days from customer payment to bank.`)
  }

  return parts.join(" ")
}

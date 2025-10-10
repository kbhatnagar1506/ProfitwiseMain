// ─── State Computation Engine ────────────────────────────────────────
//
// Reads MovementTag[] (from frozen schema) and produces the 3 core state
// objects + 5 transition detectors.
//
// Rules:
//   - Only tags with state_inclusion_policy !== "exclude_and_review" enter state
//   - EXCEPTION: contra revenue (refunds) ALWAYS included — a refund is a refund
//   - StateScope gates which metric domain each movement affects
//   - Settlement NEVER enters revenue or spend
//   - Provisional movements are counted but tracked separately

import type { MovementTag, CanonicalMovement } from "@/lib/movement-types"
import type { RevenueState, SpendState, LiquidityState, TransitionSignal, SeverityBand, AccountCash, SpendBreakdownEntry } from "./types"

type TaggedMovement = CanonicalMovement & { tag: MovementTag }

const r2 = (n: number) => Math.round(n * 100) / 100
const pct1 = (n: number, d: number) => d > 0 ? Math.round((n / d) * 1000) / 10 : 0

// ─── Revenue State ──────────────────────────────────────────────────

export function computeRevenueState(
  movements: TaggedMovement[],
  periodStart: string,
  periodEnd: string,
): RevenueState {
  let grossRevenue = 0
  let contraRevenue = 0
  let provisionalRevenue = 0
  let excludedRevenue = 0

  const customerTotals = new Map<string, { name: string; total: number; count: number }>()

  for (const m of movements) {
    const t = m.tag
    if (!t.state_scope.affects_revenue) continue

    const isContra = t.cashflow_bucket === "contra_revenue"
    const isRevIn = t.cashflow_bucket === "revenue_in"

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
  const customers = [...customerTotals.values()].sort((a, b) => b.total - a.total)
  const customerCount = customers.length
  const avgReceipt = customerCount > 0 ? grossRevenue / customers.reduce((s, c) => s + c.count, 0) : 0
  const topCustomerPct = customerCount > 0 && grossRevenue > 0 ? customers[0].total / grossRevenue : 0

  let hhi = 0
  for (const c of customers) {
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
    revenue_by_customer: customers.slice(0, 10).map((c) => ({
      entity_id: null,
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
  let payroll = 0
  let vendorPayments = 0
  let bankFees = 0
  let taxes = 0
  let processorFees = 0
  let provisionalSpend = 0
  let excludedSpend = 0
  let recurringObligations = 0
  let recurringObligationCount = 0
  let nonRecurringSpend = 0

  const vendorTotals = new Map<string, { name: string; total: number; count: number }>()

  for (const m of movements) {
    const t = m.tag
    if (!t.state_scope.affects_spend) continue

    if (t.state_inclusion_policy === "exclude_and_review") {
      excludedSpend += m.amount
      continue
    }

    if (t.state_inclusion_policy === "include_provisional") provisionalSpend += m.amount

    if (t.cashflow_bucket === "opex_out") totalOpex += m.amount
    if (t.cashflow_bucket === "cogs_out") totalCogs += m.amount

    if (t.economic_class === "vendor_payment") vendorPayments += m.amount

    switch (t.economic_class) {
      case "payroll": payroll += m.amount; break
      case "bank_fee": case "bank_fee_refund": bankFees += m.amount; break
      case "tax": taxes += m.amount; break
      case "processor_fee": processorFees += m.amount; break
    }

    if (t.is_recurring) {
      recurringObligations += m.amount
      recurringObligationCount++
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
  const vendors = [...vendorTotals.values()].sort((a, b) => b.total - a.total)
  const vendorCount = vendors.length
  const avgPayment = vendorCount > 0 ? totalSpend / vendors.reduce((s, v) => s + v.count, 0) : 0
  const topVendorPct = vendorCount > 0 && totalSpend > 0 ? vendors[0].total / totalSpend : 0

  let supplierHHI = 0
  for (const v of vendors) {
    const share = totalSpend > 0 ? v.total / totalSpend : 0
    supplierHHI += share * share
  }

  const spendByVendor: SpendBreakdownEntry[] = vendors.slice(0, 10).map((v) => ({
    entity_id: null,
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
    total_spend: r2(totalSpend),
    payroll: r2(payroll),
    vendor_payments: r2(vendorPayments),
    bank_fees: r2(bankFees),
    taxes: r2(taxes),
    processor_fees: r2(processorFees),
    recurring_obligations: r2(recurringObligations),
    recurring_obligation_count: recurringObligationCount,
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

  const accountFlows = new Map<string, AccountCash>()

  for (const m of movements) {
    const t = m.tag
    if (!t.state_scope.affects_liquidity) {
      if (t.cashflow_bucket === "transfer") transferVolume += m.amount
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
    if (t.cashflow_bucket === "settlement") {
      if (isIn) settleIn += amt; else settleOut += amt
    }
    if (t.is_owner_related) {
      if (isIn) ownerIn += amt; else ownerOut += amt
    }

    // account_id from DB is actually the account name (stored as cash_account_name during classification)
    const acctName = m.account_id || null
    const acctKey = acctName ?? "unmapped"
    const acctType = (m.metadata?.account_type as string) ?? ""
    let acctEntry = accountFlows.get(acctKey)
    if (!acctEntry) {
      acctEntry = {
        account_id: acctKey,
        account_name: acctName ?? "Unmapped account",
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

  return {
    period_start: periodStart,
    period_end: periodEnd,
    total_inflows: r2(totalIn),
    total_outflows: r2(totalOut),
    period_net_cash_flow: r2(totalIn - totalOut),
    operating_inflows: r2(opIn),
    operating_outflows: r2(opOut),
    net_operating: r2(opIn - opOut),
    financing_inflows: r2(finIn),
    financing_outflows: r2(finOut),
    net_financing: r2(finIn - finOut),
    settlement_inflows: r2(settleIn),
    settlement_outflows: r2(settleOut),
    net_settlement: r2(settleIn - settleOut),
    owner_inflows: r2(ownerIn),
    owner_outflows: r2(ownerOut),
    net_owner: r2(ownerIn - ownerOut),
    cash_by_account: cashByAccount,
    transfer_dependency_ratio: Math.round(transferDependencyRatio * 1000) / 1000,
    owner_support_ratio: Math.round(ownerSupportRatio * 1000) / 1000,
    operating_dependency_ratio: Math.round(operatingDependencyRatio * 1000) / 1000,
    excluded_cash: r2(excludedCash),
  }
}

// ─── State Confidence ───────────────────────────────────────────────

export function computeStateConfidence(
  movements: TaggedMovement[],
): { revenue_confidence: number; spend_confidence: number; liquidity_confidence: number } {
  let revTotal = 0, revUnresolved = 0
  let spendTotal = 0, spendUnresolved = 0
  let liqTotal = 0, liqUnresolved = 0

  for (const m of movements) {
    const t = m.tag
    if (t.state_scope.affects_revenue) {
      revTotal += m.amount
      if (t.economic_class === "unknown") revUnresolved += m.amount
    }
    if (t.state_scope.affects_spend) {
      spendTotal += m.amount
      if (t.economic_class === "unknown") spendUnresolved += m.amount
    }
    if (t.state_scope.affects_liquidity) {
      liqTotal += m.amount
      if (t.economic_class === "unknown" || t.state_inclusion_policy === "exclude_and_review") liqUnresolved += m.amount
    }
  }

  return {
    revenue_confidence: revTotal > 0 ? Math.round((1 - revUnresolved / revTotal) * 1000) / 10 : 100,
    spend_confidence: spendTotal > 0 ? Math.round((1 - spendUnresolved / spendTotal) * 1000) / 10 : 100,
    liquidity_confidence: liqTotal > 0 ? Math.round((1 - liqUnresolved / liqTotal) * 1000) / 10 : 100,
  }
}

// ─── Severity Bands ─────────────────────────────────────────────────

function concentrationBand(topPct: number): SeverityBand {
  if (topPct > 70) return "critical"
  if (topPct > 50) return "high"
  if (topPct > 35) return "elevated"
  if (topPct > 20) return "moderate"
  return "low"
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

// ─── Transition Detectors ───────────────────────────────────────────

export function detectTransitions(
  revenue: RevenueState,
  spend: SpendState,
  liquidity: LiquidityState,
  previousRevenue?: RevenueState | null,
  previousSpend?: SpendState | null,
  previousLiquidity?: LiquidityState | null,
): TransitionSignal[] {
  const signals: TransitionSignal[] = []

  // 1. Revenue concentration
  const concCurrent = concentrationBand(revenue.top_customer_pct)
  const concPrev = previousRevenue ? concentrationBand(previousRevenue.top_customer_pct) : null
  const concTransitioned = bandTransitioned(concCurrent, concPrev)
  const concDir = bandDirection(concCurrent, concPrev)
  signals.push({
    signal: "revenue_concentration",
    severity: concCurrent === "critical" || concCurrent === "high" ? "critical" : concCurrent === "elevated" ? "warning" : "info",
    description: concTransitioned && concPrev
      ? `Concentration ${concDir}: ${concPrev} → ${concCurrent} (top customer ${revenue.top_customer_pct}%)`
      : `Concentration is ${concCurrent} (top customer ${revenue.top_customer_pct}%)`,
    current_band: concCurrent,
    previous_band: concPrev,
    current_value: revenue.top_customer_pct,
    previous_value: previousRevenue?.top_customer_pct ?? null,
    threshold: 50,
    triggered: concTransitioned || concCurrent === "high" || concCurrent === "critical",
  })

  // 2. Abnormal outflow spike
  const prevSpend = previousSpend?.total_spend ?? spend.total_spend
  const spendRatio = prevSpend > 0 ? spend.total_spend / prevSpend : 1
  const spikeCurrent = spendSpikeBand(spendRatio)
  const spikePrev: SeverityBand = "low"
  signals.push({
    signal: "abnormal_outflow_spike",
    severity: spikeCurrent === "critical" || spikeCurrent === "high" ? "critical" : spikeCurrent === "elevated" ? "warning" : "info",
    description: spikeCurrent !== "low"
      ? `Spend spike ${spikeCurrent} — ${Math.round(spendRatio * 100)}% of prior period`
      : `Spend is stable at ${Math.round(spendRatio * 100)}% of prior period`,
    current_band: spikeCurrent,
    previous_band: previousSpend ? spikePrev : null,
    current_value: Math.round(spendRatio * 100),
    previous_value: 100,
    threshold: 150,
    triggered: spikeCurrent !== "low",
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
    current_value: Math.round(ownerPct),
    previous_value: prevOwnerPct !== null ? Math.round(prevOwnerPct) : null,
    threshold: 25,
    triggered: ownerTransitioned || ownerCurrent === "high" || ownerCurrent === "critical",
  })

  // 4. Liquidity tightening
  const netRatio = liquidity.total_inflows > 0 ? liquidity.period_net_cash_flow / liquidity.total_inflows : 0
  const liqCurrent = liquidityBand(netRatio)
  const prevNetRatio = previousLiquidity && previousLiquidity.total_inflows > 0
    ? previousLiquidity.period_net_cash_flow / previousLiquidity.total_inflows : null
  const liqPrev = prevNetRatio !== null ? liquidityBand(prevNetRatio) : null
  const liqTransitioned = bandTransitioned(liqCurrent, liqPrev)
  const liqDir = bandDirection(liqCurrent, liqPrev)
  signals.push({
    signal: "liquidity_tightening",
    severity: liqCurrent === "critical" || liqCurrent === "high" ? "critical" : liqCurrent === "elevated" ? "warning" : "info",
    description: liqTransitioned && liqPrev
      ? `Liquidity ${liqDir}: ${liqPrev} → ${liqCurrent} (net ${Math.round(netRatio * 100)}% of inflows)`
      : `Liquidity is ${liqCurrent} (net ${Math.round(netRatio * 100)}% of inflows)`,
    current_band: liqCurrent,
    previous_band: liqPrev,
    current_value: Math.round(netRatio * 100),
    previous_value: prevNetRatio !== null ? Math.round(prevNetRatio * 100) : null,
    threshold: 5,
    triggered: liqTransitioned || liqCurrent === "high" || liqCurrent === "critical",
  })

  // 5. Settlement drag
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
    current_value: Math.round(settlePct),
    previous_value: prevSettlePct !== null ? Math.round(prevSettlePct) : null,
    threshold: 30,
    triggered: settleTransitioned,
  })

  // 6. Operating dependency (new killer metric as transition)
  const opDepPct = liquidity.operating_dependency_ratio * 100
  signals.push({
    signal: "operating_dependency",
    severity: opDepPct < 50 ? "warning" : "info",
    description: `Business is ${Math.round(opDepPct)}% operating-driven, ${Math.round(100 - opDepPct)}% supported by non-operating flows`,
    current_band: opDepPct >= 80 ? "low" : opDepPct >= 60 ? "moderate" : opDepPct >= 40 ? "elevated" : "high",
    previous_band: previousLiquidity ? (
      previousLiquidity.operating_dependency_ratio * 100 >= 80 ? "low" :
      previousLiquidity.operating_dependency_ratio * 100 >= 60 ? "moderate" :
      previousLiquidity.operating_dependency_ratio * 100 >= 40 ? "elevated" : "high"
    ) : null,
    current_value: Math.round(opDepPct),
    previous_value: previousLiquidity ? Math.round(previousLiquidity.operating_dependency_ratio * 100) : null,
    threshold: 60,
    triggered: opDepPct < 60,
  })

  return signals
}

// ─── State Computation Engine ────────────────────────────────────────
//
// Reads MovementTag[] (from frozen schema) and produces the 3 core state
// objects + 5 transition detectors.
//
// Rules:
//   - Only tags with state_inclusion_policy !== "exclude_and_review" enter state
//   - StateScope gates which metric domain each movement affects
//   - Settlement NEVER enters revenue or spend
//   - Provisional movements are counted but tracked separately

import type { MovementTag, CanonicalMovement } from "@/lib/movement-types"
import type { RevenueState, SpendState, LiquidityState, TransitionSignal } from "./types"

type TaggedMovement = CanonicalMovement & { tag: MovementTag }

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

    if (t.state_inclusion_policy === "exclude_and_review") {
      if (t.cashflow_bucket === "revenue_in") excludedRevenue += m.amount
      continue
    }

    if (t.cashflow_bucket === "revenue_in") {
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

    if (t.cashflow_bucket === "contra_revenue") {
      contraRevenue += m.amount
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

  const r2 = (n: number) => Math.round(n * 100) / 100

  return {
    period_start: periodStart,
    period_end: periodEnd,
    gross_revenue: r2(grossRevenue),
    contra_revenue: r2(contraRevenue),
    net_revenue: r2(netRevenue),
    customer_count: customerCount,
    avg_receipt: r2(avgReceipt),
    top_customer_pct: Math.round(topCustomerPct * 1000) / 10,
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

    switch (t.economic_class) {
      case "payroll": payroll += m.amount; break
      case "vendor_payment": vendorPayments += m.amount; break
      case "bank_fee": case "bank_fee_refund": bankFees += m.amount; break
      case "tax": taxes += m.amount; break
      case "processor_fee": processorFees += m.amount; break
    }

    if (t.counterparty_role === "vendor" || t.counterparty_role === "employee") {
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

  const r2 = (n: number) => Math.round(n * 100) / 100

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
    vendor_count: vendorCount,
    avg_payment: r2(avgPayment),
    top_vendor_pct: Math.round(topVendorPct * 1000) / 10,
    spend_by_vendor: vendors.slice(0, 10).map((v) => ({
      entity_id: null,
      name: v.name,
      total: r2(v.total),
      count: v.count,
    })),
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

  for (const m of movements) {
    const t = m.tag
    if (!t.state_scope.affects_liquidity) continue

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
  }

  const r2 = (n: number) => Math.round(n * 100) / 100

  return {
    period_start: periodStart,
    period_end: periodEnd,
    total_inflows: r2(totalIn),
    total_outflows: r2(totalOut),
    net_cash_flow: r2(totalIn - totalOut),
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
    excluded_cash: r2(excludedCash),
  }
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

  // 1. Revenue concentration increase
  const concThreshold = 0.5
  signals.push({
    signal: "revenue_concentration_increase",
    severity: revenue.top_customer_pct > 70 ? "critical" : revenue.top_customer_pct > concThreshold * 100 ? "warning" : "info",
    description: `Top customer represents ${revenue.top_customer_pct}% of revenue`,
    current_value: revenue.top_customer_pct,
    previous_value: previousRevenue?.top_customer_pct ?? null,
    threshold: concThreshold * 100,
    triggered: revenue.top_customer_pct > concThreshold * 100,
  })

  // 2. Abnormal outflow spike
  const prevSpend = previousSpend?.total_spend ?? spend.total_spend
  const spendRatio = prevSpend > 0 ? spend.total_spend / prevSpend : 1
  signals.push({
    signal: "abnormal_outflow_spike",
    severity: spendRatio > 2.0 ? "critical" : spendRatio > 1.5 ? "warning" : "info",
    description: `Spend is ${Math.round(spendRatio * 100)}% of prior period`,
    current_value: Math.round(spendRatio * 100),
    previous_value: 100,
    threshold: 150,
    triggered: spendRatio > 1.5,
  })

  // 3. Owner support dependency increase
  const ownerPct = liquidity.total_inflows > 0
    ? (liquidity.owner_inflows / liquidity.total_inflows) * 100
    : 0
  const prevOwnerPct = previousLiquidity && previousLiquidity.total_inflows > 0
    ? (previousLiquidity.owner_inflows / previousLiquidity.total_inflows) * 100
    : null
  signals.push({
    signal: "owner_dependency_increase",
    severity: ownerPct > 40 ? "critical" : ownerPct > 25 ? "warning" : "info",
    description: `Owner provides ${Math.round(ownerPct)}% of inflows`,
    current_value: Math.round(ownerPct),
    previous_value: prevOwnerPct !== null ? Math.round(prevOwnerPct) : null,
    threshold: 25,
    triggered: ownerPct > 25,
  })

  // 4. Liquidity tightening
  const netCashRatio = liquidity.total_inflows > 0
    ? liquidity.net_cash_flow / liquidity.total_inflows
    : 0
  signals.push({
    signal: "liquidity_tightening",
    severity: netCashRatio < -0.1 ? "critical" : netCashRatio < 0.05 ? "warning" : "info",
    description: `Net cash flow is ${Math.round(netCashRatio * 100)}% of inflows`,
    current_value: Math.round(netCashRatio * 100),
    previous_value: previousLiquidity && previousLiquidity.total_inflows > 0
      ? Math.round((previousLiquidity.net_cash_flow / previousLiquidity.total_inflows) * 100)
      : null,
    threshold: 5,
    triggered: netCashRatio < 0.05,
  })

  // 5. Settlement delay increase
  const settlementPct = liquidity.total_inflows > 0
    ? (liquidity.settlement_inflows / liquidity.total_inflows) * 100
    : 0
  const prevSettlePct = previousLiquidity && previousLiquidity.total_inflows > 0
    ? (previousLiquidity.settlement_inflows / previousLiquidity.total_inflows) * 100
    : null
  const settleDropped = prevSettlePct !== null && settlementPct < prevSettlePct * 0.7
  signals.push({
    signal: "settlement_delay_increase",
    severity: settleDropped ? "warning" : "info",
    description: `Settlement is ${Math.round(settlementPct)}% of inflows${settleDropped ? " (dropped from prior period)" : ""}`,
    current_value: Math.round(settlementPct),
    previous_value: prevSettlePct !== null ? Math.round(prevSettlePct) : null,
    threshold: 30,
    triggered: settleDropped,
  })

  return signals
}

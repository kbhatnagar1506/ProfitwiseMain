import type { RevenueState, SpendState, LiquidityState } from "./types"

export type Insight = {
  id: string
  type: "revenue" | "spend" | "liquidity" | "risk"
  severity: "low" | "medium" | "high"
  message: string
  metric: number
}

export function computeInsights(
  revenue: RevenueState,
  spend: SpendState,
  liquidity: LiquidityState,
): Insight[] {
  const insights: Insight[] = []

  // ── Revenue ──

  if (revenue.top_customer_pct > 15) {
    insights.push({
      id: "rev_concentration",
      type: "revenue",
      severity: revenue.top_customer_pct > 50 ? "high" : "medium",
      message: `Revenue is ${revenue.top_customer_pct > 50 ? "highly" : "moderately"} concentrated — top customer is ${revenue.top_customer_pct}% of revenue`,
      metric: revenue.top_customer_pct,
    })
  }

  if (revenue.repeat_revenue_ratio < 0.5) {
    insights.push({
      id: "rev_retention",
      type: "revenue",
      severity: revenue.repeat_revenue_ratio < 0.2 ? "high" : "medium",
      message: `Revenue is driven by new customers — only ${Math.round(revenue.repeat_revenue_ratio * 100)}% is repeat`,
      metric: revenue.repeat_revenue_ratio,
    })
  }

  // ── Spend ──

  if (spend.top_vendor_pct > 20) {
    insights.push({
      id: "spend_vendor_conc",
      type: "spend",
      severity: spend.top_vendor_pct > 40 ? "high" : "medium",
      message: `Vendor concentration risk is elevated — top supplier is ${spend.top_vendor_pct}% of spend`,
      metric: spend.top_vendor_pct,
    })
  }

  const recurringRatio = spend.total_spend > 0 ? spend.recurring_obligations / spend.total_spend : 0
  if (recurringRatio > 0.6) {
    insights.push({
      id: "spend_fixed_cost",
      type: "spend",
      severity: recurringRatio > 0.8 ? "high" : "medium",
      message: `High fixed cost structure — ${Math.round(recurringRatio * 100)}% of spend is recurring`,
      metric: recurringRatio,
    })
  }

  // ── Liquidity ──

  if (liquidity.transfer_dependency_ratio > 0.25) {
    insights.push({
      id: "liq_transfer_dep",
      type: "liquidity",
      severity: liquidity.transfer_dependency_ratio > 0.4 ? "high" : "medium",
      message: `Liquidity depends on internal transfers (${Math.round(liquidity.transfer_dependency_ratio * 100)}% of cash flow)`,
      metric: liquidity.transfer_dependency_ratio,
    })
  }

  if (liquidity.operating_dependency_ratio < 0.7) {
    insights.push({
      id: "liq_non_operating",
      type: "liquidity",
      severity: liquidity.operating_dependency_ratio < 0.5 ? "high" : "medium",
      message: `Business relies on non-operating cash — only ${Math.round(liquidity.operating_dependency_ratio * 100)}% operating-driven`,
      metric: liquidity.operating_dependency_ratio,
    })
  }

  return insights
}

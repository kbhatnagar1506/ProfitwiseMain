import type {
  RevenueState,
  SpendState,
  LiquidityState,
  StateConfidence,
  RiskLevel,
  RiskDimension,
  RiskState,
} from "./types"

function level(score: number): RiskLevel {
  if (score >= 70) return "high"
  if (score >= 40) return "medium"
  return "low"
}

function computeLiquidityRisk(liquidity: LiquidityState): RiskDimension {
  const avgDailyOutflow = liquidity.total_outflows > 0
    ? liquidity.total_outflows / Math.max(1, daySpan(liquidity.period_start, liquidity.period_end))
    : 0
  const bufferDays = avgDailyOutflow > 0
    ? liquidity.period_net_cash_flow / avgDailyOutflow
    : Infinity

  let score = 0
  let reason = ""

  if (bufferDays < 7) {
    score = 85
    reason = `Critical: ~${Math.round(bufferDays)}d cash buffer at current burn`
  } else if (bufferDays < 14) {
    score = 60
    reason = `Tight: ~${Math.round(bufferDays)}d cash buffer`
  } else if (bufferDays < 30) {
    score = 35
    reason = `Adequate: ~${Math.round(bufferDays)}d cash buffer`
  } else {
    score = 15
    reason = `Healthy: ~${Math.round(bufferDays)}d cash buffer`
  }

  if (liquidity.liquidity_regime === "tightening") score = Math.min(100, score + 15)
  if (liquidity.liquidity_regime === "strong") score = Math.max(0, score - 10)

  return { level: level(score), score, reason }
}

function computeConcentrationRisk(revenue: RevenueState, spend: SpendState): RiskDimension {
  const custConc = revenue.top_customer_pct / 100
  const vendConc = spend.top_vendor_pct / 100
  const worst = Math.max(custConc, vendConc)

  let score = 0
  const parts: string[] = []

  if (custConc > 0.3) {
    score = Math.max(score, 80)
    parts.push(`top customer ${Math.round(custConc * 100)}%`)
  } else if (custConc > 0.15) {
    score = Math.max(score, 50)
    parts.push(`top customer ${Math.round(custConc * 100)}%`)
  }

  if (vendConc > 0.3) {
    score = Math.max(score, 75)
    parts.push(`top vendor ${Math.round(vendConc * 100)}%`)
  } else if (vendConc > 0.15) {
    score = Math.max(score, 45)
    parts.push(`top vendor ${Math.round(vendConc * 100)}%`)
  }

  if (parts.length === 0) {
    score = 10
    parts.push("well diversified")
  }

  const reason = worst > 0.3
    ? `High concentration: ${parts.join(", ")}`
    : worst > 0.15
      ? `Moderate concentration: ${parts.join(", ")}`
      : `Low concentration: ${parts.join(", ")}`

  return { level: level(score), score, reason }
}

function computeDependencyRisk(liquidity: LiquidityState): RiskDimension {
  const opDep = liquidity.operating_dependency_ratio
  const ownerRatio = liquidity.owner_support_ratio
  const transferRatio = liquidity.transfer_dependency_ratio

  let score = 0
  const parts: string[] = []

  if (opDep < 0.5) {
    score = 85
    parts.push(`only ${Math.round(opDep * 100)}% operating-driven`)
  } else if (opDep < 0.7) {
    score = 55
    parts.push(`${Math.round(opDep * 100)}% operating-driven`)
  } else {
    score = 15
    parts.push(`${Math.round(opDep * 100)}% operating-driven`)
  }

  if (ownerRatio > 0.15) {
    score = Math.min(100, score + 15)
    parts.push(`owner support ${Math.round(ownerRatio * 100)}%`)
  }
  if (transferRatio > 0.3) {
    score = Math.min(100, score + 10)
    parts.push(`transfer dependency ${Math.round(transferRatio * 100)}%`)
  }

  const reason = score >= 70
    ? `High dependency on non-operating sources: ${parts.join(", ")}`
    : score >= 40
      ? `Moderate non-operating reliance: ${parts.join(", ")}`
      : `Self-sustaining: ${parts.join(", ")}`

  return { level: level(score), score, reason }
}

function computeAnomalyRisk(spend: SpendState, liquidity: LiquidityState): RiskDimension {
  let score = 0
  const parts: string[] = []

  const recurringRatio = spend.total_spend > 0 ? spend.recurring_obligations / spend.total_spend : 0
  if (recurringRatio > 0.8) {
    score = Math.max(score, 55)
    parts.push(`${Math.round(recurringRatio * 100)}% fixed costs`)
  }

  if (liquidity.settlement_lag.confidence !== "insufficient" && liquidity.settlement_lag.avg_settlement_lag_days > 5) {
    score = Math.max(score, 50)
    parts.push(`${liquidity.settlement_lag.avg_settlement_lag_days.toFixed(1)}d settlement lag`)
  }

  if (spend.non_recurring_spend > spend.total_spend * 0.4 && spend.total_spend > 0) {
    score = Math.max(score, 45)
    parts.push(`${Math.round((spend.non_recurring_spend / spend.total_spend) * 100)}% non-recurring spend`)
  }

  if (parts.length === 0) {
    score = 10
    parts.push("no significant anomalies detected")
  }

  return {
    level: level(score),
    score,
    reason: score >= 40 ? `Elevated: ${parts.join(", ")}` : `Normal: ${parts.join(", ")}`,
  }
}

function computeUncertaintyRisk(confidence: StateConfidence): RiskDimension {
  const avgConf = (confidence.revenue_confidence + confidence.spend_confidence + confidence.liquidity_confidence) / 3

  let score: number
  let reason: string

  if (avgConf < 70) {
    score = 80
    reason = `Low data confidence (avg ${Math.round(avgConf)}%) — state may be unreliable`
  } else if (avgConf < 85) {
    score = 50
    reason = `Moderate data confidence (avg ${Math.round(avgConf)}%) — some gaps remain`
  } else if (avgConf < 95) {
    score = 25
    reason = `Good data confidence (avg ${Math.round(avgConf)}%)`
  } else {
    score = 10
    reason = `High data confidence (avg ${Math.round(avgConf)}%)`
  }

  return { level: level(score), score, reason }
}

function daySpan(start: string, end: string): number {
  const s = new Date(start)
  const e = new Date(end)
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000))
}

const WEIGHTS = {
  liquidity: 0.30,
  concentration: 0.20,
  dependency: 0.25,
  anomaly: 0.10,
  uncertainty: 0.15,
}

export function computeRiskState(
  revenue: RevenueState,
  spend: SpendState,
  liquidity: LiquidityState,
  confidence: StateConfidence,
): RiskState {
  const liquidity_risk = computeLiquidityRisk(liquidity)
  const concentration_risk = computeConcentrationRisk(revenue, spend)
  const dependency_risk = computeDependencyRisk(liquidity)
  const anomaly_risk = computeAnomalyRisk(spend, liquidity)
  const uncertainty_risk = computeUncertaintyRisk(confidence)

  const overall_score = Math.round(
    liquidity_risk.score * WEIGHTS.liquidity +
    concentration_risk.score * WEIGHTS.concentration +
    dependency_risk.score * WEIGHTS.dependency +
    anomaly_risk.score * WEIGHTS.anomaly +
    uncertainty_risk.score * WEIGHTS.uncertainty
  )

  return {
    liquidity_risk,
    concentration_risk,
    dependency_risk,
    anomaly_risk,
    uncertainty_risk,
    overall: level(overall_score),
    overall_score,
  }
}

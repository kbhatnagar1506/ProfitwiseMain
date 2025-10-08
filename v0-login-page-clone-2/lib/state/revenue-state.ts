// ─── Revenue State Engine ───────────────────────────────────────────
//
// Reads: customer_receipt, refund (maybe processor_payout later)
// Computes: trailing revenue, refund-adjusted net, concentration, repeat ratio,
//           payment cadence, volatility, quality score.

import type { TaggedMovementInput } from "./types"
import { filterIncluded } from "./types"

export type RevenueState = {
  trailing_7d_in: number
  trailing_30d_in: number
  trailing_90d_in: number
  refund_adjusted_net_in: number

  top_customer_share: number
  top_3_customer_share: number
  repeat_customer_ratio: number
  revenue_volatility_score: number
  revenue_quality_score: number

  unresolved_revenue_share: number
  state_confidence: number
}

const REVENUE_ECONOMIC_CLASSES = new Set(["customer_receipt", "processor_payout"])
const REFUND_ECONOMIC_CLASS = "refund"

function selector(items: TaggedMovementInput[]): TaggedMovementInput[] {
  return items.filter(
    (m) =>
      (REVENUE_ECONOMIC_CLASSES.has(m.tag.economic_class) || m.tag.economic_class === REFUND_ECONOMIC_CLASS) &&
      (m.direction === "inflow" || (m.direction === "outflow" && m.tag.economic_class === REFUND_ECONOMIC_CLASS)),
  )
}

function normalizer(items: TaggedMovementInput[]): { included: TaggedMovementInput[]; excluded: TaggedMovementInput[] } {
  const { included, excluded } = filterIncluded(items)
  const sorted = [...included].sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())
  return { included: sorted, excluded }
}

function signAmount(m: TaggedMovementInput): number {
  if (m.tag.economic_class === REFUND_ECONOMIC_CLASS && m.direction === "outflow") return -Math.abs(m.amount)
  return m.direction === "inflow" ? Math.abs(m.amount) : -Math.abs(m.amount)
}

function getCounterpartyKey(m: TaggedMovementInput): string {
  const cp = (m.metadata?.counterparty as string) ?? m.tag.customer_id ?? m.entity_id ?? m.id
  return String(cp).toLowerCase().trim() || "unknown"
}

function computeTrailing(included: TaggedMovementInput[], days: number, now: Date): number {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - days)
  let sum = 0
  for (const m of included) {
    const d = new Date(m.occurred_at)
    if (d >= cutoff) sum += signAmount(m)
  }
  return Math.max(0, sum)
}

function computeRefundAdjustedNet(included: TaggedMovementInput[]): number {
  let net = 0
  for (const m of included) {
    net += signAmount(m)
  }
  return Math.max(0, net)
}

function computeRevenueVolatilityScore(included: TaggedMovementInput[], now: Date): number {
  const daily = new Map<string, number>()
  for (const m of included) {
    const d = typeof m.occurred_at === "string" ? m.occurred_at.slice(0, 10) : new Date(m.occurred_at).toISOString().slice(0, 10)
    const key = d
    daily.set(key, (daily.get(key) ?? 0) + signAmount(m))
  }
  const values = [...daily.values()].filter((v) => v > 0)
  if (values.length < 2) return 0.5
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  const stddev = Math.sqrt(variance)
  const cv = mean > 0 ? stddev / mean : 1
  return Math.min(1, Math.max(0, 1 - cv))
}

function computeRevenueQualityScore(
  included: TaggedMovementInput[],
  repeatRatio: number,
  volatilityScore: number,
  unresolvedShare: number,
): number {
  const confWeight = included.length > 0
    ? included.reduce((s, m) => s + (m.tag.classification_confidence ?? 0.5), 0) / included.length
    : 0.5
  const repeatBonus = repeatRatio * 0.2
  const volBonus = volatilityScore * 0.2
  const unresolvedPenalty = unresolvedShare * 0.3
  return Math.min(1, Math.max(0, confWeight * 0.5 + repeatBonus + volBonus - unresolvedPenalty))
}

export function computeRevenueState(
  items: TaggedMovementInput[],
  options?: { asOf?: Date },
): RevenueState {
  const now = options?.asOf ?? new Date()
  const selected = selector(items)
  const { included, excluded } = normalizer(selected)

  const trailing7 = computeTrailing(included, 7, now)
  const trailing30 = computeTrailing(included, 30, now)
  const trailing90 = computeTrailing(included, 90, now)
  const refundAdjusted = computeRefundAdjustedNet(included)

  const byCustomer = new Map<string, number>()
  for (const m of included) {
    if (signAmount(m) <= 0) continue
    const key = getCounterpartyKey(m)
    byCustomer.set(key, (byCustomer.get(key) ?? 0) + signAmount(m))
  }
  const customerTotals = [...byCustomer.entries()].sort((a, b) => b[1] - a[1])
  const total = customerTotals.reduce((s, [, v]) => s + v, 0)
  const top1 = customerTotals[0]?.[1] ?? 0
  const top3 = customerTotals.slice(0, 3).reduce((s, [, v]) => s + v, 0)
  const topCustomerShare = total > 0 ? top1 / total : 0
  const top3CustomerShare = total > 0 ? top3 / total : 0

  const totalIncluded = included.reduce((s, m) => s + (signAmount(m) > 0 ? signAmount(m) : 0), 0)
  const repeatCount = included.filter((m) => m.tag.is_recurring && signAmount(m) > 0).length
  const receiptCount = included.filter((m) => signAmount(m) > 0).length
  const repeatCustomerRatio = receiptCount > 0 ? repeatCount / receiptCount : 0

  const volatilityScore = computeRevenueVolatilityScore(included, now)

  const excludedRevenue = excluded.reduce((s, m) => s + (signAmount(m) > 0 ? signAmount(m) : 0), 0)
  const totalRevenue = totalIncluded + excludedRevenue
  const unresolvedRevenueShare = totalRevenue > 0 ? excludedRevenue / totalRevenue : 0

  const stateConfidence =
    included.length > 0
      ? included.reduce((s, m) => s + (m.tag.classification_confidence ?? 0.5), 0) / included.length
      : 0.5
  const qualityScore = computeRevenueQualityScore(
    included,
    repeatCustomerRatio,
    volatilityScore,
    unresolvedRevenueShare,
  )

  return {
    trailing_7d_in: Math.round(trailing7 * 100) / 100,
    trailing_30d_in: Math.round(trailing30 * 100) / 100,
    trailing_90d_in: Math.round(trailing90 * 100) / 100,
    refund_adjusted_net_in: Math.round(refundAdjusted * 100) / 100,
    top_customer_share: Math.round(topCustomerShare * 1000) / 1000,
    top_3_customer_share: Math.round(top3CustomerShare * 1000) / 1000,
    repeat_customer_ratio: Math.round(repeatCustomerRatio * 1000) / 1000,
    revenue_volatility_score: Math.round(volatilityScore * 1000) / 1000,
    revenue_quality_score: Math.round(qualityScore * 1000) / 1000,
    unresolved_revenue_share: Math.round(unresolvedRevenueShare * 1000) / 1000,
    state_confidence: Math.round(stateConfidence * 1000) / 1000,
  }
}

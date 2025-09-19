// ─── Spend State Engine ─────────────────────────────────────────────
//
// Reads: vendor_payment, bank_fee, processor_fee (later split cogs_out vs opex_out)
// Computes: trailing spend, vendor concentration, recurring obligations,
//           fixed vs variable estimate, direct vs overhead, unusual spikes.

import type { TaggedMovementInput } from "./types"
import { filterIncluded } from "./types"

export type SpendState = {
  trailing_7d_out: number
  trailing_30d_out: number
  trailing_90d_out: number

  top_vendor_share: number
  top_3_vendor_share: number
  recurring_outflow_estimate: number
  fixed_cost_estimate: number
  variable_cost_estimate: number

  unresolved_spend_share: number
  state_confidence: number
}

const SPEND_ECONOMIC_CLASSES = new Set(["vendor_payment", "bank_fee", "processor_fee", "payroll", "tax"])

function selector(items: TaggedMovementInput[]): TaggedMovementInput[] {
  return items.filter(
    (m) => SPEND_ECONOMIC_CLASSES.has(m.tag.economic_class) && m.direction === "outflow",
  )
}

function normalizer(items: TaggedMovementInput[]): { included: TaggedMovementInput[]; excluded: TaggedMovementInput[] } {
  const { included, excluded } = filterIncluded(items)
  const sorted = [...included].sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())
  return { included: sorted, excluded }
}

function outAmount(m: TaggedMovementInput): number {
  return m.direction === "outflow" ? Math.abs(m.amount) : 0
}

function getVendorKey(m: TaggedMovementInput): string {
  const cp = (m.metadata?.counterparty as string) ?? m.tag.vendor_id ?? m.entity_id ?? m.id
  return String(cp).toLowerCase().trim() || "unknown"
}

function computeTrailingOut(included: TaggedMovementInput[], days: number, now: Date): number {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - days)
  let sum = 0
  for (const m of included) {
    const d = new Date(m.occurred_at)
    if (d >= cutoff) sum += outAmount(m)
  }
  return sum
}

function computeRecurringEstimate(included: TaggedMovementInput[]): number {
  const recurring = included.filter((m) => m.tag.is_recurring)
  const byVendor = new Map<string, number[]>()
  for (const m of recurring) {
    const key = getVendorKey(m)
    const arr = byVendor.get(key) ?? []
    arr.push(outAmount(m))
    byVendor.set(key, arr)
  }
  let est = 0
  for (const amounts of byVendor.values()) {
    if (amounts.length >= 2) {
      const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length
      est += avg * 4
    }
  }
  return est
}

function computeFixedVsVariable(included: TaggedMovementInput[]): { fixed: number; variable: number } {
  const recurring = included.filter((m) => m.tag.is_recurring)
  const nonRecurring = included.filter((m) => !m.tag.is_recurring)
  const recurringByVendor = new Map<string, number[]>()
  for (const m of recurring) {
    const key = getVendorKey(m)
    const arr = recurringByVendor.get(key) ?? []
    arr.push(outAmount(m))
    recurringByVendor.set(key, arr)
  }
  let fixed = 0
  for (const amounts of recurringByVendor.values()) {
    if (amounts.length >= 2) {
      const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length
      fixed += avg * 12
    }
  }
  const variable = nonRecurring.reduce((s, m) => s + outAmount(m), 0)
  return { fixed, variable }
}

export function computeSpendState(
  items: TaggedMovementInput[],
  options?: { asOf?: Date },
): SpendState {
  const now = options?.asOf ?? new Date()
  const selected = selector(items)
  const { included, excluded } = normalizer(selected)

  const trailing7 = computeTrailingOut(included, 7, now)
  const trailing30 = computeTrailingOut(included, 30, now)
  const trailing90 = computeTrailingOut(included, 90, now)

  const byVendor = new Map<string, number>()
  for (const m of included) {
    const key = getVendorKey(m)
    byVendor.set(key, (byVendor.get(key) ?? 0) + outAmount(m))
  }
  const vendorTotals = [...byVendor.entries()].sort((a, b) => b[1] - a[1])
  const total = vendorTotals.reduce((s, [, v]) => s + v, 0)
  const top1 = vendorTotals[0]?.[1] ?? 0
  const top3 = vendorTotals.slice(0, 3).reduce((s, [, v]) => s + v, 0)
  const topVendorShare = total > 0 ? top1 / total : 0
  const top3VendorShare = total > 0 ? top3 / total : 0

  const recurringEst = computeRecurringEstimate(included)
  const { fixed, variable } = computeFixedVsVariable(included)

  const excludedSpend = excluded.reduce((s, m) => s + outAmount(m), 0)
  const totalSpend = total + excludedSpend
  const unresolvedSpendShare = totalSpend > 0 ? excludedSpend / totalSpend : 0

  const stateConfidence =
    included.length > 0
      ? included.reduce((s, m) => s + (m.tag.classification_confidence ?? 0.5), 0) / included.length
      : 0.5

  return {
    trailing_7d_out: Math.round(trailing7 * 100) / 100,
    trailing_30d_out: Math.round(trailing30 * 100) / 100,
    trailing_90d_out: Math.round(trailing90 * 100) / 100,
    top_vendor_share: Math.round(topVendorShare * 1000) / 1000,
    top_3_vendor_share: Math.round(top3VendorShare * 1000) / 1000,
    recurring_outflow_estimate: Math.round(recurringEst * 100) / 100,
    fixed_cost_estimate: Math.round(fixed * 100) / 100,
    variable_cost_estimate: Math.round(variable * 100) / 100,
    unresolved_spend_share: Math.round(unresolvedSpendShare * 1000) / 1000,
    state_confidence: Math.round(stateConfidence * 1000) / 1000,
  }
}

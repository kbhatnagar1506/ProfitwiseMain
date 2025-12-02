import type { OutstandingInvoice } from "./types"

type CustomerArchetype =
  | "clockwork"
  | "bursty"
  | "episodic"
  | "slow_reliable"
  | "volatile"
  | "low_data"

export type ArPaymentObservation = {
  entity_id: string | null
  customer_id: string | null
  counterparty: string | null
  raw_description: string | null
  date: string
  amount: number
  classification_confidence: number | null
  is_anomaly: boolean
  is_large_outlier: boolean
  is_first_seen_counterparty: boolean
  state_inclusion_policy: string | null
  counterparty_role: string | null
  invoice_id: string | null
}

type CustomerFeatures = {
  avg_days_to_pay: number
  interval_cv: number
  amount_mean: number
  amount_std: number
  recent_trend: "accelerating" | "decelerating" | "stable" | "insufficient"
}

const r2 = (n: number) => Math.round(n * 100) / 100

function daysBetween(a: string, b: string): number {
  return Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000))
}

function addDays(date: string, days: number): string {
  const d = new Date(date)
  d.setDate(d.getDate() + Math.round(days))
  return d.toISOString().slice(0, 10)
}

function std(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function normalizeKey(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function resolveCustomerKey(p: ArPaymentObservation): string {
  if (p.customer_id) return p.customer_id
  if (p.entity_id) return p.entity_id
  if (p.counterparty) return `name:${normalizeKey(p.counterparty)}`
  if (p.raw_description) return `desc:${normalizeKey(p.raw_description)}`
  return "unknown"
}

function classifyCustomerArchetype(
  paymentCount: number,
  intervalCv: number,
  avgDaysToPay: number,
  amountCv: number,
  recentTrend: "accelerating" | "decelerating" | "stable" | "insufficient",
): CustomerArchetype {
  if (paymentCount < 3) return "low_data"
  if (intervalCv < 0.25 && amountCv < 0.3) return "clockwork"
  if (intervalCv > 0.8 && paymentCount >= 3) return "volatile"
  if (avgDaysToPay > 30 && intervalCv < 0.5) return "slow_reliable"
  if (intervalCv > 0.5 && intervalCv <= 0.8) return "bursty"
  if (paymentCount >= 3 && paymentCount <= 6 && intervalCv > 0.4) return "episodic"
  if (intervalCv < 0.5) return "clockwork"
  return recentTrend === "decelerating" ? "bursty" : "episodic"
}

function computeCustomerFeatures(
  payments: { amount: number; date: string }[],
  now: string,
): CustomerFeatures {
  const amounts = payments.map((p) => p.amount)
  const amountMean = amounts.reduce((a, b) => a + b, 0) / Math.max(1, amounts.length)
  const amountStd = std(amounts)

  const intervals: number[] = []
  for (let i = 1; i < payments.length; i++) {
    intervals.push(daysBetween(payments[i - 1].date, payments[i].date))
  }
  const avgInterval = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0
  const stdInterval = std(intervals)
  const intervalCv = avgInterval > 0 ? stdInterval / avgInterval : 999

  let recentTrend: CustomerFeatures["recent_trend"] = "insufficient"
  if (payments.length >= 4) {
    const mid = Math.floor(payments.length / 2)
    const firstAvg = amounts.slice(0, mid).reduce((a, b) => a + b, 0) / Math.max(1, mid)
    const secondAvg = amounts.slice(mid).reduce((a, b) => a + b, 0) / Math.max(1, amounts.length - mid)
    if (firstAvg > 0) {
      const ratio = secondAvg / firstAvg
      recentTrend = ratio > 1.15 ? "accelerating" : ratio < 0.85 ? "decelerating" : "stable"
    }
  }

  return {
    avg_days_to_pay: avgInterval,
    interval_cv: r2(intervalCv),
    amount_mean: r2(amountMean),
    amount_std: r2(amountStd),
    recent_trend: recentTrend,
  }
}

function expectedCollectionDate(
  inv: OutstandingInvoice,
  features: CustomerFeatures,
  archetype: CustomerArchetype,
  now: string,
): string {
  const dso = features.avg_days_to_pay
  const daysOverdue = inv.days_overdue ?? 0
  const daysUntilDue = inv.days_until_due ?? 0

  if (archetype === "clockwork") {
    const expectedDelay = dso > 0 ? dso : 5
    if (daysOverdue > 0) return addDays(now, Math.max(2, Math.round(expectedDelay - daysOverdue)))
    return inv.due_date ? addDays(inv.due_date, Math.round(expectedDelay)) : addDays(now, daysUntilDue + expectedDelay)
  }
  if (archetype === "slow_reliable") {
    const expectedDelay = Math.max(dso, 15)
    if (daysOverdue > 0) return addDays(now, Math.max(3, Math.round(expectedDelay - daysOverdue)))
    return inv.due_date ? addDays(inv.due_date, Math.round(expectedDelay)) : addDays(now, 30)
  }
  if (archetype === "bursty" || archetype === "volatile") {
    return inv.due_date ? addDays(inv.due_date, Math.round(dso > 0 ? dso : 10)) : addDays(now, 14)
  }
  if (archetype === "low_data") {
    if (daysOverdue > 0) return addDays(now, 7)
    return inv.due_date ?? addDays(now, 14)
  }
  if (daysOverdue > 0) return addDays(now, 5)
  return inv.due_date ?? addDays(now, 14)
}

export function buildArExpectedCollectionMap(
  invoices: OutstandingInvoice[],
  paymentObservations: ArPaymentObservation[],
  today: string,
): Map<string, string> {
  const byCustomer = new Map<
    string,
    { payments: { amount: number; date: string; isAnomaly: boolean; isOutlier: boolean; isFirstSeen: boolean; confidence: number }[]; invoiceIds: Set<string> }
  >()

  for (const p of paymentObservations) {
    if (p.state_inclusion_policy === "exclude_and_review") continue
    if (p.counterparty_role === "owner") continue
    const key = resolveCustomerKey(p)
    let entry = byCustomer.get(key)
    if (!entry) {
      entry = { payments: [], invoiceIds: new Set<string>() }
      byCustomer.set(key, entry)
    }
    entry.payments.push({
      amount: p.amount,
      date: p.date.slice(0, 10),
      isAnomaly: p.is_anomaly,
      isOutlier: p.is_large_outlier,
      isFirstSeen: p.is_first_seen_counterparty,
      confidence: p.classification_confidence ?? 0,
    })
    if (p.invoice_id) entry.invoiceIds.add(p.invoice_id)
  }

  const result = new Map<string, string>()
  const now = today
  const assigned = new Set<string>()

  for (const [key, data] of byCustomer) {
    const payments = data.payments.sort((a, b) => a.date.localeCompare(b.date))
    if (payments.length === 0) continue

    const normalPayments = payments.filter((p) => !p.isAnomaly && !p.isOutlier)
    const usePayments = normalPayments.length >= 2 ? normalPayments : payments
    const features = computeCustomerFeatures(usePayments.map((p) => ({ amount: p.amount, date: p.date })), now)
    const amountCv = features.amount_mean > 0 ? features.amount_std / features.amount_mean : 0
    const archetype = classifyCustomerArchetype(
      payments.length,
      features.interval_cv,
      features.avg_days_to_pay,
      amountCv,
      features.recent_trend,
    )

    const customerInvoices = invoices.filter((inv) => {
      if (assigned.has(inv.invoice_id)) return false
      if (data.invoiceIds.has(inv.invoice_id)) return true
      if (inv.entity_id && inv.entity_id === key) return true
      const invName = normalizeKey(inv.customer_name)
      return key.startsWith("name:") && invName.length >= 3 && (key.slice(5).includes(invName) || invName.includes(key.slice(5)))
    })

    if (customerInvoices.length === 0) continue
    for (const inv of customerInvoices) {
      assigned.add(inv.invoice_id)
      result.set(inv.invoice_id, expectedCollectionDate(inv, features, archetype, now))
    }
  }

  const unmatched = invoices.filter((inv) => !result.has(inv.invoice_id))
  for (const inv of unmatched) {
    const archetype: CustomerArchetype = "low_data"
    result.set(inv.invoice_id, expectedCollectionDate(inv, { avg_days_to_pay: 0, interval_cv: 999, amount_mean: inv.amount_due, amount_std: 0, recent_trend: "insufficient" }, archetype, now))
  }

  return result
}

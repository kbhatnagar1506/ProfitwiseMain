// ─── AR/AP Business State Layer ───────────────────────────────────────
//
// AR (Accounts Receivable): Expected inflow, not yet received.
//   - From invoices (QBO, Xero, Stripe, Gmail inferred)
//   - Exists before payment; decreases when payment happens
//
// Behavioral AP (Accounts Payable): Expected outflow, not yet paid.
//   - Derived from money movement patterns (recurring vendor payments)
//   - We do NOT use QBO/Xero bills — purely behavioral inference

import type { OutstandingInvoice, VendorModel } from "./types"

export type ARState = {
  total_outstanding: number
  total_overdue: number
  overdue_count: number
  invoice_count: number
  invoices: OutstandingInvoice[]
  avg_days_to_due: number | null
}

export type BehavioralAPObligation = {
  obligation_id: string
  vendor_name: string
  entity_id: string | null
  expected_amount: number
  next_expected_date: string
  days_until_due: number
  source: "behavioral"
  confidence: "high" | "medium" | "low"
  cadence: string
  payment_count: number
}

export type BehavioralAPState = {
  total_expected_30d: number
  obligation_count: number
  obligations: BehavioralAPObligation[]
}

export type ARAPState = {
  ar: ARState
  behavioral_ap: BehavioralAPState
}

const r2 = (n: number) => Math.round(n * 100) / 100

function addDays(date: string, days: number): string {
  const d = new Date(date)
  d.setDate(d.getDate() + Math.round(days))
  return d.toISOString().slice(0, 10)
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000)
}

export function computeARState(invoices: OutstandingInvoice[]): ARState {
  const total = invoices.reduce((s, i) => s + i.amount_due, 0)
  const overdue = invoices.filter((i) => i.status === "overdue")
  const overdueTotal = overdue.reduce((s, i) => s + i.amount_due, 0)
  const dueDays = invoices.filter((i) => i.days_until_due != null).map((i) => i.days_until_due!)
  const avgDue = dueDays.length > 0 ? dueDays.reduce((a, b) => a + b, 0) / dueDays.length : null

  return {
    total_outstanding: r2(total),
    total_overdue: r2(overdueTotal),
    overdue_count: overdue.length,
    invoice_count: invoices.length,
    invoices,
    avg_days_to_due: avgDue != null ? r2(avgDue) : null,
  }
}

export function computeBehavioralAPState(
  vendors: VendorModel[],
  horizonDays: number = 30,
): BehavioralAPState {
  const today = new Date().toISOString().slice(0, 10)
  const horizon = addDays(today, horizonDays)
  const obligations: BehavioralAPObligation[] = []

  for (const v of vendors) {
    // Skip vendors without recurrence signal
    if (!v.is_recurring && v.payment_count < 3) continue
    const recConf = v.recurrence.recurrence_confidence
    const recType = v.recurrence.recurrence_type
    if (recType === "episodic" || recType === "unknown") continue
    if (recConf < 0.2) continue

    // Generate next expected payment dates
    let nextDate = addDays(v.last_payment_date, v.cadence_interval_days)
    while (nextDate < today && v.cadence_interval_days > 0) {
      nextDate = addDays(nextDate, v.cadence_interval_days)
    }
    if (nextDate > horizon) continue

    const daysUntilDue = daysBetween(today, nextDate)
    if (daysUntilDue < 1) continue

    obligations.push({
      obligation_id: `behavioral_${v.entity_id}_${nextDate}`,
      vendor_name: v.name,
      entity_id: v.entity_id,
      expected_amount: r2(v.avg_amount),
      next_expected_date: nextDate,
      days_until_due: daysUntilDue,
      source: "behavioral",
      confidence: v.confidence,
      cadence: v.cadence,
      payment_count: v.payment_count,
    })
  }

  const total_expected_30d = obligations.reduce((s, o) => s + o.expected_amount, 0)

  return {
    total_expected_30d: r2(total_expected_30d),
    obligation_count: obligations.length,
    obligations: obligations.sort((a, b) => a.days_until_due - b.days_until_due),
  }
}

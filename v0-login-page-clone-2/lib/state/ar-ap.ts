// ─── AR/AP Business State Layer (Step 12 only) ────────────────────────
//
// CONSTRAINT: Only touches data from steps 1–11. No state/forecast.
//
// AR (Accounts Receivable): Expected inflow, not yet received.
//   - From invoices (QBO, Xero, Stripe, Gmail) — step 3, 4
//   - Exists before payment; decreases when payment happens
//
// AP (Accounts Payable): Expected outflow, not yet paid.
//   - Bill-based: QBO, Xero, Gmail
//   - Inferred: from tagged movements (step 10–11) — vendor payment patterns

import { toEntityUriApBill, toEntityUriApInferred } from "@/lib/entity-uri"
import type { OutstandingInvoice, OutstandingBill, VendorModel } from "./types"

export type ARState = {
  total_outstanding: number
  total_overdue: number
  overdue_count: number
  invoice_count: number
  invoices: OutstandingInvoice[]
  avg_days_to_due: number | null
}

export type APObligation = {
  obligation_id: string
  source: "bill" | "inferred"
  bill_id: string | null
  vendor_name: string
  entity_id: string | null
  expected_amount: number
  amount_due: number
  due_date: string | null
  next_expected_date: string
  days_until_due: number
  days_overdue: number | null
  priority: "high" | "medium" | "low"
  risk_flag: string | null
  confidence: "high" | "medium" | "low"
  cadence: string
  payment_count: number
  payment_terms: string | null
  tolerance_days: number | null
  metadata: Record<string, unknown>
}

export type APState = {
  total_expected_30d: number
  obligation_count: number
  obligations: APObligation[]
}

export type ARAPState = {
  ar: ARState
  ap: APState
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

export function computeAPState(
  vendors: VendorModel[],
  horizonDays: number = 30,
): APState {
  const today = new Date().toISOString().slice(0, 10)
  const horizon = addDays(today, horizonDays)
  const obligations: APObligation[] = []

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
      obligation_id: toEntityUriApInferred(v.entity_id, nextDate),
      source: "inferred",
      bill_id: null,
      vendor_name: v.name,
      entity_id: v.entity_id,
      expected_amount: r2(v.avg_amount),
      amount_due: r2(v.avg_amount),
      due_date: nextDate,
      next_expected_date: nextDate,
      days_until_due: daysUntilDue,
      days_overdue: null,
      priority: "medium",
      risk_flag: null,
      confidence: v.confidence,
      cadence: v.cadence,
      payment_count: v.payment_count,
      payment_terms: null,
      tolerance_days: v.recurrence.interval_std_days ?? null,
      metadata: {},
    })
  }

  const total_expected_30d = obligations.reduce((s, o) => s + o.expected_amount, 0)

  return {
    total_expected_30d: r2(total_expected_30d),
    obligation_count: obligations.length,
    obligations: obligations.sort((a, b) => a.days_until_due - b.days_until_due),
  }
}

/** Convert outstanding bills to AP obligations. */
export function computeAPStateFromBills(bills: OutstandingBill[]): APObligation[] {
  const today = new Date().toISOString().slice(0, 10)
  const obligations: APObligation[] = []

  for (const b of bills) {
    const dueDate = b.due_date ?? today
    const rawDaysUntilDue = b.days_until_due ?? daysBetween(today, dueDate)
    const daysUntilDue = Math.max(0, rawDaysUntilDue)
    const daysOverdue = b.days_overdue ?? (rawDaysUntilDue < 0 ? Math.abs(rawDaysUntilDue) : null)
    const priority: APObligation["priority"] = b.status === "overdue" ? "high" : "medium"
    const riskFlag = (b.days_overdue ?? 0) > 0 ? "overdue" : null
    const confidence: APObligation["confidence"] = b.due_date ? "high" : "medium"

    obligations.push({
      obligation_id: toEntityUriApBill(b.source, b.bill_id),
      source: "bill",
      bill_id: b.bill_id,
      vendor_name: b.vendor_name,
      entity_id: b.entity_id,
      expected_amount: r2(b.amount_due),
      amount_due: r2(b.amount_due),
      due_date: b.due_date,
      next_expected_date: dueDate,
      days_until_due: daysUntilDue,
      days_overdue: daysOverdue,
      priority,
      risk_flag: riskFlag,
      confidence,
      cadence: "bill",
      payment_count: 0,
      payment_terms: null,
      tolerance_days: null,
      metadata: { bill_source: b.source },
    })
  }

  return obligations
}

const DEDUP_WINDOW_DAYS = 7

function vendorKey(o: APObligation): string {
  return o.entity_id ?? `n:${o.vendor_name.toLowerCase().trim()}`
}

/**
 * Merge obligations: BEHAVIOR FIRST, bills last.
 * 1. Observed payments / recurrence (inferred) = ground truth
 * 2. Bills = optional, only when no inferred covers the due window (±7 days)
 */
export function mergeAPObligations(
  billObligations: APObligation[],
  inferredObligations: APObligation[],
): APObligation[] {
  const byVendor = new Map<string, APObligation[]>()
  for (const o of billObligations) {
    const key = vendorKey(o)
    if (!byVendor.has(key)) byVendor.set(key, [])
    byVendor.get(key)!.push(o)
  }

  const merged: APObligation[] = [...inferredObligations]

  for (const bill of billObligations) {
    const key = vendorKey(bill)
    const inferredForVendor = merged.filter((o) => vendorKey(o) === key)
    const billDue = bill.due_date ? new Date(bill.due_date).getTime() : 0
    const covered = inferredForVendor.some((inf) => {
      if (!inf.due_date) return false
      const infDue = new Date(inf.due_date).getTime()
      const diffDays = Math.abs((billDue - infDue) / 86_400_000)
      return diffDays <= DEDUP_WINDOW_DAYS
    })
    if (!covered) merged.push(bill)
  }

  return merged.sort((a, b) => a.days_until_due - b.days_until_due)
}

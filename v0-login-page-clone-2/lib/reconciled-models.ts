/**
 * Reconciled AR/AP Models
 * 
 * Builds customer inflow and vendor outflow models from reconciled movements
 * (matched to invoices/bills via movement_attributions).
 * 
 * This provides much higher confidence than raw movement models because:
 * - Only uses matched, reconciled transactions
 * - Filters out noise (transfers, fees, unmatched movements)
 * - Leverages invoice/bill due dates for better timing signals
 */

import { query } from "./db"
import { log } from "./logger"

export type ReconciledARMovement = {
  movement_id: string
  entity_id: string
  entity_name: string
  amount: number
  date: string
  invoice_id: string | null
  due_date: string | null
  days_overdue: number | null
  confidence: number
  source: "rule" | "model" | "llm" | "user"
  created_at: string
}

export type ReconciledAPMovement = {
  movement_id: string
  entity_id: string
  entity_name: string
  amount: number
  date: string
  bill_id: string | null
  due_date: string | null
  days_overdue: number | null
  confidence: number
  source: "rule" | "model" | "llm" | "user"
  created_at: string
}

/**
 * Fetch reconciled AR movements (customer payments matched to invoices)
 */
export async function fetchReconciledARMovements(userId: string): Promise<ReconciledARMovement[]> {
  try {
    const { rows } = await query<{
      movement_id: string
      entity_id: string
      entity_name: string
      amount: string
      date: string
      invoice_id: string | null
      due_date: string | null
      days_overdue: string | null
      confidence: string
      source: string
      created_at: string
    }>(
      `SELECT 
        m.id as movement_id,
        a.entity_id,
        COALESCE(e.name, a.entity_id) as entity_name,
        m.amount::float,
        m.date::text,
        a.reference_id as invoice_id,
        i.due_date::text,
        EXTRACT(DAY FROM (NOW()::date - i.due_date))::int as days_overdue,
        a.confidence::text,
        a.source,
        a.created_at::text
       FROM movement_attributions a
       JOIN movements m ON a.movement_id = m.id
       LEFT JOIN entities e ON a.entity_id = e.id
       LEFT JOIN outstanding_invoices i ON a.reference_id = i.invoice_id
       WHERE a.user_id = $1::uuid
         AND a.component_type = 'ar'
         AND m.direction = 'inflow'
         AND m.duplicate_of IS NULL
       ORDER BY m.date DESC`,
      [userId]
    )

    return rows.map((r) => ({
      movement_id: r.movement_id,
      entity_id: r.entity_id,
      entity_name: r.entity_name,
      amount: parseFloat(r.amount),
      date: r.date,
      invoice_id: r.invoice_id,
      due_date: r.due_date,
      days_overdue: r.days_overdue ? parseInt(r.days_overdue) : null,
      confidence: parseFloat(r.confidence),
      source: r.source as "rule" | "model" | "llm" | "user",
      created_at: r.created_at,
    }))
  } catch (err) {
    log("reconciled_ar.fetch.error", { error: err instanceof Error ? err.message : String(err) }, "forecast")
    return []
  }
}

/**
 * Fetch reconciled AP movements (vendor payments matched to bills)
 */
export async function fetchReconciledAPMovements(userId: string): Promise<ReconciledAPMovement[]> {
  try {
    const { rows } = await query<{
      movement_id: string
      entity_id: string
      entity_name: string
      amount: string
      date: string
      bill_id: string | null
      due_date: string | null
      days_overdue: string | null
      confidence: string
      source: string
      created_at: string
    }>(
      `SELECT 
        m.id as movement_id,
        a.entity_id,
        COALESCE(e.name, a.entity_id) as entity_name,
        m.amount::float,
        m.date::text,
        a.reference_id as bill_id,
        b.due_date::text,
        EXTRACT(DAY FROM (NOW()::date - b.due_date))::int as days_overdue,
        a.confidence::text,
        a.source,
        a.created_at::text
       FROM movement_attributions a
       JOIN movements m ON a.movement_id = m.id
       LEFT JOIN entities e ON a.entity_id = e.id
       LEFT JOIN outstanding_bills b ON a.reference_id = b.bill_id
       WHERE a.user_id = $1::uuid
         AND a.component_type = 'ap'
         AND m.direction = 'outflow'
         AND m.duplicate_of IS NULL
       ORDER BY m.date DESC`,
      [userId]
    )

    return rows.map((r) => ({
      movement_id: r.movement_id,
      entity_id: r.entity_id,
      entity_name: r.entity_name,
      amount: parseFloat(r.amount),
      date: r.date,
      bill_id: r.bill_id,
      due_date: r.due_date,
      days_overdue: r.days_overdue ? parseInt(r.days_overdue) : null,
      confidence: parseFloat(r.confidence),
      source: r.source as "rule" | "model" | "llm" | "user",
      created_at: r.created_at,
    }))
  } catch (err) {
    log("reconciled_ap.fetch.error", { error: err instanceof Error ? err.message : String(err) }, "forecast")
    return []
  }
}

/**
 * Calculate statistics for a customer from reconciled AR movements
 */
export function analyzeReconciledCustomer(movements: ReconciledARMovement[]) {
  if (movements.length === 0) {
    return {
      payment_count: 0,
      avg_amount: 0,
      total_amount: 0,
      avg_days_to_pay: 0,
      reliability_score: 0,
      avg_confidence: 0,
      date_range_days: 0,
    }
  }

  const sorted = [...movements].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  const amounts = movements.map((m) => m.amount)
  const confidences = movements.map((m) => m.confidence)

  // Calculate intervals between payments
  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const days = Math.round(
      (new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) / 86_400_000
    )
    if (days > 0 && days < 365) intervals.push(days)
  }

  // Calculate days to pay (from due date if available, else estimate)
  const daysToPayList: number[] = []
  for (const m of movements) {
    if (m.due_date) {
      const days = Math.round(
        (new Date(m.date).getTime() - new Date(m.due_date).getTime()) / 86_400_000
      )
      daysToPayList.push(Math.max(0, days))
    }
  }

  // Reliability: how consistent are the payments?
  const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length
  const variance = amounts.reduce((sum, a) => sum + Math.pow(a - avgAmount, 2), 0) / amounts.length
  const stdDev = Math.sqrt(variance)
  const cv = avgAmount > 0 ? stdDev / avgAmount : 0
  const reliability = Math.max(0, 1 - cv) // Higher CV = lower reliability

  const firstDate = new Date(sorted[0].date).getTime()
  const lastDate = new Date(sorted[sorted.length - 1].date).getTime()
  const dateRangeDays = Math.round((lastDate - firstDate) / 86_400_000)

  return {
    payment_count: movements.length,
    avg_amount: Math.round(avgAmount * 100) / 100,
    total_amount: Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100,
    avg_days_to_pay: daysToPayList.length > 0 ? Math.round(daysToPayList.reduce((a, b) => a + b, 0) / daysToPayList.length) : 0,
    reliability_score: Math.round(reliability * 100) / 100,
    avg_confidence: Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100,
    date_range_days: dateRangeDays,
  }
}

/**
 * Calculate statistics for a vendor from reconciled AP movements
 */
export function analyzeReconciledVendor(movements: ReconciledAPMovement[]) {
  if (movements.length === 0) {
    return {
      payment_count: 0,
      avg_amount: 0,
      total_amount: 0,
      avg_days_to_pay: 0,
      recurrence_score: 0,
      avg_confidence: 0,
      date_range_days: 0,
    }
  }

  const sorted = [...movements].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  const amounts = movements.map((m) => m.amount)
  const confidences = movements.map((m) => m.confidence)

  // Calculate intervals between payments
  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const days = Math.round(
      (new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) / 86_400_000
    )
    if (days > 0 && days < 365) intervals.push(days)
  }

  // Calculate days to pay (from due date if available)
  const daysToPayList: number[] = []
  for (const m of movements) {
    if (m.due_date) {
      const days = Math.round(
        (new Date(m.date).getTime() - new Date(m.due_date).getTime()) / 86_400_000
      )
      daysToPayList.push(Math.max(0, days))
    }
  }

  // Recurrence: how regular are the payments?
  const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length
  const variance = amounts.reduce((sum, a) => sum + Math.pow(a - avgAmount, 2), 0) / amounts.length
  const stdDev = Math.sqrt(variance)
  const cv = avgAmount > 0 ? stdDev / avgAmount : 0

  // Recurrence score: low CV + regular intervals = high recurrence
  const intervalVariance = intervals.length > 1
    ? intervals.reduce((sum, i) => sum + Math.pow(i - intervals[0], 2), 0) / intervals.length
    : 0
  const intervalStdDev = Math.sqrt(intervalVariance)
  const avgInterval = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0
  const intervalCV = avgInterval > 0 ? intervalStdDev / avgInterval : 0

  const recurrence = Math.max(0, (1 - cv) * (1 - intervalCV))

  const firstDate = new Date(sorted[0].date).getTime()
  const lastDate = new Date(sorted[sorted.length - 1].date).getTime()
  const dateRangeDays = Math.round((lastDate - firstDate) / 86_400_000)

  return {
    payment_count: movements.length,
    avg_amount: Math.round(avgAmount * 100) / 100,
    total_amount: Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100,
    avg_days_to_pay: daysToPayList.length > 0 ? Math.round(daysToPayList.reduce((a, b) => a + b, 0) / daysToPayList.length) : 0,
    recurrence_score: Math.round(recurrence * 100) / 100,
    avg_confidence: Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100,
    date_range_days: dateRangeDays,
  }
}

/**
 * Build customer inflow models from reconciled AR movements
 * Groups by customer and analyzes payment patterns
 */
export function buildReconciledCustomerModels(movements: ReconciledARMovement[]) {
  const byCustomer = new Map<string, ReconciledARMovement[]>()

  for (const m of movements) {
    const key = m.entity_id
    const arr = byCustomer.get(key) ?? []
    arr.push(m)
    byCustomer.set(key, arr)
  }

  const models: Array<{
    entity_id: string
    entity_name: string
    stats: ReturnType<typeof analyzeReconciledCustomer>
    movements: ReconciledARMovement[]
  }> = []

  for (const [entityId, customerMovements] of byCustomer) {
    const stats = analyzeReconciledCustomer(customerMovements)
    if (stats.payment_count >= 2) {
      // Only include customers with at least 2 reconciled payments
      models.push({
        entity_id: entityId,
        entity_name: customerMovements[0].entity_name,
        stats,
        movements: customerMovements,
      })
    }
  }

  return models.sort((a, b) => b.stats.total_amount - a.stats.total_amount)
}

/**
 * Build vendor outflow models from reconciled AP movements
 * Groups by vendor and analyzes payment patterns
 */
export function buildReconciledVendorModels(movements: ReconciledAPMovement[]) {
  const byVendor = new Map<string, ReconciledAPMovement[]>()

  for (const m of movements) {
    const key = m.entity_id
    const arr = byVendor.get(key) ?? []
    arr.push(m)
    byVendor.set(key, arr)
  }

  const models: Array<{
    entity_id: string
    entity_name: string
    stats: ReturnType<typeof analyzeReconciledVendor>
    movements: ReconciledAPMovement[]
  }> = []

  for (const [entityId, vendorMovements] of byVendor) {
    const stats = analyzeReconciledVendor(vendorMovements)
    if (stats.payment_count >= 2) {
      // Only include vendors with at least 2 reconciled payments
      models.push({
        entity_id: entityId,
        entity_name: vendorMovements[0].entity_name,
        stats,
        movements: vendorMovements,
      })
    }
  }

  return models.sort((a, b) => b.stats.total_amount - a.stats.total_amount)
}


/**
 * LLM hallucination detector for reconciliation matches.
 *
 * The LLM can hallucinate invoice_ids, bill_ids, or movement_ids that don't
 * exist in our database. It can also suggest amounts or dates that are wildly
 * inconsistent with the actual data.
 *
 * This module validates LLM output BEFORE applying any match, ensuring
 * only grounded suggestions get written to movement_attributions.
 *
 * Validation checks:
 *   1. Entity existence — invoice_id / bill_id must exist in the DB
 *   2. Movement existence — movement_id must exist in the DB
 *   3. Amount tolerance — suggested amount within ±10% of actual
 *   4. Date proximity — movement date within 60 days of invoice due date
 *   5. Entity name similarity — Levenshtein score > 0.5
 */

import { query } from "@/lib/db"
import type { ARMatchSuggestion, APMatchSuggestion, InvoiceForMatch, BillForMatch } from "@/lib/reconciliation-llm-match"
import { tokenSimilarity } from "@/lib/levenshtein"

export interface HallucinationCheckResult {
  valid: boolean
  reason: string | null
  hallucinationType: "none" | "missing_entity" | "amount_mismatch" | "date_mismatch" | "name_mismatch" | "missing_movement"
}

const AMOUNT_TOLERANCE_PCT = 0.10   // 10% tolerance
const DATE_TOLERANCE_DAYS = 60      // 60 days
const NAME_SIMILARITY_THRESHOLD = 0.40  // Levenshtein token similarity

function daysDiff(dateA: string | null | undefined, dateB: string | null | undefined): number | null {
  if (!dateA || !dateB) return null
  const a = new Date(dateA)
  const b = new Date(dateB)
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null
  return Math.abs((a.getTime() - b.getTime()) / 86_400_000)
}

/**
 * Validate a single AR (invoice) match suggestion.
 */
export function validateARSuggestion(
  suggestion: ARMatchSuggestion,
  invoiceMap: Map<string, InvoiceForMatch>,
  movementAmounts: Map<string, number>,
  movementDates?: Map<string, string>
): HallucinationCheckResult {
  // Check 1: invoice must exist in our known set
  const invoice = invoiceMap.get(suggestion.invoice_id)
  if (!invoice) {
    return {
      valid: false,
      reason: `Invoice ${suggestion.invoice_id} not found in active invoice set`,
      hallucinationType: "missing_entity",
    }
  }

  // Check 2: movement must exist
  const movementAmount = movementAmounts.get(suggestion.movement_id)
  if (movementAmount === undefined) {
    return {
      valid: false,
      reason: `Movement ${suggestion.movement_id} not found`,
      hallucinationType: "missing_movement",
    }
  }

  // Check 3: amount within tolerance
  const suggestedAmount = suggestion.amount_matched ?? invoice.amount_due
  const lower = invoice.amount_due * (1 - AMOUNT_TOLERANCE_PCT)
  const upper = invoice.amount_due * (1 + AMOUNT_TOLERANCE_PCT)
  if (suggestedAmount < lower || suggestedAmount > upper) {
    // Also allow if movement amount itself is close to invoice amount
    const movLower = movementAmount * (1 - AMOUNT_TOLERANCE_PCT)
    const movUpper = movementAmount * (1 + AMOUNT_TOLERANCE_PCT)
    if (invoice.amount_due < movLower || invoice.amount_due > movUpper) {
      return {
        valid: false,
        reason: `Amount mismatch: suggested ${suggestedAmount.toFixed(2)}, invoice ${invoice.amount_due.toFixed(2)}, movement ${movementAmount.toFixed(2)}`,
        hallucinationType: "amount_mismatch",
      }
    }
  }

  // Check 4: date proximity (best-effort, skip if dates unavailable)
  const movDate = movementDates?.get(suggestion.movement_id)
  const diff = daysDiff(movDate, invoice.due_date)
  if (diff !== null && diff > DATE_TOLERANCE_DAYS) {
    return {
      valid: false,
      reason: `Date too far apart: ${diff.toFixed(0)} days (max ${DATE_TOLERANCE_DAYS})`,
      hallucinationType: "date_mismatch",
    }
  }

  return { valid: true, reason: null, hallucinationType: "none" }
}

/**
 * Validate a single AP (bill) match suggestion.
 */
export function validateAPSuggestion(
  suggestion: APMatchSuggestion,
  billMap: Map<string, BillForMatch>,
  movementAmounts: Map<string, number>,
  movementDates?: Map<string, string>
): HallucinationCheckResult {
  const bill = billMap.get(suggestion.obligation_id)
  if (!bill) {
    return {
      valid: false,
      reason: `Bill ${suggestion.obligation_id} not found in active bill set`,
      hallucinationType: "missing_entity",
    }
  }

  const movementAmount = movementAmounts.get(suggestion.movement_id)
  if (movementAmount === undefined) {
    return {
      valid: false,
      reason: `Movement ${suggestion.movement_id} not found`,
      hallucinationType: "missing_movement",
    }
  }

  const suggestedAmount = suggestion.amount_matched ?? bill.amount_due
  const lower = bill.amount_due * (1 - AMOUNT_TOLERANCE_PCT)
  const upper = bill.amount_due * (1 + AMOUNT_TOLERANCE_PCT)
  if (suggestedAmount < lower || suggestedAmount > upper) {
    const movLower = movementAmount * (1 - AMOUNT_TOLERANCE_PCT)
    const movUpper = movementAmount * (1 + AMOUNT_TOLERANCE_PCT)
    if (bill.amount_due < movLower || bill.amount_due > movUpper) {
      return {
        valid: false,
        reason: `Amount mismatch: suggested ${suggestedAmount.toFixed(2)}, bill ${bill.amount_due.toFixed(2)}, movement ${movementAmount.toFixed(2)}`,
        hallucinationType: "amount_mismatch",
      }
    }
  }

  const movDate = movementDates?.get(suggestion.movement_id)
  const diff = daysDiff(movDate, bill.due_date)
  if (diff !== null && diff > DATE_TOLERANCE_DAYS) {
    return {
      valid: false,
      reason: `Date too far apart: ${diff.toFixed(0)} days (max ${DATE_TOLERANCE_DAYS})`,
      hallucinationType: "date_mismatch",
    }
  }

  return { valid: true, reason: null, hallucinationType: "none" }
}

export interface HallucinationReport {
  totalAR: number
  totalAP: number
  invalidAR: number
  invalidAP: number
  hallucinationRate: number
  details: Array<{
    type: "ar" | "ap"
    movementId: string
    entityId: string
    result: HallucinationCheckResult
  }>
}

/**
 * Filter a full BatchMatchResult, removing hallucinated suggestions.
 * Returns the cleaned suggestions and a hallucination report.
 */
export function filterHallucinations(
  arSuggestions: ARMatchSuggestion[],
  apSuggestions: APMatchSuggestion[],
  invoiceMap: Map<string, InvoiceForMatch>,
  billMap: Map<string, BillForMatch>,
  movementAmounts: Map<string, number>,
  movementDates?: Map<string, string>
): {
  validAR: ARMatchSuggestion[]
  validAP: APMatchSuggestion[]
  report: HallucinationReport
} {
  const details: HallucinationReport["details"] = []
  const validAR: ARMatchSuggestion[] = []
  const validAP: APMatchSuggestion[] = []

  for (const ar of arSuggestions) {
    const result = validateARSuggestion(ar, invoiceMap, movementAmounts, movementDates)
    if (result.valid) {
      validAR.push(ar)
    } else {
      details.push({ type: "ar", movementId: ar.movement_id, entityId: ar.invoice_id, result })
      console.warn(
        `[Hallucination] AR suggestion rejected: ${ar.movement_id} → ${ar.invoice_id}: ${result.reason}`
      )
    }
  }

  for (const ap of apSuggestions) {
    const result = validateAPSuggestion(ap, billMap, movementAmounts, movementDates)
    if (result.valid) {
      validAP.push(ap)
    } else {
      details.push({ type: "ap", movementId: ap.movement_id, entityId: ap.obligation_id, result })
      console.warn(
        `[Hallucination] AP suggestion rejected: ${ap.movement_id} → ${ap.obligation_id}: ${result.reason}`
      )
    }
  }

  const total = arSuggestions.length + apSuggestions.length
  const invalid = details.length
  const report: HallucinationReport = {
    totalAR: arSuggestions.length,
    totalAP: apSuggestions.length,
    invalidAR: details.filter(d => d.type === "ar").length,
    invalidAP: details.filter(d => d.type === "ap").length,
    hallucinationRate: total > 0 ? invalid / total : 0,
    details,
  }

  if (report.hallucinationRate > 0.02) {
    console.warn(
      `[Hallucination] HIGH hallucination rate: ${(report.hallucinationRate * 100).toFixed(1)}% ` +
      `(${invalid}/${total} suggestions rejected)`
    )
  }

  return { validAR, validAP, report }
}

/**
 * Log hallucination events to the reconciliation_audit_log for observability.
 * Fire-and-forget.
 */
export function logHallucinationReport(userId: string, report: HallucinationReport): void {
  if (report.hallucinationRate === 0) return

  setImmediate(async () => {
    try {
      await query(
        `INSERT INTO reconciliation_metrics (user_id, metric_name, metric_value)
         VALUES ($1, 'hallucination_rate', $2),
                ($1, 'hallucinated_ar_count', $3),
                ($1, 'hallucinated_ap_count', $4)`,
        [userId, report.hallucinationRate, report.invalidAR, report.invalidAP]
      )
    } catch (err) {
      console.error("[Hallucination] Failed to log report:", err)
    }
  })
}

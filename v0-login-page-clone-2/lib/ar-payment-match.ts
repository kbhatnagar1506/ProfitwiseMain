/**
 * AR (invoice) to Payment matching.
 * Tolerance-based: entity + time ±45d + amount ±5% (covers 3% fee + variance).
 * Payment amount = net (what hit bank); invoice amount_due = gross.
 */

import type { OutstandingInvoice } from "./state/types"
import type { EntityPaymentProfile } from "./entity-payment-profiles"
import { getEntityPaymentRatio } from "./entity-payment-profiles"
import { toEntityUriAr } from "./entity-uri"

const AMOUNT_TOLERANCE_PCT = 0.05
const AR_DATE_TOLERANCE_DAYS = 45

export type InflowPayment = {
  movement_id: string
  amount: number
  date: string
  entity_id: string | null
  raw_description: string | null
  /** Prefer `resolveDisplayNames` output (entity > merchant tag > counterparty) for name fallback when entity IDs disagree. */
  counterparty_name?: string | null
}

export type ARMatchSuggestion = {
  invoice_id: string
  customer_name: string
  amount_due: number
  confidence: "high" | "medium" | "low"
  reasoning: string
  gross_applied: number
  fee_amount: number
  net_applied: number
}

export type AllocationCandidate = {
  movement_id: string
  invoice_id: string
  gross_applied: number
  fee_amount: number
  net_applied: number
  confidence: number
  match_method: "exact" | "tolerance"
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000)
}

/** Normalize name for fuzzy match: lowercase, collapse spaces, remove punctuation. */
function normalizeName(s: string | null | undefined): string {
  if (!s || typeof s !== "string") return ""
  return s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim()
}

/** Check if two names are similar enough (one contains the other, or they share key tokens). */
function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes(nb) || nb.includes(na)) return true
  const tokensA = new Set(na.split(/\s+/).filter((t) => t.length > 1))
  const tokensB = new Set(nb.split(/\s+/).filter((t) => t.length > 1))
  const overlap = [...tokensA].filter((t) => tokensB.has(t)).length
  return overlap >= Math.min(tokensA.size, tokensB.size, 2)
}

const PROFILE_RATIO_TOLERANCE = 0.02
const PROFILE_CONFIDENCE_BOOST = 0.05

/** Deterministic AR match: entity + time ±45d + amount ±5%. When entity_id is missing on one side, use counterparty name. */
function deterministicARMatch(
  payment: InflowPayment,
  invoice: OutstandingInvoice,
  entityProfiles?: Map<string, EntityPaymentProfile>,
): { confidence: number; gross: number; fee: number; net: number; method: "exact" | "tolerance" } | null {
  if (payment.amount <= 0 || invoice.amount_due <= 0) return null

  // Entity match: when both have entity_id, they must match for full confidence.
  const entityMatch = payment.entity_id && invoice.entity_id
    ? payment.entity_id === invoice.entity_id
    : false
  // When entity IDs differ, allow name match as fallback (same person resolved to different entities).
  const nameMatch = namesMatch(
    payment.counterparty_name ?? payment.raw_description,
    invoice.customer_name,
  )
  if (payment.entity_id && invoice.entity_id && !entityMatch && !nameMatch) return null

  // Time window: payment date within ±45 days of due date
  const dueDate = invoice.due_date ?? payment.date
  const diffDays = Math.abs(daysBetween(payment.date, dueDate))
  if (diffDays > AR_DATE_TOLERANCE_DAYS) return null

  // Amount: payment (net) within ±5% of invoice (gross). Fee inferred: gross - net.
  // So net can be 95%-100% of gross (or up to 105% if overpayment)
  const ratio = payment.amount / invoice.amount_due
  if (ratio < 1 - AMOUNT_TOLERANCE_PCT || ratio > 1 + AMOUNT_TOLERANCE_PCT) return null

  const gross = invoice.amount_due
  const net = payment.amount
  const fee = Math.max(0, gross - net)
  const amountMatch = 1 - Math.abs(ratio - 1)
  const dateMatch = 1 - diffDays / AR_DATE_TOLERANCE_DAYS
  const entityScore = entityMatch ? 1 : nameMatch ? 0.85 : 0.5
  let confidence = (amountMatch + dateMatch + entityScore) / 3
  const method = ratio >= 0.99 && ratio <= 1.01 && diffDays <= 3 ? "exact" : "tolerance"

  // Entity payment memory: when invoice has a profile and ratio matches typical pattern, boost confidence
  if (entityProfiles) {
    const entityUri = invoice.entity_uri ?? toEntityUriAr(invoice.source as "stripe" | "qbo" | "xero" | "gmail", invoice.invoice_id)
    const avgRatio = getEntityPaymentRatio(entityProfiles, entityUri)
    if (avgRatio !== 1 && Math.abs(ratio - avgRatio) < PROFILE_RATIO_TOLERANCE) {
      confidence = Math.min(1, confidence + PROFILE_CONFIDENCE_BOOST)
    }
  }

  return { confidence, gross, fee, net, method }
}

const DETERMINISTIC_THRESHOLD = 0.7

/**
 * Find best AR match for an inflow payment.
 * Returns allocation candidate or null.
 * Optional entityProfiles: when provided, applies confidence boost when payment ratio matches entity's typical pattern.
 */
export function matchARPayment(
  payment: InflowPayment,
  invoices: OutstandingInvoice[],
  entityProfiles?: Map<string, EntityPaymentProfile>,
): AllocationCandidate | null {
  let best: { cand: AllocationCandidate; conf: number } | null = null
  for (const inv of invoices) {
    const m = deterministicARMatch(payment, inv, entityProfiles)
    if (m && m.confidence >= DETERMINISTIC_THRESHOLD) {
      if (!best || m.confidence > best.conf) {
        best = {
          conf: m.confidence,
          cand: {
            movement_id: payment.movement_id,
            invoice_id: inv.invoice_id,
            gross_applied: m.gross,
            fee_amount: m.fee,
            net_applied: m.net,
            confidence: m.confidence,
            match_method: m.method,
          },
        }
      }
    }
  }
  return best?.cand ?? null
}

/**
 * Suggest AR matches for an inflow (when deterministic confidence < threshold).
 * Returns suggestions for LLM or manual confirmation.
 */
export function suggestARMatches(
  payment: InflowPayment,
  invoices: OutstandingInvoice[],
  entityProfiles?: Map<string, EntityPaymentProfile>,
): ARMatchSuggestion[] {
  const withConf: { s: ARMatchSuggestion; c: number }[] = []
  for (const inv of invoices) {
    const m = deterministicARMatch(payment, inv, entityProfiles)
    if (m && m.confidence >= 0.3) {
      withConf.push({
        c: m.confidence,
        s: {
          invoice_id: inv.invoice_id,
          customer_name: inv.customer_name,
          amount_due: inv.amount_due,
          confidence: m.confidence >= 0.8 ? "high" : m.confidence >= 0.5 ? "medium" : "low",
          reasoning: `Amount within ±${AMOUNT_TOLERANCE_PCT * 100}%, date within ±${AR_DATE_TOLERANCE_DAYS} days`,
          gross_applied: m.gross,
          fee_amount: m.fee,
          net_applied: m.net,
        },
      })
    }
  }
  return withConf.sort((a, b) => b.c - a.c).slice(0, 5).map((x) => x.s)
}

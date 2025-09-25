/**
 * AP/AR Resolver: maps the document layer into the AP/AR ledger.
 * - Bills & invoices: create new ledger rows or merge into existing (field-level precedence).
 * - Payments: never create rows; only match to existing ledger rows and update/clear (reduce amount_outstanding, set status).
 * Scores candidates, applies blockers and thresholds; ambiguous cases go to Needs Review.
 */

import { query, ensureApArSchema, ensureInvoiceDocumentsSchema } from "./db"
import type { NormalizedInvoiceJSON, InvoiceProvider } from "./invoice-documents"
import { log } from "./logger"

export type MatchResult = {
  score: number
  reasons: string[]
  blockers: string[]
  apArId?: string
}

export type ResolveOutcome =
  | { type: "promoted"; apArId: string; action: "merged" | "created" }
  | { type: "needs_review"; queue: "classification" | "match" | "conflict" | "data_quality"; reason: string }
  | { type: "rejected"; reason: string }

type InvoiceDocumentVersionRow = {
  id: string
  invoice_document_id: string
  normalized: NormalizedInvoiceJSON
  document_type: string
  candidate_side: "AP" | "AR" | "unknown"
  classification_confidence: number | null
  extraction_confidence: number | null
  source_authority: number | null
  fingerprint_invoice: string | null
}

type ApArCanonicalRow = {
  id: string
  user_id: string
  side: string
  status: string
  invoice_number: string | null
  issue_date: string | null
  due_date: string | null
  currency: string | null
  amount_total: number
  amount_outstanding: number
  counterparty_name: string | null
  counterparty_email: string | null
  counterparty_type: string | null
  counterparty_id: string | null
  document_type: string | null
  winning_sources: Record<string, unknown>
  source_summary: Record<string, unknown>
}

/** Document types that are neither bill/invoice (create/merge) nor payment (apply-to-ledger); sent to review. */
const NON_PROMOTABLE_TYPES = new Set(["receipt", "statement", "quote", "purchase_order", "unknown"])
/** Payment documents only update/clear existing ledger rows; never create new ones. */
const PAYMENT_DOCUMENT_TYPES = new Set(["payment", "payment_confirmation"])
const AMOUNT_TOLERANCE = 0.50

function normalizeInvNum(n: string | null): string {
  if (!n) return ""
  return n.replace(/[\s-]/g, "").toUpperCase()
}

function daysBetween(d1: string | null, d2: string | null): number | null {
  if (!d1 || !d2) return null
  const a = new Date(d1).getTime()
  const b = new Date(d2).getTime()
  if (isNaN(a) || isNaN(b)) return null
  return Math.abs(a - b) / (1000 * 60 * 60 * 24)
}

export function scoreMatch(candidate: NormalizedInvoiceJSON, existing: ApArCanonicalRow): MatchResult {
  let score = 0
  const reasons: string[] = []
  const blockers: string[] = []

  const cInv = normalizeInvNum(candidate.invoice_number)
  const eInv = normalizeInvNum(existing.invoice_number)
  if (cInv && eInv && cInv === eInv) {
    score += 40
    reasons.push("exact_invoice_number")
  }

  const cName = (candidate.counterparty_name ?? "").toLowerCase().trim()
  const eName = (existing.counterparty_name ?? "").toLowerCase().trim()
  if (cName && eName) {
    if (cName === eName) {
      score += 25
      reasons.push("counterparty_name_exact")
    } else if (cInv && eInv && cInv === eInv) {
      blockers.push("counterparty_mismatch_with_same_invoice_number")
    }
  }

  if (candidate.total != null && existing.amount_total != null) {
    const diff = Math.abs(candidate.total - existing.amount_total)
    if (diff < 0.01) {
      score += 15
      reasons.push("exact_total")
    } else if (diff > AMOUNT_TOLERANCE && cInv && eInv && cInv === eInv) {
      blockers.push("total_mismatch_beyond_tolerance")
    }
  }

  if (candidate.currency && existing.currency) {
    if (candidate.currency.toUpperCase() === existing.currency.toUpperCase()) {
      score += 5
      reasons.push("currency_match")
    } else {
      blockers.push("currency_conflict")
    }
  }

  const issueDays = daysBetween(candidate.issue_date, existing.issue_date)
  if (issueDays !== null && issueDays <= 3) {
    score += 5
    reasons.push("issue_date_close")
  }

  const dueDays = daysBetween(candidate.due_date, existing.due_date)
  if (dueDays !== null && dueDays <= 3) {
    score += 5
    reasons.push("due_date_close")
  }

  const candidateSide = candidate.side === "unknown" ? null : candidate.side
  if (candidateSide && existing.side && candidateSide !== existing.side) {
    blockers.push("side_conflict")
  }

  return { score, reasons, blockers, apArId: existing.id }
}

type FieldPrecedenceEntry = { source: string; confidence: number; updated_at: string }

function computeFieldScore(sourceAuthority: number, classConf: number, extConf: number): number {
  return sourceAuthority * classConf * extConf
}

function shouldOverwriteField(
  existingWinning: FieldPrecedenceEntry | undefined,
  candidateScore: number
): boolean {
  if (!existingWinning) return true
  return candidateScore > existingWinning.confidence + 0.05
}

export async function resolveInvoiceCandidate(
  versionId: string,
  options: { shadowMode?: boolean } = {}
): Promise<ResolveOutcome> {
  const shadowMode = options.shadowMode ?? false

  await ensureInvoiceDocumentsSchema()
  await ensureApArSchema()

  const { rows: versionRows } = await query<InvoiceDocumentVersionRow & { normalized: unknown }>(
    `SELECT id, invoice_document_id, normalized, document_type, candidate_side,
            classification_confidence, extraction_confidence, source_authority,
            fingerprint_invoice
     FROM invoice_document_versions
     WHERE id = $1`,
    [versionId]
  )

  if (versionRows.length === 0) {
    return { type: "rejected", reason: "version_not_found" }
  }

  const v = versionRows[0]
  const normalized = v.normalized as NormalizedInvoiceJSON
  const sourceAuth = v.source_authority ?? 0.5
  const classConf = v.classification_confidence ?? 0.5
  const extConf = v.extraction_confidence ?? 0.5

  if (NON_PROMOTABLE_TYPES.has(v.document_type)) {
    const outcome: ResolveOutcome = {
      type: "needs_review",
      queue: "classification",
      reason: `document_type_not_promotable: ${v.document_type}`,
    }
    if (!shadowMode) {
      await query(
        `UPDATE invoice_document_versions SET promotion_status = 'needs_review', review_reason = $1 WHERE id = $2`,
        [outcome.reason, versionId]
      )
    }
    log("ap_ar_resolver.classification_hold", { versionId, documentType: v.document_type }, "db")
    return outcome
  }

  if (v.candidate_side === "unknown") {
    const outcome: ResolveOutcome = {
      type: "needs_review",
      queue: "classification",
      reason: "unknown_side",
    }
    if (!shadowMode) {
      await query(
        `UPDATE invoice_document_versions SET promotion_status = 'needs_review', review_reason = $1 WHERE id = $2`,
        [outcome.reason, versionId]
      )
    }
    log("ap_ar_resolver.unknown_side_hold", { versionId }, "db")
    return outcome
  }

  // Payment documents: only match to existing ledger rows and apply payment (reduce amount_outstanding); never create.
  if (PAYMENT_DOCUMENT_TYPES.has(v.document_type)) {
    const paymentAmount = normalized.total != null && normalized.total > 0 ? normalized.total : 0
    if (paymentAmount === 0) {
      const outcome: ResolveOutcome = {
        type: "needs_review",
        queue: "data_quality",
        reason: "payment_amount_missing_or_zero",
      }
      if (!shadowMode) {
        await query(
          `UPDATE invoice_document_versions SET promotion_status = 'needs_review', review_reason = $1 WHERE id = $2`,
          [outcome.reason, versionId]
        )
      }
      return outcome
    }
    const { rows: apRowsRaw } = await query<ApArCanonicalRow & { amount_total: string; amount_outstanding: string }>(
      `SELECT id, user_id, side, status, invoice_number, issue_date::text, due_date::text,
              currency, amount_total, amount_outstanding, counterparty_name, counterparty_email,
              counterparty_type, counterparty_id, document_type,
              COALESCE(winning_sources, '{}'::jsonb) as winning_sources,
              COALESCE(source_summary, '{}'::jsonb) as source_summary
       FROM ap_ar
       WHERE user_id = $1 AND side = $2`,
      [normalized.user_id, v.candidate_side]
    )
    const apRows: ApArCanonicalRow[] = apRowsRaw.map((r) => ({
      ...r,
      amount_total: Number(r.amount_total),
      amount_outstanding: Number(r.amount_outstanding),
      winning_sources: (r.winning_sources as Record<string, unknown>) ?? {},
      source_summary: (r.source_summary as Record<string, unknown>) ?? {},
    }))
    const matches: MatchResult[] = apRows.map((row) => scoreMatch(normalized, row))
    matches.sort((a, b) => b.score - a.score)
    const best = matches[0]
    const hasBlockers = best ? best.blockers.length > 0 : false
    if (best && best.score >= 95 && !hasBlockers && best.apArId) {
      const outcome: ResolveOutcome = { type: "promoted", apArId: best.apArId, action: "merged" }
      if (!shadowMode) {
        const row = apRows.find((r) => r.id === best.apArId)!
        const newOutstanding = Math.max(0, row.amount_outstanding - paymentAmount)
        const newStatus = newOutstanding <= 0 ? "paid" : "partially_paid"
        await query(
          `UPDATE ap_ar SET amount_outstanding = $1, status = $2, updated_at = NOW() WHERE id = $3`,
          [newOutstanding, newStatus, best.apArId]
        )
        await query(
          `UPDATE invoice_document_versions SET promotion_status = 'promoted' WHERE id = $1`,
          [versionId]
        )
        await query(
          `UPDATE invoice_documents SET ap_ar_id = $1, updated_at = NOW() WHERE id = $2`,
          [best.apArId, v.invoice_document_id]
        )
      }
      log("ap_ar_resolver.payment_applied", { versionId, apArId: best.apArId, paymentAmount, shadowMode }, "db")
      return outcome
    }
    const outcome: ResolveOutcome = {
      type: "needs_review",
      queue: "match",
      reason: best ? "payment_unmatched_or_ambiguous" : "payment_no_ledger_match",
    }
    if (!shadowMode) {
      await query(
        `UPDATE invoice_document_versions SET promotion_status = 'needs_review', review_reason = $1 WHERE id = $2`,
        [outcome.reason, versionId]
      )
    }
    log("ap_ar_resolver.payment_hold", { versionId, bestScore: best?.score, shadowMode }, "db")
    return outcome
  }

  if (normalized.total == null || normalized.total === 0) {
    const outcome: ResolveOutcome = {
      type: "needs_review",
      queue: "data_quality",
      reason: "missing_or_zero_total",
    }
    if (!shadowMode) {
      await query(
        `UPDATE invoice_document_versions SET promotion_status = 'needs_review', review_reason = $1 WHERE id = $2`,
        [outcome.reason, versionId]
      )
    }
    return outcome
  }

  const { rows: apRowsRaw } = await query<ApArCanonicalRow & { amount_total: string; amount_outstanding: string }>(
    `SELECT id, user_id, side, status, invoice_number, issue_date::text, due_date::text,
            currency, amount_total, amount_outstanding, counterparty_name, counterparty_email,
            counterparty_type, counterparty_id, document_type,
            COALESCE(winning_sources, '{}'::jsonb) as winning_sources,
            COALESCE(source_summary, '{}'::jsonb) as source_summary
     FROM ap_ar
     WHERE user_id = $1 AND side = $2`,
    [normalized.user_id, v.candidate_side]
  )

  const apRows: ApArCanonicalRow[] = apRowsRaw.map((r) => ({
    ...r,
    amount_total: Number(r.amount_total),
    amount_outstanding: Number(r.amount_outstanding),
    winning_sources: (r.winning_sources as Record<string, unknown>) ?? {},
    source_summary: (r.source_summary as Record<string, unknown>) ?? {},
  }))

  const matches: MatchResult[] = apRows.map((row) => scoreMatch(normalized, row))
  matches.sort((a, b) => b.score - a.score)

  const best = matches[0]
  const hasBlockers = best ? best.blockers.length > 0 : false

  if (best && best.score >= 95 && !hasBlockers && best.apArId) {
    const outcome: ResolveOutcome = { type: "promoted", apArId: best.apArId, action: "merged" }

    if (!shadowMode) {
      const existingRow = apRows.find((r) => r.id === best.apArId)!
      const fieldScore = computeFieldScore(sourceAuth, classConf, extConf)
      const now = new Date().toISOString()
      const provider = normalized.meta.source_system

      const ws = { ...(existingRow.winning_sources as Record<string, FieldPrecedenceEntry>) }

      const updates: string[] = []
      const params: unknown[] = []
      let paramIdx = 1

      const tryField = (
        fieldName: string,
        candidateValue: unknown,
        existingValue: unknown,
        sqlColumn: string,
        cast?: string
      ) => {
        if (candidateValue == null) return
        const existing = ws[fieldName]
        if (shouldOverwriteField(existing, fieldScore) || existingValue == null) {
          updates.push(`${sqlColumn} = $${paramIdx}${cast ? `::${cast}` : ""}`)
          params.push(candidateValue)
          paramIdx++
          ws[fieldName] = { source: provider, confidence: fieldScore, updated_at: now }
        }
      }

      tryField("invoice_number", normalized.invoice_number, existingRow.invoice_number, "invoice_number")
      tryField("counterparty_name", normalized.counterparty_name, existingRow.counterparty_name, "counterparty_name")
      tryField("counterparty_email", normalized.counterparty_email, existingRow.counterparty_email, "counterparty_email")
      tryField("currency", normalized.currency, existingRow.currency, "currency")
      tryField("due_date", normalized.due_date, existingRow.due_date, "due_date", "date")
      tryField("amount_outstanding", normalized.amount_outstanding, existingRow.amount_outstanding, "amount_outstanding", "numeric")

      if (normalized.status !== "unknown") {
        const existing = ws["status"]
        if (shouldOverwriteField(existing, fieldScore)) {
          updates.push(`status = $${paramIdx}`)
          params.push(normalized.status)
          paramIdx++
          ws["status"] = { source: provider, confidence: fieldScore, updated_at: now }
        }
      }

      const mergedSummary = { ...existingRow.source_summary }
      mergedSummary[provider] = {
        provider_invoice_id: normalized.meta.provider_invoice_id,
        invoice_number: normalized.invoice_number,
        total: normalized.total,
      }

      updates.push(`source_summary = $${paramIdx}::jsonb`)
      params.push(JSON.stringify(mergedSummary))
      paramIdx++

      updates.push(`winning_sources = $${paramIdx}::jsonb`)
      params.push(JSON.stringify(ws))
      paramIdx++

      updates.push(`match_confidence = $${paramIdx}`)
      params.push(best.score / 100)
      paramIdx++

      updates.push(`updated_at = NOW()`)

      params.push(best.apArId)
      await query(
        `UPDATE ap_ar SET ${updates.join(", ")} WHERE id = $${paramIdx}`,
        params
      )

      await query(
        `UPDATE invoice_document_versions SET promotion_status = 'promoted' WHERE id = $1`,
        [versionId]
      )
      await query(
        `UPDATE invoice_documents SET ap_ar_id = $1, updated_at = NOW() WHERE id = $2`,
        [best.apArId, v.invoice_document_id]
      )
    }

    log("ap_ar_resolver.promoted_merge", {
      versionId, apArId: best.apArId, score: best.score,
      reasons: best.reasons, shadowMode,
    }, "db")
    return outcome
  }

  if (best && hasBlockers) {
    const outcome: ResolveOutcome = {
      type: "needs_review",
      queue: "conflict",
      reason: `blockers: ${best.blockers.join(", ")}`,
    }
    if (!shadowMode) {
      await query(
        `UPDATE invoice_document_versions SET promotion_status = 'needs_review', review_reason = $1 WHERE id = $2`,
        [outcome.reason, versionId]
      )
    }
    log("ap_ar_resolver.conflict_hold", { versionId, blockers: best.blockers, score: best.score, shadowMode }, "db")
    return outcome
  }

  if (best && best.score >= 80 && best.score < 95) {
    const outcome: ResolveOutcome = {
      type: "needs_review",
      queue: "match",
      reason: "ambiguous_match",
    }
    if (!shadowMode) {
      await query(
        `UPDATE invoice_document_versions SET promotion_status = 'needs_review', review_reason = $1 WHERE id = $2`,
        [outcome.reason, versionId]
      )
    }
    log("ap_ar_resolver.ambiguous_hold", { versionId, score: best.score, shadowMode }, "db")
    return outcome
  }

  const canAutoCreate =
    sourceAuth >= 0.9 &&
    classConf >= 0.9 &&
    (v.document_type === "invoice" || v.document_type === "bill") &&
    (normalized.invoice_number || normalized.counterparty_name) &&
    normalized.total != null &&
    normalized.total > 0

  if (canAutoCreate) {
    if (!shadowMode) {
      const provider = normalized.meta.source_system
      const fieldScore = computeFieldScore(sourceAuth, classConf, extConf)
      const now = new Date().toISOString()
      const ws: Record<string, FieldPrecedenceEntry> = {}
      if (normalized.invoice_number) ws["invoice_number"] = { source: provider, confidence: fieldScore, updated_at: now }
      if (normalized.counterparty_name) ws["counterparty_name"] = { source: provider, confidence: fieldScore, updated_at: now }
      if (normalized.currency) ws["currency"] = { source: provider, confidence: fieldScore, updated_at: now }
      if (normalized.due_date) ws["due_date"] = { source: provider, confidence: fieldScore, updated_at: now }
      if (normalized.status !== "unknown") ws["status"] = { source: provider, confidence: fieldScore, updated_at: now }
      ws["amount_total"] = { source: provider, confidence: fieldScore, updated_at: now }

      const summary: Record<string, unknown> = {}
      summary[provider] = {
        provider_invoice_id: normalized.meta.provider_invoice_id,
        invoice_number: normalized.invoice_number,
        total: normalized.total,
      }

      const { rows } = await query<{ id: string }>(
        `INSERT INTO ap_ar (
           user_id, side, status, invoice_number, issue_date, due_date, currency,
           amount_total, amount_outstanding, counterparty_type, counterparty_name,
           counterparty_email, source_summary, document_type,
           classification_confidence, match_confidence, canonical_confidence,
           needs_review, resolution_status, winning_sources, source_authority_score
         )
         VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20::jsonb, $21)
         ON CONFLICT (user_id, side, invoice_number) WHERE invoice_number IS NOT NULL DO UPDATE SET
           source_summary = ap_ar.source_summary || EXCLUDED.source_summary,
           winning_sources = EXCLUDED.winning_sources,
           amount_outstanding = COALESCE(EXCLUDED.amount_outstanding, ap_ar.amount_outstanding),
           status = COALESCE(EXCLUDED.status, ap_ar.status),
           updated_at = NOW()
         RETURNING id`,
        [
          normalized.user_id,
          v.candidate_side,
          normalized.status || "open",
          normalized.invoice_number,
          normalized.issue_date,
          normalized.due_date,
          normalized.currency ?? "USD",
          normalized.total ?? 0,
          normalized.amount_outstanding ?? normalized.total ?? 0,
          normalized.counterparty_type,
          normalized.counterparty_name,
          normalized.counterparty_email,
          JSON.stringify(summary),
          v.document_type,
          classConf,
          null,
          sourceAuth * classConf,
          false,
          "auto",
          JSON.stringify(ws),
          sourceAuth,
        ]
      )

      const apArId = rows[0].id
      await query(
        `UPDATE invoice_document_versions SET promotion_status = 'promoted' WHERE id = $1`,
        [versionId]
      )
      await query(
        `UPDATE invoice_documents SET ap_ar_id = $1, updated_at = NOW() WHERE id = $2`,
        [apArId, v.invoice_document_id]
      )

      log("ap_ar_resolver.promoted_create", { versionId, apArId, shadowMode }, "db")
      return { type: "promoted", apArId, action: "created" }
    }

    log("ap_ar_resolver.would_create", { versionId, shadowMode: true }, "db")
    return { type: "promoted", apArId: "shadow_new", action: "created" }
  }

  const outcome: ResolveOutcome = {
    type: "needs_review",
    queue: "match",
    reason: "no_confident_match_and_insufficient_authority_for_auto_create",
  }
  if (!shadowMode) {
    await query(
      `UPDATE invoice_document_versions SET promotion_status = 'needs_review', review_reason = $1 WHERE id = $2`,
      [outcome.reason, versionId]
    )
  }
  log("ap_ar_resolver.hold", { versionId, bestScore: best?.score ?? 0, sourceAuth, shadowMode }, "db")
  return outcome
}

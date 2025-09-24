import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureInvoiceDocumentsSchema, query } from "@/lib/db"

/**
 * GET /api/ap-ar/review-queue?queue=classification|match|conflict|data_quality
 * Returns candidate versions that need human review, grouped by queue type.
 */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureInvoiceDocumentsSchema()

  const queueFilter = req.nextUrl.searchParams.get("queue")
  const limit = Math.min(100, Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10) || 50))

  const conditions = ["v.promotion_status = 'needs_review'", "d.user_id = $1"]
  const params: unknown[] = [user.id]

  if (queueFilter) {
    conditions.push(`v.review_reason LIKE $${params.length + 1}`)
    params.push(`%${queueFilter}%`)
  }

  params.push(limit)

  const { rows } = await query<{
    version_id: string
    invoice_document_id: string
    provider: string
    provider_invoice_id: string
    document_type: string
    candidate_side: string
    classification_confidence: number | null
    extraction_confidence: number | null
    source_authority: number | null
    promotion_status: string
    review_reason: string | null
    fingerprint_invoice: string | null
    normalized: unknown
    extracted_at: string
  }>(
    `SELECT
       v.id AS version_id,
       v.invoice_document_id,
       d.provider,
       d.provider_invoice_id,
       v.document_type,
       v.candidate_side,
       v.classification_confidence,
       v.extraction_confidence,
       v.source_authority,
       v.promotion_status,
       v.review_reason,
       v.fingerprint_invoice,
       v.normalized,
       v.extracted_at
     FROM invoice_document_versions v
     JOIN invoice_documents d ON d.id = v.invoice_document_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY v.extracted_at DESC
     LIMIT $${params.length}`,
    params
  )

  const queues: Record<string, typeof rows> = {
    classification: [],
    match: [],
    conflict: [],
    data_quality: [],
  }

  for (const row of rows) {
    const reason = row.review_reason ?? ""
    if (reason.includes("unknown_side") || reason.includes("classification") || reason.includes("document_type")) {
      queues.classification.push(row)
    } else if (reason.includes("conflict") || reason.includes("blocker")) {
      queues.conflict.push(row)
    } else if (reason.includes("data_quality") || reason.includes("missing") || reason.includes("zero_total")) {
      queues.data_quality.push(row)
    } else {
      queues.match.push(row)
    }
  }

  return NextResponse.json({
    total: rows.length,
    queues: {
      classification: queues.classification.length,
      match: queues.match.length,
      conflict: queues.conflict.length,
      data_quality: queues.data_quality.length,
    },
    items: queueFilter ? (queues[queueFilter] ?? rows) : rows,
  })
}

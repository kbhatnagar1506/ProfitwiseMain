import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureInvoiceDocumentsSchema, query } from "@/lib/db"
import { resolveInvoiceCandidate } from "@/lib/ap-ar-resolver"

/**
 * POST /api/ap-ar/review-queue/resolve
 * Body: { versionId: string, action: "approve" | "reject" }
 * Approve: runs the resolver in live mode (shadowMode=false) to promote the candidate.
 * Reject: marks the version as rejected.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureInvoiceDocumentsSchema()

  let body: { versionId?: string; action?: string }
  try {
    body = (await req.json()) as { versionId?: string; action?: string }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { versionId, action } = body
  if (!versionId || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ error: "versionId and action (approve|reject) required" }, { status: 400 })
  }

  const { rows } = await query<{ user_id: string }>(
    `SELECT d.user_id
     FROM invoice_document_versions v
     JOIN invoice_documents d ON d.id = v.invoice_document_id
     WHERE v.id = $1`,
    [versionId]
  )
  if (rows.length === 0 || rows[0].user_id !== user.id) {
    return NextResponse.json({ error: "Not found or unauthorized" }, { status: 404 })
  }

  if (action === "reject") {
    await query(
      `UPDATE invoice_document_versions SET promotion_status = 'rejected', review_reason = 'manually_rejected' WHERE id = $1`,
      [versionId]
    )
    return NextResponse.json({ ok: true, action: "rejected", versionId })
  }

  const outcome = await resolveInvoiceCandidate(versionId, { shadowMode: false })
  return NextResponse.json({ ok: true, action: "approved", versionId, outcome })
}

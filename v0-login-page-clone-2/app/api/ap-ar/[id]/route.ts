import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getApArById } from "@/lib/ap-ar"
import { ensureInvoiceDocumentsSchema, query } from "@/lib/db"

/**
 * GET /api/ap-ar/[id]
 * Returns a single AP/AR record with linked invoice documents.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  try {
    const apAr = await getApArById(user.id, id)
    if (!apAr) return NextResponse.json({ error: "Not found" }, { status: 404 })

    await ensureInvoiceDocumentsSchema()
    const { rows: docs } = await query<{
      id: string
      provider: string
      provider_invoice_id: string
      normalized: unknown
      raw: unknown
    }>(
      "SELECT id, provider, provider_invoice_id, normalized, raw FROM invoice_documents WHERE ap_ar_id = $1",
      [id]
    )

    return NextResponse.json({
      ...apAr,
      documents: docs.map((d) => ({
        id: d.id,
        provider: d.provider,
        provider_invoice_id: d.provider_invoice_id,
        normalized: d.normalized,
        raw: d.raw,
      })),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch" },
      { status: 500 }
    )
  }
}

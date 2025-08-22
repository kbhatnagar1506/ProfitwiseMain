import { NextRequest, NextResponse } from "next/server"
import { ensureQBOSchema, ensureXeroSchema, query } from "@/lib/db"
import { gcpDeleteScope } from "@/lib/entity-store-gcp"
import { log } from "@/lib/logger"

/** DELETE all QBO and Xero connections (and their entities via CASCADE), and remove their data from the GCP bucket. Auth: x-clean-db-secret. Production only. */
export async function DELETE(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  if (req.nextUrl.searchParams.has("secret")) {
    return NextResponse.json(
      { error: "Do not send the secret in the URL. Use the x-clean-db-secret header." },
      { status: 400 }
    )
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    await ensureQBOSchema()
    await ensureXeroSchema()

    const qboScopes = await query<{ realm_id: string }>("SELECT realm_id FROM qbo_connections")
    const xeroScopes = await query<{ tenant_id: string }>("SELECT tenant_id FROM xero_connections")
    let bucketDeleted = 0
    for (const r of qboScopes.rows) {
      bucketDeleted += await gcpDeleteScope("qbo", r.realm_id)
    }
    for (const r of xeroScopes.rows) {
      bucketDeleted += await gcpDeleteScope("xero", r.tenant_id)
    }

    const qboResult = await query<{ id: string }>("DELETE FROM qbo_connections RETURNING id")
    const xeroResult = await query<{ id: string }>("DELETE FROM xero_connections RETURNING id")
    const qboDeleted = qboResult.rows.length
    const xeroDeleted = xeroResult.rows.length

    log("admin.delete-accounting-connections.done", { qboDeleted, xeroDeleted, bucketDeleted }, "db")
    return NextResponse.json({
      ok: true,
      qbo_connections_deleted: qboDeleted,
      xero_connections_deleted: xeroDeleted,
      bucket_files_deleted: bucketDeleted,
    })
  } catch (err) {
    log("admin.delete-accounting-connections.failed", { error: String(err) }, "db")
    return NextResponse.json({ error: "Delete failed" }, { status: 500 })
  }
}

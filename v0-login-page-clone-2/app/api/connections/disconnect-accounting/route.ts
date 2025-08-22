import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { listRealmIdsByUserId } from "@/lib/quickbooks-token-store"
import { listTenantIdsByUserId } from "@/lib/xero-token-store"
import { ensureQBOSchema, ensureXeroSchema, query } from "@/lib/db"
import { gcpDeleteScope } from "@/lib/entity-store-gcp"

/** POST /api/connections/disconnect-accounting — remove all QBO and Xero connections for the current user and delete their data from the GCP bucket. */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const realmIds = await listRealmIdsByUserId(user.id)
  const tenantIds = await listTenantIdsByUserId(user.id)

  let bucketDeleted = 0
  for (const realmId of realmIds) {
    bucketDeleted += await gcpDeleteScope("qbo", realmId)
  }
  for (const tenantId of tenantIds) {
    bucketDeleted += await gcpDeleteScope("xero", tenantId)
  }

  await ensureQBOSchema()
  await ensureXeroSchema()
  const qboResult = await query<{ id: string }>("DELETE FROM qbo_connections WHERE user_id = $1 RETURNING id", [user.id])
  const xeroResult = await query<{ id: string }>("DELETE FROM xero_connections WHERE user_id = $1 RETURNING id", [user.id])

  return NextResponse.json({
    ok: true,
    qbo_connections_deleted: qboResult.rows.length,
    xero_connections_deleted: xeroResult.rows.length,
    bucket_files_deleted: bucketDeleted,
  })
}

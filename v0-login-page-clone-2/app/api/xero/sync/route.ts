import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import {
  fetchXeroList,
  getValidAccessToken,
  isXeroConfigured,
  XERO_ENTITY_PATHS,
} from "@/lib/xero"
import { upsertEntities } from "@/lib/xero-entity-store"
import { listTenantIdsByUserId } from "@/lib/xero-token-store"

export async function POST(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("xero.sync.unauthorized", { reason: "no_session" }, "xero")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!isXeroConfigured()) {
    log("xero.sync.rejected", { reason: "not_configured" }, "xero")
    return NextResponse.json({ error: "Xero not configured" }, { status: 500 })
  }

  const tenantIds = await listTenantIdsByUserId(user.id)
  log("xero.sync.started", { userId: user.id, tenantCount: tenantIds.length }, "xero")
  if (tenantIds.length === 0) {
    return NextResponse.json({ synced: 0, tenants: 0, byType: {} })
  }

  const byType: Record<string, number> = {}
  let totalSynced = 0

  for (const tenantId of tenantIds) {
    try {
      const accessToken = await getValidAccessToken(tenantId)
      for (const { type, path } of XERO_ENTITY_PATHS) {
        try {
          const items = await fetchXeroList<unknown>(accessToken, tenantId, path)
          const count = await upsertEntities(tenantId, type, items, { userId: user.id })
          byType[type] = (byType[type] ?? 0) + count
          totalSynced += count
        } catch (err) {
          log("xero.sync.entity.failed", { tenantId, type, error: err instanceof Error ? err.message : String(err) }, "xero")
        }
      }
    } catch (err) {
      log("xero.sync.tenant.failed", { tenantId, error: err instanceof Error ? err.message : String(err) }, "xero")
    }
  }

  log("xero.sync.succeeded", { tenants: tenantIds.length, totalSynced, byType }, "xero")
  return NextResponse.json({ synced: totalSynced, tenants: tenantIds.length, byType })
}

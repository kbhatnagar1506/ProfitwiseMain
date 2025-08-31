import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import { isXeroConfigured } from "@/lib/xero"
import { runXeroSyncForUser } from "@/lib/xero-sync"

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

  const result = await runXeroSyncForUser(user.id)
  return NextResponse.json({
    synced: result.totalSynced,
    tenants: result.tenants,
    byType: result.byType,
  })
}

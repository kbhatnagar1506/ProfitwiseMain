import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import { createLinkToken, isPlaidConfigured } from "@/lib/plaid"

export async function POST(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("plaid.link_token.unauthorized", { reason: "no_session" }, "plaid")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!isPlaidConfigured()) {
    log("link_token.create.rejected", { reason: "not_configured" }, "plaid")
    return NextResponse.json({ error: "Plaid not configured" }, { status: 500 })
  }
  try {
    const linkToken = await createLinkToken()
    log("link_token.create.responded", { ok: true }, "plaid")
    return NextResponse.json({ link_token: linkToken })
  } catch (err) {
    log("link_token.create.failed", { error: err instanceof Error ? err.message : String(err) }, "plaid")
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create link token" },
      { status: 500 }
    )
  }
}

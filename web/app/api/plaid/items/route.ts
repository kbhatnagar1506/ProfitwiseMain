import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import { listPlaidItemIds } from "@/lib/plaid-item-store"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("plaid.items.unauthorized", { reason: "no_session" }, "plaid")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    const itemIds = await listPlaidItemIds(user.id)
    return NextResponse.json({ item_ids: itemIds })
  } catch {
    return NextResponse.json({ item_ids: [] })
  }
}

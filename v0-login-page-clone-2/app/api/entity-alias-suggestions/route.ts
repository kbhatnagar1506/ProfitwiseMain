import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import {
  listPendingEntityAliasSuggestions,
  approveEntityAliasSuggestion,
  rejectEntityAliasSuggestion,
} from "@/lib/entity-alias-suggestion-apply"

/** GET — list pending alias suggestions for the signed-in user */
export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const suggestions = await listPendingEntityAliasSuggestions(user.id)
    return NextResponse.json({ suggestions })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** POST body: { action: "approve" | "reject", suggestion_id: string } */
export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { action?: string; suggestion_id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const action = body.action
  const suggestionId = body.suggestion_id?.trim()
  if (!suggestionId || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ error: "action (approve|reject) and suggestion_id required" }, { status: 400 })
  }

  if (action === "reject") {
    const ok = await rejectEntityAliasSuggestion(user.id, suggestionId)
    return NextResponse.json({ ok })
  }

  const result = await approveEntityAliasSuggestion(user.id, suggestionId)
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 })
  }
  return NextResponse.json({ ok: true, entity_id: result.entity_id })
}

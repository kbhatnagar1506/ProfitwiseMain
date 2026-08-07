import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  if (!token) {
    log("onboarding.progress.unauthorized", { reason: "no_token" }, "auth")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const user = await getUserBySessionToken(token)
  if (!user) {
    log("onboarding.progress.unauthorized", { reason: "invalid_session" }, "auth")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { rows } = await query<{ onboarding_step: number }>(
    "SELECT COALESCE(onboarding_step, 1) AS onboarding_step FROM users WHERE id = $1",
    [user.id]
  )
  const step = Math.min(Math.max(rows[0]?.onboarding_step ?? 1, 1), 15)
  return NextResponse.json({ step })
}

export async function PATCH(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  if (!token) {
    log("onboarding.progress.unauthorized", { reason: "no_token" }, "auth")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const user = await getUserBySessionToken(token)
  if (!user) {
    log("onboarding.progress.unauthorized", { reason: "invalid_session" }, "auth")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  let body: { step?: number }
  try {
    body = await request.json()
  } catch {
    log("onboarding.progress.rejected", { reason: "invalid_json" }, "auth")
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const step = typeof body.step === "number" ? Math.min(Math.max(Math.floor(body.step), 1), 15) : null
  if (step === null) {
    log("onboarding.progress.rejected", { reason: "invalid_step" }, "auth")
    return NextResponse.json({ error: "step must be a number between 1 and 15" }, { status: 400 })
  }
  await query("UPDATE users SET onboarding_step = $1 WHERE id = $2", [step, user.id])
  log("onboarding.progress.updated", { userId: user.id, step }, "auth")
  return NextResponse.json({ step })
}

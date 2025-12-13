import { NextRequest, NextResponse } from "next/server"
import {
  findUserByEmail,
  verifyPassword,
  createSession,
  getSessionCookieName,
  SESSION_MAX_AGE_SEC,
} from "@/lib/auth"
import { log } from "@/lib/logger"
import { verifyRecaptcha } from "@/lib/recaptcha"
import { createErrorResponse } from "@/lib/api-utils"

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string; recaptchaToken?: string }
  try {
    body = await request.json()
  } catch {
    log("auth.login.rejected", { reason: "invalid_json", operation: "login" }, "auth")
    return NextResponse.json(createErrorResponse("Invalid request"), { status: 400 })
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
  const password = typeof body.password === "string" ? body.password : ""
  const recaptchaToken = typeof body.recaptchaToken === "string" ? body.recaptchaToken : ""

  if (!email || !password) {
    log("auth.login.rejected", { reason: "missing_credentials", operation: "login", email }, "auth")
    return NextResponse.json(createErrorResponse("Email and password required"), { status: 400 })
  }

  if (process.env.RECAPTCHA_SECRET_KEY) {
    if (!recaptchaToken) {
      log("auth.login.rejected", { reason: "recaptcha_missing", operation: "login", email }, "auth")
      return NextResponse.json(createErrorResponse("Verification required. Please try again."), { status: 400 })
    }
    const recaptcha = await verifyRecaptcha(recaptchaToken, "login")
    if (!recaptcha.success) {
      log("auth.login.rejected", { reason: "recaptcha_failed", operation: "login", email }, "auth")
      return NextResponse.json(createErrorResponse("Verification failed. Please try again."), { status: 400 })
    }
  }

  if (process.env.NODE_ENV !== "production") {
    log("auth.login.rejected", { reason: "not_production", operation: "login", email }, "auth")
    return NextResponse.json(
      createErrorResponse("Auth is only available in production"),
      { status: 503 }
    )
  }

  try {
    const user = await findUserByEmail(email)
    if (!user) {
      log("auth.login.rejected", { reason: "user_not_found", operation: "login", email }, "auth")
      return NextResponse.json(createErrorResponse("Invalid email or password"), { status: 401 })
    }

    const ok = await verifyPassword(password, user.password_hash)
    if (!ok) {
      log("auth.login.rejected", { reason: "invalid_password", operation: "login", email }, "auth")
      return NextResponse.json(createErrorResponse("Invalid email or password"), { status: 401 })
    }

    const { token } = await createSession(user.id)
    log("auth.login.succeeded", { userId: user.id, operation: "login" }, "auth")
    const res = NextResponse.json({ ok: true })
    res.cookies.set(getSessionCookieName(), token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_SEC,
      path: "/",
    })
    return res
  } catch (err) {
    const pgErr = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : undefined
    const errorMsg = err instanceof Error ? err.message : String(err)
    log("auth.login.failed", { pgErr, error: errorMsg, operation: "login", email }, "auth")
    return NextResponse.json(createErrorResponse("Login failed", { details: errorMsg }), { status: 500 })
  }
}

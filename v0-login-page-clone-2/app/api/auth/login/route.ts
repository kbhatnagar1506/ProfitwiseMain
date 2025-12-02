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

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string; recaptchaToken?: string }
  try {
    body = await request.json()
  } catch {
    log("auth.login.rejected", { reason: "invalid_json" }, "auth")
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
  const password = typeof body.password === "string" ? body.password : ""
  const recaptchaToken = typeof body.recaptchaToken === "string" ? body.recaptchaToken : ""

  if (!email || !password) {
    log("auth.login.rejected", { reason: "missing_credentials" }, "auth")
    return NextResponse.json({ error: "Email and password required" }, { status: 400 })
  }

  if (process.env.RECAPTCHA_SECRET_KEY && recaptchaToken) {
    const recaptcha = await verifyRecaptcha(recaptchaToken, "login")
    if (!recaptcha.success) {
      log("auth.login.rejected", { reason: "recaptcha_failed" }, "auth")
      return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 400 })
    }
  }

  if (process.env.NODE_ENV !== "production") {
    log("auth.login.rejected", { reason: "not_production" }, "auth")
    return NextResponse.json(
      { error: "Auth is only available in production" },
      { status: 503 }
    )
  }

  try {
    const user = await findUserByEmail(email)
    if (!user) {
      log("auth.login.rejected", { reason: "user_not_found" }, "auth")
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 })
    }

    const ok = await verifyPassword(password, user.password_hash)
    if (!ok) {
      log("auth.login.rejected", { reason: "invalid_password" }, "auth")
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 })
    }

    const { token } = await createSession(user.id)
    log("auth.login.succeeded", { userId: user.id }, "auth")
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
    log("auth.login.failed", { pgErr }, "auth")
    return NextResponse.json({ error: "Login failed" }, { status: 500 })
  }
}

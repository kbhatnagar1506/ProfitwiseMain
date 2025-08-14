import { NextRequest, NextResponse } from "next/server"
import {
  createUser,
  findUserByEmail,
  createSession,
  getSessionCookieName,
  SESSION_MAX_AGE_SEC,
} from "@/lib/auth"
import { log } from "@/lib/logger"
import { validatePassword } from "@/lib/password-strength"
import { verifyRecaptcha } from "@/lib/recaptcha"

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string; recaptchaToken?: string }
  try {
    body = await request.json()
  } catch {
    log("auth.signup.rejected", { reason: "invalid_json" }, "auth")
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
  const password = typeof body.password === "string" ? body.password : ""
  const recaptchaToken = typeof body.recaptchaToken === "string" ? body.recaptchaToken : ""

  if (!email || !password) {
    log("auth.signup.rejected", { reason: "missing_credentials" }, "auth")
    return NextResponse.json({ error: "Email and password required" }, { status: 400 })
  }

  const pwdCheck = validatePassword(password)
  if (!pwdCheck.ok) {
    log("auth.signup.rejected", { reason: "weak_password", detail: pwdCheck.error }, "auth")
    return NextResponse.json({ error: pwdCheck.error }, { status: 400 })
  }

  if (process.env.RECAPTCHA_SECRET_KEY) {
    const recaptcha = await verifyRecaptcha(recaptchaToken, "signup")
    if (!recaptcha.success) {
      log("auth.signup.rejected", { reason: "recaptcha_failed" }, "auth")
      return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 400 })
    }
  }

  if (process.env.NODE_ENV !== "production") {
    log("auth.signup.rejected", { reason: "not_production" }, "auth")
    return NextResponse.json(
      { error: "Auth is only available in production" },
      { status: 503 }
    )
  }

  try {
    const existing = await findUserByEmail(email)
    if (existing) {
      log("auth.signup.rejected", { reason: "user_exists" }, "auth")
      return NextResponse.json({ error: "User already exists" }, { status: 409 })
    }

    const { id } = await createUser(email, password)
    const { token } = await createSession(id)
    log("auth.signup.succeeded", { userId: id }, "auth")
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
    log("auth.signup.failed", { pgErr }, "auth")
    return NextResponse.json({ error: "Signup failed" }, { status: 500 })
  }
}

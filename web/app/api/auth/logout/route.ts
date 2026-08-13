import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, deleteSessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"

export async function POST(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  if (token) {
    await deleteSessionToken(token)
    log("auth.logout.succeeded", undefined, "auth")
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set(getSessionCookieName(), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  })
  return res
}

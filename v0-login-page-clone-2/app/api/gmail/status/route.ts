import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getGmailConnection } from "@/lib/gmail-oauth"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const adminEmail = process.env.GMAIL_ADMIN_EMAIL?.toLowerCase().trim()
  const canConnect = !adminEmail || user.email.toLowerCase() === adminEmail
  try {
    const conn = await getGmailConnection("inbox")
    if (!conn) return NextResponse.json({ connected: false, canConnect })
    return NextResponse.json({
      connected: true,
      email: conn.email ?? undefined,
      canConnect,
    })
  } catch {
    return NextResponse.json({ connected: false, canConnect })
  }
}

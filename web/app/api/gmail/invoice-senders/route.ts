import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { gcpReadGmailInvoiceSenders, gcpWriteGmailInvoiceSenders } from "@/lib/entity-store-gcp"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const user = await getUserBySessionToken(token)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const emails = await gcpReadGmailInvoiceSenders(user.id)
  return NextResponse.json({ emails })
}

export async function POST(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const user = await getUserBySessionToken(token)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  let body: { emails?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const raw = body.emails
  const emails = Array.isArray(raw)
    ? raw.map((e) => (typeof e === "string" ? e.trim().toLowerCase() : "")).filter(Boolean)
    : []
  try {
    await gcpWriteGmailInvoiceSenders(user.id, emails)
    return NextResponse.json({ emails })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("not configured")) {
      return NextResponse.json({ error: "Storage not configured" }, { status: 503 })
    }
    return NextResponse.json({ error: "Failed to save" }, { status: 500 })
  }
}

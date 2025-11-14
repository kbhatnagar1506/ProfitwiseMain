import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { listConnectionsByUser } from "@/lib/shopify-token-store"

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const connections = await listConnectionsByUser(user.id)
  return NextResponse.json({ connections })
}

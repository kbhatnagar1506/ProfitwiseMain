import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  if (!token) {
    return NextResponse.json({ user: null }, { status: 200 })
  }

  const user = await getUserBySessionToken(token)
  if (!user) {
    return NextResponse.json({ user: null }, { status: 200 })
  }

  return NextResponse.json({ user: { id: user.id, email: user.email } }, { status: 200 })
}

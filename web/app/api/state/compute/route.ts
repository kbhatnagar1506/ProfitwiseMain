import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { computeBusinessState } from "@/lib/state"
import { log } from "@/lib/logger"

async function getUser() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  return getUserBySessionToken(sessionToken ?? "")
}

export async function POST() {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    log("state.compute.start", { userId: user.id }, "state")
    const state = await computeBusinessState(user.id)
    log("state.compute.complete", { userId: user.id }, "state")

    return NextResponse.json(state)
  } catch (err) {
    log("state.compute.error", { error: String(err) }, "error")
    return NextResponse.json(
      { error: "Failed to compute business state" },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json(
    { error: "Use POST to compute state" },
    { status: 405 }
  )
}

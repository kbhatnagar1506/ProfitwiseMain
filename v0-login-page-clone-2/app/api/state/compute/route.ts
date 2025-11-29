import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { computeBusinessState } from "@/lib/state"
import { log } from "@/lib/logger"

export async function POST() {
  try {
    const session = await getSession()
    if (!session?.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    log("state.compute.start", { userId: session.userId })
    const state = await computeBusinessState(session.userId)
    log("state.compute.complete", { userId: session.userId })

    return NextResponse.json(state)
  } catch (err) {
    log("state.compute.error", { error: String(err) }, "error")
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to compute business state" },
      { status: 500 }
    )
  }
}

export async function GET() {
  return POST()
}

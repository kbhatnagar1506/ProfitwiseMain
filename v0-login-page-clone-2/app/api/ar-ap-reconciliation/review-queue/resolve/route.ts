import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema } from "@/lib/db"
import { resolveReviewQueueItem } from "@/lib/reconciliation-review-queue"

export async function POST(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await ensureMovementsSchema()
    const body = (await req.json().catch(() => ({}))) as {
      queue_id?: string
      action?: "accept" | "reject"
      selected_event_ids?: string[]
      reason?: string
    }
    if (!body.queue_id || (body.action !== "accept" && body.action !== "reject")) {
      return NextResponse.json({ error: "queue_id and valid action are required" }, { status: 400 })
    }

    const result = await resolveReviewQueueItem({
      userId: user.id,
      queueId: body.queue_id,
      action: body.action,
      selectedEventIds: Array.isArray(body.selected_event_ids) ? body.selected_event_ids : undefined,
      reason: body.reason,
    })
    return NextResponse.json(result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

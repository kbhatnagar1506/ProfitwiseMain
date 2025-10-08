import { NextRequest, NextResponse } from "next/server"
import { runGraphMaintainer } from "@/lib/graph-maintainer"
import { log } from "@/lib/logger"

/**
 * POST /api/cron/graph-maintainer?userId=<uuid>
 * Proposes pending entity_alias_suggestions from ambiguous movements (LLM + closed-world entities).
 * Auth: x-clean-db-secret header. Production only.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("cron.graph-maintainer.unauthorized", undefined, "movements")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const userId = req.nextUrl.searchParams.get("userId")?.trim()
  if (!userId) {
    return NextResponse.json({ error: "userId query parameter required" }, { status: 400 })
  }

  const candidateLimit = Math.min(
    120,
    Math.max(1, parseInt(req.nextUrl.searchParams.get("candidateLimit") ?? "40", 10) || 40),
  )

  try {
    const result = await runGraphMaintainer(userId, { candidateLimit })
    return NextResponse.json({ ok: true, result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("cron.graph-maintainer.failed", { error: message }, "movements")
    return NextResponse.json({ error: "Graph maintainer failed", detail: message }, { status: 500 })
  }
}

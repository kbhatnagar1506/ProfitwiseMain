import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { 
  findCrossSourceDuplicates, 
  autoResolveDuplicates, 
  markAsDuplicate, 
  unmarkDuplicate,
  getDuplicateRelationships 
} from "@/lib/cross-source-dedup"
import { log } from "@/lib/logger"

async function getUser(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  return getUserBySessionToken(token ?? "")
}

/**
 * GET: Find potential duplicates and get current duplicate relationships
 * POST: Auto-resolve duplicates or manually mark/unmark
 */
export async function GET(request: NextRequest) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const [candidates, relationships] = await Promise.all([
      findCrossSourceDuplicates(user.id),
      getDuplicateRelationships(user.id),
    ])

    return NextResponse.json({
      ok: true,
      candidates: candidates.map(c => ({
        sourceId: c.sourceMovementId,
        targetId: c.targetMovementId,
        confidence: c.confidence,
        reason: c.reason,
      })),
      relationships: relationships.map(r => ({
        duplicateId: r.duplicateId,
        canonicalId: r.canonicalId,
        reason: r.reason,
      })),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("dedup.get.failed", { userId: user.id, error: message }, "dedup")
    return NextResponse.json({ error: "Failed to find duplicates" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: { action?: string; sourceId?: string; targetId?: string; reason?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { action, sourceId, targetId, reason } = body

  try {
    switch (action) {
      case "auto_resolve": {
        const result = await autoResolveDuplicates(user.id)
        log("dedup.auto_resolve", { userId: user.id, resolved: result.resolved }, "dedup")
        return NextResponse.json({
          ok: true,
          resolved: result.resolved,
          candidates: result.candidates.length,
        })
      }

      case "mark": {
        if (!sourceId || !targetId) {
          return NextResponse.json({ error: "sourceId and targetId required" }, { status: 400 })
        }
        await markAsDuplicate(user.id, sourceId, targetId, reason ?? "Manual deduplication")
        return NextResponse.json({ ok: true, marked: sourceId, canonical: targetId })
      }

      case "unmark": {
        if (!sourceId) {
          return NextResponse.json({ error: "sourceId required" }, { status: 400 })
        }
        await unmarkDuplicate(user.id, sourceId)
        return NextResponse.json({ ok: true, unmarked: sourceId })
      }

      default:
        return NextResponse.json({ error: "Invalid action. Use: auto_resolve, mark, unmark" }, { status: 400 })
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("dedup.action.failed", { userId: user.id, action, error: message }, "dedup")
    return NextResponse.json({ error: "Deduplication action failed" }, { status: 500 })
  }
}

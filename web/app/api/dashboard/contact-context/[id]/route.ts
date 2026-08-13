import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/require-session"
import { query } from "@/lib/db"
import { searchEntityProfileContext } from "@/lib/supermemory"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = session.id
    const { id: entityId } = await params

    // Fetch the entity name and type so we can query Supermemory
    const entityResult = await query<{
      canonical_name: string
      entity_type: string
    }>(
      `SELECT canonical_name, entity_type
       FROM entities
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [entityId, userId]
    )

    if (!entityResult.rows.length) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const { canonical_name, entity_type } = entityResult.rows[0]
    const safeEntityType =
      entity_type === "customer" || entity_type === "vendor" ? entity_type : null

    const context = await searchEntityProfileContext(userId, canonical_name, safeEntityType)

    return NextResponse.json({
      contractTerms: context.contractTerms,
      relationshipNotes: context.relationshipNotes,
      rawContext: context.rawContext,
    })
  } catch (err) {
    console.error("[contact-context] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

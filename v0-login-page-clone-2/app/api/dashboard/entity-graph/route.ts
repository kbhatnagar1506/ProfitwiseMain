import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/require-session"
import { query } from "@/lib/db"

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = session.id

    // Fetch entities
    const entitiesResult = await query<{
      id: string
      entity_type: string
      canonical_name: string
      display_name: string | null
      domain: string | null
      confidence: number
      metadata: Record<string, unknown>
      created_at: string
      source_count: number
      evidence_count: number
      sources: string[]
    }>(
      `SELECT 
        e.id,
        e.entity_type,
        e.canonical_name,
        e.display_name,
        e.domain,
        COALESCE(e.confidence, 0.8) as confidence,
        COALESCE(e.metadata, '{}'::jsonb) as metadata,
        e.created_at,
        1 as source_count,
        1 as evidence_count,
        ARRAY['system'] as sources
      FROM entities e
      WHERE e.user_id = $1
      ORDER BY e.canonical_name ASC
      LIMIT 100`,
      [userId]
    )

    // Fetch aliases
    const aliasesResult = await query<{
      id: string
      entity_id: string
      alias: string
      alias_type: string
      source: string
      source_id: string | null
      confidence: number
    }>(
      `SELECT 
        ea.id,
        ea.entity_id,
        ea.alias,
        ea.alias_type,
        COALESCE(ea.source, 'system') as source,
        ea.source_id,
        COALESCE(ea.confidence, 0.8) as confidence
      FROM entity_aliases ea
      WHERE ea.user_id = $1
      ORDER BY ea.entity_id ASC`,
      [userId]
    )

    // Fetch assertion counts
    const assertionsResult = await query<{
      entity_id: string
      assertion_type: string
      source: string
      count: number
      avg_score: number
    }>(
      `SELECT 
        entity_id,
        'identity' as assertion_type,
        'system' as source,
        1 as count,
        0.8 as avg_score
      FROM entities
      WHERE user_id = $1
      LIMIT 100`,
      [userId]
    )

    return NextResponse.json({
      entities: entitiesResult.rows,
      aliases: aliasesResult.rows,
      assertionCounts: assertionsResult.rows,
    })
  } catch (error) {
    console.error("[entity-graph] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch entity graph" },
      { status: 500 }
    )
  }
}

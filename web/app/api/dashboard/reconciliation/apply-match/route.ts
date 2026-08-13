import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/require-session"
import { query, withTransaction } from "@/lib/db"
import { statusFromOutstanding, writeStatusChange } from "@/lib/ar-ap-status"
import type { PoolClient } from "pg"
import { writeAuditLogWithClient } from "@/lib/reconciliation-audit-log"
import { validateSemanticMatch } from "@/lib/semantic-validation-supermemory"

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const userId = session.id

    const body = await request.json() as {
      movement_id: string
      reference_id: string     // e.g. "qbo/214" or "xero/abc"
      component_type: "ar" | "ap"
      entity_id: string        // entity URI e.g. "ar://invoice/qbo/214"
      amount: number
      entity_name?: string     // Optional: for semantic validation warning
      bank_description?: string // Optional: for semantic validation warning
    }

    const { movement_id, reference_id, component_type, entity_id, amount, entity_name, bank_description } = body
    if (!movement_id || !reference_id || !component_type || !entity_id || !amount) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }
    if (!["ar", "ap"].includes(component_type)) {
      return NextResponse.json({ error: "component_type must be ar or ap" }, { status: 400 })
    }

    // Phase 6: Entity validation — compute semantic confidence for the manual match
    let semanticValidation: { valid: boolean; score: number; reasoning: string } | null = null
    let semanticWarning: string | null = null
    if (entity_name && bank_description) {
      try {
        const validation = await validateSemanticMatch(
          bank_description,
          entity_id,
          entity_name,
          amount,
          userId
        )
        semanticValidation = { valid: validation.valid, score: validation.score, reasoning: validation.reasoning }
        if (!validation.valid) {
          semanticWarning = `Low entity confidence: ${validation.reasoning}`
        } else if (validation.score < 0.75) {
          semanticWarning = `Moderate entity confidence (${(validation.score * 100).toFixed(0)}%): ${validation.reasoning}`
        }
      } catch {
        // Never block manual match on validation failure
      }
    }

    // Verify movement belongs to user
    const { rows: movRows } = await query<{ id: string; direction: string; amount: string }>(
      `SELECT id, direction, amount::float::text AS amount
       FROM movements
       WHERE id = $1 AND user_id = $2 AND duplicate_of IS NULL`,
      [movement_id, userId]
    )
    if (!movRows.length) {
      return NextResponse.json({ error: "Movement not found" }, { status: 404 })
    }

    const applyAmount = Math.min(amount, parseFloat(movRows[0].amount))

    await withTransaction(async (client: PoolClient) => {
      // Remove any prior user-source attribution for this exact movement+reference_id
      // so re-applying is idempotent
      await client.query(
        `DELETE FROM movement_attributions
         WHERE user_id = $1 AND movement_id = $2 AND reference_id = $3 AND source = 'user'`,
        [userId, movement_id, reference_id]
      )

      // Insert the user attribution
      await client.query(
        `INSERT INTO movement_attributions
           (user_id, movement_id, component_type, entity_id, reference_id,
            gross_amount, net_amount, confidence, source, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 1.0, 'user', $7::jsonb)`,
        [
          userId,
          movement_id,
          component_type,
          entity_id,
          reference_id,
          applyAmount,
          JSON.stringify({
            match_method: "manual_user",
            applied_at: new Date().toISOString(),
            semantic_validation: semanticValidation,
            semantic_warning: semanticWarning,
          }),
        ]
      )

      // Write audit log for the manual match
      await writeAuditLogWithClient(client, {
        userId,
        movementId: movement_id,
        matchMethod: "manual_user",
        waterfallStage: "manual",
        confidence: semanticValidation?.score ?? 1.0,
        entityId: entity_id,
        referenceId: reference_id,
        amountMatched: applyAmount,
        semanticValid: semanticValidation?.valid ?? true,
        crossEntityFlag: false,
      })

      // F2: Lock the cash_event row before reading/writing to prevent race conditions
      // where two simultaneous matches double-decrement outstanding_amount.
      const lockResult = await client.query<{
        id: string; status: string; outstanding_amount: string; amount: string
      }>(
        `SELECT id, status, outstanding_amount, amount
         FROM cash_events
         WHERE user_id = $1 AND entity_id = $2 AND event_type = $3
         FOR UPDATE
         LIMIT 1`,
        [userId, entity_id, component_type]
      )
      const ce = lockResult.rows[0]
      if (!ce) {
        throw new Error(`cash_event not found for entity_id=${entity_id} event_type=${component_type}`)
      }

      const prevOutstanding = parseFloat(ce.outstanding_amount)
      const prevStatus = ce.status
      const origAmount = parseFloat(ce.amount)
      const newOutstanding = Math.max(0, prevOutstanding - applyAmount)
      const newStatus = statusFromOutstanding(newOutstanding, origAmount)

      // Decrement cash_events.outstanding_amount using the canonical helper
      await writeStatusChange(client, {
        cashEventId: ce.id,
        userId,
        fromStatus: prevStatus,
        toStatus: newStatus,
        fromOutstanding: prevOutstanding,
        toOutstanding: newOutstanding,
        triggeredBy: "apply_match",
        attributionId: null,
      })

      // Update entities table: decrease open_ar/open_ap, increase lifetime_value
      // Extract entity_id from cash_events to find the actual entity record
      const { rows: entityRows } = await client.query<{ id: string }>(
        `SELECT id FROM entities WHERE user_id = $1 AND id = (
           SELECT entity_id FROM cash_events WHERE user_id = $1 AND entity_id = $2 LIMIT 1
         )`,
        [userId, entity_id]
      )
      
      if (entityRows.length > 0) {
        const entityUuid = entityRows[0].id
        
        // Update based on component_type (ar or ap)
        if (component_type === "ar") {
          await client.query(
            `UPDATE entities
             SET open_ar = GREATEST(0, open_ar - $2),
                 lifetime_value = lifetime_value + $2,
                 last_transaction_date = NOW(),
                 updated_at = NOW()
             WHERE id = $1 AND user_id = $3`,
            [entityUuid, applyAmount, userId]
          )
        } else {
          await client.query(
            `UPDATE entities
             SET open_ap = GREATEST(0, open_ap - $2),
                 lifetime_value = lifetime_value + $2,
                 last_transaction_date = NOW(),
                 updated_at = NOW()
             WHERE id = $1 AND user_id = $3`,
            [entityUuid, applyAmount, userId]
          )
        }
      }
    })

    return NextResponse.json({ success: true, semantic_warning: semanticWarning ?? undefined })
  } catch (err) {
    console.error("[reconciliation/apply-match] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

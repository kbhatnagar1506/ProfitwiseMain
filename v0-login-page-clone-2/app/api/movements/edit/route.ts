import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"
import { parseEditIntent, type MovementSummary } from "@/lib/movement-edit-llm"
import { tagMovements } from "@/lib/movement-tag-enrich"
import { addMerchantOverrideToSupermemory } from "@/lib/supermemory"
import { createErrorResponse, validateString, safeJsonStringify } from "@/lib/api-utils"
import { log } from "@/lib/logger"

export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) {
    return NextResponse.json(createErrorResponse("Unauthorized"), { status: 401 })
  }

  let body: { intent?: string; movement_ids?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(createErrorResponse("Invalid JSON body"), { status: 400 })
  }

  const intent = validateString(body.intent, 1, 5000)
  const movementIds = Array.isArray(body.movement_ids) ? body.movement_ids.filter((id): id is string => typeof id === "string") : undefined

  if (!intent) {
    return NextResponse.json(createErrorResponse("intent is required and must be non-empty"), { status: 400 })
  }

  try {
    await ensureMovementsSchema()
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log("movements.edit.schema_error", { error: errorMsg, userId: user.id })
    return NextResponse.json(createErrorResponse("Schema not ready"), { status: 500 })
  }

  type DbRow = { id: string; direction: string; amount: string; raw_description: string | null; counterparty: string | null; movement_type: string; cash_account_id: string | null }
  const rows = await query<DbRow>(
    `SELECT id, direction, amount, raw_description, counterparty, movement_type, cash_account_id
     FROM movements WHERE user_id = $1 AND duplicate_of IS NULL`,
    [user.id],
  ).then((r) => r.rows)

  const movements: MovementSummary[] = rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    amount: parseFloat(r.amount),
    raw_description: r.raw_description,
    counterparty: r.counterparty,
    movement_type: r.movement_type,
  }))

  const plan = await parseEditIntent(intent, movements, movementIds)
  if (!plan) {
    log("movements.edit.parse_failed", { userId: user.id, intent })
    return NextResponse.json(createErrorResponse("Could not parse your request. Try being more specific, e.g. 'Change all Gusto to payroll'."), { status: 400 })
  }

  // Build list of movement IDs to update
  let candidateIds: string[]
  if (plan.match.movement_ids?.length) {
    candidateIds = plan.match.movement_ids.filter((id) => rows.some((r) => r.id === id))
  } else {
    const cpLower = (plan.match.counterparty_contains ?? "").toLowerCase()
    const descLower = (plan.match.description_contains ?? "").toLowerCase()
    candidateIds = rows
      .filter((r) => {
        if (plan.match.movement_type && r.movement_type !== plan.match.movement_type) return false
        if (cpLower) {
          const cp = (r.counterparty ?? "").toLowerCase()
          const desc = (r.raw_description ?? "").toLowerCase()
          if (!cp.includes(cpLower) && !desc.includes(cpLower)) return false
        }
        if (descLower) {
          const desc = (r.raw_description ?? "").toLowerCase()
          if (!desc.includes(descLower)) return false
        }
        return true
      })
      .map((r) => r.id)
  }

  if (candidateIds.length === 0) {
    return NextResponse.json({ error: "No matching transactions found.", plan: plan.summary }, { status: 404 })
  }

  // Apply updates
  const updates: Record<string, unknown> = {}
  if (plan.changes.movement_type) updates.movement_type = plan.changes.movement_type
  if (plan.changes.counterparty != null) updates.counterparty = plan.changes.counterparty
  if (plan.changes.confidence != null) {
    updates.confidence = JSON.stringify({ score: plan.changes.confidence, evidence_strength: plan.changes.confidence })
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No changes to apply.", plan: plan.summary }, { status: 400 })
  }

  const pnlTypes = new Set(["cash_in_customer", "cash_out_vendor", "cash_out_operating_expense", "cash_out_payroll", "cash_out_tax", "cash_out_bank_fee", "bank_fee_refund", "cash_in_refund", "cash_out_refund", "cash_in_interest", "cash_out_interest", "processor_fee_settlement", "other_operating"])

  let updated = 0
  for (const id of candidateIds) {
    const setClauses: string[] = []
    const values: unknown[] = []
    let idx = 1
    if (plan.changes.movement_type) {
      setClauses.push(`movement_type = $${idx++}`)
      values.push(plan.changes.movement_type)
    }
    if (plan.changes.counterparty != null) {
      setClauses.push(`counterparty = $${idx++}`)
      values.push(plan.changes.counterparty)
    }
    if (plan.changes.confidence != null) {
      setClauses.push(`confidence = $${idx++}::jsonb`)
      values.push(safeJsonStringify({ score: plan.changes.confidence, evidence_strength: plan.changes.confidence }))
    }
    if (plan.changes.movement_type) {
      setClauses.push(`pnl_eligible = $${idx++}`)
      values.push(pnlTypes.has(plan.changes.movement_type))
    }
    setClauses.push(`review_needed = false`)
    values.push(id, user.id)
    const idParam = idx++
    const userIdParam = idx
    await query(
      `UPDATE movements SET ${setClauses.join(", ")} WHERE id = $${idParam} AND user_id = $${userIdParam}`,
      values,
    )
    updated++
  }

  // Re-tag so movement_tags reflect updated state
  await tagMovements(user.id)

  log("movements.edit.success", { userId: user.id, updated, intent: intent.slice(0, 100) })

  // Persist user corrections to Supermemory so future classification improves
  if (process.env.SUPERMEMORY_API_KEY && (plan.changes.movement_type || plan.changes.counterparty != null)) {
    const rowById = new Map(rows.map((r) => [r.id, r]))
    for (const id of candidateIds) {
      const row = rowById.get(id)
      if (!row) continue
      const rawName = (row.raw_description ?? row.counterparty ?? "unknown").trim()
      if (!rawName) continue
      const normalizedName = (plan.changes.counterparty ?? row.counterparty ?? rawName).trim()
      const movementType = plan.changes.movement_type ?? row.movement_type
      const accountId = (row.cash_account_id ?? "unknown").trim() || "unknown"
      try {
        await addMerchantOverrideToSupermemory(
          user.id,
          accountId,
          rawName,
          normalizedName,
          movementType,
          movementType,
        )
      } catch {
        // Non-fatal: edit succeeded; Supermemory persistence is best-effort
      }
    }
  }

  return NextResponse.json({
    updated,
    plan: plan.summary,
    matched_count: candidateIds.length,
  })
}


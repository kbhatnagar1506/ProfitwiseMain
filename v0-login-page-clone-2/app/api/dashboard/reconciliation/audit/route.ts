import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type AuditEntry = {
  id: string
  movement_id: string
  action: string
  old_value: any
  new_value: any
  reason: string
  created_at: string
}

type LogAuditRequest = {
  movement_id: string
  action: "matched" | "unmatched" | "corrected" | "classified"
  old_value?: any
  new_value?: any
  reason?: string
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("reconciliation.audit.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id
    const { searchParams } = new URL(request.url)
    const movementId = searchParams.get("movement_id")
    const limit = parseInt(searchParams.get("limit") || "100", 10)

    let query_str = `SELECT id, movement_id, action, old_value, new_value, reason, created_at::text
                     FROM reconciliation_audit
                     WHERE user_id = $1`
    const params: any[] = [userId]

    if (movementId) {
      query_str += ` AND movement_id = $2`
      params.push(movementId)
    }

    query_str += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`
    params.push(limit)

    const entries = await query<AuditEntry>(query_str, params).then((r) => r.rows)

    return NextResponse.json({ entries })
  } catch (error) {
    log("reconciliation.audit.get_error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to fetch audit trail" },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("reconciliation.audit.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id
    const body: LogAuditRequest = await request.json()
    const { movement_id, action, old_value, new_value, reason } = body

    if (!movement_id || !action) {
      return NextResponse.json(
        { error: "Missing required fields: movement_id, action" },
        { status: 400 }
      )
    }

    // Validate action
    const validActions = ["matched", "unmatched", "corrected", "classified"]
    if (!validActions.includes(action)) {
      return NextResponse.json(
        { error: `Invalid action. Must be one of: ${validActions.join(", ")}` },
        { status: 400 }
      )
    }

    const result = await query<{ id: string }>(
      `INSERT INTO reconciliation_audit (user_id, movement_id, action, old_value, new_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, movement_id, action, JSON.stringify(old_value), JSON.stringify(new_value), reason]
    ).then((r) => r.rows[0])

    log("reconciliation.audit.logged", {
      userId,
      movement_id,
      action,
    })

    return NextResponse.json({
      success: true,
      audit_id: result.id,
      message: "Audit entry logged",
    })
  } catch (error) {
    log("reconciliation.audit.log_error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to log audit entry" },
      { status: 500 }
    )
  }
}

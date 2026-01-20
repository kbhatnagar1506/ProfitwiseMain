import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type ReconciliationSettings = {
  id: string
  stage4_threshold: number
  processor_fee_tolerance: number
  min_confidence: number
  auto_reconcile_exact: boolean
  created_at: string
  updated_at: string
}

type UpdateSettingsRequest = {
  stage4_threshold?: number
  processor_fee_tolerance?: number
  min_confidence?: number
  auto_reconcile_exact?: boolean
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("reconciliation.settings.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id

    let settings = await query<ReconciliationSettings>(
      `SELECT id, stage4_threshold::float, processor_fee_tolerance, min_confidence, auto_reconcile_exact, created_at::text, updated_at::text
       FROM reconciliation_settings
       WHERE user_id = $1`,
      [userId]
    ).then((r) => r.rows[0])

    // If no settings exist, create defaults
    if (!settings) {
      await query(
        `INSERT INTO reconciliation_settings (user_id, stage4_threshold, processor_fee_tolerance, min_confidence, auto_reconcile_exact)
         VALUES ($1, 1000, 0.08, 0.80, true)`,
        [userId]
      )

      settings = await query<ReconciliationSettings>(
        `SELECT id, stage4_threshold::float, processor_fee_tolerance, min_confidence, auto_reconcile_exact, created_at::text, updated_at::text
         FROM reconciliation_settings
         WHERE user_id = $1`,
        [userId]
      ).then((r) => r.rows[0])
    }

    return NextResponse.json({ settings })
  } catch (error) {
    log("reconciliation.settings.get_error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to fetch reconciliation settings" },
      { status: 500 }
    )
  }
}

export async function PUT(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("reconciliation.settings.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id
    const body: UpdateSettingsRequest = await request.json()

    // Validate inputs
    if (body.stage4_threshold !== undefined && body.stage4_threshold < 0) {
      return NextResponse.json(
        { error: "stage4_threshold must be >= 0" },
        { status: 400 }
      )
    }

    if (body.processor_fee_tolerance !== undefined && (body.processor_fee_tolerance < 0 || body.processor_fee_tolerance > 1)) {
      return NextResponse.json(
        { error: "processor_fee_tolerance must be between 0 and 1" },
        { status: 400 }
      )
    }

    if (body.min_confidence !== undefined && (body.min_confidence < 0 || body.min_confidence > 1)) {
      return NextResponse.json(
        { error: "min_confidence must be between 0 and 1" },
        { status: 400 }
      )
    }

    // Ensure settings exist
    await query(
      `INSERT INTO reconciliation_settings (user_id, stage4_threshold, processor_fee_tolerance, min_confidence, auto_reconcile_exact)
       VALUES ($1, 1000, 0.08, 0.80, true)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    )

    // Update settings
    const updates: string[] = []
    const values: any[] = [userId]
    let paramCount = 2

    if (body.stage4_threshold !== undefined) {
      updates.push(`stage4_threshold = $${paramCount}`)
      values.push(body.stage4_threshold)
      paramCount++
    }

    if (body.processor_fee_tolerance !== undefined) {
      updates.push(`processor_fee_tolerance = $${paramCount}`)
      values.push(body.processor_fee_tolerance)
      paramCount++
    }

    if (body.min_confidence !== undefined) {
      updates.push(`min_confidence = $${paramCount}`)
      values.push(body.min_confidence)
      paramCount++
    }

    if (body.auto_reconcile_exact !== undefined) {
      updates.push(`auto_reconcile_exact = $${paramCount}`)
      values.push(body.auto_reconcile_exact)
      paramCount++
    }

    if (updates.length === 0) {
      return NextResponse.json(
        { error: "No settings to update" },
        { status: 400 }
      )
    }

    updates.push("updated_at = NOW()")

    await query(
      `UPDATE reconciliation_settings SET ${updates.join(", ")} WHERE user_id = $1`,
      values
    )

    log("reconciliation.settings.updated", { userId, updates: Object.keys(body) })

    return NextResponse.json({
      success: true,
      message: "Reconciliation settings updated",
    })
  } catch (error) {
    log("reconciliation.settings.update_error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to update reconciliation settings" },
      { status: 500 }
    )
  }
}

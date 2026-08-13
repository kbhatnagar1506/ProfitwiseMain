import { NextResponse } from "next/server"
import { query } from "@/lib/db"

/**
 * Admin endpoint to clear stale reconciliation locks
 * Usage: GET /api/admin/clear-recon-lock?userId=<uuid>&secret=<CLEAN_DB_SECRET>
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const userId = url.searchParams.get("userId")
  const secret = url.searchParams.get("secret")
  const cleanDbSecret = process.env.CLEAN_DB_SECRET

  if (!secret || secret !== cleanDbSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (!userId) {
    return NextResponse.json({ error: "Missing userId" }, { status: 400 })
  }

  try {
    // Clear stale lock
    const result = await query(
      `UPDATE reconciliation_locks 
       SET status = 'failed', 
           error_message = 'Lock cleared by admin',
           completed_at = NOW()
       WHERE user_id = $1::uuid
         AND status = 'running'
       RETURNING *;`,
      [userId]
    )

    // Check current status
    const check = await query(
      `SELECT status, error_message, started_at FROM reconciliation_locks 
       WHERE user_id = $1::uuid
       ORDER BY started_at DESC LIMIT 1;`,
      [userId]
    )

    return NextResponse.json({
      cleared: result.rows.length > 0,
      currentStatus: check.rows[0] || null,
    })
  } catch (err) {
    console.error("[clear-recon-lock] Error:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

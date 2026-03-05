import { NextResponse } from "next/server"
import { query } from "@/lib/db"

export async function GET() {
  try {
    // Get cash_events summary
    const summary = await query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_count,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN status = 'partially_paid' THEN 1 ELSE 0 END) as partial_count,
        SUM(CASE WHEN metadata->>'manual_paid' = 'true' THEN 1 ELSE 0 END) as manual_paid_count,
        SUM(CASE WHEN last_reconciled_at IS NOT NULL THEN 1 ELSE 0 END) as reconciled_count
      FROM cash_events
    `)

    // Get recent events
    const recent = await query(`
      SELECT 
        ce.id,
        ce.entity_id,
        ce.event_type,
        ce.amount::text,
        ce.outstanding_amount::text,
        ce.status,
        ce.display_status,
        ce.last_reconciled_at,
        ce.metadata->>'manual_paid' as manual_paid,
        ce.updated_at
      FROM cash_events ce
      ORDER BY ce.updated_at DESC
      LIMIT 20
    `)

    // Get status log
    const logCount = await query(`
      SELECT COUNT(*) as total FROM ar_ap_status_log
    `)

    // Get recent status changes
    const logRecent = await query(`
      SELECT 
        cash_event_id,
        from_status,
        to_status,
        triggered_by,
        created_at
      FROM ar_ap_status_log
      ORDER BY created_at DESC
      LIMIT 15
    `)

    return NextResponse.json({
      summary: summary.rows[0],
      recent_events: recent.rows,
      status_log_total: logCount.rows[0].total,
      recent_status_changes: logRecent.rows
    })
  } catch (err) {
    console.error("Error:", err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

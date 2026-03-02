import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"

export async function GET(request: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureMovementsSchema()

  const { searchParams } = new URL(request.url)
  const year = parseInt(searchParams.get("year") ?? String(new Date().getFullYear()))
  const month = parseInt(searchParams.get("month") ?? String(new Date().getMonth() + 1))

  const periodStart = new Date(year, month - 1, 1).toISOString().slice(0, 10)
  const periodEnd = new Date(year, month, 0).toISOString().slice(0, 10)

  const [
    unmatchedRows,
    suspenseRows,
    openArRows,
    openApRows,
    lockedRows,
    reconLockRows,
  ] = await Promise.all([
    // 1. Unmatched operating movements in period
    query<{ count: string; total: string }>(
      `SELECT COUNT(*)::text AS count, COALESCE(SUM(ABS(m.amount)), 0)::text AS total
       FROM movements m
       LEFT JOIN movement_tags mt ON mt.movement_id = m.id AND mt.user_id = m.user_id
       WHERE m.user_id = $1
         AND m.duplicate_of IS NULL
         AND m.pnl_eligible = true
         AND m.date BETWEEN $2 AND $3
         AND NOT EXISTS (
           SELECT 1 FROM movement_attributions ma
           WHERE ma.movement_id = m.id AND ma.user_id = m.user_id
         )`,
      [user.id, periodStart, periodEnd]
    ).then(r => r.rows[0]),

    // 2. Suspense balance (unknown attributions)
    query<{ count: string; total: string }>(
      `SELECT COUNT(*)::text AS count, COALESCE(SUM(ABS(ma.net_amount)), 0)::text AS total
       FROM movement_attributions ma
       JOIN movements m ON m.id = ma.movement_id
       WHERE ma.user_id = $1
         AND ma.component_type = 'unknown'
         AND m.date BETWEEN $2 AND $3`,
      [user.id, periodStart, periodEnd]
    ).then(r => r.rows[0]),

    // 3. Open AR items
    query<{ count: string; total: string }>(
      `SELECT COUNT(*)::text AS count, COALESCE(SUM(outstanding_amount), 0)::text AS total
       FROM cash_events
       WHERE user_id = $1 AND event_type = 'ar' AND status != 'paid'`,
      [user.id]
    ).then(r => r.rows[0]),

    // 4. Open AP items
    query<{ count: string; total: string }>(
      `SELECT COUNT(*)::text AS count, COALESCE(SUM(outstanding_amount), 0)::text AS total
       FROM cash_events
       WHERE user_id = $1 AND event_type = 'ap' AND status != 'paid'`,
      [user.id]
    ).then(r => r.rows[0]),

    // 5. Locked periods
    query<{ id: string; period_year: string; period_month: string; locked_at: string }>(
      `SELECT id, period_year::text, period_month::text, locked_at::text
       FROM period_locks
       WHERE user_id = $1
       ORDER BY period_year DESC, period_month DESC
       LIMIT 24`,
      [user.id]
    ).then(r => r.rows),

    // 6. Reconciliation lock status
    query<{ status: string; completed_at: string | null }>(
      `SELECT status, completed_at::text FROM reconciliation_locks WHERE user_id = $1 LIMIT 1`,
      [user.id]
    ).then(r => r.rows[0] ?? null),
  ])

  const unmatchedCount = parseInt(unmatchedRows?.count ?? "0")
  const unmatchedTotal = parseFloat(unmatchedRows?.total ?? "0")
  const suspenseCount = parseInt(suspenseRows?.count ?? "0")
  const suspenseTotal = parseFloat(suspenseRows?.total ?? "0")
  const openArCount = parseInt(openArRows?.count ?? "0")
  const openArTotal = parseFloat(openArRows?.total ?? "0")
  const openApCount = parseInt(openApRows?.count ?? "0")
  const openApTotal = parseFloat(openApRows?.total ?? "0")
  const reconComplete = reconLockRows?.status === "complete" || reconLockRows?.status === null

  const isLockedThisPeriod = lockedRows.some(
    r => parseInt(r.period_year) === year && parseInt(r.period_month) === month
  )

  const checklist = [
    {
      id: "recon",
      label: "Bank accounts reconciled",
      description: "All movements matched against bank statements",
      passed: reconComplete,
      detail: reconComplete ? "Reconciliation complete" : "Reconciliation in progress or not run",
    },
    {
      id: "unmatched",
      label: "Unmatched operating cash = $0",
      description: "Every operating movement attributed to an invoice or expense",
      passed: unmatchedCount === 0,
      detail: unmatchedCount === 0
        ? "All movements matched"
        : `${unmatchedCount} unmatched movements totaling $${unmatchedTotal.toFixed(2)}`,
      count: unmatchedCount,
      total: unmatchedTotal,
    },
    {
      id: "suspense",
      label: "Suspense accounts = $0.00",
      description: "No unclassified entries lingering in the books",
      passed: suspenseTotal < 0.01,
      detail: suspenseTotal < 0.01
        ? "No suspense entries"
        : `$${suspenseTotal.toFixed(2)} across ${suspenseCount} entries in suspense`,
      count: suspenseCount,
      total: suspenseTotal,
    },
    {
      id: "open_ar",
      label: "Open AR reviewed",
      description: "Outstanding invoices acknowledged",
      passed: true, // informational only — doesn't block locking
      detail: openArCount === 0
        ? "No open AR"
        : `${openArCount} open invoices — $${openArTotal.toFixed(2)} outstanding`,
      count: openArCount,
      total: openArTotal,
      informational: true,
    },
    {
      id: "open_ap",
      label: "Open AP reviewed",
      description: "Outstanding bills acknowledged",
      passed: true, // informational only
      detail: openApCount === 0
        ? "No open AP"
        : `${openApCount} open bills — $${openApTotal.toFixed(2)} due`,
      count: openApCount,
      total: openApTotal,
      informational: true,
    },
  ]

  const canLock = checklist.filter(c => !c.informational).every(c => c.passed)

  return NextResponse.json({
    period: { year, month, start: periodStart, end: periodEnd },
    checklist,
    can_lock: canLock && !isLockedThisPeriod,
    is_locked: isLockedThisPeriod,
    locked_periods: lockedRows.map(r => ({
      year: parseInt(r.period_year),
      month: parseInt(r.period_month),
      locked_at: r.locked_at,
    })),
  })
}

export async function POST(request: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json()
  const { year, month } = body as { year: number; month: number }

  if (!year || !month) {
    return NextResponse.json({ error: "year and month required" }, { status: 400 })
  }

  await ensureMovementsSchema()

  // Check if already locked
  const existing = await query(
    `SELECT id FROM period_locks WHERE user_id = $1 AND period_year = $2 AND period_month = $3`,
    [user.id, year, month]
  )
  if (existing.rows.length > 0) {
    return NextResponse.json({ error: "Period already locked" }, { status: 409 })
  }

  await query(
    `INSERT INTO period_locks (user_id, period_year, period_month) VALUES ($1, $2, $3)`,
    [user.id, year, month]
  )

  return NextResponse.json({ success: true, locked: { year, month } })
}

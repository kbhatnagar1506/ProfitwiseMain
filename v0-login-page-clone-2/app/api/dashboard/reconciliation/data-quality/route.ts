import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type DuplicateGroup = {
  primary_id: string
  counterparty: string
  amount: number
  date: string
  duplicates: Array<{
    id: string
    date: string
  }>
}

type OverMatchedItem = {
  entity_id: string
  entity_name: string
  invoice_amount: number
  matched_amount: number
  over_matched_by: number
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("reconciliation.data_quality.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id

    // Get duplicate groups
    const duplicateGroups = await query<{
      primary_id: string
      counterparty: string
      amount: string
      date: string
      duplicate_ids: string
      duplicate_dates: string
    }>(
      `SELECT 
        m1.id as primary_id,
        m1.counterparty,
        m1.amount::text,
        m1.date::text,
        array_agg(m2.id)::text as duplicate_ids,
        array_agg(m2.date::text) as duplicate_dates
       FROM movements m1
       JOIN movements m2 ON m1.user_id = m2.user_id 
         AND m1.counterparty = m2.counterparty 
         AND ABS(m1.amount - m2.amount) < 0.01
         AND ABS(m1.date::date - m2.date::date) <= 1
         AND m1.id < m2.id
         AND m1.duplicate_of IS NULL
         AND m2.duplicate_of IS NULL
       WHERE m1.user_id = $1
       GROUP BY m1.id, m1.counterparty, m1.amount, m1.date`,
      [userId]
    ).then((r) => r.rows)

    // Get over-matched items
    const overMatchedItems = await query<{
      entity_id: string
      entity_name: string
      invoice_amount: string
      matched_amount: string
    }>(
      `SELECT 
        ce.entity_id,
        COALESCE(ce.metadata->>'canonical_name', ce.metadata->>'customer_name', ce.metadata->>'vendor_name', 'Unknown') as entity_name,
        ABS(ce.amount)::text as invoice_amount,
        ma.total_matched::text as matched_amount
       FROM cash_events ce
       JOIN (
         SELECT entity_id, SUM(ABS(net_amount::float)) as total_matched
         FROM movement_attributions
         WHERE user_id = $1 AND component_type IN ('ar', 'ap')
         GROUP BY entity_id
       ) ma ON ce.entity_id = ma.entity_id
       WHERE ce.user_id = $1 
         AND ce.event_type IN ('ar', 'ap')
         AND ma.total_matched > ABS(ce.amount)
       GROUP BY ce.id, ce.entity_id, ce.amount, ma.total_matched, ce.metadata->>'canonical_name', ce.metadata->>'customer_name', ce.metadata->>'vendor_name'`,
      [userId]
    ).then((r) => r.rows)

    // Get status anomalies
    const statusAnomalies = await query<{
      id: string
      entity_name: string
      event_type: string
      amount: string
      outstanding_amount: string
      status: string
    }>(
      `SELECT 
        ce.id,
        COALESCE(ce.metadata->>'canonical_name', ce.metadata->>'customer_name', ce.metadata->>'vendor_name', 'Unknown') as entity_name,
        ce.event_type,
        ABS(ce.amount)::text as amount,
        ce.outstanding_amount::text,
        ce.status
       FROM cash_events ce
       WHERE ce.user_id = $1 
         AND ce.event_type IN ('ar', 'ap')
         AND ce.status = 'paid'
         AND ce.outstanding_amount > 0
       LIMIT 100`,
      [userId]
    ).then((r) => r.rows)

    return NextResponse.json({
      duplicates: duplicateGroups.map((g) => ({
        primary_id: g.primary_id,
        counterparty: g.counterparty,
        amount: parseFloat(g.amount),
        date: g.date,
        duplicate_count: g.duplicate_ids.split(",").length,
      })),
      over_matched: overMatchedItems.map((item) => ({
        entity_id: item.entity_id,
        entity_name: item.entity_name,
        invoice_amount: parseFloat(item.invoice_amount),
        matched_amount: parseFloat(item.matched_amount),
        over_matched_by: parseFloat(item.matched_amount) - parseFloat(item.invoice_amount),
      })),
      status_anomalies: statusAnomalies.map((item) => ({
        id: item.id,
        entity_name: item.entity_name,
        type: item.event_type === "ar" ? "Invoice" : "Bill",
        amount: parseFloat(item.amount),
        outstanding: parseFloat(item.outstanding_amount),
        status: item.status,
      })),
    })
  } catch (error) {
    log("reconciliation.data_quality.error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to fetch data quality details" },
      { status: 500 }
    )
  }
}

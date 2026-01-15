import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type EntityProfile = {
  id: string
  canonical_name: string
  entity_type: "customer" | "vendor"
  total_transactions: number
  total_volume: number
  average_transaction: number
  last_transaction_date: string | null
  first_transaction_date: string | null
  payment_status: "on_time" | "late" | "mixed" | "unknown"
  average_days_to_pay: number | null
  outstanding_balance: number
  lifetime_value: number
  relationship_strength: "strong" | "moderate" | "weak"
  aliases: string[]
}

export async function GET(request?: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("dashboard.entity-profiles.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id

    // Fetch entities with their transaction history and aliases
    const entityRows = await query<{
      id: string
      canonical_name: string
      entity_type: string
      total_transactions: number
      total_volume: string
      average_transaction: string
      last_transaction_date: string | null
      first_transaction_date: string | null
      aliases: string
    }>(
      `SELECT
        e.id,
        e.canonical_name,
        CASE 
          WHEN EXISTS (SELECT 1 FROM cash_events ce WHERE ce.entity_id::text LIKE 'ar://%' AND ce.metadata->>'customer_name' = e.canonical_name)
          THEN 'customer'
          ELSE 'vendor'
        END as entity_type,
        COUNT(DISTINCT m.id) as total_transactions,
        COALESCE(SUM(ABS(m.amount)), 0) as total_volume,
        COALESCE(AVG(ABS(m.amount)), 0) as average_transaction,
        MAX(m.date) as last_transaction_date,
        MIN(m.date) as first_transaction_date,
        STRING_AGG(DISTINCT ea.alias, ', ') as aliases
       FROM entities e
       LEFT JOIN movements m ON m.counterparty_entity_id = e.id AND m.user_id = e.user_id
       LEFT JOIN entity_aliases ea ON ea.entity_id = e.id
       WHERE e.user_id = $1
       GROUP BY e.id, e.canonical_name
       ORDER BY total_volume DESC`,
      [userId]
    ).then((r) => r.rows)

    // Fetch outstanding balances from cash_events
    const outstandingRows = await query<{
      entity_id: string
      outstanding: string
    }>(
      `SELECT
        DISTINCT ON (metadata->>'customer_name', metadata->>'vendor_name')
        COALESCE(metadata->>'customer_name', metadata->>'vendor_name') as entity_id,
        SUM(outstanding_amount) as outstanding
       FROM cash_events
       WHERE user_id = $1
       GROUP BY COALESCE(metadata->>'customer_name', metadata->>'vendor_name')`,
      [userId]
    ).then((r) => r.rows)

    const outstandingMap = new Map(
      outstandingRows.map((r) => [String(r.entity_id), parseFloat(String(r.outstanding || 0))])
    )

    const profiles: EntityProfile[] = entityRows.map((row) => {
      const totalVolume = parseFloat(String(row.total_volume || 0))
      const avgTransaction = parseFloat(String(row.average_transaction || 0))
      const outstanding = outstandingMap.get(row.canonical_name) || 0

      // Determine relationship strength based on transaction count and volume
      let strength: "strong" | "moderate" | "weak" = "weak"
      if (row.total_transactions > 20 || totalVolume > 50000) {
        strength = "strong"
      } else if (row.total_transactions > 5 || totalVolume > 10000) {
        strength = "moderate"
      }

      return {
        id: row.id,
        canonical_name: row.canonical_name,
        entity_type: row.entity_type as "customer" | "vendor",
        total_transactions: parseInt(String(row.total_transactions), 10),
        total_volume: totalVolume,
        average_transaction: avgTransaction,
        last_transaction_date: row.last_transaction_date,
        first_transaction_date: row.first_transaction_date,
        payment_status: "unknown",
        average_days_to_pay: null,
        outstanding_balance: outstanding,
        lifetime_value: totalVolume,
        relationship_strength: strength,
        aliases: row.aliases ? row.aliases.split(", ").filter(Boolean) : [],
      }
    })

    const totals = {
      total_entities: profiles.length,
      total_customers: profiles.filter((p) => p.entity_type === "customer").length,
      total_vendors: profiles.filter((p) => p.entity_type === "vendor").length,
      total_volume: profiles.reduce((sum, p) => sum + p.total_volume, 0),
    }

    log("dashboard.entity-profiles.success", { userId, entityCount: profiles.length })

    return NextResponse.json({
      profiles,
      totals,
    })
  } catch (error) {
    log("dashboard.entity-profiles.error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to fetch entity profiles" },
      { status: 500 }
    )
  }
}

import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/require-session"
import { query } from "@/lib/db"
import { calculateEnrichedEntityData, EnrichedEntityData } from "@/lib/entity-calculations"

type EntityRow = {
  id: string
  entity_type: "customer" | "vendor"
  canonical_name: string
  display_name: string | null
  transaction_count: number
  lifetime_value: number
  ar_balance: number
  overdue_balance: number
  last_transaction_date: string | null
  metadata: Record<string, unknown> | null
}

type SummaryRow = {
  total_customers: number
  total_vendors: number
  total_lifetime_value: number
  total_ar_outstanding: number
  total_overdue: number
  at_risk_count: number
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = session.id
    const searchParams = request.nextUrl.searchParams

    // Parse query parameters
    const entityType = searchParams.get("entity_type") || "customer"
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10))
    const limit = Math.min(100, Math.max(10, parseInt(searchParams.get("limit") || "50", 10)))
    const offset = (page - 1) * limit
    const search = searchParams.get("search") || ""
    const sortBy = searchParams.get("sort_by") || "lifetime_value"
    const archetype = searchParams.get("archetype") || ""
    const atRisk = searchParams.get("at_risk") === "true"

    // Build WHERE clause
    const whereConditions = ["e.user_id = $1", "e.entity_type = $2"]
    const params: unknown[] = [userId, entityType]
    let paramIndex = 3

    if (search) {
      whereConditions.push(`(e.canonical_name ILIKE $${paramIndex} OR e.display_name ILIKE $${paramIndex})`)
      params.push(`%${search}%`)
      paramIndex++
    }

    const whereClause = whereConditions.join(" AND ")

    // Fetch summary stats
    const summaryResult = await query<SummaryRow>(
      `SELECT 
        COUNT(DISTINCT CASE WHEN e.entity_type = 'customer' THEN e.id END)::int as total_customers,
        COUNT(DISTINCT CASE WHEN e.entity_type = 'vendor' THEN e.id END)::int as total_vendors,
        COALESCE(SUM(CASE WHEN e.entity_type IN ('customer', 'vendor') THEN ABS(m.amount) ELSE 0 END), 0)::numeric as total_lifetime_value,
        COALESCE(SUM(CASE WHEN e.entity_type = 'customer' AND m.direction = 'inflow' AND m.movement_type = 'receivable' 
          THEN m.amount ELSE 0 END), 0)::numeric as total_ar_outstanding,
        COALESCE(SUM(CASE WHEN e.entity_type = 'customer' AND m.direction = 'inflow' AND m.movement_type = 'receivable'
          AND m.date < CURRENT_DATE THEN m.amount ELSE 0 END), 0)::numeric as total_overdue,
        COUNT(DISTINCT CASE WHEN (
          m.direction = 'inflow' AND m.movement_type = 'receivable'
        ) THEN e.id END)::int as at_risk_count
      FROM entities e
      LEFT JOIN movements m ON e.id = m.counterparty_entity_id AND m.user_id = $1
      WHERE e.user_id = $1`,
      [userId]
    ).then((r) => r.rows[0])

    // Fetch paginated entities with AR metrics
    const entitiesResult = await query<EntityRow>(
      `SELECT 
        e.id,
        e.entity_type,
        e.canonical_name,
        e.display_name,
        COUNT(m.id)::int as transaction_count,
        COALESCE(SUM(ABS(m.amount)), 0)::numeric as lifetime_value,
        COALESCE(SUM(CASE WHEN m.direction = 'inflow' AND m.movement_type = 'receivable' 
          THEN m.amount ELSE 0 END), 0)::numeric as ar_balance,
        COALESCE(SUM(CASE WHEN m.direction = 'inflow' AND m.movement_type = 'receivable'
          AND m.date < CURRENT_DATE THEN m.amount ELSE 0 END), 0)::numeric as overdue_balance,
        MAX(m.date)::text as last_transaction_date,
        e.metadata
      FROM entities e
      LEFT JOIN movements m ON e.id = m.counterparty_entity_id AND m.user_id = $1
      WHERE ${whereClause}
      GROUP BY e.id, e.entity_type, e.canonical_name, e.display_name, e.metadata
      ORDER BY ${
        sortBy === "reliability"
          ? "COALESCE((e.metadata->>'reliability_score')::numeric, 0) DESC"
          : sortBy === "txn_count"
            ? "transaction_count DESC"
            : "lifetime_value DESC"
      }
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    ).then((r) => r.rows)

    // Fetch entity_payment_profiles for fallback data
    const paymentProfilesResult = await query<{
      entity_id: string
      avg_days_to_pay: number | null
      std_days_to_pay: number | null
      on_time_payment_rate: number | null
      early_payment_rate: number | null
    }>(
      `SELECT 
        entity_id::text,
        avg_days_to_pay,
        std_days_to_pay,
        on_time_payment_rate,
        early_payment_rate
      FROM entity_payment_profiles
      WHERE user_id = $1`,
      [userId]
    ).then((r) => r.rows)

    // Fetch total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(DISTINCT e.id)::text FROM entities e
       WHERE ${whereClause}`,
      params
    ).then((r) => r.rows[0])

    const total = countResult ? parseInt(countResult.count, 10) : 0
    const totalPages = Math.ceil(total / limit)

    // Classify archetypes and calculate reliability scores
    const enrichedEntities = await Promise.all(
      entitiesResult.map(async (e) => {
        const metadata = (e.metadata || {}) as Record<string, unknown>
        const reliabilityScore = Math.round((metadata.reliability_score as number) || 80)
        let archetype = "New"

        if (e.transaction_count >= 3) {
          if (reliabilityScore >= 80) {
            archetype = "Clockwork"
          } else if (reliabilityScore >= 60) {
            archetype = "Bursty"
          } else {
            archetype = "Volatile"
          }
        }

        // Calculate enriched payment and risk data
        let enrichedData: Partial<EnrichedEntityData> = {}
        try {
          enrichedData = await calculateEnrichedEntityData(e.id, userId)
        } catch (err) {
          console.error(`[entity-profiles] Error enriching entity ${e.id}:`, err)
        }

        // Check for pre-computed payment profile data
        const paymentProfile = paymentProfilesResult.find(p => p.entity_id === e.id)
        const hasPaymentProfile = paymentProfile && paymentProfile.avg_days_to_pay !== null

        // Use pre-computed data if available, otherwise use calculated data
        const avgDaysToPay = hasPaymentProfile ? paymentProfile.avg_days_to_pay : enrichedData.avg_days_to_pay || 0
        const stdDaysToPay = hasPaymentProfile ? paymentProfile.std_days_to_pay : enrichedData.std_days_to_pay || 0
        const onTimeRate = hasPaymentProfile ? paymentProfile.on_time_payment_rate : enrichedData.on_time_payment_rate || 0
        const earlyRate = hasPaymentProfile ? paymentProfile.early_payment_rate : enrichedData.early_payment_rate || 0

        return {
          id: e.id,
          entity_type: e.entity_type,
          canonical_name: e.canonical_name,
          display_name: e.display_name,
          transaction_count: e.transaction_count,
          lifetime_value: parseFloat(String(e.lifetime_value)),
          ar_balance: parseFloat(String(e.ar_balance)),
          overdue_balance: parseFloat(String(e.overdue_balance)),
          reliability_score: reliabilityScore,
          archetype,
          last_transaction_date: e.last_transaction_date,
          ai_insight: (metadata.ai_insight as string) || null,
          // Enriched payment behavior data
          avg_days_to_pay: avgDaysToPay,
          std_days_to_pay: stdDaysToPay,
          on_time_payment_rate: onTimeRate,
          early_payment_rate: earlyRate,
          payment_count: enrichedData.payment_count || 0,
          avg_payment_amount: enrichedData.avg_payment_amount || 0,
          std_transaction_amount: enrichedData.std_transaction_amount || 0,
          // Trends
          amount_trend: enrichedData.amount_trend || "stable",
          transactions_per_month: enrichedData.transactions_per_month || 0,
          avg_interval_days: enrichedData.avg_interval_days || 0,
          interval_cv: enrichedData.interval_cv || 0,
          // Seasonality
          peak_months: enrichedData.peak_months || [],
          low_months: enrichedData.low_months || [],
          // Risk
          risk_score: enrichedData.risk_score || 0,
          risk_factors: enrichedData.risk_factors || [],
          // Forecast
          forecast_uncertainty: enrichedData.forecast_uncertainty || "medium",
          forecast_notes: enrichedData.forecast_notes || "",
        }
      })
    )

    // Apply at_risk filter if requested
    let filtered = enrichedEntities
    if (atRisk) {
      filtered = enrichedEntities.filter((e) => e.ar_balance > 0 || e.overdue_balance > 0)
    }

    // Apply archetype filter if requested
    if (archetype) {
      filtered = filtered.filter((e) => e.archetype === archetype)
    }

    const summary = summaryResult || {
      total_customers: 0,
      total_vendors: 0,
      total_lifetime_value: 0,
      total_ar_outstanding: 0,
      total_overdue: 0,
      at_risk_count: 0,
    }

    return NextResponse.json({
      summary,
      customers: filtered,
      pagination: {
        page,
        limit,
        total,
        total_pages: totalPages,
      },
    })
  } catch (error) {
    console.error("[entity-profiles] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch entity profiles" },
      { status: 500 }
    )
  }
}

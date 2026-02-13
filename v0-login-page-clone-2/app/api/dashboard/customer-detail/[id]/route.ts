import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/require-session"
import { query } from "@/lib/db"
import { calculateEnrichedEntityData } from "@/lib/entity-calculations"
import { searchEntityProfileContext } from "@/lib/supermemory"

// Customer detail endpoint - fetches complete customer profile with transactions and Supermemory context
type EntityType = "customer" | "vendor"

interface CustomerDetailResponse {
  customer: {
    id: string
    canonical_name: string
    display_name: string | null
    entity_type: EntityType
    transaction_count: number
    lifetime_value: number
    ar_balance: number
    overdue_balance: number
    reliability_score: number
    archetype: string
    last_transaction_date: string | null
    metadata: Record<string, unknown> | null
    // Enriched data
    avg_days_to_pay: number
    std_days_to_pay: number
    on_time_payment_rate: number
    early_payment_rate: number
    payment_count: number
    avg_payment_amount: number
    std_transaction_amount: number
    amount_trend: "increasing" | "decreasing" | "stable"
    transactions_per_month: number
    avg_interval_days: number
    interval_cv: number
    peak_months: number[]
    low_months: number[]
    risk_score: number
    risk_factors: string[]
    forecast_uncertainty: "low" | "medium" | "high"
    forecast_notes: string
  }
  recentTransactions: Array<{
    id: string
    date: string
    amount: number
    description: string | null
    days_to_pay: number | null
    status: string
  }>
  supermemoryContext: {
    contractTerms: string | null
    relationshipNotes: string | null
    paymentTerms: string | null
    rawContext: string
  }
  supermemoryDocuments: Array<{
    id: string
    title: string
    snippet: string
    relevanceScore: number
    source: string
  }>
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }


    const userId = session.id
    const entityId = params.id

    // Fetch entity profile
    const entityResult = await query<{
      id: string
      canonical_name: string
      display_name: string | null
      entity_type: string
      metadata: Record<string, unknown> | null
    }>(
      `SELECT id, canonical_name, display_name, entity_type, metadata
       FROM entities
       WHERE id = $1::uuid AND user_id = $2`,
      [entityId, userId]
    )

    if (entityResult.rows.length === 0) {
      return NextResponse.json({ error: "Entity not found" }, { status: 404 })
    }

    const entity = entityResult.rows[0]
    const entityType = (entity.entity_type as EntityType) || "customer"

    // Fetch payment profile with all enriched data
    const profileResult = await query<{
      transaction_count: number
      lifetime_value: number | string
      outstanding_amount: number | string
      overdue_amount: number | string
      reliability_score: number | null
      archetype: string | null
      avg_days_to_pay: number | null
      std_days_to_pay: number | null
      on_time_payment_rate: number | null
      early_payment_rate: number | null
      avg_payment_amount: number | string | null
      std_transaction_amount: number | string | null
      amount_trend: string | null
      transactions_per_month: number | null
      avg_interval_days: number | null
      interval_cv: number | null
      peak_months: number[] | null
      low_months: number[] | null
      risk_score: number | null
      risk_factors: string[] | null
      forecast_uncertainty: string | null
      forecast_notes: string | null
    }>(
      `SELECT 
        transaction_count,
        lifetime_value,
        outstanding_amount,
        overdue_amount,
        reliability_score,
        archetype,
        avg_days_to_pay,
        std_days_to_pay,
        on_time_payment_rate,
        early_payment_rate,
        avg_payment_amount,
        std_transaction_amount,
        amount_trend,
        transactions_per_month,
        avg_interval_days,
        interval_cv,
        peak_months,
        low_months,
        risk_score,
        risk_factors,
        forecast_uncertainty,
        forecast_notes
       FROM entity_payment_profiles
       WHERE entity_id = $1::uuid AND user_id = $2`,
      [entityId, userId]
    )

    const profile = profileResult.rows[0] || {}

    // Fetch recent transactions
    const transactionsResult = await query<{
      id: string
      date: string
      amount: number
      raw_description: string | null
      days_to_pay: number | null
    }>(
      `SELECT 
        m.id,
        m.date::text,
        ABS(m.amount)::numeric as amount,
        m.raw_description,
        NULL::int as days_to_pay
       FROM movements m
       WHERE m.counterparty_entity_id = $1::uuid 
         AND m.user_id = $2
       ORDER BY m.date DESC
       LIMIT 20`,
      [entityId, userId]
    )

    const recentTransactions = transactionsResult.rows.map((t) => ({
      id: t.id,
      date: t.date,
      amount: typeof t.amount === "string" ? parseFloat(t.amount) : t.amount,
      description: t.raw_description,
      days_to_pay: t.days_to_pay,
      status: "completed",
    }))

    // Fetch Supermemory context
    let supermemoryContext = {
      contractTerms: null,
      relationshipNotes: null,
      paymentTerms: null,
      rawContext: "",
    }

    try {
      const smContext = await searchEntityProfileContext(
        userId,
        entity.canonical_name,
        entityType
      )
      if (smContext) {
        supermemoryContext = {
          contractTerms: smContext.contractTerms,
          relationshipNotes: smContext.relationshipNotes,
          paymentTerms: extractPaymentTerms(smContext.rawContext),
          rawContext: smContext.rawContext,
        }
      }
    } catch (err) {
      console.warn(
        `[customer-detail] Supermemory context fetch failed for ${entity.canonical_name}:`,
        err
      )
    }

    // For now, return empty supermemory documents (will be populated by search endpoint)
    const supermemoryDocuments: Array<{
      id: string
      title: string
      snippet: string
      relevanceScore: number
      source: string
    }> = []

    const response: CustomerDetailResponse = {
      customer: {
        id: entity.id,
        canonical_name: entity.canonical_name,
        display_name: entity.display_name,
        entity_type: entityType,
        transaction_count: profile.transaction_count || 0,
        lifetime_value: typeof profile.lifetime_value === "string"
          ? parseFloat(profile.lifetime_value)
          : profile.lifetime_value || 0,
        ar_balance: typeof profile.outstanding_amount === "string"
          ? parseFloat(profile.outstanding_amount)
          : profile.outstanding_amount || 0,
        overdue_balance: typeof profile.overdue_amount === "string"
          ? parseFloat(profile.overdue_amount)
          : profile.overdue_amount || 0,
        reliability_score: profile.reliability_score || 80,
        archetype: profile.archetype || "New",
        last_transaction_date: null,
        metadata: entity.metadata,
        avg_days_to_pay: profile.avg_days_to_pay || 0,
        std_days_to_pay: profile.std_days_to_pay || 0,
        on_time_payment_rate: profile.on_time_payment_rate || 0,
        early_payment_rate: profile.early_payment_rate || 0,
        payment_count: profile.transaction_count || 0,
        avg_payment_amount: typeof profile.avg_payment_amount === "string"
          ? parseFloat(profile.avg_payment_amount)
          : profile.avg_payment_amount || 0,
        std_transaction_amount: typeof profile.std_transaction_amount === "string"
          ? parseFloat(profile.std_transaction_amount)
          : profile.std_transaction_amount || 0,
        amount_trend: (profile.amount_trend as "increasing" | "decreasing" | "stable") || "stable",
        transactions_per_month: profile.transactions_per_month || 0,
        avg_interval_days: profile.avg_interval_days || 0,
        interval_cv: profile.interval_cv || 0,
        peak_months: profile.peak_months || [],
        low_months: profile.low_months || [],
        risk_score: profile.risk_score || 0,
        risk_factors: profile.risk_factors || [],
        forecast_uncertainty: (profile.forecast_uncertainty as "low" | "medium" | "high") || "medium",
        forecast_notes: profile.forecast_notes || "",
      },
      recentTransactions,
      supermemoryContext,
      supermemoryDocuments,
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error("[customer-detail] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch customer details" },
      { status: 500 }
    )
  }
}

function extractPaymentTerms(context: string): string | null {
  if (!context) return null

  const patterns = [
    /Net\s+(\d+)/gi,
    /(\d+)\s+days?/gi,
    /payment\s+terms?:?\s*([^.\n]+)/gi,
    /due\s+(?:within|in)\s+(\d+)\s+days?/gi,
  ]

  for (const pattern of patterns) {
    const match = context.match(pattern)
    if (match) {
      return match[0]
    }
  }

  return null
}

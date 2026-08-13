import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { getEntityProfile, aggregateEntityTransactions } from "@/lib/entity-profiles"
import { generateEntityNarratives, updateEntityNarratives } from "@/lib/entity-profile-ai"
import { validateUUID, createErrorResponse } from "@/lib/api-utils"
import { log } from "@/lib/logger"
import type { EntityTransaction, EntityNarratives, ForecastFeatures, EntityArchetype } from "@/lib/state/types"

async function getUser() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  return getUserBySessionToken(sessionToken ?? "")
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getUser()
  if (!user) {
    return NextResponse.json(createErrorResponse("Unauthorized"), { status: 401 })
  }
  const userId = user.id

  const { id: entityId } = await params
  
  // Validate UUID format
  if (!validateUUID(entityId)) {
    log("entities.get.invalid_uuid", { userId, entityId })
    return NextResponse.json(createErrorResponse("Invalid entity ID format"), { status: 400 })
  }

  const { searchParams } = new URL(request.url)
  const includeTransactions = searchParams.get("transactions") !== "false"
  const refreshNarratives = searchParams.get("refresh_narratives") === "true"

  try {
    // Get entity details
    const entityResult = await query<{
      id: string
      canonical_name: string
      display_name: string | null
      entity_type: string
      domain: string | null
    }>(
      `SELECT id, canonical_name, display_name, entity_type, domain 
       FROM entities WHERE id = $1::uuid AND user_id = $2::uuid`,
      [entityId, userId]
    )

    if (entityResult.rows.length === 0) {
      return NextResponse.json(createErrorResponse("Entity not found"), { status: 404 })
    }

    const entity = entityResult.rows[0]

    // Get profile
    const profile = await getEntityProfile(userId, entityId)
    if (!profile) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 })
    }

    // Get transactions if requested
    let transactions: EntityTransaction[] = []
    if (includeTransactions) {
      transactions = await aggregateEntityTransactions(userId, entityId)
    }

    // Build narratives
    let narratives: EntityNarratives | null = null
    if (profile.ai_summary) {
      narratives = {
        ai_summary: profile.ai_summary,
        ai_forecast_notes: profile.ai_forecast_notes || "",
        ai_risk_explanation: profile.ai_risk_explanation || "",
      }
    }

    // Optionally refresh narratives
    if (refreshNarratives || (!narratives && transactions.length > 0)) {
      try {
        const newNarratives = await generateEntityNarratives({
          name: entity.canonical_name,
          entityType: (profile.entity_type as "customer" | "vendor") || "customer",
          archetype: (profile.archetype as EntityArchetype) || "low_data",
          metrics: {
            transaction_count: profile.transaction_count || 0,
            avg_days_to_pay: profile.avg_days_to_pay,
            std_days_to_pay: profile.std_days_to_pay,
            on_time_payment_rate: profile.on_time_payment_rate,
            early_payment_rate: profile.early_payment_rate,
            avg_days_early_late: profile.avg_days_early_late,
            avg_transaction_amount: profile.avg_payment_amount || 0,
            std_transaction_amount: profile.std_transaction_amount,
            largest_transaction: profile.largest_transaction || 0,
            smallest_transaction: profile.smallest_transaction || 0,
            amount_trend: profile.amount_trend || "stable",
            avg_interval_days: profile.avg_interval_days,
            interval_cv: profile.interval_cv,
            transactions_per_month: profile.transactions_per_month || 0,
          },
          risk: {
            risk_score: profile.risk_score || 0.2,
            risk_factors: profile.risk_factors || [],
            recent_trend: profile.recent_trend || "stable",
          },
          seasonality: {
            peak_months: profile.peak_months || [],
            low_months: profile.low_months || [],
            month_weights: profile.month_weights || new Array(12).fill(1),
          },
          lifetimeValue: profile.lifetime_value || 0,
          outstandingAmount: profile.outstanding_amount || 0,
          overdueAmount: profile.overdue_amount || 0,
          recentTransactions: transactions.slice(0, 10),
        })

        await updateEntityNarratives(userId, entityId, newNarratives)
        narratives = newNarratives
      } catch (e) {
        console.warn("[api/entities/[id]] Failed to generate narratives:", e)
      }
    }

    // Build forecast features
    const forecastFeatures: ForecastFeatures | null = profile.archetype
      ? {
          archetype: profile.archetype as EntityArchetype,
          avg_days_to_pay: profile.avg_days_to_pay || 0,
          std_days_to_pay: profile.std_days_to_pay || 0,
          interval_cv: profile.interval_cv || 1,
          recent_trend: profile.recent_trend === "improving"
            ? "accelerating"
            : profile.recent_trend === "deteriorating"
            ? "decelerating"
            : "stable",
          reliability_score: profile.reliability_score || 0.5,
          on_time_rate: profile.on_time_payment_rate || 0.5,
          amount_mean: profile.avg_payment_amount || 0,
          amount_std: profile.std_transaction_amount || 0,
          amount_trend: profile.amount_trend || "stable",
          month_weights: profile.month_weights || new Array(12).fill(1),
          peak_months: profile.peak_months || [],
        }
      : null

    return NextResponse.json({
      entity,
      profile,
      narratives,
      transactions: transactions.slice(0, 50),
      forecast_features: forecastFeatures,
    })
  } catch (error) {
    console.error("[api/entities/[id]] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch entity" },
      { status: 500 }
    )
  }
}

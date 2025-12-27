import { NextResponse, NextRequest } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"
import { log } from "@/lib/logger"
import { fetchInvoicesForReconciliation } from "@/lib/invoices-fetch"
import { fetchBillsForReconciliation } from "@/lib/bills-fetch"
import { syncCashEventsForUser, fetchCashEventsForUser30d, cashEventRowsToForecastEvents } from "@/lib/cash-events-build"
import { computeCashflowForecast, seedPrng, resetPrng, setIdentityContext, blendReconciledModels, type IdentityContext } from "@/lib/state/forecast-engine"
import { generateNarrativeWithLLM } from "@/lib/forecast-llm"
import { getAccountsWithBalancesByUserId } from "@/lib/plaid-persistence"
import { getAllEntityProfiles, buildEntityProfiles } from "@/lib/entity-profiles"
import { toMovementClass, computeStatePolicy, computeStateScope } from "@/lib/movement-types"
import { getForecastCalibrationForUser } from "@/lib/forecast-calibration-load"
import { DEFAULT_FORECAST_CALIBRATION, mergeCalibration } from "@/lib/state/forecast-calibration"
import type { ForecastCalibrationParams } from "@/lib/state/forecast-calibration"
import type { CanonicalMovement, MovementTag, ReviewReason } from "@/lib/movement-types"
import type { OutstandingInvoice, OutstandingBill, ForecastContext, CashflowForecast } from "@/lib/state/types"
import { fetchReconciledARMovements, fetchReconciledAPMovements, buildReconciledCustomerModels, buildReconciledVendorModels } from "@/lib/reconciled-models"
import { calculateARSettlementTiming, calculateAPSettlementTiming, getSettlementTimingConfidence } from "@/lib/settlement-timing"
import { rateLimiters, getRateLimitHeaders } from "@/lib/rate-limiter"
import { withTimeout } from "@/lib/api-utils"
import { PerformanceTracker } from "@/lib/performance-logger"
import { ensureForecastStatusSchema } from "@/lib/forecast-status-schema"
import {
  enrichInterventionsWithReasoning,
  rerankStrategiesWithAI,
  generateExecutionPlans,
  detectInterventionAnomalies,
} from "@/lib/decision-llm"
import { inferFounderProfile } from "@/lib/founder-profile"

type TagRow = {
  movement_id: string
  economic_class: string
  cashflow_bucket: string
  counterparty_role: string
  tag_data: Record<string, unknown>
}

type TaggedMovement = CanonicalMovement & { tag: MovementTag }

async function getUser() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  return getUserBySessionToken(sessionToken ?? "")
}

async function fetchTaggedMovements(userId: string): Promise<TaggedMovement[]> {
    await ensureMovementsSchema()

  type PlaidAcct = { account_id: string; name: string; type: string; subtype: string }
    const acctByName = new Map<string, PlaidAcct>()
    try {
      const acctRows = await query<PlaidAcct>(
      `SELECT pa.account_id, pa.name, pa.type, pa.subtype
       FROM plaid_accounts pa
       JOIN plaid_items pi ON pa.item_id = pi.item_id
         WHERE pi.user_id = $1`,
      [userId]
      ).then((r) => r.rows)
      for (const a of acctRows) {
        if (a.name) acctByName.set(a.name, a)
        acctByName.set(a.account_id, a)
      }
    } catch { /* plaid_accounts may not exist yet */ }

    const movementRows = await query<CanonicalMovement & { movement_type: string }>(
      `SELECT m.id, m.user_id, m.date AS occurred_at, m.direction, m.amount::float,
              m.currency, m.raw_description, m.movement_type,
              m.counterparty_entity_id AS entity_id,
              COALESCE(NULLIF(TRIM(m.cash_account_id), ''),
                (SELECT mo.account_name FROM movement_observations mo WHERE mo.movement_id = m.id AND mo.account_name IS NOT NULL AND TRIM(mo.account_name) != '' LIMIT 1)
              ) AS account_id,
              m.pnl_eligible, m.confidence, m.review_needed AS needs_review,
              m.provenance, m.coalesced_group_id, m.metadata
       FROM movements m WHERE m.user_id = $1 AND m.duplicate_of IS NULL
       ORDER BY m.date ASC`,
    [userId]
    ).then((r) => r.rows.map((row) => {
      const conf = (row.confidence as unknown as Record<string, number>) ?? {}
      const md = (row.metadata ?? {}) as Record<string, unknown>
      const acctName = row.account_id ?? null
      const acctInfo = acctByName.get(acctName ?? "")
      // Ensure occurred_at is a string (ISO format)
      const occurred_at = row.occurred_at instanceof Date 
        ? row.occurred_at.toISOString() 
        : typeof row.occurred_at === "string" 
          ? row.occurred_at 
          : new Date().toISOString()
      return {
        ...row,
        occurred_at,
        amount: typeof row.amount === "string" ? parseFloat(row.amount) : row.amount,
        movement_class: toMovementClass(row.movement_type ?? "unknown"),
        movement_type_detail: row.movement_type ?? "unknown",
        source_record_ids: [],
        confidence: conf.score ?? 0,
        evidence_strength: conf.evidence_strength ?? 0,
        review_reasons: (Array.isArray(md.review_reasons) ? md.review_reasons : []) as ReviewReason[],
        metadata: {
          ...md,
          cash_account_name: acctName,
          account_type: acctInfo?.type ?? md.account_type ?? "",
          account_subtype: acctInfo?.subtype ?? md.account_subtype ?? null,
        },
      } as CanonicalMovement
    }))

    const tagRows = await query<TagRow>(
      `SELECT movement_id, economic_class, cashflow_bucket, counterparty_role, tag_data
     FROM movement_tags WHERE movement_id IN (SELECT id FROM movements WHERE user_id = $1 AND duplicate_of IS NULL)`,
    [userId]
    ).then((r) => r.rows)

    const tagMap = new Map<string, TagRow>()
    for (const t of tagRows) tagMap.set(t.movement_id, t)

    const tagged: TaggedMovement[] = []
    for (const m of movementRows) {
      const tr = tagMap.get(m.id)
      // Include movements even if they don't have tags yet
      // (they may still be useful for movement-based analysis)
      
      const td = tr?.tag_data ?? {}
      const tag: MovementTag = {
        movement_id: m.id,
        economic_class: (tr?.economic_class as MovementTag["economic_class"]) ?? "unknown",
        cashflow_bucket: (tr?.cashflow_bucket as MovementTag["cashflow_bucket"]) ?? "unknown",
        counterparty_role: (tr?.counterparty_role as MovementTag["counterparty_role"]) ?? "unknown",
        is_operating: (td.is_operating as boolean) ?? false,
        is_financing: (td.is_financing as boolean) ?? false,
        is_investing: (td.is_investing as boolean) ?? false,
        is_owner_related: (td.is_owner_related as boolean) ?? false,
        hits_pnl: (td.hits_pnl as boolean) ?? false,
        hits_working_capital: (td.hits_working_capital as boolean) ?? false,
        state_scope: (td.state_scope as MovementTag["state_scope"]) ?? computeStateScope(
          (tr?.economic_class as MovementTag["economic_class"]) ?? "unknown",
          (tr?.cashflow_bucket as MovementTag["cashflow_bucket"]) ?? "unknown",
          (td.hits_working_capital as boolean) ?? false,
        ),
        state_inclusion_policy: (td.state_inclusion_policy as MovementTag["state_inclusion_policy"]) ?? computeStatePolicy(m.confidence, m.evidence_strength, m.needs_review, tr?.economic_class ?? "unknown"),
        policy_status: (td.policy_status as MovementTag["policy_status"]) ?? "include",
        classification_confidence: m.confidence,
        evidence_strength: m.evidence_strength,
        needs_review: m.needs_review,
        review_reasons: m.review_reasons,
        entity_id: m.entity_id,
        customer_id: (td.customer_id as string) ?? null,
        vendor_id: (td.vendor_id as string) ?? null,
        processor_id: (td.processor_id as string) ?? null,
        account_id: m.account_id,
        order_id: (td.order_id as string) ?? null,
        invoice_id: (td.invoice_id as string) ?? null,
        bill_id: (td.bill_id as string) ?? null,
        recurrence_family_id: (td.recurrence_family_id as string) ?? null,
        is_recurring: (td.is_recurring as boolean) ?? false,
        is_anomaly: (td.is_anomaly as boolean) ?? false,
        is_large_outlier: (td.is_large_outlier as boolean) ?? false,
        is_first_seen_counterparty: (td.is_first_seen_counterparty as boolean) ?? false,
        display_name: (td.display_name as string) ?? null,
      }

      tagged.push({ ...m, tag })
    }

  return tagged
}

async function enrichMovementsWithAttributionTimestamps(userId: string, movements: TaggedMovement[]): Promise<TaggedMovement[]> {
  try {
    await ensureMovementsSchema()
    
    // Fetch all attributions for this user's movements
    // Use created_at as the attribution timestamp (when the attribution was created/reconciled)
    const attributions = await query<{ movement_id: string; created_at: string }>(
      `SELECT movement_id, created_at
       FROM movement_attributions
       WHERE user_id = $1 AND component_type IN ('settlement', 'fee')
       ORDER BY movement_id, created_at DESC`,
      [userId]
    ).then((r) => r.rows)
    
    // Build a map of movement_id -> earliest created_at (first attribution)
    const attrMap = new Map<string, string>()
    for (const attr of attributions) {
      if (!attrMap.has(attr.movement_id)) {
        attrMap.set(attr.movement_id, attr.created_at)
      }
    }
    
    // Enrich movements with attribution timestamps
    return movements.map((m) => {
      const attrTs = attrMap.get(m.id)
      if (attrTs) {
        return {
          ...m,
          metadata: {
            ...m.metadata,
            reconcile_at: attrTs,
          },
        }
      }
      return m
    })
  } catch (err) {
    log("forecast.enrich_attributions.error", { error: err instanceof Error ? err.message : String(err) }, "forecast")
    return movements // Return unchanged if enrichment fails
  }
}

async function buildIdentityContext(userId: string): Promise<IdentityContext> {
  const entityNames = new Map<string, string>()
  const entityTypes = new Map<string, string>()
  const aliasToEntityId = new Map<string, string>()
  const counterpartyByMovement = new Map<string, string>()
  const familyMembers = new Map<string, { occurrences: number; dominantType: string; pattern: string }>()

  try {
    type EntityRow = { id: string; canonical_name: string; display_name: string | null; entity_type: string | null }
    const entityRows = await query<EntityRow>(
      `SELECT id::text, canonical_name, display_name, entity_type FROM entities WHERE user_id = $1`,
      [userId]
    ).then((r) => r.rows)
    for (const e of entityRows) {
      const name = (e.display_name && e.display_name.trim()) ? e.display_name.trim() : e.canonical_name
      entityNames.set(e.id, name)
      if (e.entity_type) entityTypes.set(e.id, e.entity_type)
    }

    type AliasRow = { entity_id: string; alias: string }
    const aliasRows = await query<AliasRow>(
      `SELECT entity_id::text, alias FROM entity_aliases WHERE entity_id IN (SELECT id FROM entities WHERE user_id = $1)`,
      [userId]
      ).then((r) => r.rows)
      for (const a of aliasRows) {
      aliasToEntityId.set(a.alias.toLowerCase(), a.entity_id)
    }
  } catch { /* entities table may not exist yet */ }

  return { entityNames, entityTypes, aliasToEntityId, counterpartyByMovement, familyMembers }
}

function plaidAccountBalance(a: { current_balance: number | null; available_balance: number | null }): number {
  const c = a.current_balance
  const av = a.available_balance
  const best = Math.max(
    c != null && !Number.isNaN(c) ? c : -Infinity,
    av != null && !Number.isNaN(av) ? av : -Infinity,
  )
  return Number.isFinite(best) ? best : 0
}

async function getStartingCash(userId: string): Promise<{ cash: number; source: "plaid" | "derived" }> {
  const accounts = await getAccountsWithBalancesByUserId(userId)
  if (accounts.length > 0) {
    const cashAccounts = accounts.filter((a) => 
      a.type === "depository" || a.subtype === "checking" || a.subtype === "savings"
    )
    const totalCash = cashAccounts.reduce((sum, a) => sum + plaidAccountBalance(a), 0)
    if (totalCash > 0) {
      return { cash: totalCash, source: "plaid" }
    }
  }
  
  // Fallback: derive starting cash from movement history
  // Sum all inflows minus outflows to get approximate current position
  try {
    const { rows } = await query<{ net_cash: string }>(
      `SELECT COALESCE(
        SUM(CASE WHEN direction = 'inflow' THEN amount ELSE -amount END),
        0
      )::float AS net_cash
       FROM movements
       WHERE user_id = $1 AND duplicate_of IS NULL`,
      [userId]
    )
    const netCash = parseFloat(rows[0]?.net_cash ?? "0")
    if (!isNaN(netCash) && netCash > 0) {
      return { cash: netCash, source: "derived" }
    }
  } catch {
    // Query failed, return 0
  }
  
  return { cash: 0, source: "derived" }
}

type CachedForecast = {
  forecast_data: CashflowForecast & { starting_cash: number; balance_source: string }
  computed_at: string
  expires_at: string
  movement_count: number
  invoice_count: number
  bill_count: number
  starting_cash: number
}

async function getCachedForecast(userId: string): Promise<CachedForecast | null> {
  try {
    const { rows } = await query<{
      forecast_data: CashflowForecast & { starting_cash: number; balance_source: string }
      computed_at: string
      expires_at: string
      movement_count: number
      invoice_count: number
      bill_count: number
      starting_cash: string
    }>(
      `SELECT forecast_data, computed_at::text, expires_at::text, movement_count, invoice_count, bill_count, starting_cash::float
       FROM forecast_cache
       WHERE user_id = $1 AND expires_at > NOW()`,
      [userId]
    )
    if (rows.length === 0) return null
    const row = rows[0]
    return {
      ...row,
      starting_cash: parseFloat(String(row.starting_cash)),
    }
  } catch {
    return null
  }
}

async function setCachedForecast(
  userId: string,
  forecast: CashflowForecast & { starting_cash: number; balance_source: string },
  movementCount: number,
  invoiceCount: number,
  billCount: number,
  startingCash: number,
  cacheTtlMinutes: number = DEFAULT_FORECAST_CALIBRATION.route_config.cache_ttl_minutes,
): Promise<void> {
  const expiresAt = new Date(Date.now() + cacheTtlMinutes * 60 * 1000).toISOString()
  try {
    await query(
      `INSERT INTO forecast_cache (user_id, forecast_data, computed_at, expires_at, movement_count, invoice_count, bill_count, starting_cash)
       VALUES ($1, $2, NOW(), $3::timestamptz, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         forecast_data = EXCLUDED.forecast_data,
         computed_at = NOW(),
         expires_at = EXCLUDED.expires_at,
         movement_count = EXCLUDED.movement_count,
         invoice_count = EXCLUDED.invoice_count,
         bill_count = EXCLUDED.bill_count,
         starting_cash = EXCLUDED.starting_cash`,
      [userId, JSON.stringify(forecast), expiresAt, movementCount, invoiceCount, billCount, startingCash]
    )
  } catch (e) {
    log("forecast.cache.write.error", { userId, error: String(e) }, "error")
  }
}

async function invalidateForecastCache(userId: string): Promise<void> {
  try {
    await query(`DELETE FROM forecast_cache WHERE user_id = $1`, [userId])
  } catch {
    // Non-fatal
  }
}

export async function GET(req?: NextRequest) {
  const tracker = new PerformanceTracker("forecast.compute")
  const clientIp = (req?.headers?.get('x-forwarded-for') || req?.headers?.get('x-real-ip') || 'unknown') as string
  const rateLimitCheck = rateLimiters.forecast.check({ ip: clientIp })
  
  if (!rateLimitCheck.allowed) {
    const status = rateLimiters.forecast.getStatus({ ip: clientIp })
    log("forecast.rate_limited", { ip: clientIp, operation: "forecast" })
    return NextResponse.json(
      { error: "Too many forecast requests. Please try again later." },
      {
        status: 429,
        headers: getRateLimitHeaders(status),
      }
    )
  }

  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Ensure status schema exists
    await ensureForecastStatusSchema()

    // Set status to computing
    await query(
      `INSERT INTO forecast_computation_status (user_id, status, llm_processing_complete, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET 
         status = $2, 
         llm_processing_complete = $3,
         updated_at = NOW()`,
      [user.id, "computing", false]
    ).catch((err) => {
      log("forecast.status.init.error", { error: String(err) })
    })

    // Check for cached forecast first
    const cached = await getCachedForecast(user.id)
    if (cached) {
      log("forecast.cache.hit", { userId: user.id, computedAt: cached.computed_at })
      
      // Update status to complete
      await query(
        `INSERT INTO forecast_computation_status (user_id, status, llm_processing_complete, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE SET 
           status = $2, 
           llm_processing_complete = $3,
           updated_at = NOW()`,
        [user.id, "complete", true]
      ).catch((err) => {
        log("forecast.status_update.error", { userId: user.id, error: err instanceof Error ? err.message : String(err) }, "forecast")
      })
      
      return NextResponse.json(cached.forecast_data)
    }

    log("forecast.compute.start", { userId: user.id }, "forecast")

    // Seed PRNG for reproducible Monte Carlo results within the same day
    seedPrng(user.id)

    // Fetch all required data in parallel with timeout protection
    const [
      taggedMovements,
      invoices,
      bills,
      identityCtx,
      startingCashResult,
      calibrationResult,
      reconciledARMovements,
      reconciledAPMovements,
      arSettlementTiming,
      apSettlementTiming,
      settlementTimingConfidence,
    ] = await withTimeout(Promise.all([
      fetchTaggedMovements(user.id),
      fetchInvoicesForReconciliation(user.id),
      fetchBillsForReconciliation(user.id),
      buildIdentityContext(user.id),
      getStartingCash(user.id),
      getForecastCalibrationForUser(user.id),
      fetchReconciledARMovements(user.id),
      fetchReconciledAPMovements(user.id),
      calculateARSettlementTiming(user.id),
      calculateAPSettlementTiming(user.id),
      getSettlementTimingConfidence(user.id),
    ]), 25000, "Data fetch timeout")

    // Enrich movements with attribution timestamps for settlement timing
    const enrichedMovements = await enrichMovementsWithAttributionTimestamps(user.id, taggedMovements)

    // Rebuild entity profiles if stale (per route_config) or missing
    const cal = calibrationResult.calibration
    const profileAge = await query<{ newest: string | null }>(
      `SELECT MAX(last_updated)::text as newest FROM entity_payment_profiles WHERE user_id = $1::uuid`,
        [user.id]
    )
    const newest = profileAge.rows[0]?.newest
    const isStale = !newest || (Date.now() - new Date(newest).getTime()) > cal.route_config.profile_stale_ms
    if (isStale) {
      log("forecast.profiles.rebuild", { userId: user.id, reason: newest ? "stale" : "missing" }, "forecast")
      await buildEntityProfiles(user.id)
    }
    const entityProfiles = await getAllEntityProfiles(user.id)

    // Sync cash events bridge (AR/AP to forecast events)
    const today = new Date().toISOString().slice(0, 10)
    const apObligations = bills.map((b) => ({
      obligation_id: `ap://bill/${b.source}/${b.bill_id}`,
      source: "bill" as const,
      vendor_name: b.vendor_name,
      entity_id: b.entity_id ?? null,
      expected_amount: b.amount_due,
      amount_due: b.amount_due,
      due_date: b.due_date ?? null,
      next_expected_date: b.due_date ?? today,
      days_until_due: b.days_until_due ?? 0,
      days_overdue: b.days_overdue ?? null,
      priority: (b.status === "overdue" ? "high" : "medium") as "high" | "medium" | "low",
      risk_flag: null,
      confidence: (b.due_date ? "high" : "medium") as "high" | "medium" | "low",
      cadence: "one-time",
      payment_count: 0,
      payment_terms: null,
      tolerance_days: null,
      bill_id: b.bill_id,
      metadata: {},
    }))
    await syncCashEventsForUser(user.id, invoices, apObligations)

    // Fetch bridge events for the next 30 days
    const cashEventRows = await fetchCashEventsForUser30d(user.id)
    const bridgeEvents = cashEventRowsToForecastEvents(cashEventRows, today)

    // Build forecast context
    const forecastCtx: ForecastContext = {
      risk_score: 0,
      risk_level: "low",
      top_customer_pct: 0,
      operating_dependency_ratio: 1,
      recurring_spend_ratio: 0,
      balance_source: startingCashResult.source,
      account_balances: [],
      transitions: [],
    }

    // Set identity context for entity resolution
    setIdentityContext(identityCtx)

    // Log settlement timing confidence
    log("forecast.settlement_timing", {
      ar_confidence: settlementTimingConfidence.ar_confidence,
      ap_confidence: settlementTimingConfidence.ap_confidence,
      overall_confidence: settlementTimingConfidence.overall_confidence,
      ar_count: settlementTimingConfidence.ar_count,
      ap_count: settlementTimingConfidence.ap_count,
    })

    // Compute the forecast
    const forecast = await computeCashflowForecast(
      enrichedMovements,
      startingCashResult.cash,
      cal.route_config.horizon_months,
      invoices,
      identityCtx,
      bills,
      forecastCtx,
      bridgeEvents,
      entityProfiles,
      cal,
      reconciledARMovements,
      reconciledAPMovements,
      arSettlementTiming,
      apSettlementTiming,
      settlementTimingConfidence,
      user.id,
    )

    // Update metadata with calibration source
    if (forecast.metadata) {
      forecast.metadata.calibration_source = calibrationResult.source
    }

    // Optionally enrich narrative with LLM
    let enrichedNarrative = forecast.narrative.forecast
    if (process.env.FORECAST_LLM_ENABLED) {
      try {
        enrichedNarrative = await generateNarrativeWithLLM(forecast.narrative, forecastCtx)
      } catch {
        // LLM enrichment failed, use deterministic narrative
      }
    }

    // Reset PRNG after computation
    resetPrng()

    let result = {
            ...forecast,
      narrative: {
        ...forecast.narrative,
        forecast: enrichedNarrative,
      },
      starting_cash: startingCashResult.cash,
      balance_source: startingCashResult.source,
    }

    // Try to retrieve enriched AI data if available
    try {
      const enrichedCacheKey = `forecast_enriched_${user.id}`
      const enrichedResult = await query(
        `SELECT forecast_data FROM forecast_cache WHERE user_id = $1 LIMIT 1`,
        [user.id]
      )
      if (enrichedResult.rows.length > 0) {
        const cachedForecast = enrichedResult.rows[0].forecast_data
        if (cachedForecast?.enriched_interventions) {
          result = {
            ...result,
            enriched_interventions: cachedForecast.enriched_interventions,
            ranked_strategies: cachedForecast.ranked_strategies,
            execution_plans: cachedForecast.execution_plans,
            intervention_anomalies: cachedForecast.intervention_anomalies,
          }
          log("forecast.enriched_data.merged", { userId: user.id })
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log("forecast.enriched_data.merge_error", { error: errorMsg })
    }

    // Trigger background AI enrichment if not already cached
    if (process.env.FORECAST_LLM_ENABLED) {
      (async () => {
        try {
          const existingCache = await query(
            `SELECT forecast_data FROM forecast_cache WHERE user_id = $1 LIMIT 1`,
            [user.id]
          )
          
          // Only run enrichment if not already cached with enriched data
          const hasEnrichedData = existingCache.rows.length > 0 && existingCache.rows[0].forecast_data?.enriched_interventions
          if (!hasEnrichedData) {
            const founderProfile = inferFounderProfile(forecastCtx)
            const enriched = await enrichInterventionsWithReasoning(forecast.interventions, forecast.behavioral_models, forecastCtx)
            const ranked = await rerankStrategiesWithAI(forecast.combined_strategies, forecast.interventions, forecast.behavioral_models, forecastCtx, founderProfile)
            const plans = await generateExecutionPlans(enriched, ranked, forecast.behavioral_models, forecastCtx)
            const anomalies = await detectInterventionAnomalies(enriched, ranked, forecast.behavioral_models)
            
            // Update cache with enriched data
            const enrichedForecast = {
              ...result,
              enriched_interventions: enriched,
              ranked_strategies: ranked,
              execution_plans: plans,
              intervention_anomalies: anomalies,
            }
            await query(
              `UPDATE forecast_cache SET forecast_data = $1 WHERE user_id = $2`,
              [JSON.stringify(enrichedForecast), user.id]
            )
            log("ai_decision_layer.enrichment_cached", { userId: user.id, enriched_count: enriched.length, ranked_count: ranked.length })
          }
        } catch (err) {
          log("ai_decision_layer.background_error", { error: err.message })
        }
      })()
    }

    // Cache the result for future requests
    await setCachedForecast(
      user.id,
      result,
      taggedMovements.length,
      invoices.length,
      bills.length,
      startingCashResult.cash,
      cal.route_config.cache_ttl_minutes,
    )

    log("forecast.compute.complete", { 
      userId: user.id, 
      eventsCount: forecast.events_30d.length,
      startingCash: startingCashResult.cash,
      balanceSource: startingCashResult.source,
      cached: true,
    }, "forecast")

    // Update status to complete with LLM processing done (fire and forget)
    query(
      `INSERT INTO forecast_computation_status (user_id, status, llm_processing_complete, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET 
         status = $2, 
         llm_processing_complete = $3,
         updated_at = NOW()`,
      [user.id, "complete", true]
    ).catch((err) => {
      log("forecast.status.update.error", { error: String(err) })
    })

    tracker.end({ userId: user.id, recordCount: forecast.events_30d.length })
    return NextResponse.json(result)
      } catch (err) {
    tracker.end({ userId: (await getUser())?.id, error: String(err) })
    log("forecast.compute.error", { error: String(err) }, "error")
    
    // Update status to error (fire and forget)
    try {
      const cookieStore = await cookies()
      const sessionToken = cookieStore.get(getSessionCookieName())?.value
      const user = await getUserBySessionToken(sessionToken ?? "")
      if (user) {
        query(
          `INSERT INTO forecast_computation_status (user_id, status, llm_processing_complete, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id) DO UPDATE SET 
             status = $2, 
             llm_processing_complete = $3,
             updated_at = NOW()`,
          [user.id, "error", false]
        ).catch((err) => {
          log("forecast.error_status_update.error", { userId: user.id, error: err instanceof Error ? err.message : String(err) }, "forecast")
        })
      }
    } catch {}

    return NextResponse.json(
      { error: "Failed to compute cashflow forecast" },
      { status: 500 }
    )
  }
}

export async function POST() {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Check if enriched AI data is available in cache
    const cacheResult = await query(
      `SELECT forecast_data FROM forecast_cache WHERE user_id = $1 LIMIT 1`,
      [user.id]
    )

    if (cacheResult.rows.length > 0) {
      const cachedForecast = cacheResult.rows[0].forecast_data
      if (cachedForecast?.enriched_interventions) {
        log("forecast.enriched_data.available", { userId: user.id })
        return NextResponse.json({
          ready: true,
          enriched_interventions: cachedForecast.enriched_interventions,
          ranked_strategies: cachedForecast.ranked_strategies,
          execution_plans: cachedForecast.execution_plans,
          intervention_anomalies: cachedForecast.intervention_anomalies,
        })
      }
    }

    return NextResponse.json({ ready: false })
  } catch (err) {
    log("forecast.enriched_data.check_error", { error: String(err) })
    return NextResponse.json({ ready: false, error: String(err) }, { status: 500 })
  }
}

// Export for use by other modules to invalidate cache when data changes
export { invalidateForecastCache }

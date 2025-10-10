/**
 * Unified financial brain run: attribution + cash_events + entity profiles.
 * Optional query: arApOnly, merchantOnly (same as reconciliation).
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"
import { runFinancialBrain } from "@/lib/financial-brain"
import { fetchOutstandingBills } from "@/lib/bills-fetch"
import { computeAPStateFromBills } from "@/lib/state/ar-ap"
import { fetchInvoicesForReconciliation } from "@/lib/invoices-fetch"

type BrainRequestOptions = {
  arApOnly: boolean
  merchantOnly: boolean
  syncCashEvents: boolean
  runWaterfall: boolean
  waterfallDryRun: boolean
  waterfallMinAiReviewAmount?: number
  runStage4Suggestions: boolean
  stage4BatchSize?: number
  runInBackground: boolean
}

async function parseBrainRequestOptions(req: Request): Promise<BrainRequestOptions> {
  let arApOnly = true
  let merchantOnly = false
  let syncCashEvents = true
  let runWaterfall = false
  let waterfallDryRun = false
  let waterfallMinAiReviewAmount: number | undefined
  let runStage4Suggestions = false
  let stage4BatchSize: number | undefined
  let runInBackground = false
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof body.arApOnly === "boolean") arApOnly = body.arApOnly
    if (typeof body.merchantOnly === "boolean") merchantOnly = body.merchantOnly
    if (typeof body.syncCashEvents === "boolean") syncCashEvents = body.syncCashEvents
    if (typeof body.runWaterfall === "boolean") runWaterfall = body.runWaterfall
    if (typeof body.waterfallDryRun === "boolean") waterfallDryRun = body.waterfallDryRun
    if (typeof body.waterfallMinAiReviewAmount === "number" && body.waterfallMinAiReviewAmount >= 0) {
      waterfallMinAiReviewAmount = body.waterfallMinAiReviewAmount
    }
    if (typeof body.runStage4Suggestions === "boolean") runStage4Suggestions = body.runStage4Suggestions
    if (typeof body.stage4BatchSize === "number" && body.stage4BatchSize > 0) stage4BatchSize = Math.floor(body.stage4BatchSize)
    if (typeof body.runInBackground === "boolean") runInBackground = body.runInBackground
  } catch {
    const { searchParams } = new URL(req.url)
    arApOnly = searchParams.get("arApOnly") !== "false"
    merchantOnly = searchParams.get("merchantOnly") === "true"
    runWaterfall = searchParams.get("runWaterfall") === "true"
    waterfallDryRun = searchParams.get("waterfallDryRun") === "true"
    const minAiRaw = searchParams.get("waterfallMinAiReviewAmount")
    if (minAiRaw != null) {
      const parsed = parseFloat(minAiRaw)
      if (!Number.isNaN(parsed) && parsed >= 0) waterfallMinAiReviewAmount = parsed
    }
    runStage4Suggestions = searchParams.get("runStage4Suggestions") === "true"
    const stage4BatchRaw = searchParams.get("stage4BatchSize")
    if (stage4BatchRaw != null) {
      const parsed = parseFloat(stage4BatchRaw)
      if (!Number.isNaN(parsed) && parsed > 0) stage4BatchSize = Math.floor(parsed)
    }
    runInBackground = searchParams.get("runInBackground") === "true"
  }
  return {
    arApOnly,
    merchantOnly,
    syncCashEvents,
    runWaterfall,
    waterfallDryRun,
    waterfallMinAiReviewAmount,
    runStage4Suggestions,
    stage4BatchSize,
    runInBackground,
  }
}

async function executeBrainRun(userId: string, opts: BrainRequestOptions) {
  let outstandingInvoices: import("@/lib/state/types").OutstandingInvoice[] | undefined
  let apObligations: import("@/lib/state/ar-ap").APObligation[] | undefined
  if (opts.syncCashEvents) {
    outstandingInvoices = await fetchInvoicesForReconciliation(userId)
    const bills = await fetchOutstandingBills(userId)
    apObligations = computeAPStateFromBills(bills)
  }
  return runFinancialBrain(userId, {
    arApOnly: opts.arApOnly,
    merchantOnly: opts.merchantOnly,
    ...(opts.syncCashEvents && outstandingInvoices && apObligations
      ? { outstandingInvoices, apObligations }
      : {}),
    runWaterfall: opts.runWaterfall,
    waterfallDryRun: opts.waterfallDryRun,
    ...(opts.waterfallMinAiReviewAmount != null ? { waterfallMinAiReviewAmount: opts.waterfallMinAiReviewAmount } : {}),
    runStage4Suggestions: opts.runStage4Suggestions,
    ...(opts.stage4BatchSize != null ? { stage4BatchSize: opts.stage4BatchSize } : {}),
  })
}

export async function GET(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    await ensureMovementsSchema()
    const { searchParams } = new URL(req.url)
    const arApOnly = searchParams.get("arApOnly") !== "false"
    const merchantOnly = searchParams.get("merchantOnly") === "true"
    const { rows } = await query<{ status: string; data: Record<string, unknown> | null; error_message: string | null; updated_at: string }>(
      `SELECT status, data, error_message, updated_at::text
       FROM reconciliation_cache
       WHERE user_id = $1 AND ar_ap_only = $2 AND merchant_only = $3
       LIMIT 1`,
      [user.id, arApOnly, merchantOnly],
    )
    const row = rows[0]
    if (!row) return NextResponse.json({ status: "idle", data: null })
    return NextResponse.json({
      status: row.status,
      data: row.data,
      error: row.error_message,
      updated_at: row.updated_at,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await ensureMovementsSchema()
  } catch {
    return NextResponse.json({ error: "Movements schema not available" }, { status: 500 })
  }

  const opts = await parseBrainRequestOptions(req)

  try {
    if (opts.runInBackground) {
      await query(
        `INSERT INTO reconciliation_cache (user_id, ar_ap_only, merchant_only, status, data, error_message, reconcile_at, updated_at)
         VALUES ($1,$2,$3,'processing',NULL,NULL,NOW(),NOW())
         ON CONFLICT (user_id, ar_ap_only, merchant_only)
         DO UPDATE SET status='processing', data=NULL, error_message=NULL, reconcile_at=NOW(), updated_at=NOW()`,
        [user.id, opts.arApOnly, opts.merchantOnly],
      )
      void executeBrainRun(user.id, opts)
        .then(async (result) => {
          const payload = {
            ok: true,
            cash_events_synced: result.cash_events_synced,
            entity_profiles_refreshed: result.entity_profiles_refreshed,
            allocation_count: result.attribution.allocationsRefreshed.length,
            ar_suggestions: result.attribution.arSuggestions.length,
            ap_suggestions: result.attribution.apSuggestions.length,
            waterfall: result.waterfall,
            stage4: result.stage4,
          }
          await query(
            `UPDATE reconciliation_cache
             SET status='ready', data=$4::jsonb, error_message=NULL, updated_at=NOW()
             WHERE user_id=$1 AND ar_ap_only=$2 AND merchant_only=$3`,
            [user.id, opts.arApOnly, opts.merchantOnly, JSON.stringify(payload)],
          )
        })
        .catch(async (e) => {
          const msg = e instanceof Error ? e.message : String(e)
          console.error("[brain][background] failed:", msg)
          await query(
            `UPDATE reconciliation_cache
             SET status='error', error_message=$4, updated_at=NOW()
             WHERE user_id=$1 AND ar_ap_only=$2 AND merchant_only=$3`,
            [user.id, opts.arApOnly, opts.merchantOnly, msg],
          )
        })
      return NextResponse.json({ ok: true, status: "processing", background: true }, { status: 202 })
    }

    const result = await executeBrainRun(user.id, opts)
    return NextResponse.json({
      ok: true,
      cash_events_synced: result.cash_events_synced,
      entity_profiles_refreshed: result.entity_profiles_refreshed,
      allocation_count: result.attribution.allocationsRefreshed.length,
      ar_suggestions: result.attribution.arSuggestions.length,
      ap_suggestions: result.attribution.apSuggestions.length,
      waterfall: result.waterfall,
      stage4: result.stage4,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[brain] failed:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/**
 * Unified financial brain run: attribution + cash_events + entity profiles.
 * Optional query: arApOnly, merchantOnly (same as reconciliation).
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema } from "@/lib/db"
import { runFinancialBrain } from "@/lib/financial-brain"
import { fetchOutstandingBills } from "@/lib/bills-fetch"
import { computeAPStateFromBills } from "@/lib/state/ar-ap"
import { fetchInvoicesForReconciliation } from "@/lib/invoices-fetch"

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

  let arApOnly = true
  let merchantOnly = false
  let syncCashEvents = true
  let runWaterfall = false
  let waterfallDryRun = false
  try {
    const body = await req.json().catch(() => ({}))
    if (typeof body.arApOnly === "boolean") arApOnly = body.arApOnly
    if (typeof body.merchantOnly === "boolean") merchantOnly = body.merchantOnly
    if (typeof body.syncCashEvents === "boolean") syncCashEvents = body.syncCashEvents
    if (typeof body.runWaterfall === "boolean") runWaterfall = body.runWaterfall
    if (typeof body.waterfallDryRun === "boolean") waterfallDryRun = body.waterfallDryRun
  } catch {
    const { searchParams } = new URL(req.url)
    arApOnly = searchParams.get("arApOnly") !== "false"
    merchantOnly = searchParams.get("merchantOnly") === "true"
    runWaterfall = searchParams.get("runWaterfall") === "true"
    waterfallDryRun = searchParams.get("waterfallDryRun") === "true"
  }

  try {
    let outstandingInvoices: import("@/lib/state/types").OutstandingInvoice[] | undefined
    let apObligations: import("@/lib/state/ar-ap").APObligation[] | undefined
    if (syncCashEvents) {
      outstandingInvoices = await fetchInvoicesForReconciliation(user.id)
      const bills = await fetchOutstandingBills(user.id)
      apObligations = computeAPStateFromBills(bills)
    }

    const result = await runFinancialBrain(user.id, {
      arApOnly,
      merchantOnly,
      ...(syncCashEvents && outstandingInvoices && apObligations
        ? { outstandingInvoices, apObligations }
        : {}),
      runWaterfall,
      waterfallDryRun,
    })

    return NextResponse.json({
      ok: true,
      cash_events_synced: result.cash_events_synced,
      entity_profiles_refreshed: result.entity_profiles_refreshed,
      allocation_count: result.attribution.allocationsRefreshed.length,
      ar_suggestions: result.attribution.arSuggestions.length,
      ap_suggestions: result.attribution.apSuggestions.length,
      waterfall: result.waterfall,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[brain] failed:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

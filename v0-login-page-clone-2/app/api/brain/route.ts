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
import { refreshEntityAliasesFromAccounting } from "@/lib/identity-seed"
import { refreshMovementEntityIds } from "@/lib/movement-classify"
import { createErrorResponse, createSuccessResponse } from "@/lib/api-utils"
import { log } from "@/lib/logger"

export async function POST(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json(createErrorResponse("Unauthorized"), { status: 401 })

  try {
    await ensureMovementsSchema()
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log("brain.schema_error", { error: errorMsg, userId: user.id })
    return NextResponse.json(createErrorResponse("Movements schema not available"), { status: 500 })
  }

  let arApOnly = true
  let merchantOnly = false
  let syncCashEvents = true
  try {
    const body = await req.json().catch(() => ({}))
    if (typeof body.arApOnly === "boolean") arApOnly = body.arApOnly
    if (typeof body.merchantOnly === "boolean") merchantOnly = body.merchantOnly
    if (typeof body.syncCashEvents === "boolean") syncCashEvents = body.syncCashEvents
  } catch {
    const { searchParams } = new URL(req.url)
    arApOnly = searchParams.get("arApOnly") !== "false"
    merchantOnly = searchParams.get("merchantOnly") === "true"
  }

  try {
    let outstandingInvoices: import("@/lib/state/types").OutstandingInvoice[] | undefined
    let apObligations: import("@/lib/state/ar-ap").APObligation[] | undefined
    if (syncCashEvents) {
      await refreshEntityAliasesFromAccounting(user.id)
      await refreshMovementEntityIds(user.id)

      outstandingInvoices = await fetchInvoicesForReconciliation(user.id)
      const bills = await fetchOutstandingBills(user.id)
      apObligations = computeAPStateFromBills(bills)
    }

    const result = await runFinancialBrain(user.id, {
      arApOnly,
      merchantOnly,
      ...(syncCashEvents ? { outstandingInvoices, apObligations } : {}),
    })

    log("brain.success", { userId: user.id, operation: "financial_brain", arApOnly, merchantOnly, syncCashEvents })
    return NextResponse.json(createSuccessResponse({
      ok: true,
      cash_events_synced: result.cash_events_synced,
      entity_profiles_refreshed: result.entity_profiles_refreshed,
      allocation_count: result.attribution.allocationsRefreshed.length,
      ar_suggestions: result.attribution.arSuggestions.length,
      ap_suggestions: result.attribution.apSuggestions.length,
      ...(result.waterfall
        ? {
            waterfall: {
              attributions_created: result.waterfall.attributionsCreated,
              cash_events_updated: result.waterfall.cashEventsUpdated,
              stage4_queued: result.waterfall.stage4Queued,
            },
          }
        : {}),
    }, { operation: "financial_brain" }))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log("brain.error", { userId: user.id, error: msg, operation: "financial_brain" })
    return NextResponse.json(createErrorResponse("Financial brain failed", { details: msg }), { status: 500 })
  }
}

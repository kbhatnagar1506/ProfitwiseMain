/**
 * Single orchestration entry: sync cash_events from invoices/AP → deterministic reconciliation waterfall →
 * attribution (AR/AP/merchant) → entity profile refresh. Classification/tagging stays in other pipelines.
 */

import { ensureMovementsSchema } from "./db"
import { runAttributionEngine, type AttributionEngineOptions } from "./attribution-engine"
import { syncCashEventsForUser, refreshEntityCashProfilesFromAttributions } from "./cash-events-build"
import { runReconciliationWaterfall } from "./reconciliation-waterfall"
import type { OutstandingInvoice } from "./state/types"
import type { APObligation } from "./state/ar-ap"

export type FinancialBrainOptions = AttributionEngineOptions & {
  /** When set, rebuild cash_events from these documents (skip if both empty). */
  outstandingInvoices?: OutstandingInvoice[]
  apObligations?: APObligation[]
}

export type FinancialBrainResult = {
  attribution: Awaited<ReturnType<typeof runAttributionEngine>>
  cash_events_synced: boolean
  entity_profiles_refreshed: boolean
  /** Present when cash_events were synced; deterministic waterfall + Stage 4 flags. */
  waterfall?: Awaited<ReturnType<typeof runReconciliationWaterfall>>
}

/**
 * When invoices + AP obligations are provided: sync cash_events → waterfall → attribution → profiles.
 * Otherwise: attribution only (then profiles).
 */
export async function runFinancialBrain(userId: string, options: FinancialBrainOptions = {}): Promise<FinancialBrainResult> {
  await ensureMovementsSchema()

  const { outstandingInvoices, apObligations, ...engineOpts } = options
  let cash_events_synced = false
  let waterfall: Awaited<ReturnType<typeof runReconciliationWaterfall>> | undefined

  if (outstandingInvoices && apObligations) {
    await syncCashEventsForUser(userId, outstandingInvoices, apObligations)
    cash_events_synced = true
    waterfall = await runReconciliationWaterfall(userId)
  }

  const attribution = await runAttributionEngine(userId, engineOpts)

  await refreshEntityCashProfilesFromAttributions(userId)
  const entity_profiles_refreshed = true

  return { attribution, cash_events_synced, entity_profiles_refreshed, waterfall }
}

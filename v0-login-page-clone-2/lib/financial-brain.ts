/**
 * Single orchestration entry: ingest → classify (caller) → attribution → cash_events → entity profiles → optional forecast.
 * Classification/tagging stays in existing pipelines; call this after movements + tags are current.
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
 * Run attribution engine, sync cash_events from invoices/AP obligations when provided,
 * and refresh entity cash profile aggregates from attributions.
 */
export async function runFinancialBrain(userId: string, options: FinancialBrainOptions = {}): Promise<FinancialBrainResult> {
  await ensureMovementsSchema()

  const { outstandingInvoices, apObligations, ...engineOpts } = options
  const attribution = await runAttributionEngine(userId, engineOpts)

  let cash_events_synced = false
  let waterfall: Awaited<ReturnType<typeof runReconciliationWaterfall>> | undefined
  if (outstandingInvoices && apObligations) {
    await syncCashEventsForUser(userId, outstandingInvoices, apObligations)
    cash_events_synced = true
    waterfall = await runReconciliationWaterfall(userId)
  }

  await refreshEntityCashProfilesFromAttributions(userId)
  const entity_profiles_refreshed = true

  return { attribution, cash_events_synced, entity_profiles_refreshed, waterfall }
}

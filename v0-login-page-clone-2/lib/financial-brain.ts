/**
 * Single orchestration entry: ingest → classify (caller) → attribution → cash_events → entity profiles → optional forecast.
 * Classification/tagging stays in existing pipelines; call this after movements + tags are current.
 */

import { ensureMovementsSchema } from "./db"
import { runAttributionEngine, type AttributionEngineOptions } from "./attribution-engine"
import { syncCashEventsForUser, refreshEntityCashProfilesFromAttributions } from "./cash-events-build"
import type { OutstandingInvoice } from "./state/types"
import type { APObligation } from "./state/ar-ap"
import { runReconciliationWaterfall, type WaterfallResult } from "./reconciliation-waterfall"
import { generateStage4Suggestions, type Stage4SuggestionSummary } from "./reconciliation-stage4-suggestions"

export type FinancialBrainOptions = AttributionEngineOptions & {
  /** When set, rebuild cash_events from these documents (skip if both empty). */
  outstandingInvoices?: OutstandingInvoice[]
  apObligations?: APObligation[]
  /** Run deterministic waterfall reconciliation after sync (disabled by default). */
  runWaterfall?: boolean
  /** Dry-run waterfall without writes. */
  waterfallDryRun?: boolean
  /** Stage-4 queue threshold for unresolved leftovers. */
  waterfallMinAiReviewAmount?: number
  /** Run Stage-4 suggestion generation over pending queue rows. */
  runStage4Suggestions?: boolean
  /** Pending queue rows to process for Stage-4 suggestion generation. */
  stage4BatchSize?: number
}

export type FinancialBrainResult = {
  attribution: Awaited<ReturnType<typeof runAttributionEngine>>
  cash_events_synced: boolean
  entity_profiles_refreshed: boolean
  waterfall: WaterfallResult | null
  stage4: Stage4SuggestionSummary | null
}

/**
 * Run attribution engine, sync cash_events from invoices/AP obligations when provided,
 * and refresh entity cash profile aggregates from attributions.
 */
export async function runFinancialBrain(userId: string, options: FinancialBrainOptions = {}): Promise<FinancialBrainResult> {
  await ensureMovementsSchema()

  const {
    outstandingInvoices,
    apObligations,
    runWaterfall: runWaterfallOpt,
    waterfallDryRun: waterfallDryRunOpt,
    waterfallMinAiReviewAmount,
    runStage4Suggestions: runStage4SuggestionsOpt,
    stage4BatchSize,
    ...engineOpts
  } = options
  const runWaterfall = runWaterfallOpt === true
  const waterfallDryRun = waterfallDryRunOpt === true
  const runStage4Suggestions = runStage4SuggestionsOpt === true
  const attribution = await runAttributionEngine(userId, engineOpts)

  let cash_events_synced = false
  if (outstandingInvoices && apObligations) {
    await syncCashEventsForUser(userId, outstandingInvoices, apObligations)
    cash_events_synced = true
  }

  await refreshEntityCashProfilesFromAttributions(userId)
  const entity_profiles_refreshed = true

  let waterfall: WaterfallResult | null = null
  if (runWaterfall) {
    waterfall = await runReconciliationWaterfall(userId, {
      dryRun: waterfallDryRun,
      minAiReviewAmount: waterfallMinAiReviewAmount,
    })
  }

  let stage4: Stage4SuggestionSummary | null = null
  if (runStage4Suggestions) {
    stage4 = await generateStage4Suggestions(userId, { batchSize: stage4BatchSize })
  }

  return { attribution, cash_events_synced, entity_profiles_refreshed, waterfall, stage4 }
}

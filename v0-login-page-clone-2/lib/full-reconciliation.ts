/**
 * Unified Reconciliation Engine
 *
 * Single entry point that runs ALL reconciliation stages (0-4) in sequence:
 * - Stage 0: Direct link matching (movement_id → cash_event_id)
 * - Stage 1: Exact amount matching
 * - Stage 2: Category-based matching
 * - Stage 3: FIFO with tolerance + greedy sweep prevention
 * - Stage 4: LLM semantic matching on remaining unmatched (optional — disabled by default
 *             during Phase C; re-enabled in Phase E via ENABLE_LLM_STAGE4=true)
 *
 * This consolidates the waterfall + LLM into one unified flow.
 *
 * Usage:
 *   const result = await runFullReconciliation(userId)
 */

import { runReconciliationWaterfall } from "./reconciliation-waterfall"
import { runLLMStage4, getAllUnreconciledMovements, type InvoiceForMatch, type BillForMatch } from "./reconciliation-llm-match"
import { runFusionReconciliation } from "./reconciliation-fusion-engine"
import { fetchInvoicesForReconciliation } from "./invoices-fetch"
import { fetchBillsForReconciliation } from "./bills-fetch"
import { toEntityUriApBill } from "./entity-uri"
import { filterHallucinations, logHallucinationReport } from "./llm-hallucination-detector"
import { buildRunMetrics, emitReconciliationMetrics } from "./reconciliation-monitoring"

export interface FullReconciliationResult {
  /** Stage 0-3 results from waterfall */
  waterfall: Awaited<ReturnType<typeof runReconciliationWaterfall>>
  /** Stage 4 LLM results */
  llm: Awaited<ReturnType<typeof runLLMStage4>>
  /** Total attributions created across all stages */
  totalAttributions: number
  /** Total unmatched movements after all stages */
  remainingUnmatched: number
  /** Execution time in milliseconds */
  executionTimeMs: number
  /** Any warnings or issues encountered */
  warnings: string[]
  /** Whether Stage 4 (LLM) was executed */
  stage4Enabled: boolean
}

/**
 * Run the complete reconciliation pipeline for a user.
 *
 * Supports two engines:
 * - RECONCILIATION_ENGINE=fusion: New parallel fusion engine (Math + AI + Memory)
 * - RECONCILIATION_ENGINE=waterfall (default): Sequential waterfall stages 0-4
 *
 * Phase C/E: Stage 4 gating — disabled by default, enabled via env flag
 */
export async function runFullReconciliation(userId: string): Promise<FullReconciliationResult> {
  const startTime = Date.now()
  const warnings: string[] = []

  // Check which engine to use
  const engine = process.env.RECONCILIATION_ENGINE ?? "waterfall"
  const stage4Enabled = process.env.ENABLE_LLM_STAGE4 === "true"

  try {
    console.log("[full-reconciliation] Starting reconciliation for user:", userId, `engine=${engine} stage4=${stage4Enabled}`)

    // Route to appropriate engine
    if (engine === "fusion") {
      console.log("[full-reconciliation] Using FUSION engine")
      return await runFusionReconciliation(userId)
    }

    // Default: waterfall engine
    console.log("[full-reconciliation] Using WATERFALL engine")

    // ─── Stage 0-3: Deterministic Waterfall ───────────────────────────────────
    const waterfallStart = Date.now()
    const waterfallResult = await runReconciliationWaterfall(userId)
    console.log(`[full-reconciliation] Stages 0-3 complete in ${Date.now() - waterfallStart}ms`, {
      attributionsCreated: waterfallResult.attributionsCreated,
      stage4Queued: waterfallResult.stage4Queued,
    })

    const emptyLLMResult = {
      matches: { ar: [] as import("./reconciliation-llm-match").ARMatchSuggestion[], ap: [] as import("./reconciliation-llm-match").APMatchSuggestion[] },
      applied: { applied: 0, skipped: 0, errors: [] as string[] },
    }

    let llmResult = emptyLLMResult

    // ─── Stage 4: LLM Semantic Matching (gated) ────────────────────────────────
    if (stage4Enabled) {
      console.log("[full-reconciliation] Running Stage 4: LLM Semantic Matching")
      const llmStart = Date.now()

      const unreconciledMovements = await getAllUnreconciledMovements(userId)
      console.log(`[full-reconciliation] ${unreconciledMovements.length} unreconciled movements for LLM`)

      if (unreconciledMovements.length > 0) {
        const invoices = await fetchInvoicesForReconciliation(userId)
        const bills = await fetchBillsForReconciliation(userId)

        const invoicesForLLM: InvoiceForMatch[] = invoices
          .filter((i) => i.status !== "paid" && i.amount_due > 0)
          .map((i) => ({
            invoice_id: i.invoice_id,
            customer_name: i.customer_name,
            amount_due: i.amount_due,
            due_date: i.due_date,
            entity_id: i.entity_uri,
            source: i.source,
          }))

        const billsForLLM: BillForMatch[] = bills
          .filter((b) => b.status !== "paid" && b.amount_due > 0)
          .map((b) => ({
            bill_id: b.bill_id,
            obligation_id: b.entity_uri ?? toEntityUriApBill(b.source, b.bill_id),
            vendor_name: b.vendor_name,
            amount_due: b.amount_due,
            due_date: b.due_date,
            entity_id: b.entity_uri,
            source: b.source,
          }))

        // Run LLM matching
        const rawLLMResult = await runLLMStage4(userId, unreconciledMovements, invoicesForLLM, billsForLLM, "high")

        // D3: Filter hallucinations before applying
        const invoiceMap = new Map(invoicesForLLM.map(i => [i.invoice_id, i]))
        const billMap = new Map(billsForLLM.map(b => [b.obligation_id, b]))
        const movementAmounts = new Map(unreconciledMovements.map(m => [m.movement_id, m.amount]))
        const movementDates = new Map(unreconciledMovements.map(m => [m.movement_id, m.date]))

        const { report } = filterHallucinations(
          rawLLMResult.matches.ar,
          rawLLMResult.matches.ap,
          invoiceMap,
          billMap,
          movementAmounts,
          movementDates
        )
        logHallucinationReport(userId, report)

        if (report.hallucinationRate > 0) {
          warnings.push(
            `Stage 4: ${(report.hallucinationRate * 100).toFixed(1)}% hallucination rate ` +
            `(${report.invalidAR + report.invalidAP} suggestions rejected)`
          )
        }

        llmResult = rawLLMResult

        if (rawLLMResult.applied?.errors?.length > 0) {
          warnings.push(`LLM Stage 4 encountered ${rawLLMResult.applied.errors.length} errors`)
        }

        console.log(`[full-reconciliation] Stage 4 complete in ${Date.now() - llmStart}ms`, {
          arMatches: rawLLMResult.matches.ar.length,
          apMatches: rawLLMResult.matches.ap.length,
          applied: rawLLMResult.applied.applied,
          skipped: rawLLMResult.applied.skipped,
        })
      }
    } else {
      console.log("[full-reconciliation] Stage 4 (LLM) disabled — set ENABLE_LLM_STAGE4=true to enable")
    }

    // ─── Final Metrics ─────────────────────────────────────────────────────────
    const finalUnreconciled = await getAllUnreconciledMovements(userId)
    const totalAttributions = waterfallResult.attributionsCreated + (llmResult.applied?.applied ?? 0)
    const executionTimeMs = Date.now() - startTime

    // Emit monitoring metrics (fire-and-forget)
    const runMetrics = buildRunMetrics(userId, {
      totalMovements: waterfallResult.attributionsCreated + finalUnreconciled.length,
      matchedMovements: waterfallResult.attributionsCreated,
      unmatchedCashAmount: finalUnreconciled.reduce((s, m) => s + m.amount, 0),
      errorCount: (llmResult.applied?.errors?.length ?? 0),
      stageCounts: {
        s0: 0,
        s1: 0,
        s2: 0,
        s3: waterfallResult.attributionsCreated,
        s4: llmResult.applied?.applied ?? 0,
      },
      durationMs: executionTimeMs,
    })
    emitReconciliationMetrics(runMetrics).catch(() => {})

    console.log("[full-reconciliation] Complete:", {
      totalAttributions,
      remainingUnmatched: finalUnreconciled.length,
      executionTimeMs,
      stage4Enabled,
    })

    return {
      waterfall: waterfallResult,
      llm: llmResult,
      totalAttributions,
      remainingUnmatched: finalUnreconciled.length,
      executionTimeMs,
      warnings,
      stage4Enabled,
    }
  } catch (err) {
    const executionTimeMs = Date.now() - startTime
    console.error("[full-reconciliation] Error:", err)
    throw new Error(
      `Full reconciliation failed after ${executionTimeMs}ms: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

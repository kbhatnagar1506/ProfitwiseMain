/**
 * Unified Reconciliation Engine
 *
 * Single entry point that runs ALL reconciliation stages (0-4) in sequence:
 * - Stage 0: Direct link matching (movement_id → cash_event_id)
 * - Stage 1: Exact amount matching
 * - Stage 2: Category-based matching
 * - Stage 3: FIFO with tolerance + greedy sweep prevention
 * - Stage 4: LLM semantic matching on remaining unmatched
 *
 * This consolidates the waterfall + LLM into one unified flow.
 *
 * Usage:
 *   const result = await runFullReconciliation(userId)
 */

import type { PoolClient } from "pg"
import { withTransaction } from "./db"
import { runReconciliationWaterfall } from "./reconciliation-waterfall"
import { runLLMStage4, getAllUnreconciledMovements, type InvoiceForMatch, type BillForMatch } from "./reconciliation-llm-match"
import { fetchInvoicesForReconciliation } from "./invoices-fetch"
import { fetchBillsForReconciliation } from "./bills-fetch"
import { toEntityUriApBill } from "./entity-uri"

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
}

/**
 * Run the complete reconciliation pipeline for a user.
 *
 * This is the single entry point that orchestrates:
 * 1. Stages 0-3 (deterministic waterfall)
 * 2. Stage 4 (LLM semantic matching)
 * 3. Confidence scoring and audit logging
 *
 * All stages are part of one unified flow.
 */
export async function runFullReconciliation(userId: string): Promise<FullReconciliationResult> {
  const startTime = Date.now()
  const warnings: string[] = []

  try {
    console.log("[full-reconciliation] Starting unified reconciliation for user:", userId)

    // ─── Stage 0-3: Deterministic Waterfall ───────────────────────────────────
    console.log("[full-reconciliation] Running Stages 0-3: Deterministic Waterfall")
    const waterfallStart = Date.now()
    const waterfallResult = await runReconciliationWaterfall(userId)
    const waterfallTimeMs = Date.now() - waterfallStart
    console.log(`[full-reconciliation] Stages 0-3 complete in ${waterfallTimeMs}ms`)
    console.log("[full-reconciliation] Waterfall result:", {
      attributionsCreated: waterfallResult.attributions_created,
      stage0Hits: waterfallResult.stage0_hits,
      stage1Hits: waterfallResult.stage1_hits,
      stage2Hits: waterfallResult.stage2_hits,
      stage3Hits: waterfallResult.stage3_hits,
    })

    // ─── Stage 4: LLM Semantic Matching ────────────────────────────────────────
    console.log("[full-reconciliation] Running Stage 4: LLM Semantic Matching")
    const llmStart = Date.now()

    // Fetch unreconciled movements
    const unreconciledMovements = await getAllUnreconciledMovements(userId)
    console.log(`[full-reconciliation] Found ${unreconciledMovements.length} unreconciled movements`)

    let llmResult = {
      matches: { ar: [], ap: [] },
      applied: { applied: 0, skipped: 0 },
      errors: [] as string[],
    }

    if (unreconciledMovements.length > 0) {
      // Fetch invoices and bills for LLM context
      const invoices = await fetchInvoicesForReconciliation(userId)
      const bills = await fetchBillsForReconciliation(userId)

      // Prepare data for LLM
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

      console.log(
        `[full-reconciliation] Calling LLM Stage 4 with ${invoicesForLLM.length} invoices and ${billsForLLM.length} bills`
      )

      // Run LLM matching
      llmResult = await runLLMStage4(userId, unreconciledMovements, invoicesForLLM, billsForLLM, "high")

      console.log("[full-reconciliation] LLM Stage 4 result:", {
        arMatches: llmResult.matches.ar.length,
        apMatches: llmResult.matches.ap.length,
        applied: llmResult.applied.applied,
        skipped: llmResult.applied.skipped,
        errors: llmResult.errors.length,
      })

      if (llmResult.errors.length > 0) {
        warnings.push(`LLM Stage 4 encountered ${llmResult.errors.length} errors`)
      }
    }

    const llmTimeMs = Date.now() - llmStart
    console.log(`[full-reconciliation] Stage 4 complete in ${llmTimeMs}ms`)

    // ─── Final Metrics ─────────────────────────────────────────────────────────
    const finalUnreconciled = await getAllUnreconciledMovements(userId)
    const totalAttributions = waterfallResult.attributions_created + llmResult.applied.applied

    const executionTimeMs = Date.now() - startTime
    console.log("[full-reconciliation] Reconciliation complete:", {
      totalAttributions,
      remainingUnmatched: finalUnreconciled.length,
      executionTimeMs,
      warnings: warnings.length,
    })

    return {
      waterfall: waterfallResult,
      llm: llmResult,
      totalAttributions,
      remainingUnmatched: finalUnreconciled.length,
      executionTimeMs,
      warnings,
    }
  } catch (err) {
    const executionTimeMs = Date.now() - startTime
    console.error("[full-reconciliation] Error:", err)
    throw new Error(
      `Full reconciliation failed after ${executionTimeMs}ms: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

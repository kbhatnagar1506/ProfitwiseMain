/**
 * Lightweight audit log for reconciliation match decisions.
 * Records one row per attribution per movement — supports the test harness
 * and manual investigation of match quality.
 */

import type { PoolClient } from "pg"
import { query } from "./db"

export interface AuditLogEntry {
  userId: string | null
  movementId: string
  matchMethod: string
  waterfallStage?: string | null
  confidence?: number | null
  entityId?: string | null
  referenceId?: string | null
  amountMatched?: number | null
  semanticValid?: boolean | null
  crossEntityFlag?: boolean
}

/**
 * Write an audit log entry inside an existing transaction client.
 */
export async function writeAuditLogWithClient(
  client: PoolClient,
  entry: AuditLogEntry
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO reconciliation_audit_log
         (user_id, movement_id, match_method, waterfall_stage, confidence, entity_id,
          reference_id, amount_matched, semantic_valid, cross_entity_flag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.userId ?? null,
        entry.movementId,
        entry.matchMethod,
        entry.waterfallStage ?? null,
        entry.confidence ?? null,
        entry.entityId ?? null,
        entry.referenceId ?? null,
        entry.amountMatched ?? null,
        entry.semanticValid ?? null,
        entry.crossEntityFlag ?? false,
      ]
    )
  } catch {
    // Never let audit log failures block reconciliation
  }
}

/**
 * Write an audit log entry outside a transaction (best-effort, fire-and-forget).
 */
export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO reconciliation_audit_log
         (user_id, movement_id, match_method, waterfall_stage, confidence, entity_id,
          reference_id, amount_matched, semantic_valid, cross_entity_flag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.userId ?? null,
        entry.movementId,
        entry.matchMethod,
        entry.waterfallStage ?? null,
        entry.confidence ?? null,
        entry.entityId ?? null,
        entry.referenceId ?? null,
        entry.amountMatched ?? null,
        entry.semanticValid ?? null,
        entry.crossEntityFlag ?? false,
      ]
    )
  } catch {
    // Never block callers on audit log failures
  }
}

/**
 * Bulk-write audit entries for all pendingAttributions from the waterfall.
 * Called inside the transaction after attributions are inserted.
 */
export async function bulkWriteAuditLog(
  client: PoolClient,
  userId: string,
  entries: AuditLogEntry[]
): Promise<void> {
  if (entries.length === 0) return
  const values = entries
    .map(
      (_, i) =>
        `($${i * 10 + 1}, $${i * 10 + 2}, $${i * 10 + 3}, $${i * 10 + 4}, $${i * 10 + 5}, $${i * 10 + 6}, $${i * 10 + 7}, $${i * 10 + 8}, $${i * 10 + 9}, $${i * 10 + 10})`
    )
    .join(", ")
  const params = entries.flatMap((e) => [
    userId,
    e.movementId,
    e.matchMethod,
    e.waterfallStage ?? null,
    e.confidence ?? null,
    e.entityId ?? null,
    e.referenceId ?? null,
    e.amountMatched ?? null,
    e.semanticValid ?? null,
    e.crossEntityFlag ?? false,
  ])
  // #region agent log - hypothesis G: detailed logging for bulkWriteAuditLog
  console.log("[bulkWriteAuditLog] Inserting", entries.length, "audit entries");
  try {
    await client.query(
      `INSERT INTO reconciliation_audit_log
         (user_id, movement_id, match_method, waterfall_stage, confidence, entity_id,
          reference_id, amount_matched, semantic_valid, cross_entity_flag)
       VALUES ${values}`,
      params
    )
    console.log("[bulkWriteAuditLog] Successfully inserted", entries.length, "audit entries");
  } catch (err) {
    console.error("[bulkWriteAuditLog] Error:", err instanceof Error ? err.message : String(err));
    // Don't swallow—let it propagate so we can see the real error
    throw err;
  }
  // #endregion
}

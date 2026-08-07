/**
 * Supermemory Decision History for Reconciliation
 *
 * Tracks every reconciliation decision (match applied or rejected) to build
 * a feedback loop that improves future matching.
 *
 * Decision structure:
 * - movement_id: The bank movement being reconciled
 * - entity_id: The entity matched (or rejected entity for rejections)
 * - reference_id: Invoice or bill ID if applicable
 * - match_method: How the match was made
 * - confidence: Score at time of decision
 * - outcome: 'applied' | 'rejected' | 'manual_override'
 * - created_at: When the decision was made
 */

import { query } from "./db"

export interface ReconciliationDecision {
  id?: string
  user_id: string
  movement_id: string
  entity_id: string | null
  reference_id: string | null
  match_method: string
  waterfall_stage: string | null
  confidence: number | null
  outcome: "applied" | "rejected" | "manual_override" | "pending"
  amount_matched: number | null
  rejection_reason: string | null
  created_at?: string
}

// ─── In-memory decision cache (recent 90 days per entity) ──────────────────
const DECISION_RETENTION_DAYS = 90
const RECENT_LIMIT = 20

const decisionCache = new Map<string, { decisions: ReconciliationDecision[]; cachedAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

function getDecisionsCached(cacheKey: string): ReconciliationDecision[] | null {
  const entry = decisionCache.get(cacheKey)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    decisionCache.delete(cacheKey)
    return null
  }
  return entry.decisions
}

function setDecisionsCache(cacheKey: string, decisions: ReconciliationDecision[]): void {
  decisionCache.set(cacheKey, { decisions, cachedAt: Date.now() })
}

export function clearDecisionHistoryCache(): void {
  decisionCache.clear()
}
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fetch recent reconciliation decisions for a given entity.
 * Used to inform confidence scoring and semantic validation.
 */
export async function getRecentDecisionsForEntity(
  userId: string,
  entityId: string,
  limitDays = DECISION_RETENTION_DAYS
): Promise<ReconciliationDecision[]> {
  const cacheKey = `${userId}:${entityId}`
  const cached = getDecisionsCached(cacheKey)
  if (cached) return cached

  const result = await query<ReconciliationDecision>(
    `SELECT
       id::text, user_id::text, movement_id::text, entity_id, reference_id,
       match_method, waterfall_stage, confidence::float, outcome,
       amount_matched::float, rejection_reason, created_at::text
     FROM reconciliation_audit_log
     WHERE user_id = $1
       AND entity_id = $2
       AND created_at > NOW() - ($3 || ' days')::interval
     ORDER BY created_at DESC
     LIMIT $4`,
    [userId, entityId, limitDays, RECENT_LIMIT]
  )

  const decisions = result.rows
  setDecisionsCache(cacheKey, decisions)
  return decisions
}

/**
 * Get the historical match success rate for a given entity.
 * Returns { successRate, totalDecisions, recentAvgConfidence }
 */
export async function getEntityMatchStats(
  userId: string,
  entityId: string
): Promise<{ successRate: number; totalDecisions: number; recentAvgConfidence: number }> {
  const result = await query<{
    total: number
    applied: number
    avg_confidence: number | null
  }>(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(CASE WHEN outcome = 'applied' THEN 1 END)::int AS applied,
       AVG(CASE WHEN outcome = 'applied' THEN confidence END)::float AS avg_confidence
     FROM reconciliation_audit_log
     WHERE user_id = $1
       AND entity_id = $2
       AND created_at > NOW() - INTERVAL '90 days'`,
    [userId, entityId]
  )

  const row = result.rows[0]
  const total = row?.total ?? 0
  const applied = row?.applied ?? 0
  const avgConf = row?.avg_confidence ?? 0

  return {
    successRate: total > 0 ? applied / total : 0,
    totalDecisions: total,
    recentAvgConfidence: avgConf,
  }
}

/**
 * Record a reconciliation decision in the audit log.
 * Called after every match is applied or rejected.
 */
export async function recordDecision(decision: ReconciliationDecision): Promise<void> {
  try {
    await query(
      `INSERT INTO reconciliation_audit_log
         (user_id, movement_id, match_method, waterfall_stage, confidence,
          entity_id, reference_id, amount_matched, semantic_valid, cross_entity_flag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        decision.user_id,
        decision.movement_id,
        decision.match_method,
        decision.waterfall_stage ?? null,
        decision.confidence ?? null,
        decision.entity_id ?? null,
        decision.reference_id ?? null,
        decision.amount_matched ?? null,
        decision.outcome === "applied" ? true : null,
        false,
      ]
    )
    // Invalidate cache for this entity
    if (decision.entity_id) {
      decisionCache.delete(`${decision.user_id}:${decision.entity_id}`)
    }
  } catch (err) {
    console.warn("[supermemory-decision-history] Failed to record decision:", err)
  }
}

/**
 * Get entities that have historically been rejected for cross-contamination.
 * Used to build a rejection list during reconciliation.
 */
export async function getCrossEntityRejections(
  userId: string,
  movementId: string
): Promise<string[]> {
  const result = await query<{ entity_id: string }>(
    `SELECT DISTINCT entity_id
     FROM reconciliation_audit_log
     WHERE user_id = $1
       AND movement_id = $2
       AND cross_entity_flag = true`,
    [userId, movementId]
  )
  return result.rows.map((r) => r.entity_id).filter(Boolean)
}

/**
 * Analyze patterns from decision history to compute a history-based
 * confidence adjustment for a given (movement_description, entity_id) pair.
 *
 * Returns a value between -0.15 and +0.15 to add to base confidence.
 */
export async function getHistoryConfidenceAdjustment(
  userId: string,
  entityId: string,
  amount: number
): Promise<number> {
  const stats = await getEntityMatchStats(userId, entityId)
  if (stats.totalDecisions === 0) return 0  // No history — neutral

  // Boost if historically high success rate
  if (stats.successRate >= 0.9 && stats.totalDecisions >= 5) return 0.10
  if (stats.successRate >= 0.75 && stats.totalDecisions >= 3) return 0.05

  // Penalty if historically poor success rate
  if (stats.successRate < 0.3 && stats.totalDecisions >= 3) return -0.10
  if (stats.successRate < 0.5 && stats.totalDecisions >= 5) return -0.05

  return 0
}

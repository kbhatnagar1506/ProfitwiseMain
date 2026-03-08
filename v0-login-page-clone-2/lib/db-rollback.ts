/**
 * Database rollback procedures for schema migrations.
 *
 * Each numbered migration in ensureMovementsSchema() has a corresponding
 * rollback here. Call rollbackToVersion(targetVersion) to undo migrations
 * down to (but not including) targetVersion.
 *
 * WARNING: Rollbacks are destructive. Always back up data first.
 * Use rollbackToVersion only during a maintenance window.
 */

import { query } from "@/lib/db"

interface RollbackStep {
  version: number
  name: string
  rollback: () => Promise<void>
}

const rollbackSteps: RollbackStep[] = [
  {
    version: 1,
    name: "attributions_not_empty_constraints",
    rollback: async () => {
      await query(`ALTER TABLE movement_attributions DROP CONSTRAINT IF EXISTS category_not_empty`)
      await query(`ALTER TABLE movement_attributions DROP CONSTRAINT IF EXISTS cost_type_not_empty`)
      await query(`ALTER TABLE movement_attributions DROP CONSTRAINT IF EXISTS vendor_id_not_empty`)
    },
  },
  {
    version: 2,
    name: "cash_events_amount_signed_atomic_backfill",
    rollback: async () => {
      // Nullify the column so it can be re-backfilled on next startup
      await query(`UPDATE cash_events SET amount_signed = NULL`)
      // Remove the column entirely if a clean slate is needed
      // await query(`ALTER TABLE cash_events DROP COLUMN IF EXISTS amount_signed`)
    },
  },
  {
    version: 3,
    name: "movement_attributions_cost_type_vendor_id_indexes",
    rollback: async () => {
      await query(`DROP INDEX IF EXISTS idx_attributions_cost_type`)
      await query(`DROP INDEX IF EXISTS idx_attributions_vendor_id`)
    },
  },
]

/**
 * Roll back all migrations with version > targetVersion, in reverse order.
 * After rolling back, marks those migrations as 'pending' in schema_migrations
 * so they will be re-run on the next startup.
 *
 * @param targetVersion — roll back everything ABOVE this version number
 */
export async function rollbackToVersion(targetVersion: number): Promise<void> {
  const stepsToRollback = rollbackSteps
    .filter(s => s.version > targetVersion)
    .sort((a, b) => b.version - a.version)  // highest version first

  if (stepsToRollback.length === 0) {
    console.log(`[DB-Rollback] Nothing to roll back to version ${targetVersion}`)
    return
  }

  for (const step of stepsToRollback) {
    const startMs = Date.now()
    console.log(`[DB-Rollback] Rolling back migration v${step.version}: ${step.name}`)
    try {
      await step.rollback()
      // Mark as pending so it re-runs on next startup
      await query(
        `UPDATE schema_migrations SET status = 'pending', duration_ms = $2 WHERE version = $1`,
        [step.version, Date.now() - startMs]
      )
      console.log(`[DB-Rollback] v${step.version} rolled back in ${Date.now() - startMs}ms`)
    } catch (err) {
      console.error(`[DB-Rollback] v${step.version} rollback FAILED:`, err)
      throw err  // Stop rolling back; caller must handle partial rollback
    }
  }

  console.log(`[DB-Rollback] Rolled back to version ${targetVersion}`)
}

/**
 * List all completed migrations and their status.
 */
export async function listMigrations(): Promise<Array<{
  version: number
  name: string
  status: string
  executed_at: string
  duration_ms: number | null
}>> {
  try {
    const { rows } = await query<{
      version: number
      name: string
      status: string
      executed_at: string
      duration_ms: number | null
    }>(`SELECT version, name, status, executed_at, duration_ms
        FROM schema_migrations
        ORDER BY version ASC`)
    return rows
  } catch {
    return []
  }
}

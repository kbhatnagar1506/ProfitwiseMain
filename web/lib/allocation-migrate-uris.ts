/**
 * One-time migration: backfill movement_allocations to use canonical entity URIs.
 * Converts legacy entity_id formats to ar:// and ap:// URIs.
 * Idempotent: skips rows already in URI format.
 */

import { query } from "./db"

export async function migrateAllocationUris(): Promise<{ updated: number }> {
  type Row = { id: string; entity_type: string; entity_id: string }
  const { rows } = await query<Row>(
    `SELECT id, entity_type, entity_id FROM movement_allocations
     WHERE (entity_type = 'ar' AND entity_id NOT LIKE 'ar://%')
     OR (entity_type = 'ap' AND entity_id NOT LIKE 'ap://%')`
  )
  let updated = 0
  for (const r of rows) {
    let newEntityId: string
    let synthetic = false
    if (r.entity_type === "ar") {
      if (r.entity_id.startsWith("stripe_settlement_")) {
        newEntityId = `ar://invoice/synthetic/stripe_settlement/${r.entity_id.slice(18)}`
        synthetic = true
      } else if (r.entity_id.startsWith("gmail_")) {
        newEntityId = `ar://invoice/gmail/${r.entity_id}`
      } else {
        newEntityId = `ar://invoice/legacy/${r.entity_id}`
      }
    } else {
      if (r.entity_id.startsWith("ap_bill_")) {
        newEntityId = `ap://bill/legacy/${r.entity_id.slice(8)}`
      } else if (r.entity_id.startsWith("ap_inferred_")) {
        const rest = r.entity_id.slice(12)
        const dateMatch = rest.match(/_(\d{4}-\d{2}-\d{2})$/)
        if (dateMatch) {
          const date = dateMatch[1]
          const entityPart = rest.slice(0, -date.length - 1)
          newEntityId = `ap://inferred/${entityPart}/${date}`
        } else {
          newEntityId = `ap://bill/legacy/${r.entity_id}`
        }
      } else {
        newEntityId = `ap://bill/legacy/${r.entity_id}`
      }
    }
    await query(
      `UPDATE movement_allocations SET entity_id = $2, synthetic_invoice = $3, reconcile_at = COALESCE(reconcile_at, created_at)
       WHERE id = $1`,
      [r.id, newEntityId, synthetic]
    )
    updated++
  }
  return { updated }
}

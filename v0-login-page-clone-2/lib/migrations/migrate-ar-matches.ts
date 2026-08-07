/**
 * Migration: Populate ar_reconciliation_matches from existing movement_attributions
 * 
 * This script migrates existing AR reconciliation data from the movement_attributions
 * table to the new ar_reconciliation_matches table.
 * 
 * Usage: npx ts-node lib/migrations/migrate-ar-matches.ts
 */

import { getPool } from "../db"

async function migrateARMatches() {
  const pool = await getPool()
  if (!pool) {
    console.error("Database pool not available")
    process.exit(1)
  }

  try {
    console.log("Starting AR matches migration...")

    // Get all AR attributions with their related movement and cash event data
    const result = await pool.query(`
      SELECT
        ma.id as attribution_id,
        ma.user_id,
        ma.movement_id,
        ma.reference_id as cash_event_id,
        m.amount as bank_amount,
        m.date as bank_date,
        m.raw_description as bank_description,
        m.counterparty as bank_counterparty,
        ce.metadata->>'invoice_id' as invoice_id,
        ce.metadata->>'customer_name' as customer_name,
        ce.amount as invoice_amount,
        'EXACT' as match_type,
        COALESCE(ma.confidence, 0.95) as confidence,
        0 as fee_amount,
        LEAST(m.amount, ce.amount) as matched_amount,
        CASE WHEN ma.source = 'llm' THEN 'ai' ELSE 'manual' END as matched_by,
        'confirmed' as status,
        NOW() as confirmed_at,
        ma.created_at
      FROM movement_attributions ma
      JOIN movements m ON m.id = ma.movement_id
      JOIN cash_events ce ON ce.id = ma.reference_id
      WHERE ma.component_type = 'ar'
        AND ma.user_id IS NOT NULL
        AND m.id IS NOT NULL
        AND ce.id IS NOT NULL
        AND ce.event_type = 'ar'
    `)

    console.log(`Found ${result.rows.length} AR attributions to migrate`)

    if (result.rows.length === 0) {
      console.log("No AR attributions to migrate")
      process.exit(0)
    }

    // Insert into ar_reconciliation_matches
    let inserted = 0
    let skipped = 0

    for (const row of result.rows) {
      try {
        await pool.query(
          `INSERT INTO ar_reconciliation_matches (
            id, user_id, movement_id, cash_event_id, bank_amount, bank_date,
            bank_description, bank_counterparty, invoice_id, customer_name,
            invoice_amount, match_type, confidence, fee_amount, matched_amount,
            matched_by, status, confirmed_at, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW()
          )
          ON CONFLICT (movement_id, cash_event_id) DO NOTHING`,
          [
            row.user_id,
            row.movement_id,
            row.cash_event_id,
            row.bank_amount,
            row.bank_date,
            row.bank_description,
            row.bank_counterparty,
            row.invoice_id,
            row.customer_name,
            row.invoice_amount,
            row.match_type,
            row.confidence,
            row.fee_amount,
            row.matched_amount,
            row.matched_by,
            row.status,
            row.confirmed_at,
            row.created_at,
          ]
        )
        inserted++
      } catch (err) {
        console.warn(`Skipped row for movement ${row.movement_id}:`, err instanceof Error ? err.message : String(err))
        skipped++
      }
    }

    console.log(`Migration complete: ${inserted} inserted, ${skipped} skipped`)
    process.exit(0)
  } catch (err) {
    console.error("Migration failed:", err)
    process.exit(1)
  }
}

migrateARMatches()

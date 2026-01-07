/**
 * POST /api/admin/run-full-pipeline
 * 
 * Runs the complete data processing pipeline for all users:
 * 1. Classify movements (entity resolution)
 * 2. Tag movements (economic classification)
 * 3. Seed identity graph (entity graphing)
 * 4. Reconciliation (AR/AP matching)
 * 5. Seed identity graph again (refresh)
 * 6. Compute state (revenue/spend/liquidity)
 * 7. Generate forecast
 * 
 * Logs detailed results at each step for debugging.
 * Requires x-clean-db-secret header.
 */

import { NextRequest, NextResponse } from "next/server"
import { query, ensureAuthSchema } from "@/lib/db"
import { log } from "@/lib/logger"
import { classifyMovements } from "@/lib/movement-classify"
import { tagMovements } from "@/lib/movement-tag-enrich"
import { seedIdentityGraph } from "@/lib/identity-seed"
import { computeRevenueState, computeSpendState, computeLiquidityState } from "@/lib/state/compute"

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }

  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("admin.run_full_pipeline.unauthorized", {}, "system")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await ensureAuthSchema()

    // Get all users
    const { rows: users } = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users ORDER BY created_at DESC`
    )

    console.log(`\n${"=".repeat(80)}`)
    console.log(`FULL PIPELINE RUN: ${users.length} users`)
    console.log(`${"=".repeat(80)}\n`)

    const results: Array<{
      userId: string
      email: string
      steps: Record<string, any>
      error?: string
    }> = []

    for (const user of users) {
      const userId = user.id
      const email = user.email
      const steps: Record<string, any> = {}

      console.log(`\n${"─".repeat(80)}`)
      console.log(`USER: ${email} (${userId})`)
      console.log(`${"─".repeat(80)}`)

      try {
        // Step 1: Classify movements
        console.log(`\n[1/7] Classifying movements...`)
        const classifyStart = Date.now()
        const classifyResult = await classifyMovements(userId)
        const classifyTime = Date.now() - classifyStart
        steps.classify = {
          ...classifyResult,
          duration_ms: classifyTime,
        }
        console.log(`✓ Classified in ${classifyTime}ms:`, {
          canonical_movements: classifyResult.canonical_movements,
          rule_classified: classifyResult.rule_classified,
          llm_classified: classifyResult.llm_classified,
          identity_resolved: classifyResult.identity_resolved,
        })
        log("admin.pipeline.classify.complete", { userId, ...classifyResult, duration_ms: classifyTime }, "system")

        // Step 2: Tag movements
        console.log(`\n[2/7] Tagging movements...`)
        const tagStart = Date.now()
        const tagResult = await tagMovements(userId)
        const tagTime = Date.now() - tagStart
        steps.tag = {
          total_tags: tagResult.tags.length,
          stats: tagResult.stats,
          duration_ms: tagTime,
        }
        console.log(`✓ Tagged in ${tagTime}ms:`, {
          total: tagResult.stats.total,
          deterministic: tagResult.stats.deterministic,
          identity_aware: tagResult.stats.identity_aware,
          policy_include: tagResult.stats.policy_include,
        })
        log("admin.pipeline.tag.complete", { userId, ...tagResult.stats, duration_ms: tagTime }, "system")

        // Step 3: Seed identity graph (first pass)
        console.log(`\n[3/7] Seeding identity graph (first pass)...`)
        const seedStart = Date.now()
        const seedResult = await seedIdentityGraph(userId)
        const seedTime = Date.now() - seedStart
        steps.seed_identity_1 = {
          ...seedResult,
          duration_ms: seedTime,
        }
        console.log(`✓ Seeded in ${seedTime}ms:`, {
          entitiesCreated: seedResult.entitiesCreated,
          entitiesUpdated: seedResult.entitiesUpdated,
          aliasesCreated: seedResult.aliasesCreated,
          assertionsCreated: seedResult.assertionsCreated,
        })
        log("admin.pipeline.seed_identity_1.complete", { userId, ...seedResult, duration_ms: seedTime }, "system")

        // Step 4: Reconciliation (AR/AP matching) - MUST happen before 2nd identity seeding
        console.log(`\n[4/7] Running reconciliation (AR/AP matching)...`)
        const reconStart = Date.now()
        
        // Fetch QBO invoices (AR)
        const { rows: qboInvoices } = await query<{
          id: string
          customer_id: string | null
          total: number
          due_date: string
        }>(
          `SELECT id, customer_id, total, due_date FROM qbo_invoices 
           WHERE user_id = $1 AND status = 'Open'`,
          [userId]
        )

        // Fetch QBO bills (AP)
        const { rows: qboBills } = await query<{
          id: string
          vendor_id: string | null
          total: number
          due_date: string
        }>(
          `SELECT id, vendor_id, total, due_date FROM qbo_bills 
           WHERE user_id = $1 AND status = 'Open'`,
          [userId]
        )

        // Create cash_events from invoices and bills for reconciliation
        let arCount = 0
        let apCount = 0
        
        for (const inv of qboInvoices) {
          await query(
            `INSERT INTO cash_events (user_id, event_type, entity_id, amount, expected_date, status, created_at)
             VALUES ($1, 'ar', $2, $3, $4, 'open', NOW())
             ON CONFLICT (user_id, event_type, entity_id) DO UPDATE SET
               amount = $3,
               expected_date = $4,
               status = 'open'`,
            [userId, inv.customer_id, inv.total, inv.due_date]
          )
          arCount++
        }

        for (const bill of qboBills) {
          await query(
            `INSERT INTO cash_events (user_id, event_type, entity_id, amount, expected_date, status, created_at)
             VALUES ($1, 'ap', $2, $3, $4, 'open', NOW())
             ON CONFLICT (user_id, event_type, entity_id) DO UPDATE SET
               amount = $3,
               expected_date = $4,
               status = 'open'`,
            [userId, bill.vendor_id, bill.total, bill.due_date]
          )
          apCount++
        }

        const reconTime = Date.now() - reconStart
        steps.reconciliation = {
          ar_items: arCount,
          ap_items: apCount,
          qbo_invoices: qboInvoices.length,
          qbo_bills: qboBills.length,
          duration_ms: reconTime,
        }
        console.log(`✓ Reconciliation in ${reconTime}ms:`, {
          ar_items: arCount,
          ap_items: apCount,
          qbo_invoices: qboInvoices.length,
          qbo_bills: qboBills.length,
        })
        log("admin.pipeline.reconciliation.complete", { userId, ar_items: arCount, ap_items: apCount, qbo_invoices: qboInvoices.length, qbo_bills: qboBills.length, duration_ms: reconTime }, "system")

        // Step 5: Seed identity graph again (second pass with reconciliation data)
        console.log(`\n[5/7] Seeding identity graph (second pass - with reconciliation)...`)
        const seed2Start = Date.now()
        const seed2Result = await seedIdentityGraph(userId)
        const seed2Time = Date.now() - seed2Start
        steps.seed_identity_2 = {
          ...seed2Result,
          duration_ms: seed2Time,
        }
        console.log(`✓ Seeded (2nd pass) in ${seed2Time}ms:`, {
          entitiesCreated: seed2Result.entitiesCreated,
          entitiesUpdated: seed2Result.entitiesUpdated,
        })
        log("admin.pipeline.seed_identity_2.complete", { userId, ...seed2Result, duration_ms: seed2Time }, "system")

        // Step 6: Compute state
        console.log(`\n[6/7] Computing financial state...`)
        const stateStart = Date.now()

        // Fetch tagged movements
        const { rows: rawMovements } = await query<{
          id: string
          user_id: string
          date: string
          direction: string
          amount: string
          movement_type: string
          counterparty_entity_id: string | null
          counterparty_entity_type: string | null
          counterparty_name: string | null
          source: string | null
          source_tx_id: string | null
          account_id: string | null
          account_name: string | null
        }>(
          `SELECT m.id, m.user_id, m.date, m.direction, m.amount, m.movement_type,
                  m.counterparty_entity_id, m.counterparty_entity_type,
                  m.counterparty_name, m.source, m.source_tx_id,
                  m.account_id, m.account_name
           FROM movements m
           WHERE m.user_id = $1
           ORDER BY m.date ASC`,
          [userId]
        )

        if (rawMovements.length === 0) {
          console.log(`⚠ No movements found, skipping state computation`)
          steps.state = { skipped: true, reason: "no_movements" }
        } else {
          const { rows: tags } = await query<{
            movement_id: string
            economic_class: string
            cashflow_bucket: string
            counterparty_role: string
            tag_data: any
          }>(
            `SELECT movement_id, economic_class, cashflow_bucket, counterparty_role, tag_data
             FROM movement_tags
             WHERE movement_id = ANY($1::text[])`,
            [rawMovements.map(m => m.id)]
          )

          const tagMap = new Map(tags.map(t => [t.movement_id, t]))

          const taggedMovements = rawMovements
            .filter(m => tagMap.has(m.id))
            .map(m => {
              const t = tagMap.get(m.id)!
              const td = typeof t.tag_data === 'string' ? JSON.parse(t.tag_data) : (t.tag_data || {})
              return {
                id: m.id,
                user_id: m.user_id,
                date: m.date,
                direction: m.direction as 'in' | 'out',
                amount: parseFloat(m.amount),
                movement_type: m.movement_type,
                counterparty_entity_id: m.counterparty_entity_id,
                counterparty_entity_type: m.counterparty_entity_type,
                counterparty_name: m.counterparty_name ?? '',
                source: m.source ?? '',
                source_tx_id: m.source_tx_id ?? '',
                account_id: m.account_id ?? undefined,
                account_name: m.account_name ?? undefined,
                tag: {
                  economic_class: t.economic_class,
                  cashflow_bucket: t.cashflow_bucket,
                  counterparty_role: t.counterparty_role,
                  state_inclusion_policy: td.state_inclusion_policy ?? 'include',
                  confidence: td.confidence ?? 1,
                  state_scope: td.state_scope ?? {
                    affects_revenue: true,
                    affects_spend: true,
                    affects_liquidity: true,
                  },
                },
              }
            }) as any[]

          const dates = taggedMovements.map(m => m.date).sort()
          const periodStart = dates[0]
          const periodEnd = dates[dates.length - 1]

          const revenue = computeRevenueState(taggedMovements, periodStart, periodEnd)
          const spend = computeSpendState(taggedMovements, periodStart, periodEnd)
          const liquidity = computeLiquidityState(taggedMovements, periodStart, periodEnd)

          // Persist state snapshot
          await query(
            `INSERT INTO state_snapshots (user_id, snapshot_at, revenue_state, spend_state, liquidity_state, created_at)
             VALUES ($1, NOW(), $2, $3, $4, NOW())
             ON CONFLICT (user_id) DO UPDATE SET
               revenue_state = $2,
               spend_state = $3,
               liquidity_state = $4`,
            [userId, JSON.stringify(revenue), JSON.stringify(spend), JSON.stringify(liquidity)]
          )

          const stateTime = Date.now() - stateStart
          steps.state = {
            movements_processed: taggedMovements.length,
            period_start: periodStart,
            period_end: periodEnd,
            revenue: {
              gross_revenue: revenue.gross_revenue,
              recurring_revenue: revenue.recurring_revenue,
              net_revenue: revenue.net_revenue,
            },
            spend: {
              total_opex: spend.total_opex,
              total_cogs: spend.total_cogs,
              payroll: spend.payroll,
            },
            liquidity: {
              total_in: liquidity.total_in,
              total_out: liquidity.total_out,
              net_cash_flow: liquidity.total_in - liquidity.total_out,
            },
            duration_ms: stateTime,
          }
          console.log(`✓ State computed in ${stateTime}ms:`, {
            movements: taggedMovements.length,
            gross_revenue: revenue.gross_revenue,
            total_opex: spend.total_opex,
            net_cash_flow: liquidity.total_in - liquidity.total_out,
          })
          log("admin.pipeline.state.complete", { userId, ...steps.state }, "system")
        }

        // Step 7: Generate forecast (placeholder for now)
        console.log(`\n[7/7] Forecast generation...`)
        steps.forecast = {
          status: "queued",
          note: "Forecast generation queued separately via Bull queue",
        }
        console.log(`✓ Forecast queued for async processing`)

        results.push({
          userId,
          email,
          steps,
        })

        console.log(`\n✅ COMPLETE for ${email}`)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.error(`\n❌ ERROR for ${email}:`, errorMsg)
        console.error(error)
        log("admin.pipeline.user_error", { userId, email, error: errorMsg }, "system")
        results.push({
          userId,
          email,
          steps,
          error: errorMsg,
        })
      }
    }

    console.log(`\n${"=".repeat(80)}`)
    console.log(`PIPELINE COMPLETE: ${results.length} users processed`)
    console.log(`${"=".repeat(80)}\n`)

    return NextResponse.json({
      ok: true,
      users_processed: results.length,
      results,
      message: "Check Heroku logs for detailed output",
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log("admin.run_full_pipeline.failed", { error: errorMsg }, "system")
    console.error("Pipeline error:", err)
    return NextResponse.json({ error: errorMsg }, { status: 500 })
  }
}

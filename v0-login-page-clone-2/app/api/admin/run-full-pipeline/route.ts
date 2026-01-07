/**
 * POST /api/admin/run-full-pipeline
 * 
 * Runs the complete data processing pipeline for all users:
 * 1. Entity graphing (identity seed)
 * 2. Movement classification
 * 3. Movement tagging
 * 4. State computation (revenue, spend, liquidity)
 * 5. Reconciliation (AR/AP)
 * 6. Cashflow forecast
 * 
 * Logs detailed results at each step for debugging.
 * Requires x-clean-db-secret header.
 */

import { NextRequest, NextResponse } from "next/server"
import { query, ensureAuthSchema } from "@/lib/db"
import { log } from "@/lib/logger"
import { seedIdentityGraph } from "@/lib/identity-seed"
import { classifyMovements } from "@/lib/movement-classify"
import { tagMovements } from "@/lib/movement-tag-enrich"
import { computeRevenueState, computeSpendState, computeLiquidityState } from "@/lib/state/compute"
import { computeCashflowForecast } from "@/lib/state/forecast-engine"

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

    log("admin.run_full_pipeline.start", { userCount: users.length }, "system")

    const results: Array<{
      userId: string
      email: string
      steps: Record<string, any>
      error?: string
    }> = []

    for (const user of users) {
      const userResults: any = {
        userId: user.id,
        email: user.email,
        steps: {},
      }

      try {
        console.log(`\n${'='.repeat(80)}`)
        console.log(`Processing user: ${user.email} (${user.id})`)
        console.log(`${'='.repeat(80)}`)

        // Step 1: Entity Graphing (Identity Seed)
        console.log(`\n[1/6] Entity Graphing...`)
        try {
          const identityResult = await seedIdentityGraph(user.id)
          userResults.steps.identity = identityResult
          console.log(`✓ Identity seed complete:`, identityResult)
          log("admin.run_full_pipeline.identity_complete", { userId: user.id, ...identityResult }, "system")
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          userResults.steps.identity = { error: msg }
          console.error(`✗ Identity seed failed:`, msg)
          log("admin.run_full_pipeline.identity_error", { userId: user.id, error: msg }, "system")
        }

        // Step 2: Classify Movements
        console.log(`\n[2/6] Classifying movements...`)
        try {
          const classifyResult = await classifyMovements(user.id)
          userResults.steps.classify = classifyResult
          console.log(`✓ Classification complete:`, classifyResult)
          log("admin.run_full_pipeline.classify_complete", { userId: user.id, ...classifyResult }, "system")
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          userResults.steps.classify = { error: msg }
          console.error(`✗ Classification failed:`, msg)
          log("admin.run_full_pipeline.classify_error", { userId: user.id, error: msg }, "system")
        }

        // Step 3: Tag Movements
        console.log(`\n[3/6] Tagging movements...`)
        try {
          const tagResult = await tagMovements(user.id)
          userResults.steps.tag = {
            total: tagResult.stats.total,
            deterministic: tagResult.stats.deterministic,
            identity_aware: tagResult.stats.identity_aware,
            inferred: tagResult.stats.inferred,
            recurring: tagResult.stats.recurring,
            anomalies: tagResult.stats.anomalies,
            policy_include: tagResult.stats.policy_include,
            policy_provisional: tagResult.stats.policy_provisional,
            policy_exclude: tagResult.stats.policy_exclude,
          }
          console.log(`✓ Tagging complete:`, userResults.steps.tag)
          log("admin.run_full_pipeline.tag_complete", { userId: user.id, ...userResults.steps.tag }, "system")
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          userResults.steps.tag = { error: msg }
          console.error(`✗ Tagging failed:`, msg)
          log("admin.run_full_pipeline.tag_error", { userId: user.id, error: msg }, "system")
        }

        // Step 4: Compute State
        console.log(`\n[4/6] Computing financial state...`)
        try {
          const { rows: rawMovements } = await query<any>(
            `SELECT m.id, m.user_id, m.date, m.direction, m.amount, m.movement_type,
                    m.counterparty_entity_id, m.counterparty_entity_type,
                    m.counterparty_name, m.source, m.source_tx_id,
                    m.account_id, m.account_name
             FROM movements m
             WHERE m.user_id = $1
             ORDER BY m.date ASC`,
            [user.id]
          )

          if (rawMovements.length === 0) {
            userResults.steps.state = { skipped: "no_movements" }
            console.log(`⊘ State computation skipped: no movements`)
          } else {
            const { rows: tags } = await query<any>(
              `SELECT movement_id, economic_class, cashflow_bucket, counterparty_role, tag_data
               FROM movement_tags
               WHERE movement_id = ANY($1::text[])`,
              [rawMovements.map((m: any) => m.id)]
            )

            const tagMap = new Map(tags.map((t: any) => [t.movement_id, t]))
            const taggedMovements = rawMovements
              .filter((m: any) => tagMap.has(m.id))
              .map((m: any) => {
                const t = tagMap.get(m.id)!
                const td = typeof t.tag_data === "string" ? JSON.parse(t.tag_data) : (t.tag_data || {})
                return {
                  id: m.id,
                  user_id: m.user_id,
                  date: m.date,
                  direction: m.direction as "in" | "out",
                  amount: parseFloat(m.amount),
                  movement_type: m.movement_type,
                  counterparty_entity_id: m.counterparty_entity_id,
                  counterparty_entity_type: m.counterparty_entity_type,
                  counterparty_name: m.counterparty_name ?? "",
                  source: m.source ?? "",
                  source_tx_id: m.source_tx_id ?? "",
                  account_id: m.account_id ?? undefined,
                  account_name: m.account_name ?? undefined,
                  tag: {
                    economic_class: t.economic_class,
                    cashflow_bucket: t.cashflow_bucket,
                    counterparty_role: t.counterparty_role,
                    state_inclusion_policy: td.state_inclusion_policy ?? "include",
                    confidence: td.confidence ?? 1,
                    state_scope: td.state_scope ?? {
                      affects_revenue: true,
                      affects_spend: true,
                      affects_liquidity: true,
                    },
                  },
                }
              })

            const dates = taggedMovements.map((m: any) => m.date).sort()
            const periodStart = dates[0]
            const periodEnd = dates[dates.length - 1]

            const revenue = computeRevenueState(taggedMovements as any, periodStart, periodEnd)
            const spend = computeSpendState(taggedMovements as any, periodStart, periodEnd)
            const liquidity = computeLiquidityState(taggedMovements as any, periodStart, periodEnd)

            await query(
              `INSERT INTO state_snapshots (user_id, snapshot_at, revenue_state, spend_state, liquidity_state, created_at)
               VALUES ($1, NOW(), $2, $3, $4, NOW())
               ON CONFLICT (user_id) DO UPDATE SET
                 revenue_state = $2,
                 spend_state = $3,
                 liquidity_state = $4`,
              [user.id, JSON.stringify(revenue), JSON.stringify(spend), JSON.stringify(liquidity)]
            )

            userResults.steps.state = {
              movements_processed: taggedMovements.length,
              period_start: periodStart,
              period_end: periodEnd,
              revenue_gross: revenue.gross_revenue,
              spend_total: spend.total_opex,
              liquidity_total_in: liquidity.total_in,
              liquidity_total_out: liquidity.total_out,
            }
            console.log(`✓ State computation complete:`, userResults.steps.state)
            log("admin.run_full_pipeline.state_complete", { userId: user.id, ...userResults.steps.state }, "system")
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          userResults.steps.state = { error: msg }
          console.error(`✗ State computation failed:`, msg)
          log("admin.run_full_pipeline.state_error", { userId: user.id, error: msg }, "system")
        }

        // Step 5: Reconciliation (AR/AP)
        console.log(`\n[5/6] Running reconciliation...`)
        try {
          const { rows: arItems } = await query<any>(
            `SELECT id, entity_id, amount, expected_date FROM cash_events
             WHERE user_id = $1 AND event_type = 'ar'`,
            [user.id]
          )
          const { rows: apItems } = await query<any>(
            `SELECT id, entity_id, amount, expected_date FROM cash_events
             WHERE user_id = $1 AND event_type = 'ap'`,
            [user.id]
          )

          userResults.steps.reconciliation = {
            ar_items: arItems.length,
            ap_items: apItems.length,
          }
          console.log(`✓ Reconciliation data ready:`, userResults.steps.reconciliation)
          log("admin.run_full_pipeline.reconciliation_complete", { userId: user.id, ...userResults.steps.reconciliation }, "system")
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          userResults.steps.reconciliation = { error: msg }
          console.error(`✗ Reconciliation failed:`, msg)
          log("admin.run_full_pipeline.reconciliation_error", { userId: user.id, error: msg }, "system")
        }

        // Step 6: Forecast
        console.log(`\n[6/6] Generating forecast...`)
        try {
          const { rows: movements } = await query<any>(
            `SELECT id, amount, direction, date FROM movements WHERE user_id = $1 ORDER BY date DESC`,
            [user.id]
          )
          const { rows: tags } = await query<any>(
            `SELECT movement_id, economic_class, cashflow_bucket FROM movement_tags WHERE movement_id = ANY($1::text[])`,
            [movements.map((m: any) => m.id)]
          )
          const { rows: arItems } = await query<any>(
            `SELECT entity_id, amount, expected_date FROM cash_events WHERE user_id = $1 AND event_type = 'ar'`,
            [user.id]
          )
          const { rows: apItems } = await query<any>(
            `SELECT entity_id, amount, expected_date FROM cash_events WHERE user_id = $1 AND event_type = 'ap'`,
            [user.id]
          )

          if (movements.length === 0) {
            userResults.steps.forecast = { skipped: "no_movements" }
            console.log(`⊘ Forecast skipped: no movements`)
          } else {
            const tagMap = new Map(tags.map((t: any) => [t.movement_id, t]))
            const taggedMovements = movements
              .filter((m: any) => tagMap.has(m.id))
              .map((m: any) => {
                const t = tagMap.get(m.id)!
                return {
                  ...m,
                  tag: {
                    economic_class: t.economic_class,
                    cashflow_bucket: t.cashflow_bucket,
                    counterparty_role: "",
                    state_inclusion_policy: "include",
                    confidence: 1,
                    state_scope: { affects_revenue: true, affects_spend: true, affects_liquidity: true },
                  },
                }
              })

            const forecast = await computeCashflowForecast(
              taggedMovements as any,
              0,
              6,
              arItems as any,
              undefined,
              apItems as any,
              null,
              null,
              [],
              {},
              [],
              [],
              [],
              [],
              null,
              user.id
            )

            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
            await query(
              `INSERT INTO forecast_cache (user_id, forecast_data, computed_at, expires_at, movement_count, invoice_count, bill_count, starting_cash)
               VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7)
               ON CONFLICT (user_id) DO UPDATE SET
                 forecast_data = $2,
                 computed_at = NOW(),
                 expires_at = $3,
                 movement_count = $4,
                 invoice_count = $5,
                 bill_count = $6,
                 starting_cash = $7`,
              [user.id, JSON.stringify(forecast), expiresAt, movements.length, arItems.length, apItems.length, 0]
            )

            userResults.steps.forecast = {
              movements_processed: taggedMovements.length,
              scenarios: (forecast as any).scenarios?.length ?? 0,
              has_summary: !!(forecast as any).summary,
            }
            console.log(`✓ Forecast complete:`, userResults.steps.forecast)
            log("admin.run_full_pipeline.forecast_complete", { userId: user.id, ...userResults.steps.forecast }, "system")
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          userResults.steps.forecast = { error: msg }
          console.error(`✗ Forecast failed:`, msg)
          log("admin.run_full_pipeline.forecast_error", { userId: user.id, error: msg }, "system")
        }

        results.push(userResults)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        userResults.error = msg
        console.error(`✗ User processing failed:`, msg)
        log("admin.run_full_pipeline.user_error", { userId: user.id, error: msg }, "system")
        results.push(userResults)
      }
    }

    console.log(`\n${'='.repeat(80)}`)
    console.log(`Pipeline complete for ${results.length} users`)
    console.log(`${'='.repeat(80)}\n`)

    log("admin.run_full_pipeline.complete", { userCount: results.length, successCount: results.filter(r => !r.error).length }, "system")

    return NextResponse.json({
      ok: true,
      userCount: results.length,
      results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log("admin.run_full_pipeline.failed", { error: msg }, "system")
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

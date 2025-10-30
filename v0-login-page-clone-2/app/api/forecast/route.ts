import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema, ensureQBOSchema } from "@/lib/db"
import { toMovementClass, computeStatePolicy, computeStateScope } from "@/lib/movement-types"
import type { CanonicalMovement, MovementTag, ReviewReason } from "@/lib/movement-types"
import type { OutstandingInvoice, OutstandingBill, AccountBalance, ForecastContext, TransitionSignal } from "@/lib/state/types"
import { computeCashflowForecast } from "@/lib/state/forecast-engine"
import type { IdentityContext } from "@/lib/state/forecast-engine"
import { computeBusinessState } from "@/lib/state"
import { generateNarrativeWithLLM, canonicalizeEntitiesBatch, generateExecutionSuggestions } from "@/lib/forecast-llm"
import { fetchOutstandingBills } from "@/lib/bills-fetch"
import { computeAPStateFromBills } from "@/lib/state/ar-ap"
import { syncCashEventsForUser, fetchCashEventsForUser30d, cashEventRowsToForecastEvents } from "@/lib/cash-events-build"

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await ensureMovementsSchema()

    type PlaidAcct = { account_id: string; name: string; type: string; subtype: string; current_balance: number | null; available_balance: number | null }
    const acctByName = new Map<string, PlaidAcct>()
    let plaidTotalBalance: number | null = null
    try {
      const acctRows = await query<PlaidAcct>(
        `SELECT pa.account_id, pa.name, pa.type, pa.subtype,
                pa.current_balance::float, pa.available_balance::float
         FROM plaid_accounts pa JOIN plaid_items pi ON pa.item_id = pi.item_id
         WHERE pi.user_id = $1`,
        [user.id]
      ).then((r) => r.rows)
      let balSum = 0
      let hasBalance = false
      for (const a of acctRows) {
        if (a.name) acctByName.set(a.name, a)
        acctByName.set(a.account_id, a)
        const bal = a.current_balance ?? a.available_balance
        if (bal != null && (a.type === "depository")) {
          balSum += bal
          hasBalance = true
        }
      }
      if (hasBalance) plaidTotalBalance = balSum
    } catch { /* plaid_accounts may not exist yet */ }

    const movementRows = await query<CanonicalMovement & { movement_type: string }>(
      `SELECT m.id, m.user_id, m.date AS occurred_at, m.direction, m.amount::float,
              m.currency, m.raw_description, m.movement_type,
              m.counterparty_entity_id AS entity_id,
              COALESCE(NULLIF(TRIM(m.cash_account_id), ''),
                (SELECT mo.account_name FROM movement_observations mo WHERE mo.movement_id = m.id AND mo.account_name IS NOT NULL AND TRIM(mo.account_name) != '' LIMIT 1)
              ) AS account_id,
              m.pnl_eligible, m.confidence, m.review_needed AS needs_review,
              m.provenance, m.coalesced_group_id, m.metadata
       FROM movements m WHERE m.user_id = $1 AND m.duplicate_of IS NULL
       ORDER BY m.date ASC`,
      [user.id]
    ).then((r) => r.rows.map((row) => {
      const conf = (row.confidence as unknown as Record<string, number>) ?? {}
      const md = (row.metadata ?? {}) as Record<string, unknown>
      const acctName = row.account_id ?? null
      const acctInfo = acctByName.get(acctName ?? "")
      return {
        ...row,
        amount: typeof row.amount === "string" ? parseFloat(row.amount) : row.amount,
        movement_class: toMovementClass(row.movement_type ?? "unknown"),
        movement_type_detail: row.movement_type ?? "unknown",
        source_record_ids: [],
        confidence: conf.score ?? 0,
        evidence_strength: conf.evidence_strength ?? 0,
        review_reasons: (Array.isArray(md.review_reasons) ? md.review_reasons : []) as ReviewReason[],
        metadata: {
          ...md,
          cash_account_name: acctName,
          account_type: acctInfo?.type ?? md.account_type ?? "",
          account_subtype: acctInfo?.subtype ?? md.account_subtype ?? null,
        },
      } as CanonicalMovement
    }))

    type TagRow = { movement_id: string; economic_class: string; cashflow_bucket: string; counterparty_role: string; tag_data: Record<string, unknown> }
    const tagRows = await query<TagRow>(
      `SELECT movement_id, economic_class, cashflow_bucket, counterparty_role, tag_data
       FROM movement_tags WHERE movement_id IN (SELECT id FROM movements WHERE user_id = $1)`,
      [user.id]
    ).then((r) => r.rows)

    const tagMap = new Map<string, TagRow>()
    for (const t of tagRows) tagMap.set(t.movement_id, t)

    const SYSTEM_MOVEMENT_TYPES = new Set(["opening_balance", "account_verification", "balance_adjustment"])
    type TaggedMovement = CanonicalMovement & { tag: MovementTag }
    const tagged: TaggedMovement[] = []
    for (const m of movementRows) {
      if (SYSTEM_MOVEMENT_TYPES.has(m.movement_type ?? "")) continue
      const tr = tagMap.get(m.id)
      if (!tr) continue
      const td = tr.tag_data ?? {}
      const tag: MovementTag = {
        movement_id: m.id,
        economic_class: tr.economic_class as MovementTag["economic_class"],
        cashflow_bucket: tr.cashflow_bucket as MovementTag["cashflow_bucket"],
        counterparty_role: tr.counterparty_role as MovementTag["counterparty_role"],
        is_operating: (td.is_operating as boolean) ?? false,
        is_financing: (td.is_financing as boolean) ?? false,
        is_investing: (td.is_investing as boolean) ?? false,
        is_owner_related: (td.is_owner_related as boolean) ?? false,
        hits_pnl: (td.hits_pnl as boolean) ?? false,
        hits_working_capital: (td.hits_working_capital as boolean) ?? false,
        state_scope: (td.state_scope as MovementTag["state_scope"]) ?? computeStateScope(
          tr.economic_class as MovementTag["economic_class"],
          tr.cashflow_bucket as MovementTag["cashflow_bucket"],
          (td.hits_working_capital as boolean) ?? false,
        ),
        state_inclusion_policy: (td.state_inclusion_policy as MovementTag["state_inclusion_policy"]) ?? computeStatePolicy(m.confidence, m.evidence_strength, m.needs_review, tr.economic_class),
        classification_confidence: m.confidence,
        evidence_strength: m.evidence_strength,
        needs_review: m.needs_review,
        review_reasons: m.review_reasons,
        entity_id: m.entity_id,
        customer_id: (td.customer_id as string) ?? null,
        vendor_id: (td.vendor_id as string) ?? null,
        processor_id: (td.processor_id as string) ?? null,
        account_id: m.account_id,
        order_id: (td.order_id as string) ?? null,
        invoice_id: (td.invoice_id as string) ?? null,
        bill_id: (td.bill_id as string) ?? null,
        recurrence_family_id: (td.recurrence_family_id as string) ?? null,
        is_recurring: (td.is_recurring as boolean) ?? false,
        is_anomaly: (td.is_anomaly as boolean) ?? false,
        is_large_outlier: (td.is_large_outlier as boolean) ?? false,
        is_first_seen_counterparty: (td.is_first_seen_counterparty as boolean) ?? false,
      }
      tagged.push({ ...m, tag })
    }

    // Starting cash: prefer real Plaid account balances, fall back to cumulative net
    let startingCash: number
    if (plaidTotalBalance != null) {
      startingCash = plaidTotalBalance
    } else {
      startingCash = 0
      for (const m of tagged) {
        startingCash += (m.direction === "inflow" || m.direction === ("in" as string)) ? m.amount : -m.amount
      }
    }

    // Fetch outstanding invoices from QBO and Xero
    const outstandingInvoices: OutstandingInvoice[] = []
    const today = new Date().toISOString().slice(0, 10)

    // Build entity alias lookup: QBO source_id → entity_id
    const sourceIdToEntity = new Map<string, string>()
    try {
      const aliasRows = await query<{ entity_id: string; source_id: string }>(
        `SELECT ea.entity_id, ea.source_id FROM entity_aliases ea
         JOIN entities e ON e.id = ea.entity_id
         WHERE e.user_id = $1 AND ea.source = 'qbo' AND ea.source_id IS NOT NULL`,
        [user.id]
      ).then((r) => r.rows)
      for (const a of aliasRows) {
        if (a.source_id) sourceIdToEntity.set(a.source_id, a.entity_id)
      }
    } catch { /* entity_aliases may not exist yet */ }

    // QBO Invoices
    try {
      await ensureQBOSchema()
      type QboInvRow = { entity_id: string; data: Record<string, unknown> }
      const invRows = await query<QboInvRow>(
        `SELECT e.entity_id, e.data FROM qbo_entities e
         JOIN qbo_connections c ON c.realm_id = e.realm_id
         WHERE c.user_id = $1 AND e.entity_type = 'Invoice'`,
        [user.id]
      ).then((r) => r.rows)

      for (const row of invRows) {
        const d = row.data
        const balance = parseFloat(String(d.Balance ?? 0))
        if (balance <= 0) continue

        const totalAmt = parseFloat(String(d.TotalAmt ?? balance))
        const custRef = d.CustomerRef as Record<string, unknown> | undefined
        const custName = String(custRef?.name ?? custRef?.value ?? "Unknown")
        const custSourceId = custRef?.value != null ? String(custRef.value) : null
        const dueDate = (d.DueDate as string) ?? null

        let daysToDue: number | null = null
        let daysOverdue: number | null = null
        let status: OutstandingInvoice["status"] = "open"

        if (dueDate) {
          const dueMs = new Date(dueDate).getTime()
          const todayMs = new Date(today).getTime()
          const diffDays = Math.round((dueMs - todayMs) / 86_400_000)
          if (diffDays < 0) {
            daysOverdue = Math.abs(diffDays)
            status = "overdue"
            daysToDue = null
          } else {
            daysToDue = diffDays
            daysOverdue = null
          }
        }

        if (balance < totalAmt && balance > 0) status = "partially_paid"

        const entityId = custSourceId ? (sourceIdToEntity.get(custSourceId) ?? null) : null

        outstandingInvoices.push({
          invoice_id: row.entity_id,
          source: "qbo",
          customer_name: custName,
          customer_source_id: custSourceId,
          entity_id: entityId,
          amount: totalAmt,
          amount_due: balance,
          due_date: dueDate,
          days_until_due: daysToDue,
          days_overdue: daysOverdue,
          status,
        })
      }
    } catch { /* QBO invoices may not be available */ }

    // Xero Invoices (xero_entities links via tenant_id → xero_connections)
    try {
      type XeroInvRow = { entity_id: string; data: Record<string, unknown> }
      const xeroRows = await query<XeroInvRow>(
        `SELECT e.entity_id, e.data FROM xero_entities e
         JOIN xero_connections xc ON xc.tenant_id = e.tenant_id
         WHERE xc.user_id = $1 AND e.entity_type = 'Invoice'`,
        [user.id]
      ).then((r) => r.rows)

      for (const row of xeroRows) {
        const d = row.data
        const amountDue = parseFloat(String(d.AmountDue ?? 0))
        if (amountDue <= 0) continue

        const total = parseFloat(String(d.Total ?? amountDue))
        const contact = d.Contact as Record<string, unknown> | undefined
        const custName = String(contact?.Name ?? "Unknown")
        const dueDate = (d.DueDateString as string) ?? (d.DueDate as string) ?? null

        let daysToDue: number | null = null
        let daysOverdue: number | null = null
        let status: OutstandingInvoice["status"] = "open"

        if (dueDate) {
          const cleanDate = dueDate.slice(0, 10)
          const dueMs = new Date(cleanDate).getTime()
          const todayMs = new Date(today).getTime()
          const diffDays = Math.round((dueMs - todayMs) / 86_400_000)
          if (diffDays < 0) {
            daysOverdue = Math.abs(diffDays)
            status = "overdue"
          } else {
            daysToDue = diffDays
          }
        }

        if (amountDue < total && amountDue > 0) status = "partially_paid"

        outstandingInvoices.push({
          invoice_id: row.entity_id,
          source: "xero",
          customer_name: custName,
          customer_source_id: null,
          entity_id: null,
          amount: total,
          amount_due: amountDue,
          due_date: dueDate?.slice(0, 10) ?? null,
          days_until_due: daysToDue,
          days_overdue: daysOverdue,
          status,
        })
      }
    } catch { /* Xero invoices may not be available */ }

    // Gmail extracted invoices (AR side only)
    try {
      type GmailInvRow = { extracted_invoice: Record<string, unknown> }
      const gmailRows = await query<GmailInvRow>(
        `SELECT extracted_invoice FROM gmail_synced_messages
         WHERE user_id = $1 AND extracted_invoice IS NOT NULL
         AND extracted_invoice->>'side' = 'AR'
         AND extracted_invoice->>'status' IN ('open', 'partially_paid')`,
        [user.id]
      ).then((r) => r.rows)

      for (const row of gmailRows) {
        const d = row.extracted_invoice
        const amountDue = parseFloat(String(d.amount_outstanding ?? d.total ?? 0))
        if (amountDue <= 0) continue

        const total = parseFloat(String(d.total ?? amountDue))
        const custName = String(d.counterparty_name ?? "Unknown")
        const dueDate = (d.due_date as string) ?? null

        let daysToDue: number | null = null
        let daysOverdue: number | null = null
        let status: OutstandingInvoice["status"] = "open"

        if (dueDate) {
          const dueMs = new Date(dueDate).getTime()
          const todayMs = new Date(today).getTime()
          const diffDays = Math.round((dueMs - todayMs) / 86_400_000)
          if (diffDays < 0) { daysOverdue = Math.abs(diffDays); status = "overdue" }
          else { daysToDue = diffDays }
        }

        outstandingInvoices.push({
          invoice_id: `gmail_${d.invoice_number ?? Date.now()}`,
          source: "gmail",
          customer_name: custName,
          customer_source_id: null,
          entity_id: null,
          amount: total,
          amount_due: amountDue,
          due_date: dueDate,
          days_until_due: daysToDue,
          days_overdue: daysOverdue,
          status,
        })
      }
    } catch { /* Gmail invoices may not be available */ }

    // ── Stripe outstanding invoices (AR) ──
    try {
      type StripeInvRow = { entity_id: string; data: Record<string, unknown> }
      const stripeRows = await query<StripeInvRow>(
        `SELECT se.entity_id, se.data FROM stripe_entities se
         WHERE se.user_id = $1 AND se.entity_type = 'invoice'`,
        [user.id]
      ).then((r) => r.rows)
      for (const row of stripeRows) {
        const d = row.data
        const amountDue = parseFloat(String(d.amount_due ?? 0)) / 100
        if (amountDue <= 0) continue
        const total = parseFloat(String(d.total ?? d.amount_due ?? 0)) / 100
        const custEmail = String((d.customer_email as string) ?? "")
        const custName = String(d.customer_name ?? custEmail ?? "Unknown")
        const dueTimestamp = d.due_date as number | null
        const dueDate = dueTimestamp ? new Date(dueTimestamp * 1000).toISOString().slice(0, 10) : null
        let daysToDue: number | null = null
        let daysOverdue: number | null = null
        let status: OutstandingInvoice["status"] = "open"
        if (dueDate) {
          const diff = Math.round((new Date(dueDate).getTime() - new Date(today).getTime()) / 86_400_000)
          if (diff < 0) { daysOverdue = Math.abs(diff); status = "overdue" }
          else daysToDue = diff
        }
        if (amountDue < total && amountDue > 0) status = "partially_paid"
        outstandingInvoices.push({
          invoice_id: row.entity_id, source: "stripe",
          customer_name: custName, customer_source_id: String(d.customer ?? ""),
          entity_id: null, amount: total, amount_due: amountDue,
          due_date: dueDate, days_until_due: daysToDue,
          days_overdue: daysOverdue, status,
        })
      }
    } catch { /* Stripe invoices may not be available */ }

    // Stripe subscriptions → recurring revenue signals
    try {
      type StripeSubRow = { entity_id: string; data: Record<string, unknown> }
      const subRows = await query<StripeSubRow>(
        `SELECT se.entity_id, se.data FROM stripe_entities se
         WHERE se.user_id = $1 AND se.entity_type = 'subscription'
         AND se.data->>'status' IN ('active', 'trialing')`,
        [user.id]
      ).then((r) => r.rows)
      for (const row of subRows) {
        const d = row.data
        const plan = d.plan as Record<string, unknown> | undefined
        const amount = plan ? parseFloat(String(plan.amount ?? 0)) / 100 : 0
        if (amount <= 0) continue
        const interval = String(plan?.interval ?? "month")
        const custName = String(d.customer_name ?? d.customer_email ?? "Stripe subscriber")
        const currentPeriodEnd = d.current_period_end as number | null
        const nextDate = currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString().slice(0, 10) : null
        if (nextDate) {
          const offset = Math.round((new Date(nextDate).getTime() - new Date(today).getTime()) / 86_400_000)
          if (offset >= 0 && offset <= 30) {
            outstandingInvoices.push({
              invoice_id: `stripe_sub_${row.entity_id}`,
              source: "stripe",
              customer_name: custName,
              customer_source_id: String(d.customer ?? ""),
              entity_id: null,
              amount,
              amount_due: amount,
              due_date: nextDate,
              days_until_due: offset,
              days_overdue: null,
              status: "open",
            })
          }
        }
      }
    } catch { /* Stripe subscriptions may not be available */ }

    // ── Outstanding AP Bills (QBO, Xero, Gmail) ──
    const outstandingBills = await fetchOutstandingBills(user.id)

    // ── Per-account balances ──
    const accountBalances: AccountBalance[] = []
    for (const [, acct] of acctByName) {
      if (acct.type !== "depository") continue
      const bal = acct.current_balance ?? acct.available_balance
      if (bal == null) continue
      if (accountBalances.some((a) => a.account_id === acct.account_id)) continue
      accountBalances.push({
        account_id: acct.account_id, name: acct.name,
        type: acct.type, subtype: acct.subtype ?? null, balance: bal,
      })
    }

    // ── Load state/risk context for scenario biases ──
    let forecastCtx: ForecastContext = {
      risk_score: 0, risk_level: "low",
      risk_decomposition: undefined,
      concentration_risk_score: 0, dependency_risk_score: 0, liquidity_risk_score: 0,
      top_customer_pct: 0, repeat_revenue_ratio: 0,
      operating_dependency_ratio: 1, transfer_dependency_ratio: 0,
      recurring_spend_ratio: 0, liquidity_regime: "stable",
      transitions: [], balance_source: plaidTotalBalance != null ? "plaid" : "derived",
      account_balances: accountBalances,
    }
    try {
      const state = await computeBusinessState(user.id)
      const risk = state.risk
      forecastCtx = {
        risk_score: risk?.overall_score ?? 0,
        risk_level: risk?.overall ?? "low",
        risk_decomposition: risk ? {
          liquidity: risk.liquidity_risk?.score ?? 0,
          concentration: risk.concentration_risk?.score ?? 0,
          dependency: risk.dependency_risk?.score ?? 0,
          anomaly: risk.anomaly_risk?.score ?? 0,
          uncertainty: risk.uncertainty_risk?.score ?? 0,
        } : undefined,
        concentration_risk_score: risk?.concentration_risk?.score ?? 0,
        dependency_risk_score: risk?.dependency_risk?.score ?? 0,
        liquidity_risk_score: risk?.liquidity_risk?.score ?? 0,
        top_customer_pct: state.revenue?.top_customer_pct ?? 0,
        repeat_revenue_ratio: state.revenue?.repeat_revenue_ratio ?? 0,
        operating_dependency_ratio: state.liquidity?.operating_dependency_ratio ?? 1,
        transfer_dependency_ratio: state.liquidity?.transfer_dependency_ratio ?? 0,
        recurring_spend_ratio: state.spend?.total_spend > 0 ? (state.spend?.recurring_obligations ?? 0) / state.spend.total_spend : 0,
        liquidity_regime: state.liquidity?.liquidity_regime ?? "stable",
        transitions: (state.transitions ?? []) as TransitionSignal[],
        balance_source: plaidTotalBalance != null ? "plaid" : "derived",
        account_balances: accountBalances,
      }
    } catch { /* state computation may fail — use defaults */ }

    // Build rich identity context from the entity graph
    const identityCtx: IdentityContext = {
      entityNames: new Map(),
      entityTypes: new Map(),
      aliasToEntityId: new Map(),
      counterpartyByMovement: new Map(),
      familyMembers: new Map(),
    }

    try {
      const entityRows = await query<{ id: string; display_name: string | null; canonical_name: string; entity_type: string }>(
        `SELECT id, display_name, canonical_name, entity_type FROM entities WHERE user_id = $1`,
        [user.id]
      ).then((r) => r.rows)
      for (const e of entityRows) {
        const name = e.display_name || e.canonical_name
        if (name) identityCtx.entityNames.set(e.id, name)
        identityCtx.entityTypes.set(e.id, e.entity_type)
      }
    } catch { /* entities table may not exist */ }

    // All aliases → reverse map for entity deduplication
    try {
      const aliasRows = await query<{ entity_id: string; alias: string; alias_type: string }>(
        `SELECT ea.entity_id, ea.alias, ea.alias_type FROM entity_aliases ea
         JOIN entities e ON e.id = ea.entity_id WHERE e.user_id = $1`,
        [user.id]
      ).then((r) => r.rows)
      for (const a of aliasRows) {
        identityCtx.aliasToEntityId.set(`${a.alias_type}:${a.alias.toLowerCase()}`, a.entity_id)
      }
    } catch { /* entity_aliases may not exist */ }

    // Counterparty names from movement_observations (richer than raw_description)
    try {
      const obsRows = await query<{ movement_id: string; counterparty: string | null }>(
        `SELECT mo.movement_id, mo.counterparty FROM movement_observations mo
         WHERE mo.movement_id IN (SELECT id FROM movements WHERE user_id = $1)
           AND mo.counterparty IS NOT NULL AND TRIM(mo.counterparty) != ''`,
        [user.id]
      ).then((r) => r.rows)
      for (const o of obsRows) {
        if (o.counterparty) identityCtx.counterpartyByMovement.set(o.movement_id, o.counterparty)
      }
    } catch { /* movement_observations may not exist */ }

    // Movement family membership for recurrence grouping
    try {
      const famRows = await query<{ family_key: string; occurrence_count: number; dominant_type: string; pattern: string }>(
        `SELECT family_key, occurrence_count, dominant_type, pattern FROM movement_families WHERE user_id = $1`,
        [user.id]
      ).then((r) => r.rows)
      for (const f of famRows) {
        identityCtx.familyMembers.set(f.family_key, {
          occurrences: f.occurrence_count,
          dominantType: f.dominant_type,
          pattern: f.pattern,
        })
      }
    } catch { /* movement_families may not exist */ }

    try {
      const apObs = computeAPStateFromBills(outstandingBills)
      await syncCashEventsForUser(user.id, outstandingInvoices, apObs)
    } catch (err) {
      console.warn("[Forecast] cash_events sync skipped:", err instanceof Error ? err.message : err)
    }
    const bridgeRows = await fetchCashEventsForUser30d(user.id).catch(() => [])
    const bridgeEvents = cashEventRowsToForecastEvents(bridgeRows, today)

    let forecast = computeCashflowForecast(
      tagged,
      startingCash,
      6,
      outstandingInvoices,
      identityCtx,
      outstandingBills,
      forecastCtx,
      bridgeEvents,
    )

    // LLM enrichment when enabled (Heroku: set FORECAST_LLM_ENABLED=1)
    if (process.env.FORECAST_LLM_ENABLED) {
      try {
        const enrichedForecast = await generateNarrativeWithLLM(forecast.narrative, forecast.context)
        if (enrichedForecast) forecast = { ...forecast, narrative: { ...forecast.narrative, forecast: enrichedForecast } }

        const rawEntities = [...new Set(forecast.events_30d.map((e) => e.entity).filter(Boolean))] as string[]
        const canonicalMap = await canonicalizeEntitiesBatch(rawEntities)
        if (canonicalMap.size > 0) {
          forecast = {
            ...forecast,
            events_30d: forecast.events_30d.map((e) => {
              const canonical = canonicalMap.get(e.entity)
              return canonical ? { ...e, entity: canonical } : e
            }),
          }
        }

        const execSuggestions = await generateExecutionSuggestions(
          forecast.interventions.slice(0, 4).map((i) => ({ id: i.id, label: i.label, type: i.type, entity: i.entity })),
        )
        if (execSuggestions.length > 0) {
          forecast = { ...forecast, execution_suggestions: execSuggestions }
        }
      } catch (err) {
        console.warn("[Forecast] LLM enrichment failed:", err instanceof Error ? err.message : err)
      }
    }

    return NextResponse.json(forecast)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack : undefined
    console.error("❌ [Forecast] forecast.compute.failed", { error: msg, stack })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

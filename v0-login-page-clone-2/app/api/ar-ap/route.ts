// ─── AR/AP API: Step 12 only — uses data from steps 1–11 ─────────────
//
// DATA LINEAGE (must NOT touch steps 12–15):
//   Step 1–2:  Plaid → plaid_accounts
//   Step 3:    QBO, Xero, Stripe → qbo_entities, xero_entities, stripe_entities
//   Step 4:    Gmail → gmail_synced_messages
//   Step 9:    Identity → entities, entity_aliases
//   Step 10:   Money movements → movements, movement_observations
//   Step 11:   Business semantics → movement_tags, movement_families
//
// Does NOT use: state_snapshots, forecast, /api/state, /api/forecast

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema, ensureQBOSchema } from "@/lib/db"
import { toMovementClass, computeStatePolicy, computeStateScope } from "@/lib/movement-types"
import type { CanonicalMovement, MovementTag, ReviewReason } from "@/lib/movement-types"
import type { OutstandingInvoice } from "@/lib/state/types"
import { buildBehavioralModels, setIdentityContext } from "@/lib/state/forecast-engine"
import type { IdentityContext } from "@/lib/state/forecast-engine"
import { computeARState, computeAPState, computeAPStateFromBills, mergeAPObligations } from "@/lib/state/ar-ap"
import { fetchOutstandingBills } from "@/lib/bills-fetch"
import { getAllocationsForUser } from "@/lib/allocation-persist"

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await ensureMovementsSchema()

    type PlaidAcct = { account_id: string; name: string; type: string; subtype: string }
    const acctByName = new Map<string, PlaidAcct>()
    try {
      const acctRows = await query<PlaidAcct>(
        `SELECT pa.account_id, pa.name, pa.type, pa.subtype
         FROM plaid_accounts pa JOIN plaid_items pi ON pa.item_id = pi.item_id
         WHERE pi.user_id = $1`,
        [user.id]
      ).then((r) => r.rows)
      for (const a of acctRows) {
        if (a.name) acctByName.set(a.name, a)
        acctByName.set(a.account_id, a)
      }
    } catch { /* plaid_accounts may not exist */ }

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

    // ── Fetch outstanding invoices (AR sources: QBO, Xero, Stripe, Gmail) ──
    const outstandingInvoices: OutstandingInvoice[] = []
    const today = new Date().toISOString().slice(0, 10)

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
    } catch { /* entity_aliases may not exist */ }

    // QBO Invoices
    try {
      await ensureQBOSchema()
      const invRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
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
          const diff = Math.round((new Date(dueDate).getTime() - new Date(today).getTime()) / 86_400_000)
          if (diff < 0) { daysOverdue = Math.abs(diff); status = "overdue" }
          else daysToDue = diff
        }
        if (balance < totalAmt && balance > 0) status = "partially_paid"
        const entityId = custSourceId ? (sourceIdToEntity.get(custSourceId) ?? null) : null
        outstandingInvoices.push({
          invoice_id: row.entity_id, source: "qbo",
          customer_name: custName, customer_source_id: custSourceId,
          entity_id: entityId, amount: totalAmt, amount_due: balance,
          due_date: dueDate, days_until_due: daysToDue, days_overdue: daysOverdue, status,
        })
      }
    } catch { /* QBO invoices may not be available */ }

    // Xero Invoices
    try {
      const xeroRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
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
          const diff = Math.round((new Date(cleanDate).getTime() - new Date(today).getTime()) / 86_400_000)
          if (diff < 0) { daysOverdue = Math.abs(diff); status = "overdue" }
          else daysToDue = diff
        }
        if (amountDue < total && amountDue > 0) status = "partially_paid"
        outstandingInvoices.push({
          invoice_id: row.entity_id, source: "xero",
          customer_name: custName, customer_source_id: null,
          entity_id: null, amount: total, amount_due: amountDue,
          due_date: dueDate?.slice(0, 10) ?? null, days_until_due: daysToDue,
          days_overdue: daysOverdue, status,
        })
      }
    } catch { /* Xero invoices may not be available */ }

    // Gmail AR invoices
    try {
      const gmailRows = await query<{ extracted_invoice: Record<string, unknown> }>(
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
          const diff = Math.round((new Date(dueDate).getTime() - new Date(today).getTime()) / 86_400_000)
          if (diff < 0) { daysOverdue = Math.abs(diff); status = "overdue" }
          else daysToDue = diff
        }
        outstandingInvoices.push({
          invoice_id: `gmail_${d.invoice_number ?? Date.now()}`, source: "gmail",
          customer_name: custName, customer_source_id: null,
          entity_id: null, amount: total, amount_due: amountDue,
          due_date: dueDate, days_until_due: daysToDue, days_overdue: daysOverdue, status,
        })
      }
    } catch { /* Gmail invoices may not be available */ }

    // Stripe invoices
    try {
      const stripeRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
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

    // Stripe subscriptions → recurring AR
    try {
      const subRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
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
        const custName = String(d.customer_name ?? d.customer_email ?? "Stripe subscriber")
        const currentPeriodEnd = d.current_period_end as number | null
        const nextDate = currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString().slice(0, 10) : null
        if (nextDate) {
          const offset = Math.round((new Date(nextDate).getTime() - new Date(today).getTime()) / 86_400_000)
          if (offset >= 0 && offset <= 30) {
            outstandingInvoices.push({
              invoice_id: `stripe_sub_${row.entity_id}`, source: "stripe",
              customer_name: custName, customer_source_id: String(d.customer ?? ""),
              entity_id: null, amount, amount_due: amount,
              due_date: nextDate, days_until_due: offset, days_overdue: null, status: "open",
            })
          }
        }
      }
    } catch { /* Stripe subscriptions may not be available */ }

    // ── Behavioral AP: build models from movements, NO bills (we don't use QBO bills) ──
    const identityCtx: IdentityContext = {
      entityNames: new Map(),
      entityTypes: new Map(),
      aliasToEntityId: new Map(),
      counterpartyByMovement: new Map(),
      familyMembers: new Map(),
    }
    try {
      const entityRows = await query<{ id: string; display_name: string | null; canonical_name: string }>(
        `SELECT id, display_name, canonical_name FROM entities WHERE user_id = $1`,
        [user.id]
      ).then((r) => r.rows)
      for (const e of entityRows) {
        const name = e.display_name || e.canonical_name
        if (name) identityCtx.entityNames.set(e.id, name)
      }
    } catch { /* entities may not exist */ }

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

    const { setIdentityContext } = await import("@/lib/state/forecast-engine")
    setIdentityContext(identityCtx)

    // ── Outstanding AP Bills (QBO, Xero, Gmail) ──
    const outstandingBills = await fetchOutstandingBills(user.id)

    // Behavioral models with bills for richer vendor context
    const models = buildBehavioralModels(tagged, outstandingInvoices, outstandingBills)

    // Bill-based + inferred AP, merged with deduplication
    const billObligations = computeAPStateFromBills(outstandingBills)
    const patternObligations = computeAPState(models.vendors, 30).obligations
    const mergedObligations = mergeAPObligations(billObligations, patternObligations)
    const total_expected_30d = mergedObligations.reduce((s, o) => s + o.expected_amount, 0)

    const ar = computeARState(outstandingInvoices)

    // Enrich AR/AP from movement attributions (canonical rollups)
    const allocations = await getAllocationsForUser(user.id)
    const { aggregateArAttributionsByUri, aggregateApAttributionsByUri, enrichInvoiceWithAttributions, enrichObligationWithAttributions } =
      await import("@/lib/state/ar-ap-from-attributions")
    const arByUri = aggregateArAttributionsByUri(allocations)
    const apByUri = aggregateApAttributionsByUri(allocations)
    const arWithAllocations = ar.invoices.map((inv) => enrichInvoiceWithAttributions(inv, arByUri))
    const apWithAllocations = mergedObligations.map((ob) => enrichObligationWithAttributions(ob, apByUri))
    const ap = {
      total_expected_30d: Math.round(total_expected_30d * 100) / 100,
      obligation_count: mergedObligations.length,
      obligations: apWithAllocations,
    }

    return NextResponse.json({
      ar: { ...ar, invoices: arWithAllocations },
      ap,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[AR-AP] compute failed:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

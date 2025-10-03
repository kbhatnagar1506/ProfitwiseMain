/**
 * Shared invoice fetch for AR. QBO, Xero, Gmail, Stripe.
 */

import { query, ensureQBOSchema } from "@/lib/db"
import type { OutstandingInvoice } from "./state/types"

export async function fetchOutstandingInvoices(userId: string): Promise<OutstandingInvoice[]> {
  const today = new Date().toISOString().slice(0, 10)
  const outstandingInvoices: OutstandingInvoice[] = []

  const sourceIdToEntity = new Map<string, string>()
  try {
    const aliasRows = await query<{ entity_id: string; source_id: string }>(
      `SELECT ea.entity_id, ea.source_id FROM entity_aliases ea
       JOIN entities e ON e.id = ea.entity_id
       WHERE e.user_id = $1 AND ea.source = 'qbo' AND ea.source_id IS NOT NULL`,
      [userId]
    ).then((r) => r.rows)
    for (const a of aliasRows) {
      if (a.source_id) sourceIdToEntity.set(a.source_id, a.entity_id)
    }
  } catch { /* entity_aliases may not exist */ }

  try {
    await ensureQBOSchema()
    const invRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT e.entity_id, e.data FROM qbo_entities e
       JOIN qbo_connections c ON c.realm_id = e.realm_id
       WHERE c.user_id = $1 AND e.entity_type = 'Invoice'`,
      [userId]
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

  try {
    const xeroRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT e.entity_id, e.data FROM xero_entities e
       JOIN xero_connections xc ON xc.tenant_id = e.tenant_id
       WHERE xc.user_id = $1 AND e.entity_type = 'Invoice'`,
      [userId]
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

  try {
    const gmailRows = await query<{ extracted_invoice: Record<string, unknown> }>(
      `SELECT extracted_invoice FROM gmail_synced_messages
       WHERE extracted_invoice IS NOT NULL
       AND extracted_invoice->>'side' = 'AR'
       AND extracted_invoice->>'status' IN ('open', 'partially_paid')`,
      []
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

  try {
    const stripeRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT entity_id, data FROM stripe_entities WHERE user_id = $1 AND entity_type = 'invoice'`,
      [userId]
    ).then((r) => r.rows)
    for (const row of stripeRows) {
      const d = row.data
      const amountDue = parseFloat(String(d.amount_due ?? 0)) / 100
      if (amountDue <= 0) continue
      const total = parseFloat(String(d.total ?? d.amount_due ?? 0)) / 100
      const custName = String(d.customer_name ?? d.customer_email ?? "Unknown")
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

  return outstandingInvoices
}

/** Invoices for bank-led reconciliation: outstanding + recently paid (so we can match bank payments to invoices QBO already marked paid). */
const RECENTLY_PAID_DAYS = 180

export async function fetchInvoicesForReconciliation(userId: string): Promise<OutstandingInvoice[]> {
  const outstanding = await fetchOutstandingInvoices(userId)
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - RECENTLY_PAID_DAYS)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const sourceIdToEntity = new Map<string, string>()
  try {
    const aliasRows = await query<{ entity_id: string; source_id: string }>(
      `SELECT ea.entity_id, ea.source_id FROM entity_aliases ea
       JOIN entities e ON e.id = ea.entity_id
       WHERE e.user_id = $1 AND ea.source = 'qbo' AND ea.source_id IS NOT NULL`,
      [userId]
    ).then((r) => r.rows)
    for (const a of aliasRows) {
      if (a.source_id) sourceIdToEntity.set(a.source_id, a.entity_id)
    }
  } catch { /* */ }

  try {
    await ensureQBOSchema()
    const invRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT e.entity_id, e.data FROM qbo_entities e
       JOIN qbo_connections c ON c.realm_id = e.realm_id
       WHERE c.user_id = $1 AND e.entity_type = 'Invoice'`,
      [userId]
    ).then((r) => r.rows)
    for (const row of invRows) {
      const d = row.data
      const balance = parseFloat(String(d.Balance ?? 0))
      const totalAmt = parseFloat(String(d.TotalAmt ?? balance))
      const txnDate = (d.TxnDate as string) ?? ""
      if (balance > 0) continue
      if (txnDate < cutoffStr) continue
      const custRef = d.CustomerRef as Record<string, unknown> | undefined
      const custName = String(custRef?.name ?? custRef?.value ?? "Unknown")
      const custSourceId = custRef?.value != null ? String(custRef.value) : null
      const dueDate = (d.DueDate as string) ?? null
      const entityId = custSourceId ? (sourceIdToEntity.get(custSourceId) ?? null) : null
      const existing = outstanding.find((i) => i.invoice_id === row.entity_id)
      if (existing) continue
      outstanding.push({
        invoice_id: row.entity_id,
        source: "qbo",
        customer_name: custName,
        customer_source_id: custSourceId,
        entity_id: entityId,
        amount: totalAmt,
        amount_due: totalAmt,
        due_date: dueDate,
        days_until_due: null,
        days_overdue: null,
        status: "paid",
      })
    }
  } catch { /* */ }

  try {
    const xeroRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT e.entity_id, e.data FROM xero_entities e
       JOIN xero_connections xc ON xc.tenant_id = e.tenant_id
       WHERE xc.user_id = $1 AND e.entity_type = 'Invoice'`,
      [userId]
    ).then((r) => r.rows)
    for (const row of xeroRows) {
      const d = row.data
      const amountDue = parseFloat(String(d.AmountDue ?? 0))
      if (amountDue > 0) continue
      const total = parseFloat(String(d.Total ?? 0))
      if (total <= 0) continue
      const contact = d.Contact as Record<string, unknown> | undefined
      const custName = String(contact?.Name ?? "Unknown")
      const dueDate = (d.DueDateString as string) ?? (d.DateString as string) ?? null
      const dateStr = dueDate?.slice(0, 10) ?? ""
      if (dateStr && dateStr < cutoffStr) continue
      const existing = outstanding.find((i) => i.invoice_id === row.entity_id)
      if (existing) continue
      outstanding.push({
        invoice_id: row.entity_id,
        source: "xero",
        customer_name: custName,
        customer_source_id: null,
        entity_id: null,
        amount: total,
        amount_due: total,
        due_date: dueDate?.slice(0, 10) ?? null,
        days_until_due: null,
        days_overdue: null,
        status: "paid",
      })
    }
  } catch { /* */ }

  try {
    const stripeRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT entity_id, data FROM stripe_entities WHERE user_id = $1 AND entity_type = 'invoice'`,
      [userId]
    ).then((r) => r.rows)
    for (const row of stripeRows) {
      const d = row.data
      const amountDue = parseFloat(String(d.amount_due ?? 0)) / 100
      if (amountDue > 0) continue
      const total = parseFloat(String(d.total ?? d.amount_due ?? 0)) / 100
      if (total <= 0) continue
      const dueTimestamp = d.due_date as number | null
      const dueDate = dueTimestamp ? new Date(dueTimestamp * 1000).toISOString().slice(0, 10) : null
      if (dueDate && dueDate < cutoffStr) continue
      const custName = String(d.customer_name ?? d.customer_email ?? "Unknown")
      const existing = outstanding.find((i) => i.invoice_id === row.entity_id)
      if (existing) continue
      outstanding.push({
        invoice_id: row.entity_id,
        source: "stripe",
        customer_name: custName,
        customer_source_id: String(d.customer ?? ""),
        entity_id: null,
        amount: total,
        amount_due: total,
        due_date: dueDate,
        days_until_due: null,
        days_overdue: null,
        status: "paid",
      })
    }
  } catch { /* */ }

  return outstanding
}

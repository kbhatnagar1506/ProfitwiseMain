/**
 * Shared bill fetch for AP: QBO, Xero, Gmail.
 * Used by ar-ap route and forecast route.
 */

import { query, ensureQBOSchema } from "@/lib/db"
import type { OutstandingBill } from "./state/types"

export async function fetchOutstandingBills(userId: string): Promise<OutstandingBill[]> {
  const today = new Date().toISOString().slice(0, 10)
  const outstandingBills: OutstandingBill[] = []

  // Build entity alias lookup: QBO source_id → entity_id
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
  } catch { /* entity_aliases may not exist yet */ }

  // QBO Bills
  try {
    await ensureQBOSchema()
    type QboBillRow = { entity_id: string; data: Record<string, unknown> }
    const billRows = await query<QboBillRow>(
      `SELECT e.entity_id, e.data FROM qbo_entities e
       JOIN qbo_connections c ON c.realm_id = e.realm_id
       WHERE c.user_id = $1 AND e.entity_type = 'Bill'`,
      [userId]
    ).then((r) => r.rows)
    for (const row of billRows) {
      const d = row.data
      const balance = parseFloat(String(d.Balance ?? 0))
      if (balance <= 0) continue
      const totalAmt = parseFloat(String(d.TotalAmt ?? balance))
      const vendRef = d.VendorRef as Record<string, unknown> | undefined
      const vendName = String(vendRef?.name ?? vendRef?.value ?? "Unknown")
      const vendSourceId = vendRef?.value != null ? String(vendRef.value) : null
      const dueDate = (d.DueDate as string) ?? null
      let daysToDue: number | null = null
      let daysOverdue: number | null = null
      let status: OutstandingBill["status"] = "open"
      if (dueDate) {
        const diff = Math.round((new Date(dueDate).getTime() - new Date(today).getTime()) / 86_400_000)
        if (diff < 0) { daysOverdue = Math.abs(diff); status = "overdue" }
        else daysToDue = diff
      }
      if (balance < totalAmt && balance > 0) status = "partially_paid"
      const entityId = vendSourceId ? (sourceIdToEntity.get(vendSourceId) ?? null) : null
      outstandingBills.push({
        bill_id: row.entity_id, source: "qbo",
        vendor_name: vendName, vendor_source_id: vendSourceId,
        entity_id: entityId, amount: totalAmt, amount_due: balance,
        due_date: dueDate, days_until_due: daysToDue,
        days_overdue: daysOverdue, status,
      })
    }
  } catch { /* QBO Bills may not be available */ }

  // Xero Bills
  try {
    type XeroBillRow = { entity_id: string; data: Record<string, unknown> }
    const xeroBillRows = await query<XeroBillRow>(
      `SELECT e.entity_id, e.data FROM xero_entities e
       JOIN xero_connections xc ON xc.tenant_id = e.tenant_id
       WHERE xc.user_id = $1 AND e.entity_type = 'Bill'`,
      [userId]
    ).then((r) => r.rows)
    for (const row of xeroBillRows) {
      const d = row.data
      const amountDue = parseFloat(String(d.AmountDue ?? 0))
      if (amountDue <= 0) continue
      const total = parseFloat(String(d.Total ?? amountDue))
      const contact = d.Contact as Record<string, unknown> | undefined
      const vendName = String(contact?.Name ?? "Unknown")
      const dueDate = (d.DueDateString as string) ?? (d.DueDate as string) ?? null
      let daysToDue: number | null = null
      let daysOverdue: number | null = null
      let status: OutstandingBill["status"] = "open"
      if (dueDate) {
        const cleanDate = dueDate.slice(0, 10)
        const diff = Math.round((new Date(cleanDate).getTime() - new Date(today).getTime()) / 86_400_000)
        if (diff < 0) { daysOverdue = Math.abs(diff); status = "overdue" }
        else daysToDue = diff
      }
      if (amountDue < total && amountDue > 0) status = "partially_paid"
      outstandingBills.push({
        bill_id: row.entity_id, source: "xero",
        vendor_name: vendName, vendor_source_id: null,
        entity_id: null, amount: total, amount_due: amountDue,
        due_date: dueDate?.slice(0, 10) ?? null, days_until_due: daysToDue,
        days_overdue: daysOverdue, status,
      })
    }
  } catch { /* Xero Bills may not be available */ }

  // Gmail AP bills (gmail_synced_messages may not have user_id; query all if so)
  try {
    type GmailApRow = { extracted_invoice: Record<string, unknown> }
    const gmailApRows = await query<GmailApRow>(
      `SELECT extracted_invoice FROM gmail_synced_messages
       WHERE extracted_invoice IS NOT NULL
       AND extracted_invoice->>'side' = 'AP'
       AND extracted_invoice->>'status' IN ('open', 'partially_paid')`,
      []
    ).then((r) => r.rows)
    for (const row of gmailApRows) {
      const d = row.extracted_invoice
      const amountDue = parseFloat(String(d.amount_outstanding ?? d.total ?? 0))
      if (amountDue <= 0) continue
      const total = parseFloat(String(d.total ?? amountDue))
      const vendName = String(d.counterparty_name ?? "Unknown")
      const dueDate = (d.due_date as string) ?? null
      let daysToDue: number | null = null
      let daysOverdue: number | null = null
      let status: OutstandingBill["status"] = "open"
      if (dueDate) {
        const diff = Math.round((new Date(dueDate).getTime() - new Date(today).getTime()) / 86_400_000)
        if (diff < 0) { daysOverdue = Math.abs(diff); status = "overdue" }
        else daysToDue = diff
      }
      outstandingBills.push({
        bill_id: `gmail_ap_${d.invoice_number ?? Date.now()}`, source: "gmail",
        vendor_name: vendName, vendor_source_id: null,
        entity_id: null, amount: total, amount_due: amountDue,
        due_date: dueDate, days_until_due: daysToDue,
        days_overdue: daysOverdue, status,
      })
    }
  } catch { /* Gmail AP may not be available */ }

  return outstandingBills
}

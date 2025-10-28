/**
 * Shared bill fetch for AP: QBO, Xero, Gmail.
 * Used by ar-ap route and forecast route.
 */

import { query, ensureQBOSchema, ensureGmailSchema } from "@/lib/db"
import { toEntityUriApBill } from "@/lib/entity-uri"
import type { OutstandingBill } from "./state/types"

export async function fetchOutstandingBills(userId: string): Promise<OutstandingBill[]> {
  const today = new Date().toISOString().slice(0, 10)
  const outstandingBills: OutstandingBill[] = []

  // Build entity alias lookup: QBO source_id → entity_id
  const sourceIdToEntity = new Map<string, string>()
  // Build Xero contact ID → entity_id lookup
  const xeroContactToEntity = new Map<string, string>()
  try {
    const aliasRows = await query<{ entity_id: string; source_id: string; source: string }>(
      `SELECT ea.entity_id, ea.source_id, ea.source FROM entity_aliases ea
       JOIN entities e ON e.id = ea.entity_id
       WHERE e.user_id = $1 AND ea.source IN ('qbo', 'xero') AND ea.source_id IS NOT NULL`,
      [userId]
    ).then((r) => r.rows)
    for (const a of aliasRows) {
      if (!a.source_id) continue
      if (a.source === "qbo") sourceIdToEntity.set(a.source_id, a.entity_id)
      else if (a.source === "xero") xeroContactToEntity.set(a.source_id, a.entity_id)
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
      if (balance < totalAmt && balance > 0 && status !== "overdue") status = "partially_paid"
      const entityId = vendSourceId ? (sourceIdToEntity.get(vendSourceId) ?? null) : null
      outstandingBills.push({
        bill_id: row.entity_id, source: "qbo",
        vendor_name: vendName, vendor_source_id: vendSourceId,
        entity_id: entityId, entity_uri: toEntityUriApBill("qbo", row.entity_id),
        amount: totalAmt, amount_due: balance,
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
      const contactId = contact?.ContactID != null ? String(contact.ContactID) : null
      const entityId = contactId ? (xeroContactToEntity.get(contactId) ?? null) : null
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
      if (amountDue < total && amountDue > 0 && status !== "overdue") status = "partially_paid"
      outstandingBills.push({
        bill_id: row.entity_id, source: "xero",
        vendor_name: vendName, vendor_source_id: contactId,
        entity_id: entityId, entity_uri: toEntityUriApBill("xero", row.entity_id),
        amount: total, amount_due: amountDue,
        due_date: dueDate?.slice(0, 10) ?? null, days_until_due: daysToDue,
        days_overdue: daysOverdue, status,
      })
    }
  } catch { /* Xero Bills may not be available */ }

  // Gmail AP bills
  try {
    await ensureGmailSchema()
    type GmailApRow = { message_id: string; extracted_invoice: Record<string, unknown> }
    const gmailApRows = await query<GmailApRow>(
      `SELECT message_id, extracted_invoice FROM gmail_synced_messages
       WHERE (user_id = $1 OR user_id IS NULL)
       AND extracted_invoice IS NOT NULL
       AND extracted_invoice->>'side' = 'AP'
       AND extracted_invoice->>'status' IN ('open', 'partially_paid')`,
      [userId]
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
      const billId = `gmail_ap_${row.message_id ?? d.invoice_number ?? crypto.randomUUID()}`
      outstandingBills.push({
        bill_id: billId, source: "gmail",
        vendor_name: vendName, vendor_source_id: null,
        entity_id: null, entity_uri: toEntityUriApBill("gmail", billId),
        amount: total, amount_due: amountDue,
        due_date: dueDate, days_until_due: daysToDue,
        days_overdue: daysOverdue, status,
      })
    }
  } catch { /* Gmail AP may not be available */ }

  // Dedupe by (entity_id ?? vendor_name, amount_due, due_date) — keep first occurrence
  const seen = new Map<string, OutstandingBill>()
  for (const b of outstandingBills) {
    const key = `${b.entity_id ?? b.vendor_name}|${b.amount_due}|${b.due_date ?? ""}`
    if (!seen.has(key)) seen.set(key, b)
  }
  return [...seen.values()]
}

/**
 * Fetch bills for reconciliation: outstanding + recently paid (last 180 days).
 * Used for historical reconciliation matching.
 */
export async function fetchBillsForReconciliation(userId: string): Promise<OutstandingBill[]> {
  const today = new Date().toISOString().slice(0, 10)
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - 180)
  const cutoffStr = cutoffDate.toISOString().slice(0, 10)
  
  const bills: OutstandingBill[] = []

  // Build entity alias lookup
  const sourceIdToEntity = new Map<string, string>()
  const xeroContactToEntity = new Map<string, string>()
  try {
    const aliasRows = await query<{ entity_id: string; source_id: string; source: string }>(
      `SELECT ea.entity_id, ea.source_id, ea.source FROM entity_aliases ea
       JOIN entities e ON e.id = ea.entity_id
       WHERE e.user_id = $1 AND ea.source IN ('qbo', 'xero') AND ea.source_id IS NOT NULL`,
      [userId]
    ).then((r) => r.rows)
    for (const a of aliasRows) {
      if (!a.source_id) continue
      if (a.source === "qbo") sourceIdToEntity.set(a.source_id, a.entity_id)
      else if (a.source === "xero") xeroContactToEntity.set(a.source_id, a.entity_id)
    }
  } catch { /* entity_aliases may not exist yet */ }

  // QBO Bills - outstanding + paid in last 180 days
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
      const totalAmt = parseFloat(String(d.TotalAmt ?? balance))
      const vendRef = d.VendorRef as Record<string, unknown> | undefined
      const vendName = String(vendRef?.name ?? vendRef?.value ?? "Unknown")
      const vendSourceId = vendRef?.value != null ? String(vendRef.value) : null
      const dueDate = (d.DueDate as string) ?? null
      const txnDate = (d.TxnDate as string) ?? null
      
      // Skip if paid and older than cutoff
      if (balance <= 0 && txnDate && txnDate < cutoffStr) continue
      
      let daysToDue: number | null = null
      let daysOverdue: number | null = null
      let status: OutstandingBill["status"] = balance <= 0 ? "paid" : "open"
      
      if (dueDate) {
        const diff = Math.round((new Date(dueDate).getTime() - new Date(today).getTime()) / 86_400_000)
        if (diff < 0 && status !== "paid") { daysOverdue = Math.abs(diff); status = "overdue" }
        else if (status !== "paid") daysToDue = diff
      }
      if (balance < totalAmt && balance > 0 && status !== "overdue") status = "partially_paid"
      
      const entityId = vendSourceId ? (sourceIdToEntity.get(vendSourceId) ?? null) : null
      bills.push({
        bill_id: row.entity_id, source: "qbo",
        vendor_name: vendName, vendor_source_id: vendSourceId,
        entity_id: entityId, entity_uri: toEntityUriApBill("qbo", row.entity_id),
        amount: totalAmt, amount_due: balance,
        due_date: dueDate, days_until_due: daysToDue,
        days_overdue: daysOverdue, status,
      })
    }
  } catch { /* QBO Bills may not be available */ }

  // Xero Bills - outstanding + paid in last 180 days
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
      const total = parseFloat(String(d.Total ?? amountDue))
      const contact = d.Contact as Record<string, unknown> | undefined
      const vendName = String(contact?.Name ?? "Unknown")
      const contactId = contact?.ContactID != null ? String(contact.ContactID) : null
      const entityId = contactId ? (xeroContactToEntity.get(contactId) ?? null) : null
      const dueDate = (d.DueDateString as string) ?? (d.DueDate as string) ?? null
      const dateStr = (d.DateString as string) ?? (d.Date as string) ?? null
      
      // Skip if paid and older than cutoff
      if (amountDue <= 0 && dateStr && dateStr.slice(0, 10) < cutoffStr) continue
      
      let daysToDue: number | null = null
      let daysOverdue: number | null = null
      let status: OutstandingBill["status"] = amountDue <= 0 ? "paid" : "open"
      
      if (dueDate) {
        const cleanDate = dueDate.slice(0, 10)
        const diff = Math.round((new Date(cleanDate).getTime() - new Date(today).getTime()) / 86_400_000)
        if (diff < 0 && status !== "paid") { daysOverdue = Math.abs(diff); status = "overdue" }
        else if (status !== "paid") daysToDue = diff
      }
      if (amountDue < total && amountDue > 0 && status !== "overdue") status = "partially_paid"
      
      bills.push({
        bill_id: row.entity_id, source: "xero",
        vendor_name: vendName, vendor_source_id: contactId,
        entity_id: entityId, entity_uri: toEntityUriApBill("xero", row.entity_id),
        amount: total, amount_due: amountDue,
        due_date: dueDate?.slice(0, 10) ?? null, days_until_due: daysToDue,
        days_overdue: daysOverdue, status,
      })
    }
  } catch { /* Xero Bills may not be available */ }

  // Gmail AP bills (outstanding only - Gmail doesn't track paid status well)
  try {
    await ensureGmailSchema()
    type GmailApRow = { message_id: string; extracted_invoice: Record<string, unknown> }
    const gmailApRows = await query<GmailApRow>(
      `SELECT message_id, extracted_invoice FROM gmail_synced_messages
       WHERE (user_id = $1 OR user_id IS NULL)
       AND extracted_invoice IS NOT NULL
       AND extracted_invoice->>'side' = 'AP'`,
      [userId]
    ).then((r) => r.rows)
    for (const row of gmailApRows) {
      const d = row.extracted_invoice
      const amountDue = parseFloat(String(d.amount_outstanding ?? d.total ?? 0))
      const total = parseFloat(String(d.total ?? amountDue))
      const vendName = String(d.counterparty_name ?? "Unknown")
      const dueDate = (d.due_date as string) ?? null
      const extractedStatus = (d.status as string) ?? "open"
      
      let daysToDue: number | null = null
      let daysOverdue: number | null = null
      let status: OutstandingBill["status"] = extractedStatus === "paid" ? "paid" : "open"
      
      if (dueDate) {
        const diff = Math.round((new Date(dueDate).getTime() - new Date(today).getTime()) / 86_400_000)
        if (diff < 0 && status !== "paid") { daysOverdue = Math.abs(diff); status = "overdue" }
        else if (status !== "paid") daysToDue = diff
      }
      if (amountDue < total && amountDue > 0 && status !== "overdue") status = "partially_paid"
      
      const billId = `gmail_ap_${row.message_id ?? d.invoice_number ?? crypto.randomUUID()}`
      bills.push({
        bill_id: billId, source: "gmail",
        vendor_name: vendName, vendor_source_id: null,
        entity_id: null, entity_uri: toEntityUriApBill("gmail", billId),
        amount: total, amount_due: amountDue,
        due_date: dueDate, days_until_due: daysToDue,
        days_overdue: daysOverdue, status,
      })
    }
  } catch { /* Gmail AP may not be available */ }

  // Dedupe
  const seen = new Map<string, OutstandingBill>()
  for (const b of bills) {
    const key = `${b.source}:${b.bill_id}`
    if (!seen.has(key)) seen.set(key, b)
  }
  return [...seen.values()]
}

/**
 * Enrich bills with reconciliation status from movement_attributions.
 */
export async function enrichBillsWithReconciliationStatus(
  userId: string,
  bills: OutstandingBill[]
): Promise<OutstandingBill[]> {
  if (bills.length === 0) return bills

  type AttrRow = {
    entity_id: string
    reference_id: string | null
    movement_id: string
    gross_amount: string
    metadata: Record<string, unknown>
  }

  const { rows: attrRows } = await query<AttrRow>(
    `SELECT entity_id, reference_id, movement_id, gross_amount::text, metadata
     FROM movement_attributions
     WHERE user_id = $1
       AND component_type = 'ap'
       AND source IN ('rule', 'llm')`,
    [userId]
  )

  // Track matches by specific bill reference_id
  const matchesByBillId = new Map<string, { movementIds: string[]; totalMatched: number }>()
  // Track matches by entity_uri for fallback (entity-level matching)
  const matchesByEntityUri = new Map<string, { movementIds: string[]; totalMatched: number }>()

  for (const attr of attrRows) {
    const gross = parseFloat(attr.gross_amount) || 0
    
    if (attr.reference_id) {
      // This attribution is linked to a specific bill
      const existing = matchesByBillId.get(attr.reference_id) ?? { movementIds: [], totalMatched: 0 }
      existing.movementIds.push(attr.movement_id)
      existing.totalMatched += gross
      matchesByBillId.set(attr.reference_id, existing)
    }
    
    // Also track by entity_uri for fallback matching
    if (attr.entity_id) {
      const existing = matchesByEntityUri.get(attr.entity_id) ?? { movementIds: [], totalMatched: 0 }
      existing.movementIds.push(attr.movement_id)
      existing.totalMatched += gross
      matchesByEntityUri.set(attr.entity_id, existing)
    }
  }

  return bills.map((bill) => {
    // First, try to match by specific bill_id (reference_id)
    const byId = matchesByBillId.get(bill.bill_id)
    
    if (byId && byId.movementIds.length > 0) {
      // We have a specific bill-level match
      // Cap the matched amount at the bill amount for display purposes
      // (multiple payments to the same bill shouldn't show more than the bill total)
      const rawMatchedAmount = byId.totalMatched
      const matchedAmount = Math.min(rawMatchedAmount, bill.amount)
      const billAmount = bill.amount
      const tolerance = 0.01

      let reconciliationStatus: "matched" | "unmatched" | "partial"
      if (Math.abs(matchedAmount - billAmount) < tolerance || matchedAmount >= billAmount - tolerance) {
        reconciliationStatus = "matched"
      } else if (matchedAmount > 0) {
        reconciliationStatus = "partial"
      } else {
        reconciliationStatus = "unmatched"
      }

      return {
        ...bill,
        reconciliation_status: reconciliationStatus,
        matched_movement_ids: [...new Set(byId.movementIds)],
        matched_amount: matchedAmount,
      }
    }

    // Fallback: try entity-level matching
    const byUri = bill.entity_uri ? matchesByEntityUri.get(bill.entity_uri) : undefined

    if (!byUri || byUri.movementIds.length === 0) {
      return {
        ...bill,
        reconciliation_status: "unmatched" as const,
        matched_movement_ids: [],
        matched_amount: 0,
      }
    }

    // For entity-level matching, cap the matched amount at the bill amount
    // This prevents showing inflated "matched" amounts when multiple bills share an entity
    const entityMatchedAmount = byUri.totalMatched
    const cappedMatchedAmount = Math.min(entityMatchedAmount, bill.amount)
    const billAmount = bill.amount
    const tolerance = 0.01

    let reconciliationStatus: "matched" | "unmatched" | "partial"
    if (Math.abs(cappedMatchedAmount - billAmount) < tolerance || cappedMatchedAmount >= billAmount - tolerance) {
      reconciliationStatus = "matched"
    } else if (cappedMatchedAmount > 0) {
      reconciliationStatus = "partial"
    } else {
      reconciliationStatus = "unmatched"
    }

    return {
      ...bill,
      reconciliation_status: reconciliationStatus,
      matched_movement_ids: [...new Set(byUri.movementIds)],
      matched_amount: cappedMatchedAmount,
    }
  })
}

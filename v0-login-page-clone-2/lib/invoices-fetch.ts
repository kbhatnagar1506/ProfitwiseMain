/**
 * Shared invoice fetch for AR. QBO, Xero, Gmail, Stripe, Shopify.
 */

import { query, ensureQBOSchema, ensureGmailSchema, ensureShopifySchema } from "@/lib/db"
import { toEntityUriAr } from "@/lib/entity-uri"
import { safeParseFloat } from "@/lib/utils"
import type { OutstandingInvoice } from "./state/types"

/** Parse extracted amount, stripping currency symbols and commas */
function parseExtractedAmount(value: unknown, fallback = 0): number {
  if (value == null) return fallback
  if (typeof value === "number") return value
  const cleaned = String(value).replace(/[^0-9.-]/g, "")
  const parsed = parseFloat(cleaned)
  return Number.isNaN(parsed) ? fallback : parsed
}

/** Xero invoice Contact → graph entity when `entity_aliases.source = 'xero'` (seed via graph/identity). */
async function loadXeroContactIdToEntityMap(userId: string): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  try {
    const aliasRows = await query<{ entity_id: string; source_id: string }>(
      `SELECT ea.entity_id, ea.source_id FROM entity_aliases ea
       JOIN entities e ON e.id = ea.entity_id
       WHERE e.user_id = $1 AND ea.source = 'xero' AND ea.source_id IS NOT NULL`,
      [userId],
    ).then((r) => r.rows)
    for (const a of aliasRows) {
      if (a.source_id) m.set(a.source_id, a.entity_id)
    }
  } catch (e) {
    console.warn("[invoices-fetch] entity_aliases query failed:", e instanceof Error ? e.message : String(e))
  }
  return m
}

function xeroContactIdFromInvoiceContact(contact: Record<string, unknown> | undefined): string | null {
  if (!contact) return null
  const raw = contact.ContactID ?? contact.contactID
  if (raw == null) return null
  const s = String(raw).trim()
  return s.length > 0 ? s : null
}

export async function fetchOutstandingInvoices(
  userId: string,
  preloadedXeroContactIdToEntity?: Map<string, string>,
): Promise<OutstandingInvoice[]> {
  const today = new Date().toISOString().slice(0, 10)
  const outstandingInvoices: OutstandingInvoice[] = []

  // QBO entity alias lookup
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
  } catch (e) {
    console.warn("[invoices-fetch] QBO entity_aliases query failed:", e instanceof Error ? e.message : String(e))
  }

  // Stripe customer entity alias lookup
  const stripeCustomerToEntity = new Map<string, string>()
  try {
    const stripeAliasRows = await query<{ entity_id: string; source_id: string }>(
      `SELECT ea.entity_id, ea.source_id FROM entity_aliases ea
       JOIN entities e ON e.id = ea.entity_id
       WHERE e.user_id = $1 AND ea.source = 'stripe' AND ea.source_id IS NOT NULL`,
      [userId]
    ).then((r) => r.rows)
    for (const a of stripeAliasRows) {
      if (a.source_id) stripeCustomerToEntity.set(a.source_id, a.entity_id)
    }
  } catch (e) {
    console.warn("[invoices-fetch] Stripe entity_aliases query failed:", e instanceof Error ? e.message : String(e))
  }

  const xeroContactIdToEntity = preloadedXeroContactIdToEntity ?? (await loadXeroContactIdToEntityMap(userId))

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
      const balance = safeParseFloat(d.Balance)
      if (balance <= 0) continue
      const totalAmt = safeParseFloat(d.TotalAmt, balance)
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
      if (balance < totalAmt && balance > 0 && status !== "overdue") status = "partially_paid"
      const entityId = custSourceId ? (sourceIdToEntity.get(custSourceId) ?? null) : null
      outstandingInvoices.push({
        invoice_id: row.entity_id, source: "qbo",
        customer_name: custName, customer_source_id: custSourceId,
        entity_id: entityId, entity_uri: toEntityUriAr("qbo", row.entity_id),
        amount: totalAmt, amount_due: balance,
        due_date: dueDate, days_until_due: daysToDue, days_overdue: daysOverdue, status,
      })
    }
  } catch (e) {
    console.warn("[invoices-fetch] QBO invoices fetch failed:", e instanceof Error ? e.message : String(e))
  }

  try {
    const xeroRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT e.entity_id, e.data FROM xero_entities e
       JOIN xero_connections xc ON xc.tenant_id = e.tenant_id
       WHERE xc.user_id = $1 AND e.entity_type = 'Invoice'`,
      [userId]
    ).then((r) => r.rows)
    for (const row of xeroRows) {
      const d = row.data
      const amountDue = safeParseFloat(d.AmountDue)
      if (amountDue <= 0) continue
      const total = safeParseFloat(d.Total, amountDue)
      const contact = d.Contact as Record<string, unknown> | undefined
      const custName = String(contact?.Name ?? "Unknown")
      const contactId = xeroContactIdFromInvoiceContact(contact)
      const entityId = contactId ? (xeroContactIdToEntity.get(contactId) ?? null) : null
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
      if (amountDue < total && amountDue > 0 && status !== "overdue") status = "partially_paid"
      outstandingInvoices.push({
        invoice_id: row.entity_id, source: "xero",
        customer_name: custName, customer_source_id: contactId,
        entity_id: entityId, entity_uri: toEntityUriAr("xero", row.entity_id),
        amount: total, amount_due: amountDue,
        due_date: dueDate?.slice(0, 10) ?? null, days_until_due: daysToDue,
        days_overdue: daysOverdue, status,
      })
    }
  } catch (e) {
    console.warn("[invoices-fetch] Xero invoices fetch failed:", e instanceof Error ? e.message : String(e))
  }

  try {
    await ensureGmailSchema()
    const gmailRows = await query<{ message_id: string; extracted_invoice: Record<string, unknown> }>(
      `SELECT message_id, extracted_invoice FROM gmail_synced_messages
       WHERE (user_id = $1 OR user_id IS NULL)
       AND extracted_invoice IS NOT NULL
       AND extracted_invoice->>'side' = 'AR'
       AND extracted_invoice->>'status' IN ('open', 'partially_paid')`,
      [userId]
    ).then((r) => r.rows)
    for (const row of gmailRows) {
      const d = row.extracted_invoice
      const amountDue = parseExtractedAmount(d.amount_outstanding ?? d.total)
      if (amountDue <= 0) continue
      const total = parseExtractedAmount(d.total, amountDue)
      const custName = String(d.counterparty_name ?? "Unknown")
      const dueDate = (d.due_date as string) ?? null
      let daysToDue: number | null = null
      let daysOverdue: number | null = null
      let status: OutstandingInvoice["status"] = "open"
      if (dueDate) {
        const dueTime = new Date(dueDate).getTime()
        if (!Number.isNaN(dueTime)) {
          const diff = Math.round((dueTime - new Date(today).getTime()) / 86_400_000)
        if (diff < 0) { daysOverdue = Math.abs(diff); status = "overdue" }
        else daysToDue = diff
        }
      }
      const invoiceId = `gmail_${row.message_id}`
      outstandingInvoices.push({
        invoice_id: invoiceId, source: "gmail",
        customer_name: custName, customer_source_id: null,
        entity_id: null, entity_uri: toEntityUriAr("gmail", invoiceId),
        amount: total, amount_due: amountDue,
        due_date: dueDate, days_until_due: daysToDue, days_overdue: daysOverdue, status,
      })
    }
  } catch (e) {
    console.warn("[invoices-fetch] Gmail invoices fetch failed:", e instanceof Error ? e.message : String(e))
  }

  try {
    const stripeRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT entity_id, data FROM stripe_entities WHERE user_id = $1 AND entity_type = 'invoice'`,
      [userId]
    ).then((r) => r.rows)
    for (const row of stripeRows) {
      const d = row.data
      const amountDue = safeParseFloat(d.amount_due) / 100
      if (amountDue <= 0) continue
      const total = safeParseFloat(d.total ?? d.amount_due) / 100
      const custName = String(d.customer_name ?? d.customer_email ?? "Unknown")
      const custSourceId = d.customer != null ? String(d.customer) : null
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
      if (amountDue < total && amountDue > 0 && status !== "overdue") status = "partially_paid"
      const entityId = custSourceId ? (stripeCustomerToEntity.get(custSourceId) ?? null) : null
      outstandingInvoices.push({
        invoice_id: row.entity_id, source: "stripe",
        customer_name: custName, customer_source_id: custSourceId,
        entity_id: entityId, entity_uri: toEntityUriAr("stripe", row.entity_id),
        amount: total, amount_due: amountDue,
        due_date: dueDate, days_until_due: daysToDue,
        days_overdue: daysOverdue, status,
      })
    }
  } catch (e) {
    console.warn("[invoices-fetch] Stripe invoices fetch failed:", e instanceof Error ? e.message : String(e))
  }

  // Shopify orders with pending/partially_paid financial_status as AR
  try {
    await ensureShopifySchema()
    type ShopifyOrderRow = {
      entity_id: string
      shop_domain: string
      data: {
        id: number | string
        name?: string
        order_number?: number
        created_at?: string
        financial_status?: string
        total_price?: string | number
        customer?: {
          id?: number | string
          email?: string
          first_name?: string
          last_name?: string
          default_address?: { company?: string }
        }
        billing_address?: { company?: string; name?: string }
      }
    }
    const shopifyRows = await query<ShopifyOrderRow>(
      `SELECT entity_id, shop_domain, data FROM shopify_entities 
       WHERE user_id = $1 AND entity_type = 'orders'
       AND (data->>'financial_status' IN ('pending', 'partially_paid', 'authorized'))`,
      [userId]
    ).then((r) => r.rows)
    
    for (const row of shopifyRows) {
      const d = row.data
      const totalPrice = safeParseFloat(d.total_price)
      if (totalPrice <= 0) continue
      
      // Determine customer name
      let custName = "Unknown"
      const customer = d.customer
      if (customer) {
        const company = customer.default_address?.company || d.billing_address?.company
        if (company) custName = company
        else {
          const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ")
          if (name) custName = name
          else if (customer.email) custName = customer.email
        }
      } else if (d.billing_address?.name) {
        custName = d.billing_address.name
      }
      
      // Shopify orders don't have due dates, use created_at as reference
      const createdAt = d.created_at ? d.created_at.slice(0, 10) : null
      const financialStatus = d.financial_status ?? "pending"
      
      // For partially_paid, estimate amount_due as half (Shopify doesn't provide exact partial amount)
      const amountDue = financialStatus === "partially_paid" ? totalPrice * 0.5 : totalPrice
      
      const status: OutstandingInvoice["status"] = financialStatus === "partially_paid" ? "partially_paid" : "open"
      const invoiceId = `shopify_${row.shop_domain}_${row.entity_id}`
      const custSourceId = customer?.id != null ? String(customer.id) : null
      
      outstandingInvoices.push({
        invoice_id: invoiceId,
        source: "shopify",
        customer_name: custName,
        customer_source_id: custSourceId,
        entity_id: null, // Shopify customers not yet linked to entity graph
        entity_uri: toEntityUriAr("shopify", invoiceId),
        amount: totalPrice,
        amount_due: amountDue,
        due_date: createdAt, // Use created_at as proxy for due date
        days_until_due: null,
        days_overdue: null,
        status,
      })
    }
  } catch (e) {
    console.warn("[invoices-fetch] Shopify orders fetch failed:", e instanceof Error ? e.message : String(e))
  }

  // Dedupe by source:invoice_id first (same-source duplicates)
  const seen = new Map<string, OutstandingInvoice>()
  for (const i of outstandingInvoices) {
    const key = `${i.source}:${i.invoice_id}`
    if (!seen.has(key)) seen.set(key, i)
  }
  
  // Cross-source deduplication: prefer QBO > Xero > Stripe > Shopify > Gmail
  const SOURCE_PRIORITY: Record<string, number> = { qbo: 1, xero: 2, stripe: 3, shopify: 4, gmail: 5 }
  const crossSourceSeen = new Map<string, OutstandingInvoice>()
  for (const inv of seen.values()) {
    const custNorm = (inv.customer_name || "").toLowerCase().replace(/[^a-z0-9]/g, "")
    const amtRounded = Math.round(inv.amount * 100)
    const crossKey = `${custNorm}|${amtRounded}|${inv.due_date ?? "null"}`
    
    const existing = crossSourceSeen.get(crossKey)
    if (!existing) {
      crossSourceSeen.set(crossKey, inv)
    } else {
      const existingPriority = SOURCE_PRIORITY[existing.source] ?? 99
      const newPriority = SOURCE_PRIORITY[inv.source] ?? 99
      if (newPriority < existingPriority) {
        crossSourceSeen.set(crossKey, inv)
      }
    }
  }

  return [...crossSourceSeen.values()]
}

/** Invoices for bank-led reconciliation: outstanding + recently paid (so we can match bank payments to invoices QBO already marked paid). */
const RECENTLY_PAID_DAYS = 180

export async function fetchInvoicesForReconciliation(userId: string): Promise<OutstandingInvoice[]> {
  const xeroContactIdToEntity = await loadXeroContactIdToEntityMap(userId)
  const outstanding = await fetchOutstandingInvoices(userId, xeroContactIdToEntity)
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - RECENTLY_PAID_DAYS)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  // QBO entity alias lookup
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
  } catch (e) {
    console.warn("[invoices-fetch] QBO entity_aliases for reconciliation failed:", e instanceof Error ? e.message : String(e))
  }

  // Stripe customer entity alias lookup
  const stripeCustomerToEntity = new Map<string, string>()
  try {
    const stripeAliasRows = await query<{ entity_id: string; source_id: string }>(
      `SELECT ea.entity_id, ea.source_id FROM entity_aliases ea
       JOIN entities e ON e.id = ea.entity_id
       WHERE e.user_id = $1 AND ea.source = 'stripe' AND ea.source_id IS NOT NULL`,
      [userId]
    ).then((r) => r.rows)
    for (const a of stripeAliasRows) {
      if (a.source_id) stripeCustomerToEntity.set(a.source_id, a.entity_id)
    }
  } catch (e) {
    console.warn("[invoices-fetch] Stripe entity_aliases for reconciliation failed:", e instanceof Error ? e.message : String(e))
  }

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
      const balance = safeParseFloat(d.Balance)
      const totalAmt = safeParseFloat(d.TotalAmt, balance)
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
        entity_uri: toEntityUriAr("qbo", row.entity_id),
        amount: totalAmt,
        amount_due: 0,
        due_date: dueDate,
        days_until_due: null,
        days_overdue: null,
        status: "paid",
      })
    }
  } catch (e) {
    console.warn("[invoices-fetch] QBO paid invoices fetch failed:", e instanceof Error ? e.message : String(e))
  }

  try {
    const xeroRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT e.entity_id, e.data FROM xero_entities e
       JOIN xero_connections xc ON xc.tenant_id = e.tenant_id
       WHERE xc.user_id = $1 AND e.entity_type = 'Invoice'`,
      [userId]
    ).then((r) => r.rows)
    for (const row of xeroRows) {
      const d = row.data
      const amountDue = safeParseFloat(d.AmountDue)
      if (amountDue > 0) continue
      const total = safeParseFloat(d.Total)
      if (total <= 0) continue
      const contact = d.Contact as Record<string, unknown> | undefined
      const custName = String(contact?.Name ?? "Unknown")
      const contactId = xeroContactIdFromInvoiceContact(contact)
      const entityId = contactId ? (xeroContactIdToEntity.get(contactId) ?? null) : null
      const dueDate = (d.DueDateString as string) ?? (d.DateString as string) ?? null
      const dateStr = dueDate?.slice(0, 10) ?? ""
      if (dateStr && dateStr < cutoffStr) continue
      const existing = outstanding.find((i) => i.invoice_id === row.entity_id)
      if (existing) continue
      outstanding.push({
        invoice_id: row.entity_id,
        source: "xero",
        customer_name: custName,
        customer_source_id: contactId,
        entity_id: entityId,
        entity_uri: toEntityUriAr("xero", row.entity_id),
        amount: total,
        amount_due: 0,
        due_date: dueDate?.slice(0, 10) ?? null,
        days_until_due: null,
        days_overdue: null,
        status: "paid",
      })
    }
  } catch (e) {
    console.warn("[invoices-fetch] Xero paid invoices fetch failed:", e instanceof Error ? e.message : String(e))
  }

  try {
    const stripeRows = await query<{ entity_id: string; data: Record<string, unknown> }>(
      `SELECT entity_id, data FROM stripe_entities WHERE user_id = $1 AND entity_type = 'invoice'`,
      [userId]
    ).then((r) => r.rows)
    for (const row of stripeRows) {
      const d = row.data
      const amountDue = safeParseFloat(d.amount_due) / 100
      if (amountDue > 0) continue
      const total = safeParseFloat(d.total ?? d.amount_due) / 100
      if (total <= 0) continue
      const dueTimestamp = d.due_date as number | null
      const dueDate = dueTimestamp ? new Date(dueTimestamp * 1000).toISOString().slice(0, 10) : null
      if (dueDate && dueDate < cutoffStr) continue
      const custName = String(d.customer_name ?? d.customer_email ?? "Unknown")
      const custSourceId = d.customer != null ? String(d.customer) : null
      const existing = outstanding.find((i) => i.invoice_id === row.entity_id)
      if (existing) continue
      const entityId = custSourceId ? (stripeCustomerToEntity.get(custSourceId) ?? null) : null
      outstanding.push({
        invoice_id: row.entity_id,
        source: "stripe",
        customer_name: custName,
        customer_source_id: custSourceId,
        entity_id: entityId,
        entity_uri: toEntityUriAr("stripe", row.entity_id),
        amount: total,
        amount_due: 0,
        due_date: dueDate,
        days_until_due: null,
        days_overdue: null,
        status: "paid",
      })
    }
  } catch (e) {
    console.warn("[invoices-fetch] Stripe paid invoices fetch failed:", e instanceof Error ? e.message : String(e))
  }

  // Shopify paid orders (financial_status = 'paid')
  try {
    await ensureShopifySchema()
    type ShopifyOrderRow = {
      entity_id: string
      shop_domain: string
      data: {
        id: number | string
        name?: string
        order_number?: number
        created_at?: string
        financial_status?: string
        total_price?: string | number
        customer?: {
          id?: number | string
          email?: string
          first_name?: string
          last_name?: string
          default_address?: { company?: string }
        }
        billing_address?: { company?: string; name?: string }
      }
    }
    const shopifyRows = await query<ShopifyOrderRow>(
      `SELECT entity_id, shop_domain, data FROM shopify_entities 
       WHERE user_id = $1 AND entity_type = 'orders'
       AND data->>'financial_status' = 'paid'`,
      [userId]
    ).then((r) => r.rows)
    
    for (const row of shopifyRows) {
      const d = row.data
      const totalPrice = safeParseFloat(d.total_price)
      if (totalPrice <= 0) continue
      
      const createdAt = d.created_at ? d.created_at.slice(0, 10) : null
      if (createdAt && createdAt < cutoffStr) continue
      
      // Determine customer name
      let custName = "Unknown"
      const customer = d.customer
      if (customer) {
        const company = customer.default_address?.company || d.billing_address?.company
        if (company) custName = company
        else {
          const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ")
          if (name) custName = name
          else if (customer.email) custName = customer.email
        }
      } else if (d.billing_address?.name) {
        custName = d.billing_address.name
      }
      
      const invoiceId = `shopify_${row.shop_domain}_${row.entity_id}`
      const custSourceId = customer?.id != null ? String(customer.id) : null
      
      const existing = outstanding.find((i) => i.invoice_id === invoiceId)
      if (existing) continue
      
      outstanding.push({
        invoice_id: invoiceId,
        source: "shopify",
        customer_name: custName,
        customer_source_id: custSourceId,
        entity_id: null,
        entity_uri: toEntityUriAr("shopify", invoiceId),
        amount: totalPrice,
        amount_due: 0,
        due_date: createdAt,
        days_until_due: null,
        days_overdue: null,
        status: "paid",
      })
    }
  } catch (e) {
    console.warn("[invoices-fetch] Shopify paid orders fetch failed:", e instanceof Error ? e.message : String(e))
  }

  // Dedupe by source:invoice_id first (same-source duplicates)
  const seen = new Map<string, OutstandingInvoice>()
  for (const i of outstanding) {
    const key = `${i.source}:${i.invoice_id}`
    if (!seen.has(key)) seen.set(key, i)
  }
  
  // Cross-source deduplication: if same (customer_name, amount, due_date) exists from multiple sources,
  // prefer QBO > Xero > Stripe > Shopify > Gmail (accounting systems over email extraction)
  const SOURCE_PRIORITY: Record<string, number> = { qbo: 1, xero: 2, stripe: 3, shopify: 4, gmail: 5 }
  const crossSourceSeen = new Map<string, OutstandingInvoice>()
  for (const inv of seen.values()) {
    // Normalize customer name for comparison
    const custNorm = (inv.customer_name || "").toLowerCase().replace(/[^a-z0-9]/g, "")
    // Round amount to avoid floating point comparison issues
    const amtRounded = Math.round(inv.amount * 100)
    const crossKey = `${custNorm}|${amtRounded}|${inv.due_date ?? "null"}`
    
    const existing = crossSourceSeen.get(crossKey)
    if (!existing) {
      crossSourceSeen.set(crossKey, inv)
    } else {
      // Keep the one from higher priority source (lower number = higher priority)
      const existingPriority = SOURCE_PRIORITY[existing.source] ?? 99
      const newPriority = SOURCE_PRIORITY[inv.source] ?? 99
      if (newPriority < existingPriority) {
        crossSourceSeen.set(crossKey, inv)
      }
    }
  }
  
  return [...crossSourceSeen.values()]
}

/**
 * Enrich invoices with reconciliation status from movement_attributions.
 * Queries the attributions table to find which invoices have been matched to bank movements.
 * 
 * IMPORTANT: Only uses reference_id (invoice_id) for matching, NOT entity-level fallback.
 * Entity-level fallback was removed because it incorrectly aggregated ALL attributions 
 * for a customer across ALL their invoices, causing misleading "partial" matches.
 */
export async function enrichInvoicesWithReconciliationStatus(
  userId: string,
  invoices: OutstandingInvoice[]
): Promise<OutstandingInvoice[]> {
  if (invoices.length === 0) return invoices

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
       AND component_type = 'ar'
       AND source IN ('rule', 'llm')`,
    [userId]
  )

  // Track matches by specific invoice reference_id ONLY
  // We no longer use entity-level fallback as it caused incorrect aggregation
  // Handle both old format (qbo/178) and new format (178) for reference_id
  const matchesByInvoiceId = new Map<string, { movementIds: string[]; totalMatched: number }>()

  for (const attr of attrRows) {
    const gross = safeParseFloat(attr.gross_amount)
    
    // Only count attributions that have a specific reference_id (invoice_id)
    if (attr.reference_id) {
      // Normalize reference_id: strip source prefix if present (e.g., "qbo/178" -> "178")
      const normalizedRefId = attr.reference_id.includes('/') 
        ? attr.reference_id.split('/').pop() ?? attr.reference_id
        : attr.reference_id
      
      const existing = matchesByInvoiceId.get(normalizedRefId) ?? { movementIds: [], totalMatched: 0 }
      existing.movementIds.push(attr.movement_id)
      existing.totalMatched += gross
      matchesByInvoiceId.set(normalizedRefId, existing)
    }
    // Note: Attributions without reference_id are NOT counted toward any specific invoice
    // This prevents the bug where ALL customer payments were aggregated together
  }

  return invoices.map((inv) => {
    // Use amount_due if available, otherwise fall back to amount
    const targetAmount = (inv.amount_due != null && inv.amount_due > 0) ? inv.amount_due : inv.amount
    
    // Match by specific invoice_id (reference_id) ONLY
    const byId = matchesByInvoiceId.get(inv.invoice_id)
    
    if (byId && byId.movementIds.length > 0) {
      // We have a specific invoice-level match
      const rawMatchedAmount = byId.totalMatched
      const matchedAmount = Math.min(rawMatchedAmount, targetAmount)
      const tolerance = 0.01

      let reconciliationStatus: "matched" | "unmatched" | "partial"
      if (Math.abs(matchedAmount - targetAmount) < tolerance || matchedAmount >= targetAmount - tolerance) {
        reconciliationStatus = "matched"
      } else if (matchedAmount > 0) {
        reconciliationStatus = "partial"
      } else {
        reconciliationStatus = "unmatched"
      }

      return {
        ...inv,
        reconciliation_status: reconciliationStatus,
        matched_movement_ids: [...new Set(byId.movementIds)],
        matched_amount: matchedAmount,
      }
    }

    // No specific match found - invoice is unmatched
    return {
      ...inv,
      reconciliation_status: "unmatched" as const,
      matched_movement_ids: [],
      matched_amount: 0,
    }
  })
}

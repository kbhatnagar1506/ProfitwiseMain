/**
 * Adapters: map Stripe and QBO invoice payloads to NormalizedInvoiceJSON.
 * Stripe/QBO invoices are AR (receivables) by default.
 */

import type { NormalizedInvoiceJSON, InvoiceProvider } from "./invoice-documents"

function mapStatusToNormalized(status: string | undefined): NormalizedInvoiceJSON["status"] {
  if (!status) return "unknown"
  const s = status.toLowerCase()
  if (s === "paid" || s === "complete") return "paid"
  if (s === "draft") return "draft"
  if (s === "open" || s === "uncollectible") return "open"
  if (s === "void" || s === "voided") return "void"
  if (s === "cancelled" || s === "canceled") return "cancelled"
  if (s === "partial" || s.includes("partial")) return "partially_paid"
  return "unknown"
}

export function normalizeStripeInvoice(item: Record<string, unknown>, userId: string): NormalizedInvoiceJSON {
  const id = item.id != null ? String(item.id) : ""
  const number = item.number != null ? String(item.number) : id
  const created = item.created != null ? Number(item.created) : null
  const issueDate = created ? new Date(created * 1000).toISOString().slice(0, 10) : null
  const dueDate =
    item.due_date != null
      ? new Date(Number(item.due_date) * 1000).toISOString().slice(0, 10)
      : null
  const totalCents =
    typeof item.amount_due === "number"
      ? item.amount_due
      : typeof item.total === "number"
        ? item.total
        : typeof item.amount_paid === "number"
          ? item.amount_paid
          : null
  const total = totalCents != null ? totalCents / 100 : 0
  const amountPaid = typeof item.amount_paid === "number" ? item.amount_paid / 100 : null
  const amountOutstanding =
    typeof item.amount_due === "number" ? item.amount_due / 100 : total
  const currency =
    item.currency != null ? String(item.currency).toUpperCase() : "USD"
  const status = mapStatusToNormalized(item.status as string)
  const customerName =
    (item.customer_name as string) ??
    (item.customer_email as string) ??
    null
  const customerEmail = (item.customer_email as string) ?? null

  const lines: NormalizedInvoiceJSON["lines"] = []
  const linesData = (item.lines as { data?: Array<Record<string, unknown>> })?.data
  if (Array.isArray(linesData) && linesData.length > 0) {
    for (const line of linesData) {
      const desc = (line.description as string) ?? ""
      const amount = typeof line.amount === "number" ? line.amount / 100 : 0
      const qty = typeof line.quantity === "number" ? line.quantity : 1
      const unitPrice = qty > 0 ? amount / qty : null
      lines.push({
        description: desc,
        quantity: qty,
        unit_price: unitPrice,
        amount,
        sku: (line.price?.product as string) ?? null,
        account_code: null,
      })
    }
  }
  if (lines.length === 0 && total > 0) {
    lines.push({
      description: "Invoice",
      quantity: 1,
      unit_price: total,
      amount: total,
      sku: null,
      account_code: null,
    })
  }

  return {
    version: 1,
    user_id: userId,
    side: "AR",
    kind: "invoice",
    invoice_number: number || null,
    issue_date: issueDate,
    due_date: dueDate,
    currency,
    total,
    amount_outstanding: amountPaid != null ? Math.max(0, total - amountPaid) : amountOutstanding,
    status,
    counterparty_type: "customer",
    counterparty_name: customerName,
    counterparty_email: customerEmail,
    lines,
    meta: {
      source_system: "stripe" as InvoiceProvider,
      source_system_hint: "stripe",
      provider_invoice_id: id || null,
      provider_data: {
        hosted_invoice_url: item.hosted_invoice_url,
        invoice_pdf: item.invoice_pdf,
        customer: item.customer,
      },
      gmail_message_id: null,
      gmail_thread_id: null,
      gmail_subject: null,
      gmail_body_excerpt: null,
      stripe_invoice_id: id || null,
      stripe_customer_id: (item.customer as string) ?? null,
      qbo_invoice_id: null,
      xero_invoice_id: null,
      raw_payload: {},
    },
  }
}

export function normalizeQboInvoice(
  item: Record<string, unknown>,
  userId: string,
  realmId?: string
): NormalizedInvoiceJSON {
  const id = item.Id != null ? String(item.Id) : ""
  const docNum = item.DocNumber != null ? String(item.DocNumber) : ""
  const txnDate = item.TxnDate != null ? String(item.TxnDate) : null
  const dueDate = item.DueDate != null ? String(item.DueDate) : null
  const totalAmt =
    typeof item.TotalAmt === "number" ? item.TotalAmt : item.TotalAmt != null ? Number(item.TotalAmt) : 0
  const balance =
    typeof item.Balance === "number" ? item.Balance : item.Balance != null ? Number(item.Balance) : totalAmt
  const amountOutstanding = balance
  const status =
    balance === 0 ? "paid" : (item as { status?: string }).status ? mapStatusToNormalized((item as { status: string }).status) : "open"

  const customerRef = item.CustomerRef as { name?: string } | undefined
  const customerName = customerRef?.name != null ? String(customerRef.name) : null
  const billEmail = item.BillEmail as { Address?: string } | undefined
  const customerEmail = billEmail?.Address != null ? String(billEmail.Address) : null

  const lines: NormalizedInvoiceJSON["lines"] = []
  const lineItems = item.Line as Array<Record<string, unknown>>
  if (Array.isArray(lineItems) && lineItems.length > 0) {
    for (const line of lineItems) {
      const desc = (line.Description as string) ?? (line.SalesItemLineDetail as { ItemRef?: { name?: string } })?.ItemRef?.name ?? ""
      const amount = typeof line.Amount === "number" ? line.Amount : 0
      const qty =
        typeof (line.SalesItemLineDetail as { Qty?: number })?.Qty === "number"
          ? (line.SalesItemLineDetail as { Qty: number }).Qty
          : 1
      const unitPrice = qty > 0 ? amount / qty : null
      if (desc || amount > 0) {
        lines.push({
          description: desc,
          quantity: qty,
          unit_price: unitPrice,
          amount,
          sku: null,
          account_code: null,
        })
      }
    }
  }
  if (lines.length === 0 && totalAmt > 0) {
    lines.push({
      description: "Invoice",
      quantity: 1,
      unit_price: totalAmt,
      amount: totalAmt,
      sku: null,
      account_code: null,
    })
  }

  return {
    version: 1,
    user_id: userId,
    side: "AR",
    kind: "invoice",
    invoice_number: docNum || null,
    issue_date: txnDate,
    due_date: dueDate,
    currency: "USD",
    total: totalAmt,
    amount_outstanding: amountOutstanding,
    status,
    counterparty_type: "customer",
    counterparty_name: customerName,
    counterparty_email: customerEmail,
    lines,
    meta: {
      source_system: "qbo" as InvoiceProvider,
      source_system_hint: "qbo",
      provider_invoice_id: id || null,
      provider_data: { realm_id: realmId ?? (item.realmId as string) ?? null },
      gmail_message_id: null,
      gmail_thread_id: null,
      gmail_subject: null,
      gmail_body_excerpt: null,
      stripe_invoice_id: null,
      stripe_customer_id: null,
      qbo_invoice_id: id || null,
      xero_invoice_id: null,
      raw_payload: {},
    },
  }
}

export function normalizeXeroInvoice(
  item: Record<string, unknown>,
  userId: string,
  tenantId?: string
): NormalizedInvoiceJSON {
  const id = item.InvoiceID != null ? String(item.InvoiceID) : item.Id != null ? String(item.Id) : ""
  const number = item.InvoiceNumber != null ? String(item.InvoiceNumber) : ""
  const issueDate = item.Date != null ? String(item.Date) : null
  const dueDate = item.DueDate != null ? String(item.DueDate) : null

  const total =
    typeof item.Total === "number"
      ? item.Total
      : item.Total != null
        ? Number(item.Total)
        : null
  const amountPaid =
    typeof item.AmountPaid === "number"
      ? item.AmountPaid
      : item.AmountPaid != null
        ? Number(item.AmountPaid)
        : null
  const amountDue =
    typeof item.AmountDue === "number"
      ? item.AmountDue
      : item.AmountDue != null
        ? Number(item.AmountDue)
        : total

  const currency =
    item.CurrencyCode != null ? String(item.CurrencyCode).toUpperCase() : "USD"
  const status = mapStatusToNormalized(item.Status as string | undefined)

  const contact = item.Contact as { Name?: string; EmailAddress?: string } | undefined
  const contactName = contact?.Name != null ? String(contact.Name) : null
  const contactEmail = contact?.EmailAddress != null ? String(contact.EmailAddress) : null

  const type = item.Type != null ? String(item.Type).toUpperCase() : "ACCREC"
  const side: NormalizedInvoiceJSON["side"] =
    type === "ACCPAY" ? "AP" : "AR"
  const kind: NormalizedInvoiceJSON["kind"] =
    side === "AP" ? "bill" : "invoice"
  const counterpartyType: NormalizedInvoiceJSON["counterparty_type"] =
    side === "AP" ? "vendor" : "customer"

  const lines: NormalizedInvoiceJSON["lines"] = []
  const lineItems = item.LineItems as Array<Record<string, unknown>>
  if (Array.isArray(lineItems) && lineItems.length > 0) {
    for (const line of lineItems) {
      const desc = (line.Description as string) ?? ""
      const qty =
        typeof line.Quantity === "number"
          ? line.Quantity
          : line.Quantity != null
            ? Number(line.Quantity)
            : 1
      const lineAmount =
        typeof line.LineAmount === "number"
          ? line.LineAmount
          : line.LineAmount != null
            ? Number(line.LineAmount)
            : null
      const unitAmount =
        typeof line.UnitAmount === "number"
          ? line.UnitAmount
          : line.UnitAmount != null
            ? Number(line.UnitAmount)
            : null
      const amount =
        lineAmount != null
          ? lineAmount
          : unitAmount != null
            ? unitAmount * qty
            : null
      const sku = (line.ItemCode as string) ?? null
      const accountCode = (line.AccountCode as string) ?? null

      if (desc || amount != null) {
        lines.push({
          description: desc,
          quantity: qty,
          unit_price: unitAmount,
          amount,
          sku,
          account_code: accountCode,
        })
      }
    }
  }

  if (lines.length === 0 && total != null && total > 0) {
    lines.push({
      description: kind === "bill" ? "Bill" : "Invoice",
      quantity: 1,
      unit_price: total,
      amount: total,
      sku: null,
      account_code: null,
    })
  }

  const amountOutstanding =
    amountDue != null
      ? amountDue
      : total != null && amountPaid != null
        ? Math.max(0, total - amountPaid)
        : total

  return {
    version: 1,
    user_id: userId,
    side,
    kind,
    invoice_number: number || null,
    issue_date: issueDate,
    due_date: dueDate,
    currency,
    total,
    amount_outstanding: amountOutstanding,
    status,
    counterparty_type: counterpartyType,
    counterparty_name: contactName,
    counterparty_email: contactEmail,
    lines,
    meta: {
      source_system: "xero" as InvoiceProvider,
      source_system_hint: "other",
      provider_invoice_id: id || null,
      provider_data: { tenant_id: tenantId ?? (item.tenantId as string) ?? null },
      gmail_message_id: null,
      gmail_thread_id: null,
      gmail_subject: null,
      gmail_body_excerpt: null,
      stripe_invoice_id: null,
      stripe_customer_id: null,
      qbo_invoice_id: null,
      xero_invoice_id: id || null,
      raw_payload: {},
    },
  }
}

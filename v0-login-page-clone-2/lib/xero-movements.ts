/**
 * Xero Entities to Movements Conversion
 * Converts synced Xero invoices, bills, and payments into canonical movements for financial analysis.
 */

import { query, ensureMovementsSchema, ensureXeroSchema } from "./db"
import { log } from "./logger"

type XeroInvoice = {
  InvoiceID: string
  InvoiceNumber?: string
  Type?: "ACCREC" | "ACCPAY" // ACCREC = sales invoice, ACCPAY = bill
  Contact?: {
    ContactID?: string
    Name?: string
    EmailAddress?: string
  }
  Total?: number
  AmountDue?: number
  AmountPaid?: number
  AmountCredited?: number
  CurrencyCode?: string
  Status?: string
  Date?: string
  DueDate?: string
  FullyPaidOnDate?: string
  Reference?: string
  LineItems?: Array<{
    Description?: string
    Quantity?: number
    UnitAmount?: number
    LineAmount?: number
    AccountCode?: string
  }>
}

type XeroPayment = {
  PaymentID: string
  Invoice?: {
    InvoiceID?: string
    InvoiceNumber?: string
    Contact?: { Name?: string }
    CurrencyCode?: string
  }
  Amount?: number
  CurrencyCode?: string
  CurrencyRate?: number
  Date?: string
  Reference?: string
  Status?: string
  PaymentType?: string
  Account?: {
    AccountID?: string
    Name?: string
    Code?: string
  }
}

type XeroBankTransaction = {
  BankTransactionID: string
  Type?: string
  Contact?: {
    ContactID?: string
    Name?: string
  }
  Total?: number
  CurrencyCode?: string
  Date?: string
  Reference?: string
  Status?: string
  IsReconciled?: boolean
  BankAccount?: {
    AccountID?: string
    Name?: string
    Code?: string
  }
  LineItems?: Array<{
    Description?: string
    LineAmount?: number
    AccountCode?: string
  }>
}

function parseAmount(value: number | string | undefined | null): number {
  if (value === undefined || value === null) return 0
  const num = typeof value === "string" ? parseFloat(value) : value
  return isNaN(num) ? 0 : num
}

function parseXeroDate(dateStr: string | undefined): string {
  if (!dateStr) return new Date().toISOString().slice(0, 10)
  // Xero dates can be in format "/Date(1234567890000)/" or ISO format
  const msMatch = dateStr.match(/\/Date\((\d+)/)
  if (msMatch) {
    return new Date(parseInt(msMatch[1], 10)).toISOString().slice(0, 10)
  }
  // Try ISO format
  const d = new Date(dateStr)
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10)
  }
  return new Date().toISOString().slice(0, 10)
}

export async function convertXeroToMovements(userId: string, tenantId: string): Promise<{
  processed: number
  created: number
  updated: number
  errors: number
}> {
  await ensureXeroSchema()
  await ensureMovementsSchema()

  const stats = { processed: 0, created: 0, updated: 0, errors: 0 }

  // Track which invoice IDs we convert to avoid double-counting with payments
  const convertedInvoiceIds = new Set<string>()

  // Process invoices (both sales invoices and bills)
  const { rows: invoiceRows } = await query<{ entity_id: string; data: XeroInvoice }>(
    `SELECT entity_id, data FROM xero_entities 
     WHERE user_id = $1 AND tenant_id = $2 AND entity_type = 'Invoice'`,
    [userId, tenantId]
  )

  for (const row of invoiceRows) {
    stats.processed++
    const invoice = row.data
    const invoiceId = invoice.InvoiceID

    try {
      // Only process fully paid invoices (AUTHORISED may have partial/zero payment)
      const status = invoice.Status?.toUpperCase()
      if (status !== "PAID") continue

      const amountPaid = parseAmount(invoice.AmountPaid)
      if (amountPaid <= 0) continue

      const isSalesInvoice = invoice.Type === "ACCREC"
      const counterpartyName = invoice.Contact?.Name || (isSalesInvoice ? "Xero Customer" : "Xero Vendor")
      const invoiceDate = parseXeroDate(invoice.FullyPaidOnDate || invoice.Date)
      const currency = (invoice.CurrencyCode || "USD").toUpperCase()

      const movementId = `xero_invoice_${tenantId}_${invoiceId}`

      const metadata = {
        source: "xero",
        tenant_id: tenantId,
        invoice_id: invoiceId,
        invoice_number: invoice.InvoiceNumber,
        invoice_type: invoice.Type,
        contact_id: invoice.Contact?.ContactID,
        contact_email: invoice.Contact?.EmailAddress,
        status: invoice.Status,
        total: parseAmount(invoice.Total),
        amount_due: parseAmount(invoice.AmountDue),
        reference: invoice.Reference,
        line_items: invoice.LineItems?.slice(0, 10).map(li => ({
          description: li.Description,
          amount: parseAmount(li.LineAmount),
          account_code: li.AccountCode,
        })),
      }

      const direction = isSalesInvoice ? "inflow" : "outflow"
      const movementType = isSalesInvoice ? "xero_sales_invoice" : "xero_bill"
      const description = isSalesInvoice
        ? `Xero Invoice ${invoice.InvoiceNumber || invoiceId} - ${counterpartyName}`
        : `Xero Bill ${invoice.InvoiceNumber || invoiceId} - ${counterpartyName}`

      await query(
        `INSERT INTO movements (
          id, user_id, direction, amount, date, movement_type, provenance,
          counterparty, raw_description, metadata, currency, confidence, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'xero', $7, $8, $9, $10, 0.9, NOW())
        ON CONFLICT (id) DO UPDATE SET
          amount = EXCLUDED.amount,
          date = EXCLUDED.date,
          counterparty = EXCLUDED.counterparty,
          raw_description = EXCLUDED.raw_description,
          metadata = EXCLUDED.metadata,
          currency = EXCLUDED.currency,
          direction = EXCLUDED.direction,
          updated_at = NOW()
        WHERE movements.user_id = $2`,
        [
          movementId,
          userId,
          direction,
          amountPaid,
          invoiceDate,
          movementType,
          counterpartyName,
          description,
          JSON.stringify(metadata),
          currency,
        ]
      )
      stats.created++
      convertedInvoiceIds.add(invoiceId)
    } catch (e) {
      stats.errors++
      log("xero.movements.invoice_error", { userId, tenantId, invoiceId, error: String(e) }, "xero")
    }
  }

  // Process payments
  const { rows: paymentRows } = await query<{ entity_id: string; data: XeroPayment }>(
    `SELECT entity_id, data FROM xero_entities 
     WHERE user_id = $1 AND tenant_id = $2 AND entity_type = 'Payment'`,
    [userId, tenantId]
  )

  for (const row of paymentRows) {
    stats.processed++
    const payment = row.data
    const paymentId = payment.PaymentID

    try {
      if (payment.Status?.toUpperCase() === "DELETED") continue

      // Skip payments for invoices already converted — prevents double-counting
      const linkedInvoiceId = payment.Invoice?.InvoiceID
      if (linkedInvoiceId && convertedInvoiceIds.has(linkedInvoiceId)) continue

      const amount = parseAmount(payment.Amount)
      if (amount <= 0) continue

      const counterpartyName = payment.Invoice?.Contact?.Name || "Xero Payment"
      const paymentDate = parseXeroDate(payment.Date)

      const movementId = `xero_payment_${tenantId}_${paymentId}`

      const metadata = {
        source: "xero",
        tenant_id: tenantId,
        payment_id: paymentId,
        invoice_id: payment.Invoice?.InvoiceID,
        invoice_number: payment.Invoice?.InvoiceNumber,
        payment_type: payment.PaymentType,
        account_name: payment.Account?.Name,
        account_code: payment.Account?.Code,
        reference: payment.Reference,
        status: payment.Status,
      }

      // Determine direction based on payment type
      const isReceive = payment.PaymentType?.toUpperCase().includes("RECEIVE") ||
                        payment.PaymentType?.toUpperCase().includes("ACCRECPAYMENT")
      const direction = isReceive ? "inflow" : "outflow"
      const paymentCurrency = (payment.CurrencyCode || payment.Invoice?.CurrencyCode || "USD").toUpperCase()

      await query(
        `INSERT INTO movements (
          id, user_id, direction, amount, date, movement_type, provenance,
          counterparty, raw_description, metadata, currency, confidence, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'xero_payment', 'xero', $6, $7, $8, $9, 0.85, NOW())
        ON CONFLICT (id) DO UPDATE SET
          amount = EXCLUDED.amount,
          date = EXCLUDED.date,
          counterparty = EXCLUDED.counterparty,
          raw_description = EXCLUDED.raw_description,
          metadata = EXCLUDED.metadata,
          direction = EXCLUDED.direction,
          currency = EXCLUDED.currency,
          updated_at = NOW()
        WHERE movements.user_id = $2`,
        [
          movementId,
          userId,
          direction,
          amount,
          paymentDate,
          counterpartyName,
          `Xero Payment - ${counterpartyName}`,
          JSON.stringify(metadata),
          paymentCurrency,
        ]
      )
      stats.created++
    } catch (e) {
      stats.errors++
      log("xero.movements.payment_error", { userId, tenantId, paymentId, error: String(e) }, "xero")
    }
  }

  // Process bank transactions
  const { rows: bankTxnRows } = await query<{ entity_id: string; data: XeroBankTransaction }>(
    `SELECT entity_id, data FROM xero_entities 
     WHERE user_id = $1 AND tenant_id = $2 AND entity_type = 'BankTransaction'`,
    [userId, tenantId]
  )

  for (const row of bankTxnRows) {
    stats.processed++
    const txn = row.data
    const txnId = txn.BankTransactionID

    try {
      if (txn.Status?.toUpperCase() === "DELETED") continue

      const amount = parseAmount(txn.Total)
      if (amount <= 0) continue

      const counterpartyName = txn.Contact?.Name || "Xero Bank Transaction"
      const txnDate = parseXeroDate(txn.Date)
      const currency = (txn.CurrencyCode || "USD").toUpperCase()

      const movementId = `xero_banktxn_${tenantId}_${txnId}`

      const metadata = {
        source: "xero",
        tenant_id: tenantId,
        bank_transaction_id: txnId,
        transaction_type: txn.Type,
        contact_id: txn.Contact?.ContactID,
        bank_account_name: txn.BankAccount?.Name,
        bank_account_code: txn.BankAccount?.Code,
        reference: txn.Reference,
        is_reconciled: txn.IsReconciled,
        status: txn.Status,
        line_items: txn.LineItems?.slice(0, 10).map(li => ({
          description: li.Description,
          amount: parseAmount(li.LineAmount),
          account_code: li.AccountCode,
        })),
      }

      // Xero types: RECEIVE, RECEIVE-OVERPAYMENT, RECEIVE-PREPAYMENT = inflow
      //             SPEND, SPEND-OVERPAYMENT, SPEND-PREPAYMENT = outflow
      const type = txn.Type?.toUpperCase() || ""
      const isInflow = type.includes("RECEIVE")
      const direction = isInflow ? "inflow" : "outflow"

      await query(
        `INSERT INTO movements (
          id, user_id, direction, amount, date, movement_type, provenance,
          counterparty, raw_description, metadata, currency, confidence, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'xero_bank_transaction', 'xero', $6, $7, $8, $9, 0.85, NOW())
        ON CONFLICT (id) DO UPDATE SET
          amount = EXCLUDED.amount,
          date = EXCLUDED.date,
          counterparty = EXCLUDED.counterparty,
          raw_description = EXCLUDED.raw_description,
          metadata = EXCLUDED.metadata,
          currency = EXCLUDED.currency,
          direction = EXCLUDED.direction,
          updated_at = NOW()
        WHERE movements.user_id = $2`,
        [
          movementId,
          userId,
          direction,
          amount,
          txnDate,
          counterpartyName,
          `Xero ${txn.Type || "Transaction"} - ${counterpartyName}`,
          JSON.stringify(metadata),
          currency,
        ]
      )
      stats.created++
    } catch (e) {
      stats.errors++
      log("xero.movements.banktxn_error", { userId, tenantId, txnId, error: String(e) }, "xero")
    }
  }

  log("xero.movements.converted", { userId, tenantId, ...stats }, "xero")
  return stats
}

export async function convertAllXeroToMovements(userId: string): Promise<{
  tenants: Array<{ tenantId: string; stats: { processed: number; created: number; updated: number; errors: number } }>
}> {
  await ensureXeroSchema()

  const { rows } = await query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM xero_connections WHERE user_id = $1`,
    [userId]
  )

  const tenants: Array<{ tenantId: string; stats: { processed: number; created: number; updated: number; errors: number } }> = []

  for (const row of rows) {
    const stats = await convertXeroToMovements(userId, row.tenant_id)
    tenants.push({ tenantId: row.tenant_id, stats })
  }

  return { tenants }
}

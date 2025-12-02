/**
 * Stripe Entities to Movements Conversion
 * Converts synced Stripe invoices, charges, and payouts into canonical movements for financial analysis.
 */

import { query, ensureMovementsSchema, ensureStripeSchema } from "./db"
import { log } from "./logger"

type StripeInvoice = {
  id: string
  number?: string
  customer?: string
  customer_name?: string
  customer_email?: string
  amount_paid?: number
  amount_due?: number
  total?: number
  subtotal?: number
  tax?: number
  currency?: string
  status?: string
  paid?: boolean
  created?: number
  paid_at?: number
  due_date?: number
  description?: string
  lines?: { data?: Array<{ description?: string; amount?: number }> }
  metadata?: Record<string, string>
}

type StripePaymentIntent = {
  id: string
  amount?: number
  amount_received?: number
  currency?: string
  status?: string
  created?: number
  description?: string
  customer?: string
  metadata?: Record<string, string>
  charges?: { data?: Array<{ id?: string; amount?: number; refunded?: boolean; amount_refunded?: number }> }
}

type StripePayout = {
  id: string
  amount?: number
  currency?: string
  status?: string
  arrival_date?: number
  created?: number
  description?: string
  destination?: string
  fee?: number
  metadata?: Record<string, string>
}

type StripeCustomer = {
  id: string
  name?: string
  email?: string
  description?: string
  metadata?: Record<string, string>
}

function parseAmount(value: number | string | undefined | null): number {
  if (value === undefined || value === null) return 0
  const num = typeof value === "string" ? parseFloat(value) : value
  return isNaN(num) ? 0 : num / 100 // Stripe amounts are in cents
}

function timestampToDate(ts: number | undefined): string {
  if (!ts) return new Date().toISOString().slice(0, 10)
  return new Date(ts * 1000).toISOString().slice(0, 10)
}

export async function convertStripeToMovements(userId: string, stripeAccountId: string): Promise<{
  processed: number
  created: number
  updated: number
  errors: number
}> {
  await ensureStripeSchema()
  await ensureMovementsSchema()

  const stats = { processed: 0, created: 0, updated: 0, errors: 0 }

  // Build customer lookup
  const { rows: customerRows } = await query<{ entity_id: string; data: StripeCustomer }>(
    `SELECT entity_id, data FROM stripe_entities 
     WHERE user_id = $1 AND stripe_account_id = $2 AND entity_type = 'customer'`,
    [userId, stripeAccountId]
  )
  const customerMap = new Map<string, StripeCustomer>()
  for (const row of customerRows) {
    customerMap.set(row.entity_id, row.data)
  }

  // Process invoices (customer payments - inflows)
  const { rows: invoiceRows } = await query<{ entity_id: string; data: StripeInvoice }>(
    `SELECT entity_id, data FROM stripe_entities 
     WHERE user_id = $1 AND stripe_account_id = $2 AND entity_type = 'invoice'`,
    [userId, stripeAccountId]
  )

  for (const row of invoiceRows) {
    stats.processed++
    const invoice = row.data
    const invoiceId = invoice.id

    try {
      // Only process paid invoices
      if (!invoice.paid && invoice.status !== "paid") continue

      const amount = parseAmount(invoice.amount_paid || invoice.total)
      if (amount <= 0) continue

      const customer = invoice.customer ? customerMap.get(invoice.customer) : null
      const customerName = invoice.customer_name || customer?.name || customer?.email || `Stripe Customer`
      const invoiceDate = timestampToDate(invoice.paid_at || invoice.created)
      const currency = (invoice.currency || "usd").toUpperCase()

      const movementId = `stripe_invoice_${stripeAccountId}_${invoiceId}`

      const metadata = {
        source: "stripe",
        stripe_account_id: stripeAccountId,
        invoice_id: invoiceId,
        invoice_number: invoice.number,
        customer_id: invoice.customer,
        customer_email: invoice.customer_email || customer?.email,
        status: invoice.status,
        subtotal: parseAmount(invoice.subtotal),
        tax: parseAmount(invoice.tax),
        line_items: invoice.lines?.data?.slice(0, 10).map(li => ({
          description: li.description,
          amount: parseAmount(li.amount),
        })),
      }

      await query(
        `INSERT INTO movements (
          id, user_id, direction, amount, date, movement_type, provenance,
          counterparty, raw_description, metadata, currency, confidence, created_at
        ) VALUES ($1, $2, 'inflow', $3, $4, 'stripe_invoice', 'stripe', $5, $6, $7, $8, 0.9, NOW())
        ON CONFLICT (id) DO UPDATE SET
          amount = EXCLUDED.amount,
          date = EXCLUDED.date,
          counterparty = EXCLUDED.counterparty,
          raw_description = EXCLUDED.raw_description,
          metadata = EXCLUDED.metadata,
          currency = EXCLUDED.currency,
          updated_at = NOW()
        WHERE movements.user_id = $2`,
        [
          movementId,
          userId,
          amount,
          invoiceDate,
          customerName,
          `Stripe Invoice ${invoice.number || invoiceId} - ${customerName}`,
          JSON.stringify(metadata),
          currency,
        ]
      )
      stats.created++
    } catch (e) {
      stats.errors++
      log("stripe.movements.invoice_error", { userId, stripeAccountId, invoiceId, error: String(e) }, "stripe")
    }
  }

  // Process payment intents (direct charges - inflows)
  // Skip payment intents that back an invoice to avoid double-counting.
  // An invoice's payment_intent is already captured via the invoice movement above.
  const invoicePaymentIntentIds = new Set<string>()
  for (const row of invoiceRows) {
    const inv = row.data
    if (inv.paid || inv.status === "paid") {
      const piId = (inv as Record<string, unknown>).payment_intent
      if (typeof piId === "string" && piId) invoicePaymentIntentIds.add(piId)
    }
  }

  const { rows: paymentRows } = await query<{ entity_id: string; data: StripePaymentIntent }>(
    `SELECT entity_id, data FROM stripe_entities 
     WHERE user_id = $1 AND stripe_account_id = $2 AND entity_type = 'payment_intent'`,
    [userId, stripeAccountId]
  )

  for (const row of paymentRows) {
    stats.processed++
    const payment = row.data
    const paymentId = payment.id

    try {
      if (payment.status !== "succeeded") continue
      if (invoicePaymentIntentIds.has(paymentId)) continue

      const amount = parseAmount(payment.amount_received || payment.amount)
      if (amount <= 0) continue

      const customer = payment.customer ? customerMap.get(payment.customer) : null
      const customerName = customer?.name || customer?.email || "Stripe Payment"
      const paymentDate = timestampToDate(payment.created)
      const currency = (payment.currency || "usd").toUpperCase()

      const movementId = `stripe_payment_${stripeAccountId}_${paymentId}`

      const metadata = {
        source: "stripe",
        stripe_account_id: stripeAccountId,
        payment_intent_id: paymentId,
        customer_id: payment.customer,
        description: payment.description,
        status: payment.status,
      }

      await query(
        `INSERT INTO movements (
          id, user_id, direction, amount, date, movement_type, provenance,
          counterparty, raw_description, metadata, currency, confidence, created_at
        ) VALUES ($1, $2, 'inflow', $3, $4, 'stripe_payment', 'stripe', $5, $6, $7, $8, 0.9, NOW())
        ON CONFLICT (id) DO UPDATE SET
          amount = EXCLUDED.amount,
          date = EXCLUDED.date,
          counterparty = EXCLUDED.counterparty,
          raw_description = EXCLUDED.raw_description,
          metadata = EXCLUDED.metadata,
          currency = EXCLUDED.currency,
          updated_at = NOW()
        WHERE movements.user_id = $2`,
        [
          movementId,
          userId,
          amount,
          paymentDate,
          customerName,
          payment.description || `Stripe Payment - ${customerName}`,
          JSON.stringify(metadata),
          currency,
        ]
      )
      stats.created++
    } catch (e) {
      stats.errors++
      log("stripe.movements.payment_error", { userId, stripeAccountId, paymentId, error: String(e) }, "stripe")
    }
  }

  // Payouts are internal transfers (Stripe balance -> bank), not new revenue.
  // They will appear as bank deposits via Plaid. Recording them here as movements
  // would double-count the cash. Instead, we skip payout conversion entirely.
  // The bank-side deposit (from Plaid) is the canonical movement for this cash.

  log("stripe.movements.converted", { userId, stripeAccountId, ...stats }, "stripe")
  return stats
}

export async function convertAllStripeToMovements(userId: string): Promise<{
  accounts: Array<{ stripeAccountId: string; stats: { processed: number; created: number; updated: number; errors: number } }>
}> {
  await ensureStripeSchema()

  const { rows } = await query<{ stripe_account_id: string }>(
    `SELECT DISTINCT stripe_account_id FROM stripe_connections WHERE user_id = $1`,
    [userId]
  )

  const accounts: Array<{ stripeAccountId: string; stats: { processed: number; created: number; updated: number; errors: number } }> = []

  for (const row of rows) {
    const stats = await convertStripeToMovements(userId, row.stripe_account_id)
    accounts.push({ stripeAccountId: row.stripe_account_id, stats })
  }

  return { accounts }
}

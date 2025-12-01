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

      const { rowCount: existingCount } = await query(
        `SELECT 1 FROM movements WHERE id = $1 AND user_id = $2`,
        [movementId, userId]
      )

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

      if (existingCount && existingCount > 0) {
        await query(
          `UPDATE movements SET
            amount = $1,
            date = $2,
            counterparty = $3,
            raw_description = $4,
            metadata = $5,
            currency = $6,
            updated_at = NOW()
          WHERE id = $7 AND user_id = $8`,
          [
            amount,
            invoiceDate,
            customerName,
            `Stripe Invoice ${invoice.number || invoiceId} - ${customerName}`,
            JSON.stringify(metadata),
            currency,
            movementId,
            userId,
          ]
        )
        stats.updated++
      } else {
        await query(
          `INSERT INTO movements (
            id, user_id, direction, amount, date, movement_type, provenance,
            counterparty, raw_description, metadata, currency, confidence, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
          [
            movementId,
            userId,
            "inflow",
            amount,
            invoiceDate,
            "stripe_invoice",
            "stripe",
            customerName,
            `Stripe Invoice ${invoice.number || invoiceId} - ${customerName}`,
            JSON.stringify(metadata),
            currency,
            0.9,
          ]
        )
        stats.created++
      }
    } catch (e) {
      stats.errors++
      log("stripe.movements.invoice_error", { userId, stripeAccountId, invoiceId, error: String(e) }, "stripe")
    }
  }

  // Process payment intents (direct charges - inflows)
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
      // Only process succeeded payments
      if (payment.status !== "succeeded") continue

      const amount = parseAmount(payment.amount_received || payment.amount)
      if (amount <= 0) continue

      const customer = payment.customer ? customerMap.get(payment.customer) : null
      const customerName = customer?.name || customer?.email || "Stripe Payment"
      const paymentDate = timestampToDate(payment.created)
      const currency = (payment.currency || "usd").toUpperCase()

      const movementId = `stripe_payment_${stripeAccountId}_${paymentId}`

      const { rowCount: existingCount } = await query(
        `SELECT 1 FROM movements WHERE id = $1 AND user_id = $2`,
        [movementId, userId]
      )

      const metadata = {
        source: "stripe",
        stripe_account_id: stripeAccountId,
        payment_intent_id: paymentId,
        customer_id: payment.customer,
        description: payment.description,
        status: payment.status,
      }

      if (existingCount && existingCount > 0) {
        await query(
          `UPDATE movements SET
            amount = $1,
            date = $2,
            counterparty = $3,
            raw_description = $4,
            metadata = $5,
            currency = $6,
            updated_at = NOW()
          WHERE id = $7 AND user_id = $8`,
          [
            amount,
            paymentDate,
            customerName,
            payment.description || `Stripe Payment - ${customerName}`,
            JSON.stringify(metadata),
            currency,
            movementId,
            userId,
          ]
        )
        stats.updated++
      } else {
        await query(
          `INSERT INTO movements (
            id, user_id, direction, amount, date, movement_type, provenance,
            counterparty, raw_description, metadata, currency, confidence, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
          [
            movementId,
            userId,
            "inflow",
            amount,
            paymentDate,
            "stripe_payment",
            "stripe",
            customerName,
            payment.description || `Stripe Payment - ${customerName}`,
            JSON.stringify(metadata),
            currency,
            0.9,
          ]
        )
        stats.created++
      }
    } catch (e) {
      stats.errors++
      log("stripe.movements.payment_error", { userId, stripeAccountId, paymentId, error: String(e) }, "stripe")
    }
  }

  // Process payouts (bank transfers - outflows from Stripe to bank)
  const { rows: payoutRows } = await query<{ entity_id: string; data: StripePayout }>(
    `SELECT entity_id, data FROM stripe_entities 
     WHERE user_id = $1 AND stripe_account_id = $2 AND entity_type = 'payout'`,
    [userId, stripeAccountId]
  )

  for (const row of payoutRows) {
    stats.processed++
    const payout = row.data
    const payoutId = payout.id

    try {
      // Only process paid/in_transit payouts
      if (!["paid", "in_transit"].includes(payout.status || "")) continue

      const amount = parseAmount(payout.amount)
      if (amount <= 0) continue

      const payoutDate = timestampToDate(payout.arrival_date || payout.created)
      const currency = (payout.currency || "usd").toUpperCase()

      const movementId = `stripe_payout_${stripeAccountId}_${payoutId}`

      const { rowCount: existingCount } = await query(
        `SELECT 1 FROM movements WHERE id = $1 AND user_id = $2`,
        [movementId, userId]
      )

      const metadata = {
        source: "stripe",
        stripe_account_id: stripeAccountId,
        payout_id: payoutId,
        destination: payout.destination,
        status: payout.status,
        fee: parseAmount(payout.fee),
      }

      if (existingCount && existingCount > 0) {
        await query(
          `UPDATE movements SET
            amount = $1,
            date = $2,
            counterparty = $3,
            raw_description = $4,
            metadata = $5,
            currency = $6,
            updated_at = NOW()
          WHERE id = $7 AND user_id = $8`,
          [
            amount,
            payoutDate,
            "Stripe Payout",
            payout.description || `Stripe Payout to Bank`,
            JSON.stringify(metadata),
            currency,
            movementId,
            userId,
          ]
        )
        stats.updated++
      } else {
        await query(
          `INSERT INTO movements (
            id, user_id, direction, amount, date, movement_type, provenance,
            counterparty, raw_description, metadata, currency, confidence, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
          [
            movementId,
            userId,
            "inflow", // Payout is inflow to bank account
            amount,
            payoutDate,
            "stripe_payout",
            "stripe",
            "Stripe Payout",
            payout.description || `Stripe Payout to Bank`,
            JSON.stringify(metadata),
            currency,
            0.85, // Slightly lower confidence as it may match bank deposit
          ]
        )
        stats.created++
      }
    } catch (e) {
      stats.errors++
      log("stripe.movements.payout_error", { userId, stripeAccountId, payoutId, error: String(e) }, "stripe")
    }
  }

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

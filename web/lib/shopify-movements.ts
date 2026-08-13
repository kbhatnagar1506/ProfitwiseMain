/**
 * Shopify Orders to Movements Conversion
 * Converts synced Shopify orders into canonical movements for financial analysis.
 */

import { query, ensureMovementsSchema, ensureShopifySchema } from "./db"
import { log } from "./logger"

type ShopifyOrderData = {
  id: number | string
  name?: string
  order_number?: number
  created_at?: string
  updated_at?: string
  processed_at?: string
  financial_status?: string
  fulfillment_status?: string
  total_price?: string | number
  subtotal_price?: string | number
  total_tax?: string | number
  total_discounts?: string | number
  total_shipping_price_set?: { shop_money?: { amount?: string } }
  currency?: string
  customer?: {
    id?: number | string
    email?: string
    first_name?: string
    last_name?: string
    default_address?: { company?: string }
  }
  billing_address?: { company?: string; name?: string }
  line_items?: Array<{
    id?: number | string
    title?: string
    quantity?: number
    price?: string | number
    sku?: string
    product_id?: number | string
  }>
  refunds?: Array<{
    id?: number | string
    created_at?: string
    processed_at?: string
    refund_line_items?: Array<{
      quantity?: number
      subtotal?: string | number
      total_tax?: string | number
    }>
    transactions?: Array<{
      amount?: string | number
      kind?: string
      status?: string
    }>
  }>
  transactions?: Array<{
    id?: number | string
    kind?: string
    status?: string
    amount?: string | number
    created_at?: string
    gateway?: string
  }>
}

function parseAmount(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0
  const num = typeof value === "string" ? parseFloat(value) : value
  return isNaN(num) ? 0 : num
}

function getCustomerName(order: ShopifyOrderData): string {
  const customer = order.customer
  if (customer) {
    const company = customer.default_address?.company || order.billing_address?.company
    if (company) return company
    const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ")
    if (name) return name
    if (customer.email) return customer.email
  }
  return order.billing_address?.name || `Shopify Order #${order.order_number || order.id}`
}

export async function convertShopifyOrdersToMovements(userId: string, shopDomain: string): Promise<{
  processed: number
  created: number
  updated: number
  errors: number
}> {
  await ensureShopifySchema()
  await ensureMovementsSchema()

  const stats = { processed: 0, created: 0, updated: 0, errors: 0 }

  // Fetch all orders for this shop
  const { rows: orderRows } = await query<{ entity_id: string; data: ShopifyOrderData }>(
    `SELECT entity_id, data FROM shopify_entities 
     WHERE user_id = $1 AND shop_domain = $2 AND entity_type = 'orders'`,
    [userId, shopDomain]
  )

  for (const row of orderRows) {
    stats.processed++
    const order = row.data
    const orderId = String(order.id)

    try {
      // Skip unfulfilled/cancelled orders that haven't been paid
      const financialStatus = order.financial_status?.toLowerCase() ?? ""
      if (!["paid", "partially_paid", "partially_refunded", "refunded"].includes(financialStatus)) {
        continue
      }

      const totalPrice = parseAmount(order.total_price)
      if (totalPrice <= 0) continue

      const customerName = getCustomerName(order)
      const orderDate = order.processed_at || order.created_at || new Date().toISOString()
      const currency = order.currency?.toUpperCase() || "USD"
      const orderRef = order.name || `#${order.order_number || orderId}`

      // Create/update the main order movement (inflow - customer payment)
      const movementId = `shopify_order_${shopDomain}_${orderId}`

      const metadata = {
        source: "shopify",
        shop_domain: shopDomain,
        order_id: orderId,
        order_number: order.order_number,
        order_name: order.name,
        financial_status: order.financial_status,
        fulfillment_status: order.fulfillment_status,
        subtotal: parseAmount(order.subtotal_price),
        tax: parseAmount(order.total_tax),
        discounts: parseAmount(order.total_discounts),
        shipping: parseAmount(order.total_shipping_price_set?.shop_money?.amount),
        customer_email: order.customer?.email,
        line_items: order.line_items?.map((li) => ({
          title: li.title,
          quantity: li.quantity,
          price: parseAmount(li.price),
          sku: li.sku,
        })),
      }

      const { rowCount } = await query(
        `INSERT INTO movements (
          id, user_id, direction, amount, date, movement_type, provenance,
          counterparty, raw_description, metadata, currency, confidence, created_at
        ) VALUES ($1, $2, 'inflow', $3, $4, 'shopify_order', 'shopify', $5, $6, $7, $8, 0.9, NOW())
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
          totalPrice,
          orderDate.slice(0, 10),
          customerName,
          `Shopify Order ${orderRef} - ${customerName}`,
          JSON.stringify(metadata),
          currency,
        ]
      )
      if (rowCount && rowCount > 0) stats.created++; else stats.updated++

      // Process refunds as separate outflow movements
      for (const refund of order.refunds ?? []) {
        const refundId = String(refund.id)
        const refundMovementId = `shopify_refund_${shopDomain}_${refundId}`
        
        // Calculate refund amount from transactions or line items
        let refundAmount = 0
        for (const txn of refund.transactions ?? []) {
          if (txn.kind === "refund" && txn.status === "success") {
            refundAmount += parseAmount(txn.amount)
          }
        }
        if (refundAmount === 0) {
          for (const rli of refund.refund_line_items ?? []) {
            refundAmount += parseAmount(rli.subtotal) + parseAmount(rli.total_tax)
          }
        }

        if (refundAmount <= 0) continue

        const refundDate = refund.processed_at || refund.created_at || orderDate
        const refundMetadata = {
          source: "shopify",
          shop_domain: shopDomain,
          order_id: orderId,
          refund_id: refundId,
          order_name: order.name,
          original_order_amount: totalPrice,
        }

        await query(
          `INSERT INTO movements (
            id, user_id, direction, amount, date, movement_type, provenance,
            counterparty, raw_description, metadata, currency, confidence, created_at
          ) VALUES ($1, $2, 'outflow', $3, $4, 'shopify_refund', 'shopify', $5, $6, $7, $8, 0.9, NOW())
          ON CONFLICT (id) DO UPDATE SET
            amount = EXCLUDED.amount,
            date = EXCLUDED.date,
            counterparty = EXCLUDED.counterparty,
            raw_description = EXCLUDED.raw_description,
            metadata = EXCLUDED.metadata,
            updated_at = NOW()
          WHERE movements.user_id = $2`,
          [
            refundMovementId,
            userId,
            refundAmount,
            refundDate.slice(0, 10),
            customerName,
            `Shopify Refund for ${orderRef} - ${customerName}`,
            JSON.stringify(refundMetadata),
            currency,
          ]
        )
        stats.created++
      }
    } catch (e) {
      stats.errors++
      log("shopify.movements.order_error", { userId, shopDomain, orderId, error: String(e) }, "shopify")
    }
  }

  log("shopify.movements.converted", { userId, shopDomain, ...stats }, "shopify")
  return stats
}

export async function convertAllShopifyOrdersToMovements(userId: string): Promise<{
  shops: Array<{ shopDomain: string; stats: { processed: number; created: number; updated: number; errors: number } }>
}> {
  await ensureShopifySchema()
  
  const { rows } = await query<{ shop_domain: string }>(
    `SELECT DISTINCT shop_domain FROM shopify_connections WHERE user_id = $1`,
    [userId]
  )

  const shops: Array<{ shopDomain: string; stats: { processed: number; created: number; updated: number; errors: number } }> = []
  
  for (const row of rows) {
    const stats = await convertShopifyOrdersToMovements(userId, row.shop_domain)
    shops.push({ shopDomain: row.shop_domain, stats })
  }

  return { shops }
}

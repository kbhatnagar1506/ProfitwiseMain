/**
 * Vendor Credit Matching
 *
 * Handles the case where a vendor has issued a credit memo (negative outstanding_amount
 * on an AP cash_event). The credit can be:
 *
 * 1. Applied against a new bill from the same vendor (reduces what we owe)
 * 2. Applied against a partial payment for the same vendor
 * 3. Left as a credit balance (credit_type = 'vendor_credit')
 *
 * Customer overpayments (AR) follow the same logic inverted.
 */

import { query } from "./db"

export interface VendorCredit {
  cash_event_id: string
  entity_id: string
  credit_amount: number  // Absolute value of the negative outstanding_amount
  credit_type: "vendor_credit" | "customer_overpayment"
  user_id: string
}

export interface CreditApplicationResult {
  credit_id: string
  applied_to_event_id: string
  amount_applied: number
  remaining_credit: number
}

/**
 * Fetch all vendor credits (AP events with negative outstanding_amount) for a user.
 */
export async function fetchVendorCredits(userId: string): Promise<VendorCredit[]> {
  const result = await query<{
    id: string
    entity_id: string
    outstanding_amount: number
    credit_type: string
  }>(
    `SELECT id, entity_id, outstanding_amount, COALESCE(credit_type, 'vendor_credit') AS credit_type
     FROM cash_events
     WHERE user_id = $1
       AND event_type = 'ap'
       AND outstanding_amount < -0.01
     ORDER BY entity_id, outstanding_amount ASC`,
    [userId]
  )

  return result.rows.map((row) => ({
    cash_event_id: row.id,
    entity_id: row.entity_id,
    credit_amount: Math.abs(row.outstanding_amount),
    credit_type: row.credit_type as "vendor_credit" | "customer_overpayment",
    user_id: userId,
  }))
}

/**
 * Fetch all customer overpayments (AR events with negative outstanding_amount) for a user.
 */
export async function fetchCustomerOverpayments(userId: string): Promise<VendorCredit[]> {
  const result = await query<{
    id: string
    entity_id: string
    outstanding_amount: number
  }>(
    `SELECT id, entity_id, outstanding_amount
     FROM cash_events
     WHERE user_id = $1
       AND event_type = 'ar'
       AND outstanding_amount < -0.01
     ORDER BY entity_id, outstanding_amount ASC`,
    [userId]
  )

  return result.rows.map((row) => ({
    cash_event_id: row.id,
    entity_id: row.entity_id,
    credit_amount: Math.abs(row.outstanding_amount),
    credit_type: "customer_overpayment" as const,
    user_id: userId,
  }))
}

/**
 * Apply vendor credits against open bills for the same entity.
 * Returns a list of applications made.
 *
 * This is non-destructive; it only updates outstanding_amount and
 * credit_type — does NOT create movement_attributions.
 */
export async function applyVendorCreditsToOpenBills(
  userId: string
): Promise<CreditApplicationResult[]> {
  const credits = await fetchVendorCredits(userId)
  const applications: CreditApplicationResult[] = []

  for (const credit of credits) {
    if (credit.credit_amount <= 0.01) continue

    // Find open AP events for the same entity with positive outstanding_amount
    const openBills = await query<{
      id: string
      outstanding_amount: number
    }>(
      `SELECT id, outstanding_amount
       FROM cash_events
       WHERE user_id = $1
         AND event_type = 'ap'
         AND entity_id = $2
         AND outstanding_amount > 0.01
         AND status IN ('open', 'partially_paid')
       ORDER BY outstanding_amount ASC`,
      [userId, credit.entity_id]
    )

    let remainingCredit = credit.credit_amount

    for (const bill of openBills.rows) {
      if (remainingCredit <= 0.01) break

      const apply = Math.min(remainingCredit, bill.outstanding_amount)
      const newBillOutstanding = bill.outstanding_amount - apply
      const newBillStatus =
        newBillOutstanding <= 0.01
          ? "paid"
          : newBillOutstanding < bill.outstanding_amount
          ? "partially_paid"
          : "open"

      await query(
        `UPDATE cash_events
         SET outstanding_amount = $2,
             status = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [bill.id, newBillOutstanding, newBillStatus]
      )

      remainingCredit -= apply

      applications.push({
        credit_id: credit.cash_event_id,
        applied_to_event_id: bill.id,
        amount_applied: apply,
        remaining_credit: remainingCredit,
      })
    }

    // Update the credit event's outstanding_amount to reflect what remains
    const newCreditOutstanding = -remainingCredit
    const newCreditStatus =
      remainingCredit <= 0.01 ? "paid" : "open"
    const newCreditType =
      remainingCredit <= 0.01 ? "none" : credit.credit_type

    await query(
      `UPDATE cash_events
       SET outstanding_amount = $2,
           status = $3,
           credit_type = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [credit.cash_event_id, newCreditOutstanding, newCreditStatus, newCreditType]
    )
  }

  return applications
}

/**
 * Classify cash_events with zero/negative outstanding_amount as credits.
 * Sets credit_type and status = 'credit' where applicable.
 *
 * This is run during the cash_events build phase to ensure proper display.
 */
export async function classifyCreditEvents(userId: string): Promise<number> {
  const result = await query<{ id: string }>(
    `UPDATE cash_events
     SET credit_type = CASE
           WHEN event_type = 'ap' AND outstanding_amount < -0.01 THEN 'vendor_credit'
           WHEN event_type = 'ar' AND outstanding_amount < -0.01 THEN 'customer_overpayment'
           ELSE 'none'
         END,
         status = CASE
           WHEN outstanding_amount < -0.01 THEN 'open'  -- credits remain open until consumed
           ELSE status
         END,
         amount_signed = CASE
           WHEN event_type = 'ar' THEN amount
           ELSE -amount
         END
     WHERE user_id = $1
       AND (credit_type IS NULL OR amount_signed IS NULL)
     RETURNING id`,
    [userId]
  )
  return result.rowCount ?? 0
}

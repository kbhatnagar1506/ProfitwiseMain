/**
 * Maps economic_class + movement_type to reconciliation payment_class.
 * Used to classify payments for AR/AP reconciliation and filtering.
 */

export type PaymentClass =
  | "AR_COLLECTION"
  | "AP_PAYMENT"
  | "INTERNAL_TRANSFER"
  | "FINANCING"
  | "FEES"
  | "PROCESSOR_SETTLEMENT"
  | "OTHER"

/**
 * Maps economic_class (and optionally movement_type) to reconciliation payment_class.
 */
export function getPaymentClass(
  economicClass: string | null | undefined,
  movementType?: string | null
): PaymentClass {
  const ec = (economicClass ?? "unknown").toLowerCase()

  switch (ec) {
    case "customer_receipt":
      return "AR_COLLECTION"
    case "vendor_payment":
    case "payroll":
    case "debt_payment":
    case "tax":
      return "AP_PAYMENT"
    case "transfer":
      return "INTERNAL_TRANSFER"
    case "processor_payout":
    case "settlement_in":
      return "PROCESSOR_SETTLEMENT"
    case "bank_fee":
    case "bank_fee_refund":
    case "processor_fee":
      return "FEES"
    case "owner_contribution":
    case "owner_draw":
      return "FINANCING"
    case "refund":
      return "AR_COLLECTION" // refunds are contra-revenue, treat as AR-related
    case "opening_balance":
    case "account_verification":
    case "system_adjustment":
    case "settlement_adjustment":
    case "unknown":
    default:
      return "OTHER"
  }
}

/** True if payment_class should be included in AR/AP reconciliation table by default. */
export function isARAPOperating(pc: PaymentClass): boolean {
  return pc === "AR_COLLECTION" || pc === "AP_PAYMENT" || pc === "PROCESSOR_SETTLEMENT"
}

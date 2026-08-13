/**
 * Processor / merchant rails — deterministic settlement before LLM or generic transfer rules.
 * Uses scrubbed uppercase text + direction + amount.
 */

export type ProcessorInterceptResult = {
  movement_type:
    | "processor_payout"
    | "processor_fee_settlement"
    | "cash_out_refund"
  confidence: number
  reason: string
}

/** Strong processor / merchant settlement signals (uppercase). Kept tight to avoid false positives. */
const PROCESSOR_RAIL_MARKERS = [
  "MERCHANT BANKCD",
  "MERCHANT BANK CD",
  "BANKCD DEPOSIT",
  "MERCH DEP",
  "SHOPIFY ST-",
  "SHOPIFY ST ",
  "SQ *",
  "TST*",
  "POS DEPOSIT",
  "POS DEP",
]

/**
 * @param scrubbedUpper — output of scrubBankText (already uppercased)
 */
export function interceptProcessor(
  scrubbedUpper: string,
  amount: number,
  direction: "inflow" | "outflow"
): ProcessorInterceptResult | null {
  const text = scrubbedUpper
  if (!text) return null

  const hasProcessorRail = PROCESSOR_RAIL_MARKERS.some((p) => text.includes(p))

  if (direction === "inflow" && hasProcessorRail) {
    return {
      movement_type: "processor_payout",
      confidence: 0.99,
      reason: "processor_rail_inflow",
    }
  }

  const looksProcessorOut = direction === "outflow" && hasProcessorRail

  if (looksProcessorOut) {
    if (amount < 50) {
      return {
        movement_type: "processor_fee_settlement",
        confidence: 0.9,
        reason: "processor_outflow_small",
      }
    }
    return {
      movement_type: "cash_out_refund",
      confidence: 0.85,
      reason: "processor_outflow_large",
    }
  }

  return null
}

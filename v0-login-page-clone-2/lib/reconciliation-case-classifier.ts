/**
 * AR Reconciliation Case Classifier
 *
 * Deterministic classification of bank INFLOWS into distinct case types.
 * AR-ONLY: Matches customer payments to invoices.
 * 
 * AP (outflows) are excluded - they go through vendor classification instead.
 */

import type { CashEventRow } from "./cash-events-build"
import { heuristicAliasMatch, normalizeForMatch } from "./alias-normalize"

const EPS = 0.01

// ─────────────────────────────────────────────────────────────────────────────
// Type Definitions - AR FOCUSED
// ─────────────────────────────────────────────────────────────────────────────

export type CaseType =
  // Direct Link Cases (5) - Invoice ID found in bank data
  | "DIRECT_LINK_SINGLE"           // One invoice linked directly
  | "DIRECT_LINK_MULTI_SAME_CUSTOMER" // Multiple invoices, same customer
  | "DIRECT_LINK_MULTI_DIFF_CUSTOMER" // Multiple invoices, different customers
  | "DIRECT_LINK_WITH_FEE"         // Direct link but with processor fee
  | "DIRECT_LINK_PARTIAL"          // Direct link but partial payment
  // Exact Match Cases (4) - Payment = Invoice amount
  | "EXACT_SINGLE"                 // One invoice, exact amount match
  | "EXACT_MULTI_SAME_CUSTOMER"    // Multiple invoices same amount, same customer
  | "EXACT_MULTI_DIFF_CUSTOMER"    // Multiple invoices same amount, different customers
  | "EXACT_WITH_REFERENCE"         // Exact match with reference number in description
  // Fee-Adjusted Cases (4) - Payment = Invoice - processor fee
  | "FEE_ADJUSTED_SINGLE"          // One invoice, fee deducted (2-5%)
  | "FEE_ADJUSTED_MULTI"           // Multiple invoices, fee deducted
  | "FEE_STRIPE_SQUARE"            // Stripe/Square processor fee pattern
  | "FEE_ACH"                      // ACH processing fee pattern
  // Partial Payment Cases (3) - Payment < Invoice amount
  | "PARTIAL_SINGLE"               // Partial payment on one invoice
  | "PARTIAL_MULTI_SAME_CUSTOMER"  // Partial across multiple, same customer
  | "PARTIAL_MULTI_DIFF_CUSTOMER"  // Partial across multiple, different customers
  // Aggregation Cases (3) - One payment covers multiple invoices
  | "AGGREGATION_SAME_CUSTOMER"    // Multiple invoices, same customer
  | "AGGREGATION_DIFF_CUSTOMER"    // Multiple invoices, different customers (rare)
  | "AGGREGATION_WITH_FEE"         // Aggregation with fee deducted
  // Overpayment Cases (2) - Payment > Invoice amount
  | "OVERPAYMENT_SINGLE"           // Paid more than invoice amount
  | "OVERPAYMENT_PREPAYMENT"       // Payment before invoice exists (deposit)
  // Rounding Cases (2) - Small difference < $0.05
  | "ROUNDING_UNDER"               // Paid slightly less
  | "ROUNDING_OVER"                // Paid slightly more
  // Discount Cases (2)
  | "EARLY_DISCOUNT"               // Early payment discount (1-3%)
  | "VOLUME_DISCOUNT"              // Volume-based discount
  // Refund Cases (2) - Money going back to customer
  | "REFUND_FULL"                  // Full refund (outflow matching AR)
  | "REFUND_PARTIAL"               // Partial refund
  // Special Cases (3)
  | "DUPLICATE_PAYMENT"            // Same payment made twice
  | "CROSS_CUSTOMER_PAYMENT"       // Payment from wrong customer
  | "ZERO_AMOUNT"                  // $0 transaction
  // Zero Candidate Cases (5) - No matching invoice found (AR-specific)
  | "ZERO_MISSING_INVOICE"         // Customer paid but no invoice exists
  | "ZERO_PREPAYMENT"              // Large deposit/prepayment before invoice
  | "ZERO_REFUND_RECEIVED"         // Refund from vendor (unusual inflow)
  | "ZERO_DELETED_CUSTOMER"        // Customer was deleted from system
  | "ZERO_UNCLASSIFIED"            // Needs manual review
  // No Match Cases (2)
  | "NO_MATCH_HAS_CANDIDATES"      // Has invoice candidates but none match well
  | "NO_MATCH_NO_CANDIDATES"       // No invoice candidates at all
  // Non-Operational Cases (12) - Excluded from AR reconciliation
  | "INTERCOMPANY_TRANSFER"
  | "LOAN_PAYMENT"
  | "LOAN_PROCEEDS"
  | "PAYROLL"
  | "TAX_PAYMENT"
  | "OWNER_DRAW"
  | "OWNER_CONTRIBUTION"
  | "BANK_FEE"
  | "INTEREST_INCOME"
  | "CREDIT_CARD_PAYMENT"
  | "MERCHANT_DEPOSIT"
  | "UNCLASSIFIED_NON_OP"
  // AP Placeholder (outflows excluded from reconciliation)
  | "AP_EXCLUDED"

export type MatchType = "EXACT" | "FEE" | "PARTIAL" | "AGGREGATION" | "ROUNDING" | "DISCOUNT" | "REVERSAL" | "DIRECT_LINK"

export interface Candidate {
  id: string
  entity_id: string
  entity_name: string
  amount: number
  outstanding_amount: number
  due_date: string | null
  match_type: MatchType
  secondary_match_types: MatchType[]
  amount_diff: number
  fee_implied: number | null
  is_direct_link: boolean
  reference_match: boolean
  is_customer_match?: boolean  // NEW: matched via customer name
  is_amount_match?: boolean    // NEW: matched via amount tolerance
}

export interface ClassificationFlags {
  has_direct_link: boolean
  has_reference: boolean
  has_fee: boolean
  is_partial: boolean
  is_aggregation: boolean
  is_reversal: boolean
  same_amount_conflict: boolean
  cross_entity: boolean
  is_zero_amount: boolean
  is_duplicate: boolean
}

export interface ClassificationResult {
  movement_id: string
  case_type: CaseType
  is_operational: boolean
  candidates: Candidate[]
  flags: ClassificationFlags
  suggested_action: "auto_match" | "review" | "manual" | "exclude"
}

export type MovementWithAvailableCash = {
  id: string
  user_id: string
  direction: "inflow" | "outflow"
  amount: number
  date: string
  movement_type: string
  counterparty: string | null
  counterparty_entity_id: string | null
  raw_description: string | null
  metadata: Record<string, unknown>
  available_cash: number
  economic_class: string | null
  tag_data: Record<string, unknown> | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function isNonOperational(economicClass: string | null): boolean {
  if (!economicClass) return false
  const nonOpClasses = [
    "transfer",
    "owner_draw",
    "owner_contribution",
    "bank_fee",
    "bank_fee_refund",
    "interest",
    "processor_fee",
    "processor_payout",
    "opening_balance",
    "account_verification",
    "system_adjustment",
  ]
  return nonOpClasses.includes(economicClass)
}

function classifyNonOperational(economicClass: string | null): CaseType {
  switch (economicClass) {
    case "transfer":
      return "INTERCOMPANY_TRANSFER"
    case "owner_draw":
      return "OWNER_DRAW"
    case "owner_contribution":
      return "OWNER_CONTRIBUTION"
    case "bank_fee":
      return "BANK_FEE"
    case "interest":
      return "INTEREST_INCOME"
    case "processor_fee":
      return "FEE_STRIPE_SQUARE"
    case "processor_payout":
      return "MERCHANT_DEPOSIT"
    default:
      return "UNCLASSIFIED_NON_OP"
  }
}

function extractDirectLinkId(tagData: Record<string, unknown> | null): string | null {
  if (!tagData) return null
  return (tagData.invoice_id as string) || (tagData.bill_id as string) || null
}

function extractReferenceFromDescription(description: string | null): string[] {
  if (!description) return []

  const references: string[] = []

  // Extract invoice/bill numbers
  const invMatch = description.match(/(?:inv|invoice|bill|ref|reference|#)[\s#]*(\d+)/gi)
  if (invMatch) {
    references.push(...invMatch.map((m) => m.replace(/\D/g, "")))
  }

  // Extract PO numbers
  const poMatch = description.match(/(?:po|purchase order)[\s#]*(\d+)/gi)
  if (poMatch) {
    references.push(...poMatch.map((m) => m.replace(/\D/g, "")))
  }

  // Extract check numbers
  const checkMatch = description.match(/(?:check|chk)[\s#]*(\d+)/gi)
  if (checkMatch) {
    references.push(...checkMatch.map((m) => m.replace(/\D/g, "")))
  }

  return [...new Set(references)] // Remove duplicates
}

function detectFeeAmount(movement: MovementWithAvailableCash, candidate: CashEventRow): number | null {
  const movAmount = Math.abs(movement.available_cash)
  const candAmount = candidate.amount

  // Fee only applies when payment is less than invoice (processor took a cut)
  if (movAmount >= candAmount) return null

  const diff = candAmount - movAmount
  if (diff < EPS) return null

  const feeRatio = diff / candAmount
  // Fee can be 0-5% (typical processor fees: Stripe 2.9%+$0.30, PayPal 2.9%, Square 2.6%, ACH 0.5-1%)
  // No lower bound - even small fees are valid
  if (feeRatio > 0.05) return null

  return diff
}

function detectProcessorType(counterparty: string | null): "stripe" | "square" | "ach" | null {
  if (!counterparty) return null
  const lower = counterparty.toLowerCase()
  if (lower.includes("stripe")) return "stripe"
  if (lower.includes("square")) return "square"
  if (lower.includes("ach")) return "ach"
  return null
}

function isEarlyDiscount(movement: MovementWithAvailableCash, candidate: CashEventRow): boolean {
  if (!candidate.expected_date) return false

  const movDate = new Date(movement.date).getTime()
  const dueDate = new Date(candidate.expected_date).getTime()
  const daysDiff = (movDate - dueDate) / (1000 * 60 * 60 * 24) // Payment date - due date

  // Payment must be BEFORE due date (negative daysDiff) and within 10 days
  if (daysDiff > 0 || daysDiff < -10) return false

  const discountRatio = (candidate.amount - Math.abs(movement.available_cash)) / candidate.amount
  return discountRatio >= 0.01 && discountRatio <= 0.03
}

function isReversal(movement: MovementWithAvailableCash, candidate: CashEventRow): boolean {
  const movAmount = Math.abs(movement.available_cash)
  const candAmount = Math.abs(candidate.amount)

  // Amounts must match
  if (Math.abs(movAmount - candAmount) >= EPS) return false

  // For AR (receivable), a reversal would be an outflow (refund to customer)
  // For AP (payable), a reversal would be an inflow (refund from vendor)
  const isOppositeDirection =
    (candidate.event_type === "ar" && movement.direction === "outflow") ||
    (candidate.event_type === "ap" && movement.direction === "inflow")
  if (!isOppositeDirection) return false

  // Optional: Check if reversal is recent (within 30 days)
  const movDate = new Date(movement.date).getTime()
  const candDate = new Date(candidate.expected_date || "").getTime()
  if (candDate === 0) return true // No date to check

  const daysDiff = Math.abs(movDate - candDate) / (1000 * 60 * 60 * 24)
  return daysDiff <= 30
}

function isRounding(movement: MovementWithAvailableCash, candidate: CashEventRow): boolean {
  const diff = Math.abs(candidate.amount - Math.abs(movement.available_cash))
  return diff > EPS && diff <= 0.05
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate Building
// ─────────────────────────────────────────────────────────────────────────────

function buildCandidates(
  movement: MovementWithAvailableCash,
  cashEvents: CashEventRow[],
  targetType: "ar" | "ap",
  matchedCustomer: string | null = null,  // NEW: matched customer from LLM
  maxCandidates: number = 20
): Candidate[] {
  const candidates: Candidate[] = []
  const movAmount = Math.abs(movement.available_cash)
  const directLinkId = extractDirectLinkId(movement.tag_data)
  const refsFromDesc = [
    ...extractReferenceFromDescription(movement.counterparty),
    ...extractReferenceFromDescription(movement.raw_description),
  ]

  // Also check for reversals (opposite direction)
  const reverseType = targetType === "ar" ? "ap" : "ar"

  // Track which candidates are amount-based vs customer-based
  const amountBasedIds = new Set<string>()
  const customerBasedIds = new Set<string>()

  for (const event of cashEvents) {
    // Check both target type and reverse type (for reversals)
    const isTargetType = event.event_type === targetType
    const isReverseType = event.event_type === reverseType
    if (!isTargetType && !isReverseType) continue
    
    // Use original amount for matching - we're correcting books, not filtering by outstanding
    // Skip only if the original amount is zero/invalid
    if (event.amount <= EPS) continue

    const entityName = (event.metadata?.customer_name || event.metadata?.vendor_name || event.entity_id) as string
    const amountDiff = Math.abs(event.amount - movAmount)
    const isDirectLink = directLinkId === event.id || directLinkId === event.metadata?.invoice_id || directLinkId === event.metadata?.bill_id
    const refMatch = refsFromDesc.some((ref) => {
      const candRef = String(event.metadata?.invoice_number || event.metadata?.bill_number || "")
      return candRef === ref // Exact match
    })

    // Determine all applicable match types
    const matchTypes: MatchType[] = []

    // Check for reversal first (only for opposite type)
    if (isReverseType && isReversal(movement, event)) {
      matchTypes.push("REVERSAL")
    }

    // Skip non-reversal candidates from reverse type
    if (isReverseType && matchTypes.length === 0) continue

    if (isDirectLink) {
      matchTypes.push("DIRECT_LINK")
    }

    // Only check fee/discount/partial for target type (not reversals)
    if (isTargetType) {
      const feeImplied = detectFeeAmount(movement, event)
      if (feeImplied) {
        matchTypes.push("FEE")
      }
      if (isRounding(movement, event)) {
        matchTypes.push("ROUNDING")
      }
      if (isEarlyDiscount(movement, event)) {
        matchTypes.push("DISCOUNT")
      }
      // PARTIAL: payment is less than invoice, but NOT explained by fee or discount
      // Only mark as PARTIAL if no fee was detected
      if (movAmount < event.amount - EPS && !feeImplied && !isEarlyDiscount(movement, event)) {
        matchTypes.push("PARTIAL")
      }

      // Primary is the first (highest priority), secondary are the rest
      const primaryMatchType = matchTypes[0] || "EXACT"
      const secondaryMatchTypes = matchTypes.slice(1)

      // Check if this is an amount-based match (within 20%)
      const diffRatio = amountDiff / event.amount
      const isAmountMatch = diffRatio <= 0.2 || primaryMatchType === "DIRECT_LINK" || amountDiff < EPS
      if (isAmountMatch) {
        amountBasedIds.add(event.id)
      }

      candidates.push({
        id: event.id,
        entity_id: event.entity_id,
        entity_name: entityName,
        amount: event.amount,
        outstanding_amount: event.outstanding_amount,
        due_date: event.expected_date,
        match_type: primaryMatchType,
        secondary_match_types: secondaryMatchTypes,
        amount_diff: amountDiff,
        fee_implied: detectFeeAmount(movement, event),
        is_direct_link: isDirectLink,
        reference_match: !!refMatch,
        is_amount_match: isAmountMatch,
        is_customer_match: false,  // Will be set below
      })
    } else {
      // Reversal candidate
      candidates.push({
        id: event.id,
        entity_id: event.entity_id,
        entity_name: entityName,
        amount: event.amount,
        outstanding_amount: event.outstanding_amount,
        due_date: event.expected_date,
        match_type: "REVERSAL",
        secondary_match_types: [],
        amount_diff: amountDiff,
        fee_implied: null,
        is_direct_link: isDirectLink,
        reference_match: !!refMatch,
        is_amount_match: false,
        is_customer_match: false,
      })
    }
  }

  // NEW: Add customer-based candidates if customer was matched
  if (matchedCustomer) {
    const normalizedMatchedCustomer = normalizeForMatch(matchedCustomer)
    
    for (const event of cashEvents) {
      // Skip if already added as amount-based
      if (candidates.some(c => c.id === event.id)) continue
      
      if (event.event_type !== targetType) continue
      if (event.amount <= EPS) continue

      const eventCustomerName = (event.metadata?.customer_name || event.metadata?.vendor_name) as string
      
      // Check if customer names match using normalized comparison
      // This ensures ALL invoices for the matched customer are included, regardless of minor name variations
      if (eventCustomerName && normalizeForMatch(eventCustomerName) === normalizedMatchedCustomer) {
        const entityName = eventCustomerName || event.entity_id
        const amountDiff = Math.abs(event.amount - movAmount)
        
        customerBasedIds.add(event.id)
        
        candidates.push({
          id: event.id,
          entity_id: event.entity_id,
          entity_name: entityName,
          amount: event.amount,
          outstanding_amount: event.outstanding_amount,
          due_date: event.expected_date,
          match_type: "EXACT",  // Default to EXACT for customer matches
          secondary_match_types: [],
          amount_diff: amountDiff,
          fee_implied: null,
          is_direct_link: false,
          reference_match: false,
          is_amount_match: false,
          is_customer_match: true,  // NEW: marked as customer match
        })
      }
    }
  }

  // Sort by match quality: 
  // 1. Both amount and customer match (highest priority)
  // 2. Direct link
  // 3. EXACT match type
  // 4. Amount diff
  candidates.sort((a, b) => {
    // Both matches (intersection) - highest priority
    const aIsBoth = a.is_amount_match && a.is_customer_match
    const bIsBoth = b.is_amount_match && b.is_customer_match
    if (aIsBoth !== bIsBoth) return aIsBoth ? -1 : 1

    // Direct link
    if (a.is_direct_link !== b.is_direct_link) return a.is_direct_link ? -1 : 1
    
    // Customer match
    if (a.is_customer_match !== b.is_customer_match) return a.is_customer_match ? -1 : 1
    
    // EXACT match type
    if (a.match_type === "EXACT" && b.match_type !== "EXACT") return -1
    if (a.match_type !== "EXACT" && b.match_type === "EXACT") return 1
    
    // Amount diff
    return a.amount_diff - b.amount_diff
  })

  // Filter out low-quality matches (amount diff > 20%), but keep customer matches
  const qualityCandidates = candidates.filter((c) => {
    const diffRatio = c.amount_diff / c.amount
    // Keep if: within 20% diff, OR direct link, OR truly exact, OR customer match
    return diffRatio <= 0.2 || c.match_type === "DIRECT_LINK" || c.amount_diff < EPS || c.is_customer_match
  })

  // Return top N candidates
  return qualityCandidates.slice(0, maxCandidates)
}

// ─────────────────────────────────────────────────────────────────────────────
// Flag Detection
// ─────────────────────────────────────────────────────────────────────────────

function detectFlags(
  movement: MovementWithAvailableCash,
  candidates: Candidate[],
  allMovements?: MovementWithAvailableCash[]
): ClassificationFlags {
  const directLinkCandidates = candidates.filter((c) => c.is_direct_link)
  const exactCandidates = candidates.filter((c) => c.match_type === "EXACT" && Math.abs(c.amount_diff) < EPS)
  const feeCandidates = candidates.filter((c) => c.match_type === "FEE")
  const reversalCandidates = candidates.filter((c) => c.match_type === "REVERSAL")
  const partialCandidates = candidates.filter((c) => c.match_type === "PARTIAL")

  // Only sum candidates that are truly matchable (EXACT or FEE matches)
  const matchableCandidates = candidates.filter((c) => c.match_type === "EXACT" || c.match_type === "FEE")
  const aggregationSum = matchableCandidates.reduce((sum, c) => sum + c.amount, 0)

  // Improved conflict detection: account for fees
  const potentialConflicts = [
    ...exactCandidates,
    ...feeCandidates.filter((fc) => {
      // A fee candidate conflicts if its amount (minus fee) matches movement
      const amountAfterFee = fc.amount - (fc.fee_implied || 0)
      return Math.abs(amountAfterFee - Math.abs(movement.available_cash)) < EPS
    }),
  ]

  // Detect chargeback from description
  const desc = (movement.raw_description || "").toLowerCase()
  const isChargeback = desc.includes("chargeback") || desc.includes("dispute") || desc.includes("reversal")

  // Cross-movement analysis for duplicates
  let isDuplicate = false
  if (allMovements && allMovements.length > 0) {
    const duplicateResult = detectDuplicatePayment(movement, allMovements, candidates)
    isDuplicate = duplicateResult.isDuplicate
  }

  return {
    has_direct_link: directLinkCandidates.length > 0,
    has_reference: candidates.some((c) => c.reference_match),
    has_fee: feeCandidates.length > 0,
    is_partial: partialCandidates.length > 0,
    is_aggregation: matchableCandidates.length > 1 && Math.abs(aggregationSum - Math.abs(movement.available_cash)) < EPS,
    is_reversal: reversalCandidates.length > 0 || isChargeback,
    same_amount_conflict: potentialConflicts.length > 1,
    // Only flag cross_entity if the EXACT matches span multiple entities (not all candidates)
    cross_entity: exactCandidates.length > 0 && new Set(exactCandidates.map((c) => c.entity_id)).size > 1,
    is_zero_amount: Math.abs(movement.available_cash) < 0.1,
    is_duplicate: isDuplicate,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Zero-Candidate Sub-Classification (AR-Specific)
// ─────────────────────────────────────────────────────────────────────────────

function classifyZeroCandidate(movement: MovementWithAvailableCash): CaseType {
  const counterparty = (movement.counterparty || "").toLowerCase()
  const description = (movement.raw_description || "").toLowerCase()
  const amount = Math.abs(movement.available_cash)

  // AR only processes inflows - this should always be true here
  if (movement.direction !== "inflow") {
    return "AP_EXCLUDED"
  }

  // 1. Deleted customer - highest priority
  if (counterparty.includes("(deleted)") || description.includes("(deleted)")) {
    return "ZERO_DELETED_CUSTOMER"
  }

  // 2. Refund patterns - unusual inflow that looks like a vendor refund
  const isRefundPattern = 
    description.includes("refund") ||
    description.includes("credit") ||
    description.includes("return") ||
    counterparty.includes("refund")
  
  if (isRefundPattern && amount < 1000) {
    return "ZERO_REFUND_RECEIVED"
  }

  // 3. Large prepayment/deposit - over $5000 with no invoice
  if (amount > 5000) {
    return "ZERO_PREPAYMENT"
  }

  // 4. Missing invoice - customer payment with no matching invoice
  // This is the most common case for AR
  if (counterparty && counterparty.length > 2) {
    return "ZERO_MISSING_INVOICE"
  }

  // 5. Fallback - needs manual review
  return "ZERO_UNCLASSIFIED"
}

// ─────────────────────────────────────────────────────────────────────────────
// Case Resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveCase(
  movement: MovementWithAvailableCash,
  candidates: Candidate[],
  flags: ClassificationFlags,
  allMovements?: MovementWithAvailableCash[]
): CaseType {
  // Zero amount
  if (flags.is_zero_amount) return "ZERO_AMOUNT"

  // Duplicate payment check (highest priority)
  if (flags.is_duplicate) {
    return "DUPLICATE_PAYMENT"
  }

  // Direct link cases - invoice ID found in bank data
  if (flags.has_direct_link) {
    const directLinks = candidates.filter((c) => c.is_direct_link)
    if (directLinks.length === 1) {
      if (flags.has_fee) return "DIRECT_LINK_WITH_FEE"
      if (flags.is_partial) return "DIRECT_LINK_PARTIAL"
      return "DIRECT_LINK_SINGLE"
    }
    const uniqueCustomers = new Set(directLinks.map((c) => c.entity_id)).size
    return uniqueCustomers === 1 ? "DIRECT_LINK_MULTI_SAME_CUSTOMER" : "DIRECT_LINK_MULTI_DIFF_CUSTOMER"
  }

  // Exact match cases - payment = invoice amount
  const exactMatches = candidates.filter((c) => c.match_type === "EXACT" && Math.abs(c.amount_diff) < EPS)
  if (exactMatches.length > 0) {
    if (exactMatches.length === 1) {
      if (flags.same_amount_conflict) {
        const uniqueCustomers = new Set(candidates.filter(c => c.match_type === "EXACT").map((c) => c.entity_id)).size
        return uniqueCustomers === 1 ? "EXACT_MULTI_SAME_CUSTOMER" : "EXACT_MULTI_DIFF_CUSTOMER"
      }
      if (flags.has_reference) return "EXACT_WITH_REFERENCE"
      return "EXACT_SINGLE"
    }
    const uniqueCustomers = new Set(exactMatches.map((c) => c.entity_id)).size
    return uniqueCustomers === 1 ? "EXACT_MULTI_SAME_CUSTOMER" : "EXACT_MULTI_DIFF_CUSTOMER"
  }

  // Fee-adjusted cases - payment = invoice - processor fee
  if (flags.has_fee) {
    const feeCandidates = candidates.filter((c) => c.match_type === "FEE")
    
    if (feeCandidates.length === 1) {
      const processor = detectProcessorType(movement.counterparty)
      if (processor === "stripe" || processor === "square") return "FEE_STRIPE_SQUARE"
      if (processor === "ach") return "FEE_ACH"
      return "FEE_ADJUSTED_SINGLE"
    }
    return "FEE_ADJUSTED_MULTI"
  }

  // Aggregation cases - one payment covers multiple invoices
  if (flags.is_aggregation) {
    const uniqueCustomers = new Set(candidates.map((c) => c.entity_id)).size
    if (flags.has_fee) return "AGGREGATION_WITH_FEE"
    return uniqueCustomers === 1 ? "AGGREGATION_SAME_CUSTOMER" : "AGGREGATION_DIFF_CUSTOMER"
  }

  // Partial payment cases - payment < invoice amount
  if (flags.is_partial) {
    const partialCandidates = candidates.filter((c) => c.match_type === "PARTIAL")
    if (partialCandidates.length === 1) {
      return "PARTIAL_SINGLE"
    }
    const uniqueCustomers = new Set(partialCandidates.map((c) => c.entity_id)).size
    return uniqueCustomers === 1 ? "PARTIAL_MULTI_SAME_CUSTOMER" : "PARTIAL_MULTI_DIFF_CUSTOMER"
  }

  // Discount cases
  const discountCandidates = candidates.filter((c) => c.match_type === "DISCOUNT")
  if (discountCandidates.length > 0) {
    return candidates.length > 1 ? "VOLUME_DISCOUNT" : "EARLY_DISCOUNT"
  }

  // Refund cases (outflow matching AR invoice)
  if (flags.is_reversal) {
    const reversalCandidates = candidates.filter((c) => c.match_type === "REVERSAL")
    if (reversalCandidates.length === 1) {
      const diff = Math.abs(reversalCandidates[0].amount - Math.abs(movement.available_cash))
      return diff < EPS ? "REFUND_FULL" : "REFUND_PARTIAL"
    }
    return "REFUND_PARTIAL"
  }

  // Cross-customer payment
  if (flags.cross_entity && candidates.length > 0) {
    return "CROSS_CUSTOMER_PAYMENT"
  }

  // Rounding cases
  const roundingCandidates = candidates.filter((c) => c.match_type === "ROUNDING")
  if (roundingCandidates.length > 0) {
    const movAmount = Math.abs(movement.available_cash)
    const candAmount = roundingCandidates[0].amount
    return movAmount > candAmount ? "ROUNDING_OVER" : "ROUNDING_UNDER"
  }

  // Overpayment cases
  if (candidates.length > 0) {
    const bestCandidate = candidates[0]
    const overpaymentAmount = Math.abs(movement.available_cash) - bestCandidate.amount

    if (overpaymentAmount > EPS) {
      return "OVERPAYMENT_SINGLE"
    }
  }

  // Zero candidates - use AR-specific sub-classifier
  if (candidates.length === 0) {
    return classifyZeroCandidate(movement)
  }

  // Has candidates but none match well
  return "NO_MATCH_HAS_CANDIDATES"
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-Movement Analysis Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface SeparateFeeResult {
  found: boolean
  feeMovementId: string | null
  feeAmount: number
}

function findSeparateFeeTransaction(
  movement: MovementWithAvailableCash,
  allMovements: MovementWithAvailableCash[],
  candidate: Candidate
): SeparateFeeResult {
  // Look for a separate fee transaction that:
  // 1. Is an outflow (fee deducted)
  // 2. Occurred within 3 days of the main movement
  // 3. Amount is within typical fee range (0.5% - 10% of candidate amount)
  // 4. Description contains fee-related keywords
  
  const movDate = new Date(movement.date).getTime()
  const expectedFee = candidate.amount - Math.abs(movement.available_cash)
  
  if (expectedFee <= 0) return { found: false, feeMovementId: null, feeAmount: 0 }
  
  for (const m of allMovements) {
    if (m.id === movement.id) continue
    if (m.direction !== "outflow") continue
    
    const mDate = new Date(m.date).getTime()
    const daysDiff = Math.abs(movDate - mDate) / (1000 * 60 * 60 * 24)
    if (daysDiff > 3) continue
    
    const mAmount = Math.abs(m.available_cash)
    const feeRatio = mAmount / candidate.amount
    if (feeRatio < 0.005 || feeRatio > 0.1) continue
    
    // Check if amounts match (movement + fee = candidate)
    const totalPaid = Math.abs(movement.available_cash) + mAmount
    if (Math.abs(totalPaid - candidate.amount) < EPS) {
      // Check description for fee keywords
      const desc = (m.raw_description || "").toLowerCase()
      const isFeeDesc = desc.includes("fee") || desc.includes("charge") || 
                        desc.includes("processing") || desc.includes("service")
      
      if (isFeeDesc || Math.abs(mAmount - expectedFee) < EPS) {
        return { found: true, feeMovementId: m.id, feeAmount: mAmount }
      }
    }
  }
  
  return { found: false, feeMovementId: null, feeAmount: 0 }
}

function detectDuplicatePayment(
  movement: MovementWithAvailableCash,
  allMovements: MovementWithAvailableCash[],
  candidates: Candidate[]
): { isDuplicate: boolean; originalMovementId: string | null } {
  // Look for another movement that:
  // 1. Has the same amount
  // 2. Same direction
  // 3. Same or similar counterparty
  // 4. Occurred within 30 days
  // 5. Could match the same candidate(s)
  
  const movAmount = Math.abs(movement.available_cash)
  const movDate = new Date(movement.date).getTime()
  
  for (const m of allMovements) {
    if (m.id === movement.id) continue
    if (m.direction !== movement.direction) continue
    
    const mAmount = Math.abs(m.available_cash)
    if (Math.abs(mAmount - movAmount) >= EPS) continue
    
    const mDate = new Date(m.date).getTime()
    const daysDiff = Math.abs(movDate - mDate) / (1000 * 60 * 60 * 24)
    if (daysDiff > 30) continue
    
    // Check if counterparties match
    const sameCounterparty = movement.counterparty && m.counterparty &&
      movement.counterparty.toLowerCase() === m.counterparty.toLowerCase()
    
    // Check if they could match the same candidate
    const sameEntity = movement.counterparty_entity_id && m.counterparty_entity_id &&
      movement.counterparty_entity_id === m.counterparty_entity_id
    
    if (sameCounterparty || sameEntity) {
      // The earlier one is the "original", the later one is the "duplicate"
      if (mDate < movDate) {
        return { isDuplicate: true, originalMovementId: m.id }
      }
    }
  }
  
  return { isDuplicate: false, originalMovementId: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Classification Function
// ─────────────────────────────────────────────────────────────────────────────

export function classifyMovement(
  movement: MovementWithAvailableCash,
  cashEvents: CashEventRow[],
  allMovements?: MovementWithAvailableCash[],  // Optional: for cross-movement analysis
  matchedCustomer?: string | null  // NEW: matched customer from LLM
): ClassificationResult {
  // Check if non-operational
  if (isNonOperational(movement.economic_class)) {
    return {
      movement_id: movement.id,
      case_type: classifyNonOperational(movement.economic_class),
      is_operational: false,
      candidates: [],
      flags: {
        has_direct_link: false,
        has_reference: false,
        has_fee: false,
        is_partial: false,
        is_aggregation: false,
        is_reversal: false,
        same_amount_conflict: false,
        cross_entity: false,
        is_zero_amount: false,
        is_duplicate: false,
      },
      suggested_action: "exclude",
    }
  }

  // AR RECONCILIATION ONLY
  // Outflows (AP) are NOT reconciled - they go through vendor classification instead
  if (movement.direction === "outflow") {
    return {
      movement_id: movement.id,
      case_type: "AP_EXCLUDED" as CaseType,
      is_operational: true,
      candidates: [],
      flags: {
        has_direct_link: false,
        has_reference: false,
        has_fee: false,
        is_partial: false,
        is_aggregation: false,
        is_reversal: false,
        same_amount_conflict: false,
        cross_entity: false,
        is_zero_amount: Math.abs(movement.available_cash) < EPS,
        is_duplicate: false,
      },
      suggested_action: "exclude",
    }
  }

  // AR only - match inflows to invoices
  const targetType = "ar" as const

  // Build candidates (with customer matching if available)
  // Increased limit to 50 to show all customer-based candidates
  const candidates = buildCandidates(movement, cashEvents, targetType, matchedCustomer ?? null, 50)

  // Detect flags (with cross-movement analysis if available)
  const flags = detectFlags(movement, candidates, allMovements)

  // Resolve case type (with cross-movement analysis if available)
  const caseType = resolveCase(movement, candidates, flags, allMovements)

  // Determine suggested action based on case type
  // NOTE: All auto_match changed to review for evaluation phase - no auto-matching yet
  const caseActionMap: Record<CaseType, "auto_match" | "review" | "manual" | "exclude"> = {
    // Direct links - review (was auto_match)
    DIRECT_LINK_SINGLE: "review",
    DIRECT_LINK_MULTI_SAME_CUSTOMER: "review",
    DIRECT_LINK_MULTI_DIFF_CUSTOMER: "review",
    DIRECT_LINK_WITH_FEE: "review",
    DIRECT_LINK_PARTIAL: "review",

    // Exact matches - review (was auto_match)
    EXACT_SINGLE: "review",
    EXACT_MULTI_SAME_CUSTOMER: "review",
    EXACT_MULTI_DIFF_CUSTOMER: "review",
    EXACT_WITH_REFERENCE: "review",

    // Fee cases - review (was auto_match)
    FEE_ADJUSTED_SINGLE: "review",
    FEE_ADJUSTED_MULTI: "review",
    FEE_STRIPE_SQUARE: "review",
    FEE_ACH: "review",

    // Partial payments
    PARTIAL_SINGLE: "review",
    PARTIAL_MULTI_SAME_CUSTOMER: "review",
    PARTIAL_MULTI_DIFF_CUSTOMER: "review",

    // Aggregation - review (was auto_match)
    AGGREGATION_SAME_CUSTOMER: "review",
    AGGREGATION_DIFF_CUSTOMER: "review",
    AGGREGATION_WITH_FEE: "review",

    // Rounding - review (was auto_match)
    ROUNDING_UNDER: "review",
    ROUNDING_OVER: "review",

    // Discounts - review (was auto_match)
    EARLY_DISCOUNT: "review",
    VOLUME_DISCOUNT: "review",

    // Refunds
    REFUND_FULL: "review",
    REFUND_PARTIAL: "review",

    // Overpayments
    OVERPAYMENT_SINGLE: "review",
    OVERPAYMENT_PREPAYMENT: "review",

    // Special cases
    DUPLICATE_PAYMENT: "review",
    CROSS_CUSTOMER_PAYMENT: "review",
    ZERO_AMOUNT: "review",

    // Zero-candidate sub-cases - all need review
    ZERO_MISSING_INVOICE: "review",
    ZERO_PREPAYMENT: "review",
    ZERO_REFUND_RECEIVED: "review",
    ZERO_DELETED_CUSTOMER: "review",
    ZERO_UNCLASSIFIED: "review",

    // No match - needs review to understand why
    NO_MATCH_HAS_CANDIDATES: "review",
    NO_MATCH_NO_CANDIDATES: "review",

    // Non-operational
    INTERCOMPANY_TRANSFER: "exclude",
    LOAN_PAYMENT: "exclude",
    LOAN_PROCEEDS: "exclude",
    PAYROLL: "exclude",
    TAX_PAYMENT: "exclude",
    OWNER_DRAW: "exclude",
    OWNER_CONTRIBUTION: "exclude",
    BANK_FEE: "exclude",
    INTEREST_INCOME: "exclude",
    CREDIT_CARD_PAYMENT: "exclude",
    MERCHANT_DEPOSIT: "exclude",
    UNCLASSIFIED_NON_OP: "exclude",
    
    // AP excluded from AR reconciliation
    AP_EXCLUDED: "exclude",
  }

  let suggestedAction = caseActionMap[caseType] || "manual"

  // Override: Don't auto_match if there's a same_amount_conflict
  if (flags.same_amount_conflict && suggestedAction === "auto_match") {
    suggestedAction = "review"
  }

  return {
    movement_id: movement.id,
    case_type: caseType,
    is_operational: true,
    candidates,
    flags,
    suggested_action: suggestedAction,
  }
}

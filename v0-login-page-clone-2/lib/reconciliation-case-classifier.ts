/**
 * Reconciliation Case Classifier
 *
 * Deterministic classification of bank movements into ~49 distinct case types.
 * No AI/ML - purely data-driven matching based on amounts, counts, entity relationships, and flags.
 *
 * Purpose: Identify what kind of reconciliation scenario each bank movement represents,
 * then surface all candidate invoices/bills with their match types.
 */

import type { CashEventRow } from "./cash-events-build"

const EPS = 0.01

// ─────────────────────────────────────────────────────────────────────────────
// Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

export type CaseType =
  // Direct Link Cases (5)
  | "DIRECT_LINK_SINGLE"
  | "DIRECT_LINK_MULTI_SAME_ENTITY"
  | "DIRECT_LINK_MULTI_DIFF_ENTITY"
  | "DIRECT_LINK_WITH_FEE"
  | "DIRECT_LINK_PARTIAL"
  // Exact Match Cases (4)
  | "EXACT_SINGLE"
  | "EXACT_MULTI_SAME_ENTITY"
  | "EXACT_MULTI_DIFF_ENTITY"
  | "EXACT_WITH_REFERENCE"
  // Fee Cases (6)
  | "FEE_IMPLIED_SINGLE"
  | "FEE_IMPLIED_MULTI"
  | "FEE_FROM_TAG_DATA"
  | "FEE_SEPARATE_TRANSACTION"
  | "FEE_STRIPE_SQUARE"
  | "FEE_ACH"
  // Partial Payment Cases (4)
  | "PARTIAL_SINGLE"
  | "PARTIAL_MULTI_SAME_ENTITY"
  | "PARTIAL_MULTI_DIFF_ENTITY"
  | "PARTIAL_WITH_FEE"
  // Aggregation Cases (4)
  | "AGGREGATION_SAME_ENTITY"
  | "AGGREGATION_DIFF_ENTITY"
  | "AGGREGATION_WITH_FEE"
  | "AGGREGATION_PARTIAL"
  // Overpayment Cases (3)
  | "OVERPAYMENT_SINGLE"
  | "OVERPAYMENT_PREPAYMENT"
  | "OVERPAYMENT_CREDIT_MEMO"
  // Rounding Cases (2)
  | "ROUNDING_UNDER"
  | "ROUNDING_OVER"
  // Discount Cases (2)
  | "EARLY_DISCOUNT"
  | "VOLUME_DISCOUNT"
  // Reversal/Refund Cases (3)
  | "REVERSAL_FULL"
  | "REVERSAL_PARTIAL"
  | "CHARGEBACK"
  // Special Cases (4)
  | "DUPLICATE_PAYMENT"
  | "CROSS_ENTITY_PAYMENT"
  | "SETTLEMENT_BREAKDOWN"
  | "ZERO_AMOUNT"
  // No Match Cases (2)
  | "NO_MATCH_HAS_CANDIDATES"
  | "NO_MATCH_NO_CANDIDATES"
  // Non-Operational Cases (12)
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
  const diff = Math.abs(candidate.amount - Math.abs(movement.available_cash))
  if (diff < EPS) return null

  const feeRatio = diff / candidate.amount
  if (feeRatio < 0.005 || feeRatio > 0.1) return null

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

  // Direction must be opposite
  const expectedDirection = candidate.event_type === "ar" ? "outflow" : "inflow"
  if (movement.direction !== expectedDirection) return false

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
  maxCandidates: number = 20
): Candidate[] {
  const candidates: Candidate[] = []
  const movAmount = Math.abs(movement.available_cash)
  const directLinkId = extractDirectLinkId(movement.tag_data)
  const refsFromDesc = extractReferenceFromDescription(movement.counterparty)

  for (const event of cashEvents) {
    if (event.event_type !== targetType) continue
    if (event.outstanding_amount <= EPS) continue

    const entityName = (event.metadata?.customer_name || event.metadata?.vendor_name || event.entity_id) as string
    const amountDiff = Math.abs(event.amount - movAmount)
    const feeImplied = detectFeeAmount(movement, event)
    const isDirectLink = directLinkId === event.id || directLinkId === event.metadata?.invoice_id || directLinkId === event.metadata?.bill_id
    const refMatch = refsFromDesc.some((ref) => {
      const candRef = String(event.metadata?.invoice_number || event.metadata?.bill_number || "")
      return candRef === ref // Exact match
    })

    // Determine all applicable match types
    const matchTypes: MatchType[] = []

    if (isDirectLink) {
      matchTypes.push("DIRECT_LINK")
    }
    if (feeImplied) {
      matchTypes.push("FEE")
    }
    if (isReversal(movement, event)) {
      matchTypes.push("REVERSAL")
    }
    if (isRounding(movement, event)) {
      matchTypes.push("ROUNDING")
    }
    if (isEarlyDiscount(movement, event)) {
      matchTypes.push("DISCOUNT")
    }
    if (movAmount < event.amount - EPS) {
      matchTypes.push("PARTIAL")
    }

    // Primary is the first (highest priority), secondary are the rest
    const primaryMatchType = matchTypes[0] || "EXACT"
    const secondaryMatchTypes = matchTypes.slice(1)

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
      fee_implied: feeImplied,
      is_direct_link: isDirectLink,
      reference_match: !!refMatch,
    })
  }

  // Sort by match quality: direct link first, then exact, then by amount diff
  candidates.sort((a, b) => {
    if (a.is_direct_link !== b.is_direct_link) return a.is_direct_link ? -1 : 1
    if (a.match_type === "EXACT" && b.match_type !== "EXACT") return -1
    if (a.match_type !== "EXACT" && b.match_type === "EXACT") return 1
    return a.amount_diff - b.amount_diff
  })

  // Filter out low-quality matches (amount diff > 20%)
  const qualityCandidates = candidates.filter((c) => {
    const diffRatio = c.amount_diff / c.amount
    return diffRatio <= 0.2 || c.match_type === "DIRECT_LINK" || c.match_type === "EXACT"
  })

  // Return top N candidates
  return qualityCandidates.slice(0, maxCandidates)
}

// ─────────────────────────────────────────────────────────────────────────────
// Flag Detection
// ─────────────────────────────────────────────────────────────────────────────

function detectFlags(
  movement: MovementWithAvailableCash,
  candidates: Candidate[]
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

  return {
    has_direct_link: directLinkCandidates.length > 0,
    has_reference: candidates.some((c) => c.reference_match),
    has_fee: feeCandidates.length > 0,
    is_partial: partialCandidates.length > 0,
    is_aggregation: matchableCandidates.length > 1 && Math.abs(aggregationSum - Math.abs(movement.available_cash)) < EPS,
    is_reversal: reversalCandidates.length > 0,
    same_amount_conflict: potentialConflicts.length > 1,
    cross_entity: candidates.length > 0 && new Set(candidates.map((c) => c.entity_id)).size > 1,
    is_zero_amount: Math.abs(movement.available_cash) < 0.1,
    is_duplicate: false, // Would need historical data to detect
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Case Resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveCase(
  movement: MovementWithAvailableCash,
  candidates: Candidate[],
  flags: ClassificationFlags
): CaseType {
  // Zero amount
  if (flags.is_zero_amount) return "ZERO_AMOUNT"

  // Direct link cases
  if (flags.has_direct_link) {
    const directLinks = candidates.filter((c) => c.is_direct_link)
    if (directLinks.length === 1) {
      if (flags.has_fee) return "DIRECT_LINK_WITH_FEE"
      if (flags.is_partial) return "DIRECT_LINK_PARTIAL"
      return "DIRECT_LINK_SINGLE"
    }
    const uniqueEntities = new Set(directLinks.map((c) => c.entity_id)).size
    return uniqueEntities === 1 ? "DIRECT_LINK_MULTI_SAME_ENTITY" : "DIRECT_LINK_MULTI_DIFF_ENTITY"
  }

  // Exact match cases
  const exactMatches = candidates.filter((c) => c.match_type === "EXACT" && Math.abs(c.amount_diff) < EPS)
  if (exactMatches.length > 0) {
    if (exactMatches.length === 1) {
      if (flags.has_reference) return "EXACT_WITH_REFERENCE"
      return "EXACT_SINGLE"
    }
    const uniqueEntities = new Set(exactMatches.map((c) => c.entity_id)).size
    return uniqueEntities === 1 ? "EXACT_MULTI_SAME_ENTITY" : "EXACT_MULTI_DIFF_ENTITY"
  }

  // Fee cases
  if (flags.has_fee) {
    const feeCandidates = candidates.filter((c) => c.match_type === "FEE")
    if (feeCandidates.length === 1) {
      const processor = detectProcessorType(movement.counterparty)
      if (processor === "stripe" || processor === "square") return "FEE_STRIPE_SQUARE"
      if (processor === "ach") return "FEE_ACH"
      return "FEE_IMPLIED_SINGLE"
    }
    return "FEE_IMPLIED_MULTI"
  }

  // Aggregation cases
  if (flags.is_aggregation) {
    const uniqueEntities = new Set(candidates.map((c) => c.entity_id)).size
    if (flags.has_fee) return "AGGREGATION_WITH_FEE"
    return uniqueEntities === 1 ? "AGGREGATION_SAME_ENTITY" : "AGGREGATION_DIFF_ENTITY"
  }

  // Partial payment cases
  if (flags.is_partial) {
    const partialCandidates = candidates.filter((c) => c.match_type === "PARTIAL")
    if (partialCandidates.length === 1) {
      if (flags.has_fee) return "PARTIAL_WITH_FEE"
      return "PARTIAL_SINGLE"
    }
    const uniqueEntities = new Set(partialCandidates.map((c) => c.entity_id)).size
    return uniqueEntities === 1 ? "PARTIAL_MULTI_SAME_ENTITY" : "PARTIAL_MULTI_DIFF_ENTITY"
  }

  // Discount cases
  const discountCandidates = candidates.filter((c) => c.match_type === "DISCOUNT")
  if (discountCandidates.length > 0) {
    return candidates.length > 1 ? "VOLUME_DISCOUNT" : "EARLY_DISCOUNT"
  }

  // Reversal cases
  if (flags.is_reversal) {
    const reversalCandidates = candidates.filter((c) => c.match_type === "REVERSAL")
    if (reversalCandidates.length === 1) {
      const diff = Math.abs(reversalCandidates[0].amount - Math.abs(movement.available_cash))
      return diff < EPS ? "REVERSAL_FULL" : "REVERSAL_PARTIAL"
    }
    return "REVERSAL_PARTIAL"
  }

  // Rounding cases
  const roundingCandidates = candidates.filter((c) => c.match_type === "ROUNDING")
  if (roundingCandidates.length > 0) {
    const diff = roundingCandidates[0].amount_diff
    return diff > 0 ? "ROUNDING_OVER" : "ROUNDING_UNDER"
  }

  // Overpayment cases
  if (candidates.length > 0) {
    // Find the best matching candidate (first one after sorting)
    const bestCandidate = candidates[0]
    const overpaymentAmount = Math.abs(movement.available_cash) - bestCandidate.amount

    if (overpaymentAmount > EPS) {
      // Check if overpayment could be offset by credit memo
      const creditMemos = candidates.filter((c) => c.amount < 0) // Negative amounts = credits
      const creditSum = creditMemos.reduce((sum, c) => sum + Math.abs(c.amount), 0)

      if (creditSum >= overpaymentAmount - EPS) {
        return "OVERPAYMENT_CREDIT_MEMO"
      }
      return "OVERPAYMENT_SINGLE"
    }
  } else if (Math.abs(movement.available_cash) > EPS) {
    // Payment with no matching invoice
    return "OVERPAYMENT_PREPAYMENT"
  }

  // No match cases
  return candidates.length > 0 ? "NO_MATCH_HAS_CANDIDATES" : "NO_MATCH_NO_CANDIDATES"
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Classification Function
// ─────────────────────────────────────────────────────────────────────────────

export function classifyMovement(
  movement: MovementWithAvailableCash,
  cashEvents: CashEventRow[]
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

  // Determine target type (AR for inflows, AP for outflows)
  const targetType = movement.direction === "inflow" ? "ar" : "ap"

  // Build candidates
  const candidates = buildCandidates(movement, cashEvents, targetType)

  // Detect flags
  const flags = detectFlags(movement, candidates)

  // Resolve case type
  const caseType = resolveCase(movement, candidates, flags)

  // Determine suggested action based on case type
  const caseActionMap: Record<CaseType, "auto_match" | "review" | "manual" | "exclude"> = {
    // Direct links - auto match
    DIRECT_LINK_SINGLE: "auto_match",
    DIRECT_LINK_MULTI_SAME_ENTITY: "auto_match",
    DIRECT_LINK_MULTI_DIFF_ENTITY: "review",
    DIRECT_LINK_WITH_FEE: "auto_match",
    DIRECT_LINK_PARTIAL: "review",

    // Exact matches
    EXACT_SINGLE: "auto_match",
    EXACT_MULTI_SAME_ENTITY: "auto_match", // Same entity, exact amounts
    EXACT_MULTI_DIFF_ENTITY: "review", // Conflict
    EXACT_WITH_REFERENCE: "auto_match",

    // Fee cases
    FEE_IMPLIED_SINGLE: "auto_match",
    FEE_IMPLIED_MULTI: "review",
    FEE_FROM_TAG_DATA: "auto_match",
    FEE_SEPARATE_TRANSACTION: "review",
    FEE_STRIPE_SQUARE: "auto_match",
    FEE_ACH: "auto_match",

    // Partial payments
    PARTIAL_SINGLE: "auto_match",
    PARTIAL_MULTI_SAME_ENTITY: "review",
    PARTIAL_MULTI_DIFF_ENTITY: "review",
    PARTIAL_WITH_FEE: "review",

    // Aggregation
    AGGREGATION_SAME_ENTITY: "auto_match",
    AGGREGATION_DIFF_ENTITY: "review",
    AGGREGATION_WITH_FEE: "review",
    AGGREGATION_PARTIAL: "review",

    // Rounding - auto match (small diff)
    ROUNDING_UNDER: "auto_match",
    ROUNDING_OVER: "auto_match",

    // Discounts
    EARLY_DISCOUNT: "auto_match",
    VOLUME_DISCOUNT: "review",

    // Reversals
    REVERSAL_FULL: "review", // Verify it's intentional
    REVERSAL_PARTIAL: "review",
    CHARGEBACK: "review",

    // Overpayments
    OVERPAYMENT_SINGLE: "review",
    OVERPAYMENT_PREPAYMENT: "manual",
    OVERPAYMENT_CREDIT_MEMO: "review",

    // Special cases
    DUPLICATE_PAYMENT: "review",
    CROSS_ENTITY_PAYMENT: "review",
    SETTLEMENT_BREAKDOWN: "review",
    ZERO_AMOUNT: "manual",

    // No match
    NO_MATCH_HAS_CANDIDATES: "manual",
    NO_MATCH_NO_CANDIDATES: "manual",

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
  }

  const suggestedAction = caseActionMap[caseType] || "manual"

  return {
    movement_id: movement.id,
    case_type: caseType,
    is_operational: true,
    candidates,
    flags,
    suggested_action: suggestedAction,
  }
}

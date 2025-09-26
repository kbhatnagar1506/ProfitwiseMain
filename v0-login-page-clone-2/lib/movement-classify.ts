/**
 * Money Movement Classification Engine v4.
 *
 * Outputs cash movement classifications, NOT accounting event classifications.
 *
 * Pipeline:
 *   Step 1:  Extract source observations from Plaid, QBO, Stripe, Xero (skip $0 non-cash)
 *   Step 2:  Coalesce cross-source observations into canonical movements (date-window matching)
 *   Step 2b: Pair Plaid cross-account transfers
 *   Step 3:  Resolve accounts
 *   Step 4:  Resolve counterparty identity
 *   Step 5:  Classify non-P&L (transfers, settlements, fees, equity, financing, CC payments)
 *   Step 6:  Classify operating (customer, vendor, refund, interest)
 *   Step 6b: Provisional classes (merchant_deposit_unresolved, owner_contribution_candidate)
 *   Step 7:  Fallback to unknown_inflow / unknown_outflow / unknown_transfer_candidate
 *   Step 7b: Family-level learning (recurring pattern recognition)
 *   Step 8:  LLM assist for low-confidence
 *   Step 8b: Direction/type consistency validation
 *   Step 9:  Batch persist (with provenance)
 */

import { query, ensureMovementsSchema, ensurePlaidSchema } from "./db"
import { log } from "./logger"
import {
  buildMovementIdentityContext,
  seedIdentityGraph,
  getSelfContext,
  type MovementIdentityContext,
  type MovementIdentityEntry,
  type SelfContext,
} from "./identity-seed"
import { normalizeForMatch } from "./alias-normalize"
import { enrichUnresolved } from "./unresolved-enrich"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

// ─── Movement Type Taxonomy ──────────────────────────────────────────

const NON_PNL_TYPES = [
  "internal_transfer",
  "processor_payout",
  "credit_card_payment",
  "loan_funding",
  "loan_principal_payment",
  "owner_contribution",
  "owner_draw",
  "account_verification",
  "opening_balance",
  "balance_adjustment",
  "merchant_deposit_resolved",
] as const

const PNL_TYPES = [
  "cash_in_customer",
  "cash_out_vendor",
  "cash_out_operating_expense",
  "processor_fee_settlement",
  "cash_out_refund",
  "cash_in_refund",
  "cash_in_interest",
  "cash_out_interest",
  "cash_out_bank_fee",
  "bank_fee_refund",
  "cash_out_payroll",
  "cash_out_tax",
  "other_operating",
] as const

const PROVISIONAL_TYPES = [
  "merchant_deposit_unresolved",
  "owner_contribution_candidate",
] as const

const FALLBACK_TYPES = [
  "unknown_inflow",
  "unknown_outflow",
  "unknown_transfer_candidate",
] as const

const ALL_MOVEMENT_TYPES = [...NON_PNL_TYPES, ...PNL_TYPES, ...PROVISIONAL_TYPES, ...FALLBACK_TYPES] as const
type MovementType = (typeof ALL_MOVEMENT_TYPES)[number]

const PNL_ELIGIBLE_SET = new Set<string>(PNL_TYPES as unknown as string[])
function isPnlEligible(t: MovementType): boolean {
  return PNL_ELIGIBLE_SET.has(t)
}

// ─── Source Observation (raw, pre-dedup) ────────────────────────────

type SourceObservation = {
  source: "plaid" | "qbo" | "stripe" | "xero"
  source_type: string
  source_id: string
  date: string
  amount: number       // positive = inflow, negative = outflow (normalized)
  raw_description: string | null
  counterparty: string | null
  plaid_category: string[] | null
  plaid_pfc: Record<string, string> | null   // personal_finance_category
  plaid_payment_channel: string | null        // "in store" | "online" | "other"
  account_name: string | null
  account_id: string | null
  account_type: string | null                 // "depository", "credit", "loan", etc.
  account_subtype: string | null              // "checking", "savings", "money market", etc.
  metadata: Record<string, unknown>
}

// ─── Canonical Movement (post-dedup, pre-classify) ──────────────────

type Provenance = "bank_observed" | "accounting_observed" | "coalesced"

type CanonicalMovement = {
  direction: "inflow" | "outflow"
  amount: number       // always positive
  date: string
  cash_account_id: string | null
  cash_account_name: string | null
  counterparty: string | null
  counterparty_entity_id: string | null
  counterparty_entity_type: string | null
  linked_internal_account_id: string | null
  raw_description: string | null
  evidence: SourceObservation[]
  provenance: Provenance
  plaid_category: string[] | null
  plaid_pfc: Record<string, string> | null
  plaid_payment_channel: string | null
  metadata: Record<string, unknown>
}

// ─── Compositional confidence ─────────────────────────────────────
//
// Two separate scores:
//   classification_confidence (score) — "How sure are we this is the right bucket?"
//     Only uses signals that ARE present. Absent signals are neutral, not penalizing.
//     source_authority boosts trust based on HOW we know (bank > accounting > guess).
//   evidence_strength — "How well-corroborated is this across sources/history/entities?"
//     This one DOES penalize for missing corroboration.

type ConfidenceBreakdown = {
  score: number                 // = classification_confidence
  evidence_strength: number     // corroboration score (0–1)
  entity_confidence: number     // identity resolution quality (0–1), -1 = not applicable
  account_resolution: number    // how well we know the cash account (0–1)
  pattern_strength: number      // description pattern match strength (0–1)
  source_authority: number      // trustworthiness of the primary source (0–1)
  source_agreement: number      // cross-source agreement, -1 = single source
  history: number               // family/recurring pattern strength (0–1), -1 = not applicable
  directional_consistency: number // how well direction matches type (0–1)
}

const SOURCE_AUTHORITY: Record<string, number> = {
  plaid: 0.90,    // bank-observed, high trust
  stripe: 0.90,   // processor-observed, high trust
  qbo: 0.80,      // accounting system, medium-high trust
  xero: 0.80,     // accounting system, medium-high trust
  email: 0.40,    // extracted, low trust
}

function getSourceAuthority(evidence: SourceObservation[]): number {
  if (!evidence.length) return 0.2
  let best = 0
  for (const o of evidence) {
    const a = SOURCE_AUTHORITY[o.source] ?? 0.3
    if (a > best) best = a
  }
  return best
}

function computeConfidence(signals: Partial<ConfidenceBreakdown>): ConfidenceBreakdown {
  const e = signals.entity_confidence ?? -1
  const a = signals.account_resolution ?? 0
  const p = signals.pattern_strength ?? 0
  const sa = signals.source_authority ?? 0.3
  const s = signals.source_agreement ?? -1   // -1 = single source (neutral)
  const h = signals.history ?? -1             // -1 = no family (neutral)
  const d = signals.directional_consistency ?? 1

  // ── Classification confidence ──
  // Weights: pattern 25%, account 15%, source_authority 20%, direction 10%
  // Optional: entity 15%, source_agreement 10%, history 5%
  const signalEntries: Array<{ value: number; weight: number }> = []
  signalEntries.push({ value: p, weight: 0.25 })              // always present
  signalEntries.push({ value: a, weight: 0.15 })              // always present
  signalEntries.push({ value: sa, weight: 0.20 })             // always present
  signalEntries.push({ value: d, weight: 0.10 })              // always present
  if (e >= 0) signalEntries.push({ value: e, weight: 0.15 })  // only if entity resolved
  if (s >= 0) signalEntries.push({ value: s, weight: 0.10 })  // only if multi-source
  if (h >= 0) signalEntries.push({ value: h, weight: 0.05 })  // only if family exists

  const totalWeight = signalEntries.reduce((sum, x) => sum + x.weight, 0)
  const classificationConfidence = totalWeight > 0
    ? Math.min(1, Math.max(0, signalEntries.reduce((sum, x) => sum + x.value * (x.weight / totalWeight), 0)))
    : p

  // ── Evidence strength ──
  // Penalizes for missing corroboration
  const evidenceStrength = Math.min(1, Math.max(0,
    (e >= 0 ? e : 0) * 0.20 +
    a * 0.15 +
    (s >= 0 ? s : 0) * 0.30 +
    (h >= 0 ? h : 0) * 0.20 +
    sa * 0.05 +
    d * 0.10
  ))

  return {
    score: classificationConfidence,
    evidence_strength: evidenceStrength,
    entity_confidence: e,
    account_resolution: a,
    pattern_strength: p,
    source_authority: sa,
    source_agreement: s,
    history: h,
    directional_consistency: d,
  }
}

type ClassifiedMovement = CanonicalMovement & {
  movement_type: MovementType
  pnl_eligible: boolean
  confidence: ConfidenceBreakdown
  review_needed: boolean
  review_reasons: string[]
  currency: string
  coalesced_group_id: string | null
}

// ─── Known patterns ────────────────────────────────────────────────

const TRANSFER_PATTERNS = [
  /^transfer (credit|debit)/i,
  /^(preauthorized ach|ach)\s+(credit|debit)/i,
  /^incoming wire/i,
  /^(debit|credit)\s+\(any type\)/i,
  /^money (move|market)/i,
  /transfer.*ref\s/i,
  /xfer|tfr/i,
]

const BANK_FEE_PATTERNS = [
  /\bfee\b/i,
  /\bservice charge\b/i,
  /\bmonthly maintenance\b/i,
  /\boverdraft\b/i,
  /\bnsf\b/i,
  /balance requirement/i,
  /\bwire fee\b/i,
]

const TAX_PATTERNS = [
  /\birs\b/i,
  /\binternal revenue\b/i,
  /\btax (payment|remit)/i,
  /\bstate tax\b/i,
  /\bsales tax\b/i,
  /\bpayroll tax\b/i,
  /\beftps\b/i,
  /\bfranchise tax\b/i,
]

const LOAN_PATTERNS = [
  /\bloan (payment|draw|advance|repay|disbursement|proceed)/i,
  /\bcredit line\b/i,
  /\bline of credit\b/i,
  /\bsba\b/i,
  /\bmortgage\b/i,
]

const INTEREST_PATTERNS = [
  /\binterest (payment|charge|earned|income|expense)\b/i,
  /\binterest on\b/i,
]

const PAYROLL_PROCESSORS = new Set([
  "gusto", "adp", "paychex", "justworks", "rippling", "paylocity",
  "paycom", "trinet", "deel", "remote.com",
])

const REFUND_PATTERNS = [
  /\brefund\b/i,
  /\bcredit memo\b/i,
  /\breversed?\b/i,
  /\bchargeback\b/i,
]

const CC_PAYMENT_PATTERNS = [
  /\bcredit card payment\b/i,
  /\bcard payment\b/i,
  /\bautomatic payment.*card\b/i,
  /\bpayment.*chase\b/i,
  /\bpayment.*amex\b/i,
  /\bpayment.*citi\b/i,
  /\bpayment.*capital one\b/i,
  /\bpayment.*visa\b/i,
  /\bpayment.*mastercard\b/i,
]

const OWNER_PATTERNS = [
  /\bowner.*(draw|distribution|distrib)\b/i,
  /\bshareholder.*(draw|distribution)\b/i,
  /\bdividend\b/i,
  /\bmember.*(draw|distribution)\b/i,
]

const OWNER_CONTRIBUTION_PATTERNS = [
  /\bowner.*(contribut|invest|infusion|capital)\b/i,
  /\bshareholder.*(contribut|invest|capital)\b/i,
  /\bmember.*(contribut|capital)\b/i,
  /\bcapital\s+contribut/i,
]

const MERCHANT_DEPOSIT_PATTERNS = [
  /\bmerchant\s*(bankcd|bank\s*card|deposit|service)\b/i,
  /\bbankcd.*deposit\b/i,
  /\bdeposit\s+\d{6,}\b/i,
  /\bmerch\s*dep\b/i,
  /\bpos\s*deposit\b/i,
  /\b(square|clover|toast|stripe|adyen|worldpay|fiserv|heartland)\b.*\b(deposit|payout|transfer)\b/i,
]

const PROCESSOR_PAYOUT_DESC_PATTERNS = [
  /\bpreauthorized\s+ach\s+credit\b.*\b(shopify|stripe|paypal|square|clover|toast|adyen|worldpay|fiserv|heartland|braintree|gofundme)\b/i,
  /\bach\s+credit\b.*\b(shopify|stripe|paypal|square|clover|toast|adyen|worldpay|fiserv|heartland|braintree)\b/i,
  /\b(shopify|stripe|paypal|square|clover|toast|adyen|worldpay|fiserv|heartland|braintree)\b.*\b(payout|settlement|ach credit)\b/i,
]

const BANK_FEE_REFUND_PATTERNS = [
  /\bfee\s*refund\b/i,
  /\brefund.*\bfee\b/i,
  /\breversed?\s*(service charge|maintenance|fee)\b/i,
  /\b(service charge|fee)\s*reversal\b/i,
]

const VERIFICATION_PATTERNS = [
  /\b(micro|account)\s*(verification|verify)\b/i,
  /\bverify.*account\b/i,
  /\bplaid\b/i,
  /\b(test|pending)\s+(deposit|credit)\b/i,
]

const OPENING_BALANCE_PATTERNS = [
  /\bopening balance\b/i,
  /\binitial (balance|deposit|funding)\b/i,
]

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "")
}

// ─── Step 1: Extract source observations ────────────────────────────

type PlaidAccountInfo = { name: string; type: string | null; subtype: string | null }

async function extractPlaidObservations(userId: string): Promise<SourceObservation[]> {
  const obs: SourceObservation[] = []

  const { rows: userAccounts } = await query<{
    account_id: string; name: string | null; type: string | null; subtype: string | null
  }>(
    `SELECT pa.account_id, pa.name, pa.type, pa.subtype FROM plaid_accounts pa
     JOIN plaid_items pi ON pi.item_id = pa.item_id
     WHERE pi.user_id = $1`,
    [userId]
  )
  const accountInfo = new Map<string, PlaidAccountInfo>(
    userAccounts.map((a) => [a.account_id, { name: a.name ?? a.account_id, type: a.type, subtype: a.subtype }])
  )

  const { rows: txns } = await query<{
    transaction_id: string; account_id: string; amount: string; date: string
    name: string | null; merchant_name: string | null; category: string[] | null
    personal_finance_category: Record<string, string> | null
    payment_channel: string | null; pending: boolean
  }>(
    `SELECT pt.transaction_id, pt.account_id, pt.amount, pt.date, pt.name, pt.merchant_name,
            pt.category, pt.personal_finance_category, pt.payment_channel, pt.pending
     FROM plaid_transactions pt
     JOIN plaid_items pi ON pi.item_id = pt.item_id
     WHERE pi.user_id = $1 AND pt.pending = false`,
    [userId]
  )

  for (const tx of txns) {
    const desc = tx.merchant_name?.trim() || tx.name?.trim() || null
    // Plaid: positive = money left (expense), negative = money in
    const amt = -parseFloat(tx.amount)
    const acctInfo = accountInfo.get(tx.account_id)

    obs.push({
      source: "plaid",
      source_type: "transaction",
      source_id: tx.transaction_id,
      date: tx.date,
      amount: amt,
      raw_description: desc,
      counterparty: tx.merchant_name?.trim() || null,
      plaid_category: tx.category,
      plaid_pfc: tx.personal_finance_category,
      plaid_payment_channel: tx.payment_channel,
      account_name: acctInfo?.name ?? tx.account_id,
      account_id: tx.account_id,
      account_type: acctInfo?.type ?? null,
      account_subtype: acctInfo?.subtype ?? null,
      metadata: { plaid_name: tx.name, payment_channel: tx.payment_channel },
    })
  }

  return obs
}

async function extractQboObservations(userId: string): Promise<SourceObservation[]> {
  const obs: SourceObservation[] = []

  const QBO_TXN_TYPES = [
    "Invoice", "Payment", "Bill", "BillPayment", "Purchase",
    "Transfer", "SalesReceipt", "RefundReceipt", "Deposit",
    "CreditMemo", "VendorCredit", "JournalEntry",
  ]

  const { rows } = await query<{ entity_type: string; entity_id: string; data: Record<string, unknown> }>(
    `SELECT e.entity_type, e.entity_id, e.data FROM qbo_entities e
     JOIN qbo_connections c ON c.realm_id = e.realm_id
     WHERE c.user_id = $1 AND e.entity_type = ANY($2)`,
    [userId, QBO_TXN_TYPES]
  )

  for (const row of rows) {
    const d = row.data
    const meta = d.MetaData as Record<string, unknown> | undefined
    const txnDate = (d.TxnDate ?? (meta?.CreateTime) ?? "") as string
    const total = parseFloat(String(d.TotalAmt ?? d.Amount ?? d.Balance ?? 0))

    let counterparty: string | null = null
    const custRef = d.CustomerRef as Record<string, unknown> | undefined
    const vendRef = d.VendorRef as Record<string, unknown> | undefined
    const entityRef = d.EntityRef as Record<string, unknown> | undefined
    if (custRef?.name) counterparty = String(custRef.name)
    else if (vendRef?.name) counterparty = String(vendRef.name)
    else if (entityRef?.name) counterparty = String(entityRef.name)

    const isInflow = ["Invoice", "Payment", "SalesReceipt", "Deposit", "CreditMemo"].includes(row.entity_type)
    const amount = isInflow ? Math.abs(total) : -Math.abs(total)

    let fromAcct: string | null = null
    let toAcct: string | null = null
    if (row.entity_type === "Transfer") {
      const fromRef = d.FromAccountRef as Record<string, unknown> | undefined
      const toRef = d.ToAccountRef as Record<string, unknown> | undefined
      fromAcct = fromRef?.name ? String(fromRef.name) : null
      toAcct = toRef?.name ? String(toRef.name) : null
    }

    const docNumber = d.DocNumber ? String(d.DocNumber) : null
    const memo = (d.PrivateNote ?? d.Memo ?? "") as string
    const bankAcct = (d.AccountRef as Record<string, unknown> | undefined)?.name as string | undefined

    obs.push({
      source: "qbo",
      source_type: row.entity_type,
      source_id: row.entity_id,
      date: txnDate ? txnDate.split("T")[0] : "1970-01-01",
      amount,
      raw_description: memo || counterparty || row.entity_type,
      counterparty,
      plaid_category: null,
      plaid_pfc: null,
      plaid_payment_channel: null,
      account_name: bankAcct ?? fromAcct ?? toAcct ?? null,
      account_id: null,
      account_type: null,
      account_subtype: null,
      metadata: {
        qbo_type: row.entity_type,
        doc_number: docNumber,
        from_account: fromAcct,
        to_account: toAcct,
      },
    })
  }

  return obs
}

async function extractStripeObservations(userId: string): Promise<SourceObservation[]> {
  const obs: SourceObservation[] = []

  const { rows: stripeCusts } = await query<{ entity_id: string; data: Record<string, unknown> }>(
    `SELECT entity_id, data FROM stripe_entities WHERE user_id = $1 AND entity_type = 'customer'`,
    [userId]
  )
  const custIdToName = new Map<string, string>()
  for (const c of stripeCusts) {
    const name = c.data.name as string | undefined
    if (name) custIdToName.set(c.entity_id, name)
  }

  const STRIPE_TXN_TYPES = ["payment_intent", "payout", "balance_transaction", "invoice"]

  const { rows } = await query<{ entity_type: string; entity_id: string; data: Record<string, unknown> }>(
    `SELECT entity_type, entity_id, data FROM stripe_entities
     WHERE user_id = $1 AND entity_type = ANY($2)`,
    [userId, STRIPE_TXN_TYPES]
  )

  for (const row of rows) {
    const d = row.data
    const created = d.created ? new Date(Number(d.created) * 1000).toISOString().split("T")[0] : "1970-01-01"

    let counterparty: string | null = null
    let desc: string | null = String(d.description ?? d.statement_descriptor ?? "")
    if (!desc) desc = null

    let amount: number
    if (row.entity_type === "payout") {
      amount = parseFloat(String(d.amount ?? 0)) / 100
    } else if (row.entity_type === "balance_transaction") {
      amount = parseFloat(String(d.net ?? d.amount ?? 0)) / 100
    } else {
      amount = parseFloat(String(d.amount ?? d.amount_paid ?? 0)) / 100
    }

    if (d.customer && typeof d.customer === "string") {
      counterparty = custIdToName.get(d.customer) ?? d.customer
    }

    const txnType = (d.type ?? row.entity_type) as string
    const invoiceId = row.entity_type === "invoice" ? row.entity_id : (d.invoice as string) ?? null
    const paymentIntentId = row.entity_type === "payment_intent" ? row.entity_id : (d.payment_intent as string) ?? null
    const orderId = (d.metadata?.order_id as string) ?? (d.order as string) ?? invoiceId ?? paymentIntentId

    obs.push({
      source: "stripe",
      source_type: row.entity_type,
      source_id: row.entity_id,
      date: created,
      amount,
      raw_description: desc,
      counterparty,
      plaid_category: null,
      plaid_pfc: null,
      plaid_payment_channel: null,
      account_name: "Stripe",
      account_id: null,
      account_type: null,
      account_subtype: null,
      metadata: {
        stripe_type: txnType,
        status: d.status,
        stripe_customer_id: d.customer ?? null,
        order_id: orderId,
        invoice_id: invoiceId,
        payment_intent_id: paymentIntentId,
      },
    })
  }

  return obs
}

async function extractXeroObservations(userId: string): Promise<SourceObservation[]> {
  const obs: SourceObservation[] = []

  const XERO_TXN_TYPES = ["Invoice", "Bill", "Payment", "CreditNote", "BankTransaction", "ManualJournal"]

  const { rows } = await query<{ entity_type: string; entity_id: string; data: Record<string, unknown> }>(
    `SELECT e.entity_type, e.entity_id, e.data FROM xero_entities e
     JOIN xero_connections c ON c.tenant_id = e.tenant_id
     WHERE c.user_id = $1 AND e.entity_type = ANY($2)`,
    [userId, XERO_TXN_TYPES]
  )

  for (const row of rows) {
    const d = row.data
    const txnDate = (d.Date ?? d.DateString ?? "") as string
    const total = parseFloat(String(d.Total ?? d.SubTotal ?? d.Amount ?? 0))

    let counterparty: string | null = null
    const contact = d.Contact as Record<string, unknown> | undefined
    if (contact?.Name) counterparty = String(contact.Name)

    const xeroType = (d.Type as string) ?? row.entity_type
    const isInflow = row.entity_type === "Invoice"
      ? xeroType === "ACCREC"
      : row.entity_type === "Payment"
        ? (d.Invoice as Record<string, unknown> | undefined)?.Type === "ACCREC"
        : row.entity_type === "CreditNote"
          ? xeroType === "ACCREC"
          : false
    const amount = isInflow ? Math.abs(total) : -Math.abs(total)

    const bankAcct = d.BankAccount as Record<string, unknown> | undefined
    const acctName = bankAcct?.Name ? String(bankAcct.Name) : null
    const ref = (d.Reference ?? d.InvoiceNumber ?? "") as string

    obs.push({
      source: "xero",
      source_type: row.entity_type,
      source_id: `xero_${row.entity_id}`,
      date: txnDate ? txnDate.split("T")[0] : "1970-01-01",
      amount,
      raw_description: ref || counterparty || row.entity_type,
      counterparty,
      plaid_category: null,
      plaid_pfc: null,
      plaid_payment_channel: null,
      account_name: acctName,
      account_id: null,
      account_type: null,
      account_subtype: null,
      metadata: { xero_type: row.entity_type, xero_sub_type: xeroType },
    })
  }

  return obs
}

// ─── Step 2: Deduplicate / coalesce into canonical movements ────────

// Fix 4: Bank observation is ground truth of cash movement
// Bank sources have highest priority as the primary observation
const SOURCE_PRIORITY: Record<string, number> = { plaid: 4, stripe: 3, qbo: 2, xero: 1 }

// Normalize vendor/counterparty name: strip invoice boilerplate (plan #4)
function normalizeVendorName(s: string): string {
  return s
    .replace(/\b(?:invoices?inv|oices?inv|inv\.?)\b/gi, "")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{0,4}\b/gi, "")
    .replace(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function counterpartyMatchScore(a: string | null, b: string | null): number {
  if (!a || !b) return 0.5
  const na = normKey(normalizeVendorName(a))
  const nb = normKey(normalizeVendorName(b))
  if (na === nb) return 1.0
  if (na.length < 3 || nb.length < 3) return 0
  const shorter = na.length <= nb.length ? na : nb
  const longer = na.length > nb.length ? na : nb
  if (longer.startsWith(shorter) || longer.endsWith(shorter)) {
    return shorter.length / longer.length
  }
  return 0
}

function extractOrderId(obs: SourceObservation): string | null {
  const m = obs.metadata ?? {}
  return (m.order_id as string) ?? (m.invoice_id as string) ?? (m.payment_intent_id as string) ?? null
}

function orderIdsMatch(a: SourceObservation, b: SourceObservation): boolean {
  const oa = extractOrderId(a)
  const ob = extractOrderId(b)
  if (!oa || !ob) return false
  return oa === ob
}

function dateDistance(a: string, b: string): number {
  const da = new Date(a).getTime()
  const db = new Date(b).getTime()
  return Math.abs(da - db) / 86400000 // in days
}

function coalesceObservations(observations: SourceObservation[]): CanonicalMovement[] {
  // Filter out zero-dollar non-cash notices
  const nonZero = observations.filter((o) => Math.abs(o.amount) >= 0.01)

  // Group by |amount| rounded to cents — the primary matching dimension
  // Date is checked with a ±1 day window during pairing, not as a key
  type Indexed = SourceObservation & { _idx: number }
  const indexed: Indexed[] = nonZero.map((o, i) => ({ ...o, _idx: i }))

  const byAmount = new Map<string, Indexed[]>()
  for (const o of indexed) {
    const key = Math.abs(o.amount).toFixed(2)
    const list = byAmount.get(key) ?? []
    list.push(o)
    byAmount.set(key, list)
  }

  const movements: CanonicalMovement[] = []
  const used = new Set<number>()

  for (const [, group] of byAmount) {
    // Sort by source priority (highest first)
    group.sort((a, b) => (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0))

    for (let i = 0; i < group.length; i++) {
      if (used.has(group[i]._idx)) continue
      const primary = group[i]
      const evidenceGroup = [primary]
      used.add(primary._idx)

      // Try to find matches within ±1 day (plan #3, #4: order_id, vendor normalization)
      for (let j = i + 1; j < group.length; j++) {
        if (used.has(group[j]._idx)) continue
        const candidate = group[j]

        // Same source: coalesce when order_id matches OR when vendor name matches (same-source vendor coalescing)
        const sameSource = candidate.source === primary.source
        if (sameSource && !orderIdsMatch(primary, candidate)) {
          const cpScore = counterpartyMatchScore(primary.counterparty, candidate.counterparty)
          if (cpScore < 0.4) continue // same source, no order_id, vendor doesn't match → skip
        }

        // Must have same sign (both inflow or both outflow)
        if (Math.sign(candidate.amount) !== Math.sign(primary.amount)) continue

        // Date must be within 1 day
        if (dateDistance(primary.date, candidate.date) > 1) continue

        // Counterparty: require similarity OR at least one side blank OR order_id match
        // Relaxed: when either has order_id/invoice_id/payment_intent_id, allow even if counterparty differs
        const orderMatch = orderIdsMatch(primary, candidate)
        const eitherHasOrderId = !!extractOrderId(primary) || !!extractOrderId(candidate)
        const cpScore = counterpartyMatchScore(primary.counterparty, candidate.counterparty)
        const eitherBlank = !primary.counterparty || !candidate.counterparty
        if (!orderMatch && cpScore < 0.4 && !eitherBlank && !eitherHasOrderId) continue

        evidenceGroup.push(candidate)
        used.add(candidate._idx)
      }

      movements.push(obsToCanonical(evidenceGroup))
    }
  }

  return movements
}

const BANK_SOURCES = new Set(["plaid"])

function deriveProvenance(evidence: SourceObservation[]): Provenance {
  if (evidence.length > 1) return "coalesced"
  const src = evidence[0].source
  if (BANK_SOURCES.has(src)) return "bank_observed"
  return "accounting_observed"
}

function sourceAgreementScore(evidence: SourceObservation[]): number {
  if (evidence.length <= 1) return -1 // single source → absent signal (neutral)
  const sources = new Set(evidence.map((e) => e.source))
  if (sources.size <= 1) return -1
  const hasBankAndAccounting = [...sources].some((s) => BANK_SOURCES.has(s)) &&
    [...sources].some((s) => !BANK_SOURCES.has(s))
  if (hasBankAndAccounting) return 1.0
  return 0.7
}

function obsToCanonical(evidence: SourceObservation[]): CanonicalMovement {
  // Primary = first (highest priority after sort)
  const primary = evidence[0]
  const amt = primary.amount
  const direction: "inflow" | "outflow" = amt >= 0 ? "inflow" : "outflow"

  // Merge counterparty: prefer the one with an actual name
  let counterparty = primary.counterparty
  if (!counterparty) {
    for (const e of evidence) {
      if (e.counterparty) { counterparty = e.counterparty; break }
    }
  }

  // Merge account info — prefer bank-observed account
  let cashAcct = primary.account_name
  let cashAcctId = primary.account_id
  for (const e of evidence) {
    if (e.source === "plaid" && e.account_name) {
      cashAcct = e.account_name
      cashAcctId = e.account_id
      break
    }
  }
  if (!cashAcct) {
    for (const e of evidence) {
      if (e.account_name) { cashAcct = e.account_name; cashAcctId = e.account_id; break }
    }
  }

  // Merge plaid fields
  let plaidCat: string[] | null = null
  let plaidPfc: Record<string, string> | null = null
  let plaidChannel: string | null = null
  for (const e of evidence) {
    if (e.plaid_category && e.plaid_category.length > 0 && !plaidCat) plaidCat = e.plaid_category
    if (e.plaid_pfc && !plaidPfc) plaidPfc = e.plaid_pfc
    if (e.plaid_payment_channel && !plaidChannel) plaidChannel = e.plaid_payment_channel
  }

  // Merge metadata
  const mergedMeta: Record<string, unknown> = {}
  for (const e of evidence) {
    Object.assign(mergedMeta, e.metadata)
  }
  if (evidence.length > 1) {
    mergedMeta.coalesced_sources = evidence.map((e) => `${e.source}:${e.source_id}`)
  }

  return {
    direction,
    amount: Math.abs(amt),
    date: primary.date,
    cash_account_id: cashAcctId,
    cash_account_name: cashAcct,
    counterparty,
    counterparty_entity_id: null,
    counterparty_entity_type: null,
    linked_internal_account_id: null,
    raw_description: primary.raw_description,
    evidence,
    provenance: deriveProvenance(evidence),
    plaid_category: plaidCat,
    plaid_pfc: plaidPfc,
    plaid_payment_channel: plaidChannel,
    metadata: mergedMeta,
  }
}

// ─── Step 2b: Plaid cross-account transfer pairing ──────────────────

function pairPlaidTransfers(
  movements: CanonicalMovement[],
  ownAccountIds: Set<string>
): CanonicalMovement[] {
  // Find Plaid-only canonical movements with single evidence
  const plaidSingles = movements.filter(
    (m) => m.evidence.length === 1 && m.evidence[0].source === "plaid"
  )

  // Index by |amount|
  const byAmount = new Map<string, CanonicalMovement[]>()
  for (const m of plaidSingles) {
    const key = m.amount.toFixed(2)
    const list = byAmount.get(key) ?? []
    list.push(m)
    byAmount.set(key, list)
  }

  const pairedSet = new Set<CanonicalMovement>()

  for (const [, group] of byAmount) {
    if (group.length < 2) continue

    for (let i = 0; i < group.length; i++) {
      if (pairedSet.has(group[i])) continue
      for (let j = i + 1; j < group.length; j++) {
        if (pairedSet.has(group[j])) continue

        const a = group[i]
        const b = group[j]

        if (a.direction === b.direction) continue

        const aAcct = a.evidence[0].account_id
        const bAcct = b.evidence[0].account_id
        if (!aAcct || !bAcct || aAcct === bAcct) continue
        if (!ownAccountIds.has(aAcct) || !ownAccountIds.has(bAcct)) continue

        // Date within 1 day
        const da = new Date(a.date).getTime()
        const db = new Date(b.date).getTime()
        if (Math.abs(da - db) > 86400000) continue

        // Merge into single internal_transfer canonical movement
        const outflow = a.direction === "outflow" ? a : b
        const inflow = a.direction === "inflow" ? a : b

        const fromObs = outflow.evidence[0]
        const toObs = inflow.evidence[0]

        outflow.evidence = [...outflow.evidence, ...inflow.evidence]
        outflow.linked_internal_account_id = inflow.cash_account_name ?? inflow.cash_account_id
        outflow.metadata = {
          ...outflow.metadata,
          transfer_type: "cross_account",
          from_account_name: fromObs.account_name,
          from_account_type: fromObs.account_type,
          from_account_subtype: fromObs.account_subtype,
          to_account_name: toObs.account_name,
          to_account_type: toObs.account_type,
          to_account_subtype: toObs.account_subtype,
        }

        pairedSet.add(inflow)
        break
      }
    }
  }

  return movements.filter((m) => !pairedSet.has(m))
}

// ─── Step 3: Resolve accounts ───────────────────────────────────────

function resolveAccounts(movements: CanonicalMovement[], ctx: MovementIdentityContext): void {
  for (const m of movements) {
    // If we have a Plaid account_id, check if it's one of user's own accounts
    const acctId = m.cash_account_id
    if (acctId) {
      const acctEntry = ctx.get(`__plaid_account__${acctId}`)
      if (acctEntry) {
        m.cash_account_name = m.cash_account_name ?? acctEntry.canonical_name
      }
    }

    // If QBO Transfer, both sides are internal accounts
    const fromAcct = m.metadata.from_account as string | undefined
    const toAcct = m.metadata.to_account as string | undefined
    if (fromAcct && toAcct) {
      m.cash_account_name = m.cash_account_name ?? fromAcct
      m.linked_internal_account_id = m.linked_internal_account_id ?? toAcct
      // Enrich metadata with consistent from/to naming
      m.metadata.from_account_name = m.metadata.from_account_name ?? fromAcct
      m.metadata.to_account_name = m.metadata.to_account_name ?? toAcct
      m.metadata.transfer_type = m.metadata.transfer_type ?? "qbo_transfer"
    }

    // For Plaid single-sided transfers, enrich with account info from evidence
    const primaryEvidence = m.evidence[0]
    if (primaryEvidence?.source === "plaid" && primaryEvidence.account_type) {
      m.metadata.account_type = m.metadata.account_type ?? primaryEvidence.account_type
      m.metadata.account_subtype = m.metadata.account_subtype ?? primaryEvidence.account_subtype
    }
  }
}

// ─── Step 4: Resolve counterparty identity ──────────────────────────

// Build a prefix index for fast fuzzy lookups (built once per classify run)
type PrefixIndex = Map<string, Array<{ fullKey: string; entry: MovementIdentityEntry }>>

function buildPrefixIndex(ctx: MovementIdentityContext): PrefixIndex {
  const idx: PrefixIndex = new Map()
  const PREFIX_LEN = 6
  for (const [k, entry] of ctx) {
    if (k.startsWith("__") || k.length < 4) continue
    const prefix = k.slice(0, PREFIX_LEN)
    const list = idx.get(prefix) ?? []
    list.push({ fullKey: k, entry })
    idx.set(prefix, list)
  }
  return idx
}

function fuzzyMatch(query: string, candidate: string): number {
  if (query === candidate) return 1.0
  const shorter = query.length <= candidate.length ? query : candidate
  const longer = query.length > candidate.length ? query : candidate
  if (shorter.length < 4) return 0

  // Prefix/suffix containment with length ratio
  if (longer.startsWith(shorter) || longer.endsWith(shorter)) {
    return shorter.length / longer.length
  }

  // Token overlap: split by common word boundaries in normalized strings
  // (digits act as separators in normKey output)
  const qTokens = query.match(/[a-z]+/g) ?? []
  const cTokens = candidate.match(/[a-z]+/g) ?? []
  if (qTokens.length === 0 || cTokens.length === 0) return 0

  let matches = 0
  for (const qt of qTokens) {
    if (qt.length < 3) continue
    for (const ct of cTokens) {
      if (ct.length < 3) continue
      if (ct === qt || (ct.length >= 4 && qt.length >= 4 && (ct.startsWith(qt) || qt.startsWith(ct)))) {
        matches++
        break
      }
    }
  }
  const significantTokens = qTokens.filter((t) => t.length >= 3).length
  return significantTokens > 0 ? matches / significantTokens : 0
}

function resolveCounterpartyIdentity(
  m: CanonicalMovement,
  ctx: MovementIdentityContext,
  prefixIdx: PrefixIndex
): MovementIdentityEntry | null {
  const candidates: string[] = []
  if (m.counterparty) candidates.push(m.counterparty)
  if (m.raw_description && m.raw_description !== m.counterparty) candidates.push(m.raw_description)

  for (const c of candidates) {
    const key = normalizeForMatch(c)
    if (key.length < 2) continue

    // 1. Exact match (O(1)) — plan #5 alias normalization
    const exact = ctx.get(key)
    if (exact) return exact

    // 2. Prefix-indexed fuzzy match (O(bucket_size) not O(n))
    if (key.length >= 6) {
      const prefix = key.slice(0, 6)
      const bucket = prefixIdx.get(prefix)
      if (bucket) {
        let bestScore = 0
        let bestEntry: MovementIdentityEntry | null = null
        for (const { fullKey, entry } of bucket) {
          const score = fuzzyMatch(key, fullKey)
          if (score > bestScore && score >= 0.6) {
            bestScore = score
            bestEntry = entry
          }
        }
        if (bestEntry) return bestEntry
      }
    }

    // 3. Reverse containment: check if query is a well-known entity name
    //    Only for short-ish queries (< 20 chars) to avoid false positives
    if (key.length >= 5 && key.length <= 20) {
      const directHit = ctx.get(key)
      if (directHit) return directHit
    }

    // 4. Owner containment: "JACK RUBENSTEIN" contains "jack" → match owner "Jack"
    const ownerEntries = (ctx as Map<string, unknown> & { _ownerEntries?: MovementIdentityEntry[] })._ownerEntries
    if (ownerEntries && key.length >= 6) {
      for (const entry of ownerEntries) {
        const ownerNorm = normalizeForMatch(entry.canonical_name)
        if (ownerNorm.length >= 4 && key.includes(ownerNorm)) return entry
      }
    }
  }

  return null
}

// ─── Classification result ────────────────────────────────────────

type ClassifyResult = { type: MovementType; signals: Partial<ConfidenceBreakdown> }

// ─── Step 5: Classify non-P&L movements ─────────────────────────────

function classifyNonPnl(m: CanonicalMovement, identity: MovementIdentityEntry | null, selfCtx: SelfContext): ClassifyResult | null {
  const desc = (m.raw_description ?? "").toLowerCase()
  const catStr = (m.plaid_category ?? []).join(" ").toLowerCase()
  const pfcPrimary = (m.plaid_pfc?.primary ?? "").toUpperCase()
  const pfcDetailed = (m.plaid_pfc?.detailed ?? "").toUpperCase()
  const primaryObs = m.evidence[0]
  const eid = identity?.confidence ?? -1
  const srcAuth = getSourceAuthority(m.evidence)
  const ar = m.cash_account_id ? 0.9 : (m.cash_account_name ? 0.6 : 0.2)

  // ── Plaid PFC (high-quality signal) ──
  if (pfcPrimary === "TRANSFER_IN" || pfcPrimary === "TRANSFER_OUT") {
    if (pfcDetailed.includes("ACCOUNT_TRANSFER")) return { type: "internal_transfer", signals: { pattern_strength: 0.95, entity_confidence: eid, source_authority: srcAuth, account_resolution: ar } }
    if (pfcDetailed.includes("LOAN") || pfcDetailed.includes("MORTGAGE")) {
      const t = m.direction === "inflow" ? "loan_funding" as const : "loan_principal_payment" as const
      return { type: t, signals: { pattern_strength: 0.90, entity_confidence: eid, source_authority: srcAuth, account_resolution: ar } }
    }
    if (pfcDetailed.includes("CREDIT_CARD")) return { type: "credit_card_payment", signals: { pattern_strength: 0.95, entity_confidence: eid, source_authority: srcAuth, account_resolution: ar } }
    if (pfcDetailed.includes("DEPOSIT")) return { type: "internal_transfer", signals: { pattern_strength: 0.85, source_authority: srcAuth, account_resolution: ar } }
  }
  if (pfcPrimary === "LOAN_PAYMENTS") {
    return { type: "loan_principal_payment", signals: { pattern_strength: 0.95, source_authority: srcAuth, account_resolution: ar } }
  }

  // ── Structural: cross-account transfer (paired) ──
  if (m.metadata.transfer_type === "cross_account") {
    return { type: "internal_transfer", signals: { pattern_strength: 1.0, account_resolution: 1.0, source_authority: srcAuth } }
  }

  // ── Structural: QBO Transfer entity ──
  if (primaryObs.source === "qbo" && primaryObs.source_type === "Transfer") {
    return { type: "internal_transfer", signals: { pattern_strength: 0.95, account_resolution: Math.max(ar, 0.7), source_authority: srcAuth } }
  }

  // ── Structural: Stripe payout ──
  if (primaryObs.source === "stripe" && primaryObs.source_type === "payout") {
    return { type: "processor_payout", signals: { pattern_strength: 0.95, entity_confidence: 0.9, source_authority: srcAuth, account_resolution: ar } }
  }

  // ── Structural: Stripe balance_transaction ──
  if (primaryObs.source === "stripe" && primaryObs.source_type === "balance_transaction") {
    const sType = (m.metadata.stripe_type ?? "") as string
    if (sType === "stripe_fee" || sType === "fee") return { type: "processor_fee_settlement", signals: { pattern_strength: 0.95, entity_confidence: 0.9, source_authority: srcAuth } }
    if (sType === "payout") return { type: "processor_payout", signals: { pattern_strength: 0.95, entity_confidence: 0.9, source_authority: srcAuth } }
  }

  // ── Verification deposits ──
  if (m.amount <= 1.0 && VERIFICATION_PATTERNS.some((p) => p.test(desc))) {
    return { type: "account_verification", signals: { pattern_strength: 0.95, source_authority: srcAuth, account_resolution: ar } }
  }
  if (m.amount <= 0.50 && catStr.includes("bank fees")) {
    return { type: "account_verification", signals: { pattern_strength: 0.90, source_authority: srcAuth, account_resolution: ar } }
  }

  // ── Bank fee refund (must come before general bank fee & refund matching) ──
  if (BANK_FEE_REFUND_PATTERNS.some((p) => p.test(desc))) {
    return { type: "bank_fee_refund", signals: { pattern_strength: 0.90, source_authority: srcAuth, account_resolution: ar } }
  }

  // ── Opening balance ──
  if (OPENING_BALANCE_PATTERNS.some((p) => p.test(desc))) {
    return { type: "opening_balance", signals: { pattern_strength: 0.90, source_authority: srcAuth } }
  }

  // ── Credit card payments ──
  if (CC_PAYMENT_PATTERNS.some((p) => p.test(desc))) {
    return { type: "credit_card_payment", signals: { pattern_strength: 0.90, entity_confidence: eid, source_authority: srcAuth, account_resolution: ar } }
  }
  if (identity?.role === "processor" && CC_PAYMENT_PATTERNS.some((p) => p.test(m.counterparty ?? ""))) {
    return { type: "credit_card_payment", signals: { pattern_strength: 0.90, entity_confidence: eid, source_authority: srcAuth } }
  }

  // ── Processor payout by descriptor (ACH CREDIT from known processors) ──
  if (m.direction === "inflow" && PROCESSOR_PAYOUT_DESC_PATTERNS.some((p) => p.test(desc))) {
    return { type: "processor_payout", signals: { pattern_strength: 0.92, source_authority: srcAuth, account_resolution: ar } }
  }

  // Helper: is this a merchant deposit descriptor? Used to block owner contamination.
  const isMerchantDepositDesc = MERCHANT_DEPOSIT_PATTERNS.some((p) => p.test(desc))

  // ── Owner draw / contribution (pattern-based) — block merchant deposit descriptors ──
  if (!isMerchantDepositDesc && OWNER_CONTRIBUTION_PATTERNS.some((p) => p.test(desc))) {
    return { type: "owner_contribution", signals: { pattern_strength: 0.85, entity_confidence: eid, source_authority: srcAuth } }
  }
  if (!isMerchantDepositDesc && OWNER_PATTERNS.some((p) => p.test(desc))) {
    return { type: "owner_draw", signals: { pattern_strength: 0.85, entity_confidence: eid, source_authority: srcAuth } }
  }
  if (!isMerchantDepositDesc && identity?.role === "owner") {
    const t = m.direction === "inflow" ? "owner_contribution" as const : "owner_draw" as const
    return { type: t, signals: { entity_confidence: identity.confidence, pattern_strength: 0.65, source_authority: srcAuth, account_resolution: ar } }
  }

  // ── Owner detection from descriptor containing owner name — block merchant deposit descriptors ──
  if (!isMerchantDepositDesc && m.direction === "inflow" && selfCtx.ownerNames.length > 0) {
    const descNorm = normKey(desc)
    for (const on of selfCtx.ownerNames) {
      const onNorm = on.toLowerCase().replace(/[^a-z0-9]/g, "")
      if (onNorm.length >= 3 && descNorm.includes(onNorm)) {
        return { type: "owner_contribution_candidate", signals: { entity_confidence: 0.5, pattern_strength: 0.55, source_authority: srcAuth, account_resolution: ar } }
      }
    }
  }

  // ── Loan / financing ──
  if (LOAN_PATTERNS.some((p) => p.test(desc))) {
    const t = m.direction === "inflow" ? "loan_funding" as const : "loan_principal_payment" as const
    return { type: t, signals: { pattern_strength: 0.85, entity_confidence: eid, source_authority: srcAuth } }
  }
  if (catStr.includes("loan")) {
    const t = m.direction === "inflow" ? "loan_funding" as const : "loan_principal_payment" as const
    return { type: t, signals: { pattern_strength: 0.70, source_authority: srcAuth } }
  }
  if (identity?.role === "lender") {
    const t = m.direction === "inflow" ? "loan_funding" as const : "loan_principal_payment" as const
    return { type: t, signals: { entity_confidence: identity.confidence, pattern_strength: 0.60, source_authority: srcAuth } }
  }

  // ── Transfer patterns (bank description) — but not processor payouts or merchant deposits ──
  if (TRANSFER_PATTERNS.some((p) => p.test(desc))) {
    if (PROCESSOR_PAYOUT_DESC_PATTERNS.some((p) => p.test(desc))) {
      return { type: "processor_payout", signals: { pattern_strength: 0.92, source_authority: srcAuth, account_resolution: ar } }
    }
    if (identity && (identity.role === "internal" || identity.role === "bank_account" || identity.is_own_account)) {
      return { type: "internal_transfer", signals: { pattern_strength: 0.80, entity_confidence: identity.confidence, account_resolution: ar, source_authority: srcAuth } }
    }
    if (catStr.includes("transfer") && !catStr.includes("wire transfer") && m.linked_internal_account_id) {
      return { type: "internal_transfer", signals: { pattern_strength: 0.80, account_resolution: 0.9, source_authority: srcAuth } }
    }
  }

  // ── Identity: processor → settlement or CC payment ──
  if (identity?.role === "processor" && identity.confidence >= 0.6) {
    if (m.direction === "inflow") {
      return { type: "processor_payout", signals: { entity_confidence: identity.confidence, pattern_strength: 0.90, source_authority: srcAuth, account_resolution: ar } }
    }
    const cpLower = (m.counterparty ?? "").toLowerCase()
    const isCcBrand = /\bchase\b|\bamex\b|\bciti\b|\bcapital\s*one\b|\bvisa\b|\bmastercard\b|\bdiscover\b/.test(cpLower)
    const isCcDesc = CC_PAYMENT_PATTERNS.some((p) => p.test(desc))
    if (isCcBrand || isCcDesc) {
      return { type: "credit_card_payment", signals: { entity_confidence: identity.confidence, pattern_strength: 0.80, source_authority: srcAuth, account_resolution: ar } }
    }
    return { type: "processor_fee_settlement", signals: { entity_confidence: identity.confidence, pattern_strength: 0.65, source_authority: srcAuth } }
  }

  // ── Identity: internal / bank_account → internal_transfer ──
  if (identity && (identity.role === "internal" || identity.role === "bank_account") && identity.confidence >= 0.6) {
    return { type: "internal_transfer", signals: { entity_confidence: identity.confidence, pattern_strength: 0.70, account_resolution: ar, source_authority: srcAuth } }
  }

  return null
}

// ─── Step 6: Classify operating cash movements ──────────────────────

function classifyOperating(m: CanonicalMovement, identity: MovementIdentityEntry | null): ClassifyResult | null {
  const desc = (m.raw_description ?? "").toLowerCase()
  const catStr = (m.plaid_category ?? []).join(" ").toLowerCase()
  const pfcPrimary = (m.plaid_pfc?.primary ?? "").toUpperCase()
  const pfcDetailed = (m.plaid_pfc?.detailed ?? "").toUpperCase()
  const primaryObs = m.evidence[0]
  const eid = identity?.confidence ?? -1
  const srcAuth = getSourceAuthority(m.evidence)
  const ar = m.cash_account_id ? 0.9 : (m.cash_account_name ? 0.6 : 0.2)

  // ── Plaid PFC operating signals ──
  if (pfcPrimary === "BANK_FEES") return { type: "cash_out_bank_fee", signals: { pattern_strength: 0.95, source_authority: srcAuth, account_resolution: ar } }
  if (pfcPrimary === "INCOME" && pfcDetailed.includes("INTEREST")) return { type: "cash_in_interest", signals: { pattern_strength: 0.95, source_authority: srcAuth, account_resolution: ar } }
  if (pfcPrimary === "INCOME") return { type: "cash_in_customer", signals: { pattern_strength: 0.80, entity_confidence: eid, source_authority: srcAuth, account_resolution: ar } }
  if (pfcDetailed.includes("TAX") || pfcPrimary === "GOVERNMENT_AND_NON_PROFIT") {
    if (TAX_PATTERNS.some((p) => p.test(desc))) return { type: "cash_out_tax", signals: { pattern_strength: 0.95, source_authority: srcAuth, account_resolution: ar } }
  }
  if (pfcPrimary === "RENT_AND_UTILITIES" || pfcPrimary === "GENERAL_SERVICES") {
    return { type: "cash_out_operating_expense", signals: { pattern_strength: 0.85, source_authority: srcAuth, account_resolution: ar } }
  }

  // ── Bank fee refund (must check before general bank fee matching) ──
  if (BANK_FEE_REFUND_PATTERNS.some((p) => p.test(desc))) return { type: "bank_fee_refund", signals: { pattern_strength: 0.90, source_authority: srcAuth, account_resolution: ar } }

  // ── Bank fees (descriptor match) ──
  if (BANK_FEE_PATTERNS.some((p) => p.test(desc))) return { type: "cash_out_bank_fee", signals: { pattern_strength: 0.90, source_authority: srcAuth, account_resolution: ar } }
  if (catStr.includes("bank fees")) return { type: "cash_out_bank_fee", signals: { pattern_strength: 0.85, source_authority: srcAuth, account_resolution: ar } }

  // ── Payroll ──
  if (catStr.includes("payroll")) return { type: "cash_out_payroll", signals: { pattern_strength: 0.90, source_authority: srcAuth, account_resolution: ar } }
  const cpNorm = normKey(m.counterparty ?? "")
  for (const pp of PAYROLL_PROCESSORS) {
    if (cpNorm.includes(pp.replace(/[^a-z0-9]/g, ""))) return { type: "cash_out_payroll", signals: { pattern_strength: 0.90, entity_confidence: eid, source_authority: srcAuth, account_resolution: ar } }
  }
  if (identity?.role === "employee" && identity.confidence >= 0.6) {
    return { type: "cash_out_payroll", signals: { entity_confidence: identity.confidence, pattern_strength: 0.60, source_authority: srcAuth, account_resolution: ar } }
  }

  // ── Tax ──
  if (TAX_PATTERNS.some((p) => p.test(desc))) return { type: "cash_out_tax", signals: { pattern_strength: 0.90, source_authority: srcAuth, account_resolution: ar } }
  if (catStr.includes("tax")) return { type: "cash_out_tax", signals: { pattern_strength: 0.75, source_authority: srcAuth } }
  if (identity?.role === "tax_authority" && identity.confidence >= 0.6) {
    return { type: "cash_out_tax", signals: { entity_confidence: identity.confidence, pattern_strength: 0.60, source_authority: srcAuth } }
  }

  // ── Interest ──
  if (INTEREST_PATTERNS.some((p) => p.test(desc))) {
    const t = m.direction === "inflow" ? "cash_in_interest" as const : "cash_out_interest" as const
    return { type: t, signals: { pattern_strength: 0.90, source_authority: srcAuth, account_resolution: ar } }
  }

  // ── Refunds ──
  if (REFUND_PATTERNS.some((p) => p.test(desc))) {
    const t = m.direction === "inflow" ? "cash_in_refund" as const : "cash_out_refund" as const
    return { type: t, signals: { pattern_strength: 0.85, source_authority: srcAuth, account_resolution: ar } }
  }
  if (primaryObs.source === "qbo" && ["RefundReceipt", "CreditMemo", "VendorCredit"].includes(primaryObs.source_type)) {
    return { type: "cash_out_refund", signals: { pattern_strength: 0.90, source_authority: srcAuth, account_resolution: ar } }
  }
  if (primaryObs.source === "xero" && primaryObs.source_type === "CreditNote") {
    return { type: "cash_out_refund", signals: { pattern_strength: 0.90, source_authority: srcAuth, account_resolution: ar } }
  }
  if (primaryObs.source === "stripe" && primaryObs.source_type === "balance_transaction") {
    const sType = (m.metadata.stripe_type ?? "") as string
    if (sType === "refund") return { type: "cash_out_refund", signals: { pattern_strength: 0.95, entity_confidence: 0.9, source_authority: srcAuth, account_resolution: ar } }
  }

  // ── Identity: customer / vendor ──
  if (identity?.role === "customer" && identity.confidence >= 0.6) {
    return { type: "cash_in_customer", signals: { entity_confidence: identity.confidence, pattern_strength: 0.60, source_authority: srcAuth, account_resolution: ar } }
  }
  if (identity?.role === "vendor" && identity.confidence >= 0.6) {
    return { type: "cash_out_vendor", signals: { entity_confidence: identity.confidence, pattern_strength: 0.60, source_authority: srcAuth, account_resolution: ar } }
  }

  // ── QBO type-based classification ──
  if (primaryObs.source === "qbo") {
    if (["Invoice", "SalesReceipt"].includes(primaryObs.source_type)) {
      return { type: "cash_in_customer", signals: { pattern_strength: 0.85, source_authority: srcAuth, account_resolution: ar } }
    }
    if (primaryObs.source_type === "Payment") {
      return { type: "cash_in_customer", signals: { pattern_strength: 0.85, entity_confidence: eid, source_authority: srcAuth, account_resolution: ar } }
    }
    if (primaryObs.source_type === "Deposit") {
      if (m.counterparty && identity?.role === "customer") {
        return { type: "cash_in_customer", signals: { pattern_strength: 0.70, entity_confidence: identity.confidence, source_authority: srcAuth, account_resolution: ar } }
      }
      return m.counterparty
        ? { type: "cash_in_customer", signals: { pattern_strength: 0.60, source_authority: srcAuth, account_resolution: ar } }
        : { type: "unknown_inflow", signals: { pattern_strength: 0.20, source_authority: srcAuth } }
    }
    if (["Bill", "BillPayment", "Purchase"].includes(primaryObs.source_type)) {
      return { type: "cash_out_vendor", signals: { pattern_strength: 0.80, entity_confidence: eid, source_authority: srcAuth, account_resolution: ar } }
    }
  }

  // ── Xero type-based classification ──
  if (primaryObs.source === "xero") {
    const xeroSubType = (m.metadata.xero_sub_type ?? "") as string
    if (primaryObs.source_type === "Invoice") {
      const t = xeroSubType === "ACCPAY" ? "cash_out_vendor" as const : "cash_in_customer" as const
      return { type: t, signals: { pattern_strength: 0.80, source_authority: srcAuth, account_resolution: ar } }
    }
    if (primaryObs.source_type === "Bill") return { type: "cash_out_vendor", signals: { pattern_strength: 0.80, source_authority: srcAuth, account_resolution: ar } }
    if (primaryObs.source_type === "Payment") {
      const t = m.direction === "outflow" ? "cash_out_vendor" as const : "cash_in_customer" as const
      return { type: t, signals: { pattern_strength: 0.70, source_authority: srcAuth, account_resolution: ar } }
    }
    if (primaryObs.source_type === "BankTransaction") {
      const t = m.direction === "inflow" ? "cash_in_customer" as const : "cash_out_operating_expense" as const
      return { type: t, signals: { pattern_strength: 0.60, source_authority: srcAuth, account_resolution: ar } }
    }
  }

  // ── Stripe type-based classification ──
  if (primaryObs.source === "stripe" && (primaryObs.source_type === "payment_intent" || primaryObs.source_type === "invoice")) {
    return { type: "cash_in_customer", signals: { pattern_strength: 0.80, entity_confidence: 0.7, source_authority: srcAuth, account_resolution: ar } }
  }

  // ── Plaid category heuristics ──
  if (m.direction === "inflow" && catStr.includes("deposit")) {
    return { type: "cash_in_customer", signals: { pattern_strength: 0.55, source_authority: srcAuth, account_resolution: ar } }
  }

  // ── Plaid payment_channel ──
  if (m.plaid_payment_channel === "in store" || m.plaid_payment_channel === "online") {
    const t = m.direction === "inflow" ? "cash_in_customer" as const : "cash_out_operating_expense" as const
    return { type: t, signals: { pattern_strength: 0.55, source_authority: srcAuth, account_resolution: ar } }
  }

  return null
}

// ─── Step 6b: Provisional classes ───────────────────────────────────

function classifyProvisional(m: CanonicalMovement, identity: MovementIdentityEntry | null): ClassifyResult | null {
  const desc = (m.raw_description ?? "").toLowerCase()
  const srcAuth = getSourceAuthority(m.evidence)
  const isMerchantDepositDesc = MERCHANT_DEPOSIT_PATTERNS.some((p) => p.test(desc))

  // Merchant deposit: recurring BANKCD/DEPOSIT patterns — recognized economic class
  if (m.direction === "inflow" && isMerchantDepositDesc) {
    return { type: "merchant_deposit_unresolved", signals: { pattern_strength: 0.65, source_authority: srcAuth } }
  }

  // Inflows from owner-linked entities without strong signals — NEVER if merchant deposit descriptor
  if (!isMerchantDepositDesc && m.direction === "inflow" && identity?.role === "internal") {
    if (!OWNER_CONTRIBUTION_PATTERNS.some((p) => p.test(desc))) {
      return { type: "owner_contribution_candidate", signals: { entity_confidence: identity.confidence, pattern_strength: 0.40, source_authority: srcAuth } }
    }
  }

  // Inflows from own accounts without internal transfer pairing — NEVER if merchant deposit descriptor
  if (!isMerchantDepositDesc && m.direction === "inflow" && identity?.is_own_account && !m.linked_internal_account_id) {
    return { type: "owner_contribution_candidate", signals: { entity_confidence: identity.confidence, pattern_strength: 0.40, source_authority: srcAuth } }
  }

  return null
}

// ─── Step 7: Fallback ───────────────────────────────────────────────

function classifyFallback(m: CanonicalMovement): ClassifyResult {
  const desc = (m.raw_description ?? "").toLowerCase()
  const srcAuth = getSourceAuthority(m.evidence)

  if (TRANSFER_PATTERNS.some((p) => p.test(desc))) {
    return { type: "unknown_transfer_candidate", signals: { pattern_strength: 0.15, source_authority: srcAuth * 0.5 } }
  }

  // Unresolved enrichment: Zelle/Venmo/Cash App → transfer
  const enrich = enrichUnresolved(m)
  if (enrich?.suggested_type === "internal_transfer" && enrich.confidence >= 0.65) {
    return { type: "unknown_transfer_candidate", signals: { pattern_strength: enrich.confidence, source_authority: srcAuth * 0.6 } }
  }

  const t = m.direction === "inflow" ? "unknown_inflow" as const : "unknown_outflow" as const
  return { type: t, signals: { pattern_strength: 0.10, source_authority: srcAuth * 0.5 } }
}

// ─── Step 7b: Family-level learning (persisted to movement_families) ─

type MovementFamily = {
  family_key: string
  pattern: string
  account: string | null
  direction: "inflow" | "outflow"
  count: number
  dominantType: MovementType
  dominantConfidence: number
  last_seen: string
}

function familyKey(desc: string, direction: string, account: string | null): string {
  const prefix = desc.toLowerCase().replace(/\d{4,}/g, "NNNNN").replace(/\s+/g, " ").trim().slice(0, 40)
  return `${direction}|${account ?? "?"}|${prefix}`
}

function buildFamilies(classified: ClassifiedMovement[]): Map<string, MovementFamily> {
  const families = new Map<string, { types: Map<string, { count: number; totalConf: number }>; account: string | null; direction: "inflow" | "outflow"; count: number; last_seen: string }>()

  for (const c of classified) {
    if (c.confidence.score < 0.6) continue
    const desc = c.raw_description ?? ""
    if (desc.length < 5) continue

    const key = familyKey(desc, c.direction, c.cash_account_name)
    let fam = families.get(key)
    if (!fam) {
      fam = { types: new Map(), account: c.cash_account_name, direction: c.direction, count: 0, last_seen: c.date }
      families.set(key, fam)
    }
    fam.count++
    if (c.date > fam.last_seen) fam.last_seen = c.date
    const typeEntry = fam.types.get(c.movement_type) ?? { count: 0, totalConf: 0 }
    typeEntry.count++
    typeEntry.totalConf += c.confidence.score
    fam.types.set(c.movement_type, typeEntry)
  }

  const result = new Map<string, MovementFamily>()
  for (const [key, fam] of families) {
    if (fam.count < 3) continue
    let bestType: MovementType = "unknown_inflow"
    let bestCount = 0
    let bestConf = 0
    for (const [type, entry] of fam.types) {
      if (entry.count > bestCount) {
        bestCount = entry.count
        bestType = type as MovementType
        bestConf = entry.totalConf / entry.count
      }
    }
    if (bestCount / fam.count >= 0.6) {
      result.set(key, {
        family_key: key,
        pattern: key.split("|").slice(2).join("|"),
        account: fam.account,
        direction: fam.direction,
        count: fam.count,
        dominantType: bestType,
        dominantConfidence: Math.min(0.85, bestConf + 0.05),
        last_seen: fam.last_seen,
      })
    }
  }
  return result
}

function applyFamilyLearning(classified: ClassifiedMovement[], families: Map<string, MovementFamily>): number {
  if (families.size === 0) return 0
  let upgraded = 0

  for (const c of classified) {
    const desc = c.raw_description ?? ""
    const key = familyKey(desc, c.direction, c.cash_account_name)
    const family = families.get(key)
    if (!family) continue

    // Promote merchant_deposit_unresolved to resolved when family is recurring
    if (c.movement_type === "merchant_deposit_unresolved" && family.count >= 3) {
      c.movement_type = "merchant_deposit_resolved"
      c.pnl_eligible = false
      const familyPatternFloor = family.count >= 10 ? 0.85 : family.count >= 5 ? 0.75 : 0.65
      c.confidence = computeConfidence({
        ...c.confidence,
        history: family.dominantConfidence,
        pattern_strength: Math.max(c.confidence.pattern_strength, familyPatternFloor),
      })
      c.review_needed = c.confidence.score < 0.55
      c.metadata.family_learned = true
      c.metadata.family_key = family.family_key
      c.metadata.family_count = family.count
      upgraded++
      continue
    }

    if (c.confidence.score >= 0.55) continue
    if (family.dominantConfidence > c.confidence.score) {
      c.movement_type = family.dominantType
      c.pnl_eligible = isPnlEligible(family.dominantType)
      const familyPatternFloor = family.count >= 10 ? 0.80 : family.count >= 5 ? 0.70 : 0.60
      c.confidence = computeConfidence({
        ...c.confidence,
        history: family.dominantConfidence,
        pattern_strength: Math.max(c.confidence.pattern_strength, familyPatternFloor),
      })
      c.review_needed = c.confidence.score < 0.55
      c.metadata.family_learned = true
      c.metadata.family_key = family.family_key
      c.metadata.family_count = family.count
      upgraded++
    }
  }
  return upgraded
}

async function persistFamilies(userId: string, families: Map<string, MovementFamily>): Promise<void> {
  if (families.size === 0) return
  const entries = [...families.values()]
  const batchSize = 50
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize)
    const values: string[] = []
    const params: unknown[] = []
    let idx = 0
    for (const f of batch) {
      const offsets = Array.from({ length: 8 }, (_, k) => `$${idx + k + 1}`)
      values.push(`(${offsets.join(", ")})`)
      params.push(userId, f.family_key, f.pattern, f.account, f.direction, f.dominantType, f.dominantConfidence, f.count)
      idx += 8
    }
    await query(
      `INSERT INTO movement_families (user_id, family_key, pattern, account, direction, dominant_type, dominant_confidence, occurrence_count)
       VALUES ${values.join(", ")}
       ON CONFLICT (user_id, family_key) DO UPDATE SET
         dominant_type = EXCLUDED.dominant_type,
         dominant_confidence = EXCLUDED.dominant_confidence,
         occurrence_count = EXCLUDED.occurrence_count,
         updated_at = NOW()`,
      params,
    )
  }
}

// ─── Step 8: LLM assist ────────────────────────────────────────────

type LlmClassResult = { index: number; movement_type: string; confidence: number }

async function llmClassifyBatch(
  unclassified: Array<{ movement: CanonicalMovement; identity: MovementIdentityEntry | null }>
): Promise<LlmClassResult[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || unclassified.length === 0) return []

  const results: LlmClassResult[] = []
  const batchSize = 40

  for (let i = 0; i < unclassified.length; i += batchSize) {
    const batch = unclassified.slice(i, i + batchSize)
    const numbered = batch.map(({ movement: m, identity }, idx) => {
      const cp = m.counterparty ?? "unknown"
      const roleTag = identity ? ` (${identity.role})` : ""
      const src = m.evidence.map((e) => `${e.source}/${e.source_type}`).join(", ")
      return `${idx + 1}. [${m.direction.toUpperCase()}] $${m.amount.toFixed(2)} | ${m.raw_description ?? "(no description)"} | counterparty: ${cp}${roleTag} | source: ${src} | date: ${m.date} | account: ${m.cash_account_name ?? "unknown"}`
    }).join("\n")

    const typeList = ALL_MOVEMENT_TYPES.join(", ")

    const systemPrompt = `You classify cash movements for a small business. For each record, determine the movement_type.

Types: ${typeList}

Non-P&L types (not operational cash activity):
- internal_transfer: own-account-to-own-account
- processor_payout: payment processor settlement → bank (e.g. ACH credit from processor)
- processor_fee_settlement: processor fees, platform charges
- credit_card_payment: CC bill payments
- loan_funding: loan draws, credit line advances
- loan_principal_payment: loan repayments
- owner_contribution: owner capital infusion
- owner_draw: owner distributions, personal
- account_verification: micro-deposits, test transactions
- opening_balance: initial balance
- balance_adjustment: reconciliation adjustments
- merchant_deposit_resolved: confirmed recurring merchant/card settlement family

P&L types (operational):
- cash_in_customer: customer payments, sales receipts
- cash_out_vendor: vendor payments, supplier costs
- cash_out_operating_expense: general operating expenses
- cash_out_refund / cash_in_refund: refunds, chargebacks
- cash_in_interest / cash_out_interest: interest
- cash_out_bank_fee: bank service fees
- bank_fee_refund: refund/reversal of a bank fee (contra-fee, not expense)
- cash_out_payroll: employee compensation
- cash_out_tax: tax payments

Provisional (low certainty but directional):
- merchant_deposit_unresolved: recurring merchant/card deposit, likely settlement, but counterparty unknown
- owner_contribution_candidate: inflow that may be owner capital, but not confirmed

IMPORTANT: "MERCHANT BANKCD/DEPOSIT" or "BANKCD DEPOSIT" descriptors are merchant settlements, NOT owner contributions.

Fallback:
- unknown_inflow / unknown_outflow / unknown_transfer_candidate

The counterparty role in parentheses (if present) is a strong signal from the identity graph.

Return a JSON array. Each element: {"index": 1, "movement_type": "...", "confidence": 0.0-1.0}
Output ONLY valid JSON array. No markdown.`

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Classify these cash movements:\n${numbered}` },
          ],
          max_tokens: 2048,
          temperature: 0.05,
        }),
      })

      if (!res.ok) {
        log("movements.llm_classify.error", { status: res.status, batch: i }, "movements")
        continue
      }

      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content ?? ""
      const jsonStr = content.replace(/```json?\s*/gi, "").replace(/```/g, "").trim()
      const parsed = JSON.parse(jsonStr) as Array<{ index: number; movement_type: string; confidence: number }>

      if (Array.isArray(parsed)) {
        for (const p of parsed) {
          const validType = (ALL_MOVEMENT_TYPES as readonly string[]).includes(p.movement_type) ? p.movement_type : null
          if (validType) {
            results.push({
              index: (i + p.index - 1),
              movement_type: validType,
              confidence: Math.min(1, Math.max(0, p.confidence ?? 0.5)),
            })
          }
        }
      }
      log("movements.llm_classify.batch_done", { batch: i, count: parsed.length }, "movements")
    } catch (err) {
      log("movements.llm_classify.parse_error", { batch: i, error: err instanceof Error ? err.message : String(err) }, "movements")
    }
  }

  return results
}

// ─── Main classify function ────────────────────────────────────────

export async function classifyMovements(userId: string): Promise<{
  total_observations: number
  zero_dollar_skipped: number
  canonical_movements: number
  coalesced_count: number
  rule_classified: number
  provisional_classified: number
  family_upgraded: number
  llm_classified: number
  identity_resolved: number
  transfers_paired: number
  pnl_eligible: number
  review_needed: number
  by_type: Record<string, number>
  by_provenance: Record<string, number>
}> {
  await ensureMovementsSchema()
  await ensurePlaidSchema()

  const stats = {
    total_observations: 0, zero_dollar_skipped: 0,
    canonical_movements: 0, coalesced_count: 0,
    rule_classified: 0, provisional_classified: 0, family_upgraded: 0, llm_classified: 0,
    identity_resolved: 0, transfers_paired: 0, pnl_eligible: 0, review_needed: 0,
    by_type: {} as Record<string, number>,
    by_provenance: {} as Record<string, number>,
  }

  log("movements.classify.start", { userId }, "movements")

  // Step 1: Extract source observations
  const [plaidObs, qboObs, stripeObs, xeroObs] = await Promise.all([
    extractPlaidObservations(userId),
    extractQboObservations(userId),
    extractStripeObservations(userId),
    extractXeroObservations(userId),
  ])

  const allObs = [...plaidObs, ...qboObs, ...stripeObs, ...xeroObs]
  stats.total_observations = allObs.length

  log("movements.classify.extracted", {
    userId, plaid: plaidObs.length, qbo: qboObs.length, stripe: stripeObs.length, xero: xeroObs.length, total: allObs.length,
  }, "movements")

  if (allObs.length === 0) {
    log("movements.classify.done", { userId, ...stats }, "movements")
    return stats
  }

  // Step 2a: Build identity context + self context (for owner detection)
  let identityCtx = await buildMovementIdentityContext(userId)
  if (identityCtx.size === 0) {
    log("movements.classify.identity_empty_seeding", { userId }, "movements")
    await seedIdentityGraph(userId)
    identityCtx = await buildMovementIdentityContext(userId)
  }
  const selfCtx = await getSelfContext(userId)

  // Build prefix index for fast fuzzy identity lookups
  const prefixIdx = buildPrefixIndex(identityCtx)

  // Step 2b: Coalesce cross-source observations into canonical movements
  let movements = coalesceObservations(allObs)
  stats.zero_dollar_skipped = allObs.filter((o) => Math.abs(o.amount) < 0.01).length
  stats.coalesced_count = movements.filter((m) => m.provenance === "coalesced").length

  // Get own Plaid account IDs for transfer pairing
  const { rows: ownAccts } = await query<{ account_id: string }>(
    `SELECT pa.account_id FROM plaid_accounts pa
     JOIN plaid_items pi ON pi.item_id = pa.item_id
     WHERE pi.user_id = $1`,
    [userId]
  )
  const ownAccountIds = new Set(ownAccts.map((a) => a.account_id))

  // Step 2c: Pair Plaid cross-account transfers
  movements = pairPlaidTransfers(movements, ownAccountIds)
  stats.transfers_paired = movements.filter((m) => m.metadata.transfer_type === "cross_account").length

  stats.canonical_movements = movements.length

  // Step 3: Resolve accounts
  resolveAccounts(movements, identityCtx)

  // Step 4: Resolve counterparty identity
  for (const m of movements) {
    const entry = resolveCounterpartyIdentity(m, identityCtx, prefixIdx)
    if (entry) {
      m.counterparty_entity_id = entry.entity_id
      m.counterparty_entity_type = entry.role
      m.counterparty = m.counterparty ?? entry.canonical_name
      stats.identity_resolved++
    }
  }

  log("movements.classify.prepared", {
    userId,
    observations: stats.total_observations,
    canonical: stats.canonical_movements,
    identityResolved: stats.identity_resolved,
    transfersPaired: stats.transfers_paired,
    identityContextSize: identityCtx.size,
  }, "movements")

  // Steps 5-7: Classify
  const classified: ClassifiedMovement[] = []
  const needsLlm: Array<{ idx: number; movement: CanonicalMovement; identity: MovementIdentityEntry | null }> = []

  for (const m of movements) {
    const identity = m.counterparty_entity_id ? resolveCounterpartyIdentity(m, identityCtx, prefixIdx) : null
    const sa = sourceAgreementScore(m.evidence)

    // Step 5: Non-P&L first
    const nonPnl = classifyNonPnl(m, identity, selfCtx)
    if (nonPnl) {
      const conf = computeConfidence({ ...nonPnl.signals, source_agreement: sa })
      const reasons: string[] = []
      if (conf.score < 0.55) reasons.push("low_classification_confidence")
      if (conf.evidence_strength < 0.20) reasons.push("low_evidence")
      classified.push({
        ...m,
        movement_type: nonPnl.type,
        pnl_eligible: false,
        confidence: conf,
        review_needed: reasons.length > 0,
        review_reasons: reasons,
        currency: "USD",
        coalesced_group_id: m.provenance === "coalesced" ? m.evidence.map((e) => e.source_id).sort().join(":") : null,
      })
      stats.rule_classified++
      continue
    }

    // Step 6: Operating
    const operating = classifyOperating(m, identity)
    if (operating) {
      const conf = computeConfidence({ ...operating.signals, source_agreement: sa })
      const reasons: string[] = []
      if (conf.score < 0.55) reasons.push("low_classification_confidence")
      if (conf.evidence_strength < 0.20) reasons.push("low_evidence")
      classified.push({
        ...m,
        movement_type: operating.type,
        pnl_eligible: isPnlEligible(operating.type),
        confidence: conf,
        review_needed: reasons.length > 0,
        review_reasons: reasons,
        currency: "USD",
        coalesced_group_id: m.provenance === "coalesced" ? m.evidence.map((e) => e.source_id).sort().join(":") : null,
      })
      stats.rule_classified++
      continue
    }

    // Step 6b: Provisional classes
    const provisional = classifyProvisional(m, identity)
    if (provisional) {
      const conf = computeConfidence({ ...provisional.signals, source_agreement: sa })
      const reasons: string[] = ["provisional_classification"]
      if (conf.score < 0.55) reasons.push("low_classification_confidence")
      if (conf.evidence_strength < 0.20) reasons.push("low_evidence")
      classified.push({
        ...m,
        movement_type: provisional.type,
        pnl_eligible: isPnlEligible(provisional.type),
        confidence: conf,
        review_needed: true,
        review_reasons: reasons,
        currency: "USD",
        coalesced_group_id: m.provenance === "coalesced" ? m.evidence.map((e) => e.source_id).sort().join(":") : null,
      })
      stats.provisional_classified++
      continue
    }

    // Step 7: Fallback (but also queue for LLM if we have API key)
    const fallback = classifyFallback(m)
    const conf = computeConfidence({ ...fallback.signals, source_agreement: sa })
    const reasons: string[] = ["low_classification_confidence"]
    if (conf.evidence_strength < 0.20) reasons.push("low_evidence")
    needsLlm.push({ idx: classified.length, movement: m, identity })
    classified.push({
      ...m,
      movement_type: fallback.type,
      pnl_eligible: false,
      confidence: conf,
      review_needed: true,
      review_reasons: reasons,
      currency: "USD",
      coalesced_group_id: m.provenance === "coalesced" ? m.evidence.map((e) => e.source_id).sort().join(":") : null,
    })
  }

  // Step 8: LLM assist — upgrade fallback classifications
  if (needsLlm.length > 0) {
    const llmResults = await llmClassifyBatch(needsLlm.map((n) => ({ movement: n.movement, identity: n.identity })))

    for (const llmResult of llmResults) {
      const globalIdx = llmResult.index
      if (globalIdx < 0 || globalIdx >= needsLlm.length) continue
      const target = needsLlm[globalIdx]
      if (llmResult.confidence > classified[target.idx].confidence.score) {
        const t = llmResult.movement_type as MovementType
        classified[target.idx].movement_type = t
        classified[target.idx].pnl_eligible = isPnlEligible(t)
        classified[target.idx].confidence = computeConfidence({
          ...classified[target.idx].confidence,
          pattern_strength: llmResult.confidence,
        })
        const newReasons: string[] = ["llm_fallback"]
        if (classified[target.idx].confidence.score < 0.55) newReasons.push("low_classification_confidence")
        if (classified[target.idx].confidence.evidence_strength < 0.20) newReasons.push("low_evidence")
        classified[target.idx].review_reasons = newReasons
        classified[target.idx].review_needed = classified[target.idx].confidence.score < 0.55
        stats.llm_classified++
      }
    }
  }

  // Step 7b: Family-level learning — upgrade low-confidence items from recurring patterns
  const families = buildFamilies(classified)
  stats.family_upgraded = applyFamilyLearning(classified, families)

  // Step 8b: Direction/type consistency validation
  const INFLOW_TYPES = new Set<string>([
    "cash_in_customer", "cash_in_refund", "cash_in_interest", "bank_fee_refund",
    "loan_funding", "owner_contribution", "owner_contribution_candidate",
    "merchant_deposit_unresolved", "merchant_deposit_resolved", "unknown_inflow",
  ])
  const OUTFLOW_TYPES = new Set<string>([
    "cash_out_vendor", "cash_out_operating_expense", "cash_out_refund",
    "cash_out_bank_fee", "cash_out_payroll", "cash_out_tax", "cash_out_interest",
    "credit_card_payment", "loan_principal_payment", "owner_draw", "unknown_outflow",
  ])
  // Types that can be either direction: internal_transfer, processor_payout,
  // processor_fee_settlement, account_verification, opening_balance,
  // balance_adjustment, other_operating, unknown_transfer_candidate

  for (const c of classified) {
    const isInflow = c.direction === "inflow"
    if ((isInflow && OUTFLOW_TYPES.has(c.movement_type)) || (!isInflow && INFLOW_TYPES.has(c.movement_type))) {
      c.review_needed = true
      if (!c.review_reasons.includes("direction_type_mismatch")) {
        c.review_reasons.push("direction_type_mismatch")
      }
      c.confidence = computeConfidence({
        ...c.confidence,
        pattern_strength: Math.min(c.confidence.pattern_strength, 0.3),
        directional_consistency: 0.1,
      })
      log("movements.classify.direction_mismatch", {
        type: c.movement_type, direction: c.direction, amount: c.amount, counterparty: c.counterparty,
      }, "movements")
    }
  }

  // Count stats
  for (const c of classified) {
    stats.by_type[c.movement_type] = (stats.by_type[c.movement_type] ?? 0) + 1
    stats.by_provenance[c.provenance] = (stats.by_provenance[c.provenance] ?? 0) + 1
    if (c.pnl_eligible) stats.pnl_eligible++
    if (c.review_needed) stats.review_needed++
  }

  // Step 9: Persist families
  await persistFamilies(userId, families)

  // Step 9b: Cross-bucket duplicate detection (plan #8) — same event, different interpretation
  const CROSS_BUCKET_PAIRS: [string, string][] = [
    ["cash_out_vendor", "credit_card_payment"],
    ["cash_out_operating_expense", "credit_card_payment"],
    ["owner_contribution", "merchant_deposit_resolved"],
    ["owner_contribution", "merchant_deposit_unresolved"],
  ]
  const pairSet = new Set<string>()
  for (const [a, b] of CROSS_BUCKET_PAIRS) {
    pairSet.add(`${a}:${b}`)
    pairSet.add(`${b}:${a}`)
  }
  const duplicateIndices = new Set<number>()
  for (let i = 0; i < classified.length; i++) {
    if (duplicateIndices.has(i)) continue
    const a = classified[i]
    const amt = a.amount.toFixed(2)
    const dateA = new Date(a.date).getTime()
    for (let j = i + 1; j < classified.length; j++) {
      if (duplicateIndices.has(j)) continue
      const b = classified[j]
      if (b.amount.toFixed(2) !== amt) continue
      const dateB = new Date(b.date).getTime()
      if (Math.abs(dateA - dateB) > 3 * 86400000) continue // within 3 days
      const key = `${a.movement_type}:${b.movement_type}`
      if (!pairSet.has(key)) continue
      const confA = a.confidence?.score ?? 0
      const confB = b.confidence?.score ?? 0
      const toRemove = confA >= confB ? j : i
      duplicateIndices.add(toRemove)
      if (toRemove === i) break
    }
  }
  const toPersist = classified.filter((_, i) => !duplicateIndices.has(i))

  // Step 10: Batch persist — two tables: movements + movement_observations
  // First delete old data for this user
  await query("DELETE FROM movements WHERE user_id = $1", [userId])

  const BATCH_SIZE = 50
  for (let i = 0; i < toPersist.length; i += BATCH_SIZE) {
    const batch = toPersist.slice(i, i + BATCH_SIZE)

    // Insert movements
    const mvtValues: string[] = []
    const mvtParams: unknown[] = []
    let mvtIdx = 0

    for (const m of batch) {
      const meta = { ...m.metadata, review_reasons: m.review_reasons }
      const offsets = Array.from({ length: 18 }, (_, k) => `$${mvtIdx + k + 1}`)
      mvtValues.push(`(${offsets.join(", ")})`)
      mvtParams.push(
        userId, m.direction, m.amount, m.date, m.movement_type, m.pnl_eligible,
        m.provenance, m.cash_account_name, m.counterparty,
        m.counterparty_entity_id, m.counterparty_entity_type,
        m.linked_internal_account_id, JSON.stringify(m.confidence),
        m.review_needed, m.raw_description, JSON.stringify(meta),
        m.currency, m.coalesced_group_id,
      )
      mvtIdx += 18
    }

    const { rows: insertedMovements } = await query<{ id: string }>(
      `INSERT INTO movements (
        user_id, direction, amount, date, movement_type, pnl_eligible,
        provenance, cash_account_id, counterparty,
        counterparty_entity_id, counterparty_entity_type,
        linked_internal_account_id, confidence,
        review_needed, raw_description, metadata,
        currency, coalesced_group_id
      )
      VALUES ${mvtValues.join(", ")}
      RETURNING id`,
      mvtParams,
    )

    // Insert observations for each movement
    const obsValues: string[] = []
    const obsParams: unknown[] = []
    let obsIdx = 0

    for (let b = 0; b < batch.length; b++) {
      const m = batch[b]
      const movementId = insertedMovements[b]?.id
      if (!movementId) continue

      for (const ev of m.evidence) {
        const offsets = Array.from({ length: 11 }, (_, k) => `$${obsIdx + k + 1}`)
        obsValues.push(`(${offsets.join(", ")})`)
        obsParams.push(
          movementId, ev.source, ev.source_type, ev.source_id,
          Math.abs(ev.amount), ev.date, ev.raw_description, ev.counterparty,
          ev.account_name, ev.account_id, JSON.stringify(ev.metadata),
        )
        obsIdx += 11
      }
    }

    if (obsValues.length > 0) {
      await query(
        `INSERT INTO movement_observations (
          movement_id, source, source_type, source_id,
          amount, date, raw_description, counterparty,
          account_name, account_id, metadata
        )
        VALUES ${obsValues.join(", ")}
        ON CONFLICT (source, source_id) DO UPDATE SET
          movement_id = EXCLUDED.movement_id,
          raw_description = EXCLUDED.raw_description,
          counterparty = EXCLUDED.counterparty`,
        obsParams,
      )
    }
  }

  log("movements.classify.done", { userId, ...stats }, "movements")
  return stats
}

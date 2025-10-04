/**
 * Money Movement Classification Engine v3.
 *
 * Outputs cash movement classifications, NOT accounting event classifications.
 *
 * Pipeline:
 *   Step 1: Extract source observations from Plaid, QBO, Stripe, Xero
 *   Step 2: Deduplicate / coalesce cross-source observations into canonical movements
 *   Step 3: Resolve accounts (source cash account, destination, internal flag)
 *   Step 4: Resolve counterparty identity (entity, entity_type, confidence)
 *   Step 5: Classify non-P&L movements first (transfers, settlements, fees, equity, financing)
 *   Step 6: Classify operating cash movements (customer, vendor, refund, interest)
 *   Step 7: Fallback to unknown_inflow / unknown_outflow / unknown_transfer_candidate
 *   Step 8: LLM assist for low-confidence
 *   Step 9: Batch persist
 */

import { query, ensureMovementsSchema } from "./db"
import { log } from "./logger"
import {
  buildMovementIdentityContext,
  seedIdentityGraph,
  type MovementIdentityContext,
  type MovementIdentityEntry,
} from "./identity-seed"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

// ─── Movement Type Taxonomy ──────────────────────────────────────────

const NON_PNL_TYPES = [
  "internal_transfer",
  "processor_payout",
  "processor_fee_settlement",
  "credit_card_payment",
  "loan_funding",
  "loan_principal_payment",
  "owner_contribution",
  "owner_draw",
  "account_verification",
  "opening_balance",
  "balance_adjustment",
] as const

const PNL_TYPES = [
  "cash_in_customer",
  "cash_out_vendor",
  "cash_out_operating_expense",
  "cash_out_refund",
  "cash_in_refund",
  "cash_in_interest",
  "cash_out_interest",
  "cash_out_bank_fee",
  "cash_out_payroll",
  "cash_out_tax",
  "other_operating",
] as const

const FALLBACK_TYPES = [
  "unknown_inflow",
  "unknown_outflow",
  "unknown_transfer_candidate",
] as const

const ALL_MOVEMENT_TYPES = [...NON_PNL_TYPES, ...PNL_TYPES, ...FALLBACK_TYPES] as const
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
  plaid_category: string[] | null
  plaid_pfc: Record<string, string> | null
  plaid_payment_channel: string | null
  metadata: Record<string, unknown>
}

type ClassifiedMovement = CanonicalMovement & {
  movement_type: MovementType
  pnl_eligible: boolean
  confidence: number
  review_needed: boolean
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
      metadata: { stripe_type: txnType, status: d.status, stripe_customer_id: d.customer ?? null },
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

const SOURCE_PRIORITY: Record<string, number> = { qbo: 4, xero: 3, stripe: 2, plaid: 1 }

function counterpartyMatchScore(a: string | null, b: string | null): number {
  if (!a || !b) return 0.5
  const na = normKey(a)
  const nb = normKey(b)
  if (na === nb) return 1.0
  if (na.length < 3 || nb.length < 3) return 0
  const shorter = na.length <= nb.length ? na : nb
  const longer = na.length > nb.length ? na : nb
  if (longer.startsWith(shorter) || longer.endsWith(shorter)) {
    return shorter.length / longer.length
  }
  return 0
}

function coalesceObservations(observations: SourceObservation[]): CanonicalMovement[] {
  // Dedup key: |amount| rounded to cents + date (narrow window)
  // Counterparty is NOT in the key — checked explicitly during pairing
  type KeyedObs = SourceObservation & { _key: string }
  const keyed: KeyedObs[] = observations.map((o) => ({
    ...o,
    _key: `${Math.abs(o.amount).toFixed(2)}|${o.date}`,
  }))

  const groups = new Map<string, KeyedObs[]>()
  for (const o of keyed) {
    const list = groups.get(o._key) ?? []
    list.push(o)
    groups.set(o._key, list)
  }

  const movements: CanonicalMovement[] = []

  for (const [, group] of groups) {
    if (group.length === 1) {
      movements.push(obsToCanonical([group[0]]))
      continue
    }

    // Within same source, always keep each as separate movement
    const bySource = new Map<string, KeyedObs[]>()
    for (const o of group) {
      const list = bySource.get(o.source) ?? []
      list.push(o)
      bySource.set(o.source, list)
    }

    if (bySource.size === 1) {
      for (const o of group) {
        movements.push(obsToCanonical([o]))
      }
      continue
    }

    // Cross-source: attempt to pair observations that describe the same cash event
    group.sort((a, b) => (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0))

    const used = new Set<number>()
    for (let i = 0; i < group.length; i++) {
      if (used.has(i)) continue
      const primary = group[i]
      const evidenceGroup = [primary]
      used.add(i)

      for (let j = i + 1; j < group.length; j++) {
        if (used.has(j)) continue
        const candidate = group[j]
        if (candidate.source === primary.source) continue
        if (Math.sign(candidate.amount) !== Math.sign(primary.amount)) continue

        // Require counterparty similarity OR at least one side has no counterparty
        const cpScore = counterpartyMatchScore(primary.counterparty, candidate.counterparty)
        const eitherBlank = !primary.counterparty || !candidate.counterparty
        if (cpScore < 0.5 && !eitherBlank) continue

        evidenceGroup.push(candidate)
        used.add(j)
      }

      movements.push(obsToCanonical(evidenceGroup))
    }
  }

  return movements
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

  // Merge account info
  let cashAcct = primary.account_name
  let cashAcctId = primary.account_id
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
    mergedMeta.dedup_sources = evidence.map((e) => `${e.source}:${e.source_id}`)
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
    const key = normKey(c)
    if (key.length < 2) continue

    // 1. Exact match (O(1))
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
  }

  return null
}

// ─── Step 5: Classify non-P&L movements ─────────────────────────────

function classifyNonPnl(m: CanonicalMovement, identity: MovementIdentityEntry | null): { type: MovementType; confidence: number } | null {
  const desc = (m.raw_description ?? "").toLowerCase()
  const catStr = (m.plaid_category ?? []).join(" ").toLowerCase()
  const pfcPrimary = (m.plaid_pfc?.primary ?? "").toUpperCase()
  const pfcDetailed = (m.plaid_pfc?.detailed ?? "").toUpperCase()
  const primaryObs = m.evidence[0]

  // ── Plaid personal_finance_category (high-quality signal) ──
  if (pfcPrimary === "TRANSFER_IN" || pfcPrimary === "TRANSFER_OUT") {
    if (pfcDetailed.includes("ACCOUNT_TRANSFER")) return { type: "internal_transfer", confidence: 0.9 }
    if (pfcDetailed.includes("LOAN") || pfcDetailed.includes("MORTGAGE")) {
      return m.direction === "inflow"
        ? { type: "loan_funding", confidence: 0.85 }
        : { type: "loan_principal_payment", confidence: 0.85 }
    }
    if (pfcDetailed.includes("CREDIT_CARD")) return { type: "credit_card_payment", confidence: 0.9 }
    if (pfcDetailed.includes("DEPOSIT")) return { type: "internal_transfer", confidence: 0.8 }
  }
  if (pfcPrimary === "LOAN_PAYMENTS") {
    return { type: "loan_principal_payment", confidence: 0.9 }
  }

  // ── Structural: cross-account transfer (already paired) ──
  if (m.metadata.transfer_type === "cross_account") {
    return { type: "internal_transfer", confidence: 0.95 }
  }

  // ── Structural: QBO Transfer entity ──
  if (primaryObs.source === "qbo" && primaryObs.source_type === "Transfer") {
    return { type: "internal_transfer", confidence: 0.95 }
  }

  // ── Structural: Stripe payout (processor → bank) ──
  if (primaryObs.source === "stripe" && primaryObs.source_type === "payout") {
    return { type: "processor_payout", confidence: 0.95 }
  }

  // ── Structural: Stripe balance_transaction sub-types ──
  if (primaryObs.source === "stripe" && primaryObs.source_type === "balance_transaction") {
    const sType = (m.metadata.stripe_type ?? "") as string
    if (sType === "stripe_fee" || sType === "fee") return { type: "processor_fee_settlement", confidence: 0.95 }
    if (sType === "payout") return { type: "processor_payout", confidence: 0.9 }
  }

  // ── Verification deposits (tiny amounts ≤ $1, verification description) ──
  if (m.amount <= 1.0 && VERIFICATION_PATTERNS.some((p) => p.test(desc))) {
    return { type: "account_verification", confidence: 0.9 }
  }
  if (m.amount <= 0.50 && catStr.includes("bank fees")) {
    return { type: "account_verification", confidence: 0.85 }
  }

  // ── Opening balance ──
  if (OPENING_BALANCE_PATTERNS.some((p) => p.test(desc))) {
    return { type: "opening_balance", confidence: 0.85 }
  }

  // ── Credit card payments ──
  if (CC_PAYMENT_PATTERNS.some((p) => p.test(desc))) {
    return { type: "credit_card_payment", confidence: 0.85 }
  }
  if (identity?.role === "processor" && CC_PAYMENT_PATTERNS.some((p) => p.test(m.counterparty ?? ""))) {
    return { type: "credit_card_payment", confidence: 0.85 }
  }

  // ── Owner draw / contribution ──
  if (OWNER_CONTRIBUTION_PATTERNS.some((p) => p.test(desc))) {
    return { type: "owner_contribution", confidence: 0.85 }
  }
  if (OWNER_PATTERNS.some((p) => p.test(desc))) {
    return { type: "owner_draw", confidence: 0.85 }
  }
  if (identity?.role === "owner") {
    return m.direction === "inflow"
      ? { type: "owner_contribution", confidence: Math.min(0.88, identity.confidence) }
      : { type: "owner_draw", confidence: Math.min(0.88, identity.confidence) }
  }

  // ── Loan / financing ──
  if (LOAN_PATTERNS.some((p) => p.test(desc))) {
    return m.direction === "inflow"
      ? { type: "loan_funding", confidence: 0.8 }
      : { type: "loan_principal_payment", confidence: 0.8 }
  }
  if (catStr.includes("loan")) {
    return m.direction === "inflow"
      ? { type: "loan_funding", confidence: 0.75 }
      : { type: "loan_principal_payment", confidence: 0.75 }
  }
  if (identity?.role === "lender") {
    return m.direction === "inflow"
      ? { type: "loan_funding", confidence: Math.min(0.85, identity.confidence) }
      : { type: "loan_principal_payment", confidence: Math.min(0.85, identity.confidence) }
  }

  // ── Transfer patterns (bank description) ──
  if (TRANSFER_PATTERNS.some((p) => p.test(desc))) {
    // Only classify as internal_transfer if identity confirms it's own account
    if (identity && (identity.role === "internal" || identity.role === "bank_account" || identity.is_own_account)) {
      return { type: "internal_transfer", confidence: 0.85 }
    }
    // Plaid transfer category + both from/to accounts known (strong internal signal)
    if (catStr.includes("transfer") && !catStr.includes("wire transfer") && m.linked_internal_account_id) {
      return { type: "internal_transfer", confidence: 0.8 }
    }
    // Without identity or linked account, do NOT force internal_transfer —
    // this could be a vendor wire, customer wire, etc. Let it fall through
    // to operating classification or fallback as unknown_transfer_candidate.
  }

  // ── Identity: processor → settlement ──
  if (identity?.role === "processor" && identity.confidence >= 0.6) {
    if (m.direction === "inflow") {
      return { type: "processor_payout", confidence: Math.min(0.88, identity.confidence) }
    }
    return { type: "processor_fee_settlement", confidence: Math.min(0.85, identity.confidence) }
  }

  // ── Identity: internal / bank_account → internal_transfer ──
  if (identity && (identity.role === "internal" || identity.role === "bank_account") && identity.confidence >= 0.6) {
    return { type: "internal_transfer", confidence: Math.min(0.88, identity.confidence) }
  }

  return null
}

// ─── Step 6: Classify operating cash movements ──────────────────────

function classifyOperating(m: CanonicalMovement, identity: MovementIdentityEntry | null): { type: MovementType; confidence: number } | null {
  const desc = (m.raw_description ?? "").toLowerCase()
  const catStr = (m.plaid_category ?? []).join(" ").toLowerCase()
  const pfcPrimary = (m.plaid_pfc?.primary ?? "").toUpperCase()
  const pfcDetailed = (m.plaid_pfc?.detailed ?? "").toUpperCase()
  const primaryObs = m.evidence[0]

  // ── Plaid personal_finance_category operating signals ──
  if (pfcPrimary === "BANK_FEES") return { type: "cash_out_bank_fee", confidence: 0.9 }
  if (pfcPrimary === "INCOME" && pfcDetailed.includes("INTEREST")) return { type: "cash_in_interest", confidence: 0.9 }
  if (pfcPrimary === "INCOME") return { type: "cash_in_customer", confidence: 0.75 }
  if (pfcDetailed.includes("TAX") || pfcPrimary === "GOVERNMENT_AND_NON_PROFIT") {
    if (TAX_PATTERNS.some((p) => p.test(desc))) return { type: "cash_out_tax", confidence: 0.9 }
  }
  if (pfcPrimary === "RENT_AND_UTILITIES" || pfcPrimary === "GENERAL_SERVICES") {
    return { type: "cash_out_operating_expense", confidence: 0.8 }
  }

  // ── Bank fees ──
  if (BANK_FEE_PATTERNS.some((p) => p.test(desc))) {
    return { type: "cash_out_bank_fee", confidence: 0.85 }
  }
  if (catStr.includes("bank fees")) {
    return { type: "cash_out_bank_fee", confidence: 0.85 }
  }

  // ── Payroll ──
  if (catStr.includes("payroll")) {
    return { type: "cash_out_payroll", confidence: 0.85 }
  }
  const cpNorm = normKey(m.counterparty ?? "")
  for (const pp of PAYROLL_PROCESSORS) {
    if (cpNorm.includes(pp.replace(/[^a-z0-9]/g, ""))) return { type: "cash_out_payroll", confidence: 0.85 }
  }
  if (identity?.role === "employee" && identity.confidence >= 0.6) {
    return { type: "cash_out_payroll", confidence: Math.min(0.88, identity.confidence) }
  }

  // ── Tax ──
  if (TAX_PATTERNS.some((p) => p.test(desc))) {
    return { type: "cash_out_tax", confidence: 0.85 }
  }
  if (catStr.includes("tax")) {
    return { type: "cash_out_tax", confidence: 0.8 }
  }
  if (identity?.role === "tax_authority" && identity.confidence >= 0.6) {
    return { type: "cash_out_tax", confidence: Math.min(0.88, identity.confidence) }
  }

  // ── Interest ──
  if (INTEREST_PATTERNS.some((p) => p.test(desc))) {
    return m.direction === "inflow"
      ? { type: "cash_in_interest", confidence: 0.8 }
      : { type: "cash_out_interest", confidence: 0.8 }
  }

  // ── Refunds ──
  if (REFUND_PATTERNS.some((p) => p.test(desc))) {
    return m.direction === "inflow"
      ? { type: "cash_in_refund", confidence: 0.8 }
      : { type: "cash_out_refund", confidence: 0.8 }
  }
  if (primaryObs.source === "qbo" && ["RefundReceipt", "CreditMemo", "VendorCredit"].includes(primaryObs.source_type)) {
    return { type: "cash_out_refund", confidence: 0.9 }
  }
  if (primaryObs.source === "xero" && primaryObs.source_type === "CreditNote") {
    return { type: "cash_out_refund", confidence: 0.9 }
  }
  if (primaryObs.source === "stripe" && primaryObs.source_type === "balance_transaction") {
    const sType = (m.metadata.stripe_type ?? "") as string
    if (sType === "refund") {
      return { type: "cash_out_refund", confidence: 0.9 }
    }
  }

  // ── Identity: customer → cash_in_customer ──
  if (identity?.role === "customer" && identity.confidence >= 0.6) {
    return { type: "cash_in_customer", confidence: Math.min(0.88, identity.confidence) }
  }

  // ── Identity: vendor → cash_out_vendor ──
  if (identity?.role === "vendor" && identity.confidence >= 0.6) {
    return { type: "cash_out_vendor", confidence: Math.min(0.88, identity.confidence) }
  }

  // ── QBO type fallback ──
  if (primaryObs.source === "qbo") {
    if (["Invoice", "SalesReceipt"].includes(primaryObs.source_type)) {
      return { type: "cash_in_customer", confidence: 0.8 }
    }
    if (primaryObs.source_type === "Payment") {
      // QBO Payment is specifically a customer payment against an invoice
      return { type: "cash_in_customer", confidence: 0.8 }
    }
    if (primaryObs.source_type === "Deposit") {
      // QBO Deposit can be mixed — only high confidence if we have a customer counterparty
      if (m.counterparty && identity?.role === "customer") {
        return { type: "cash_in_customer", confidence: 0.75 }
      }
      // Without identity, it could be owner contribution, transfer, or mixed — lower confidence
      return m.counterparty
        ? { type: "cash_in_customer", confidence: 0.6 }
        : { type: "unknown_inflow", confidence: 0.4 }
    }
    if (["Bill", "BillPayment", "Purchase"].includes(primaryObs.source_type)) {
      return { type: "cash_out_vendor", confidence: 0.75 }
    }
  }

  // ── Xero type fallback ──
  if (primaryObs.source === "xero") {
    const xeroSubType = (m.metadata.xero_sub_type ?? "") as string
    if (primaryObs.source_type === "Invoice") {
      return xeroSubType === "ACCPAY"
        ? { type: "cash_out_vendor", confidence: 0.75 }
        : { type: "cash_in_customer", confidence: 0.75 }
    }
    if (primaryObs.source_type === "Bill") return { type: "cash_out_vendor", confidence: 0.75 }
    if (primaryObs.source_type === "Payment") {
      return m.direction === "outflow"
        ? { type: "cash_out_vendor", confidence: 0.7 }
        : { type: "cash_in_customer", confidence: 0.7 }
    }
    if (primaryObs.source_type === "BankTransaction") {
      return m.direction === "inflow"
        ? { type: "cash_in_customer", confidence: 0.65 }
        : { type: "cash_out_operating_expense", confidence: 0.65 }
    }
  }

  // ── Stripe type fallback ──
  if (primaryObs.source === "stripe" && (primaryObs.source_type === "payment_intent" || primaryObs.source_type === "invoice")) {
    return { type: "cash_in_customer", confidence: 0.75 }
  }

  // ── Plaid category-based operating heuristics ──
  if (m.direction === "inflow" && catStr.includes("deposit")) {
    return { type: "cash_in_customer", confidence: 0.6 }
  }

  // ── Plaid payment_channel: "in store" or "online" strongly suggests operating ──
  if (m.plaid_payment_channel === "in store" || m.plaid_payment_channel === "online") {
    return m.direction === "inflow"
      ? { type: "cash_in_customer", confidence: 0.6 }
      : { type: "cash_out_operating_expense", confidence: 0.6 }
  }

  return null
}

// ─── Step 7: Fallback ───────────────────────────────────────────────

function classifyFallback(m: CanonicalMovement): { type: MovementType; confidence: number } {
  const desc = (m.raw_description ?? "").toLowerCase()

  // If it looks like a transfer but we couldn't confirm
  if (TRANSFER_PATTERNS.some((p) => p.test(desc))) {
    return { type: "unknown_transfer_candidate", confidence: 0.3 }
  }

  return m.direction === "inflow"
    ? { type: "unknown_inflow", confidence: 0.3 }
    : { type: "unknown_outflow", confidence: 0.3 }
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
- processor_payout: Shopify/Stripe/PayPal → bank
- processor_fee_settlement: processor fees, platform charges
- credit_card_payment: CC bill payments
- loan_funding: loan draws, credit line advances
- loan_principal_payment: loan repayments
- owner_contribution: owner capital infusion
- owner_draw: owner distributions, personal
- account_verification: micro-deposits, test transactions
- opening_balance: initial balance
- balance_adjustment: reconciliation adjustments

P&L types (operational):
- cash_in_customer: customer payments, sales receipts
- cash_out_vendor: vendor payments, supplier costs
- cash_out_operating_expense: general operating expenses
- cash_out_refund / cash_in_refund: refunds, chargebacks
- cash_in_interest / cash_out_interest: interest
- cash_out_bank_fee: bank service fees
- cash_out_payroll: employee compensation
- cash_out_tax: tax payments

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
  canonical_movements: number
  rule_classified: number
  llm_classified: number
  identity_resolved: number
  transfers_paired: number
  pnl_eligible: number
  review_needed: number
  by_type: Record<string, number>
}> {
  await ensureMovementsSchema()

  const stats = {
    total_observations: 0, canonical_movements: 0, rule_classified: 0, llm_classified: 0,
    identity_resolved: 0, transfers_paired: 0, pnl_eligible: 0, review_needed: 0,
    by_type: {} as Record<string, number>,
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

  // Step 2a: Build identity context
  let identityCtx = await buildMovementIdentityContext(userId)
  if (identityCtx.size === 0) {
    log("movements.classify.identity_empty_seeding", { userId }, "movements")
    await seedIdentityGraph(userId)
    identityCtx = await buildMovementIdentityContext(userId)
  }

  // Build prefix index for fast fuzzy identity lookups
  const prefixIdx = buildPrefixIndex(identityCtx)

  // Step 2b: Coalesce cross-source observations into canonical movements
  let movements = coalesceObservations(allObs)

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

    // Step 5: Non-P&L first
    const nonPnl = classifyNonPnl(m, identity)
    if (nonPnl) {
      classified.push({
        ...m,
        movement_type: nonPnl.type,
        pnl_eligible: false,
        confidence: nonPnl.confidence,
        review_needed: nonPnl.confidence < 0.7,
      })
      stats.rule_classified++
      continue
    }

    // Step 6: Operating
    const operating = classifyOperating(m, identity)
    if (operating) {
      classified.push({
        ...m,
        movement_type: operating.type,
        pnl_eligible: isPnlEligible(operating.type),
        confidence: operating.confidence,
        review_needed: operating.confidence < 0.7,
      })
      stats.rule_classified++
      continue
    }

    // Step 7: Fallback (but also queue for LLM if we have API key)
    const fallback = classifyFallback(m)
    needsLlm.push({ idx: classified.length, movement: m, identity })
    classified.push({
      ...m,
      movement_type: fallback.type,
      pnl_eligible: false,
      confidence: fallback.confidence,
      review_needed: true,
    })
  }

  // Step 8: LLM assist — upgrade fallback classifications
  if (needsLlm.length > 0) {
    const llmResults = await llmClassifyBatch(needsLlm.map((n) => ({ movement: n.movement, identity: n.identity })))

    for (const llmResult of llmResults) {
      const globalIdx = llmResult.index
      if (globalIdx < 0 || globalIdx >= needsLlm.length) continue
      const target = needsLlm[globalIdx]
      if (llmResult.confidence > classified[target.idx].confidence) {
        const t = llmResult.movement_type as MovementType
        classified[target.idx].movement_type = t
        classified[target.idx].pnl_eligible = isPnlEligible(t)
        classified[target.idx].confidence = llmResult.confidence
        classified[target.idx].review_needed = llmResult.confidence < 0.7
        stats.llm_classified++
      }
    }
  }

  // Step 8b: Direction/type consistency validation
  const INFLOW_TYPES = new Set<string>([
    "cash_in_customer", "cash_in_refund", "cash_in_interest",
    "loan_funding", "owner_contribution", "unknown_inflow",
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
    if (isInflow && OUTFLOW_TYPES.has(c.movement_type)) {
      // Direction contradicts type — flag for review, downgrade confidence
      c.review_needed = true
      c.confidence = Math.min(c.confidence, 0.5)
      log("movements.classify.direction_mismatch", {
        type: c.movement_type, direction: c.direction, amount: c.amount,
        counterparty: c.counterparty,
      }, "movements")
    } else if (!isInflow && INFLOW_TYPES.has(c.movement_type)) {
      c.review_needed = true
      c.confidence = Math.min(c.confidence, 0.5)
      log("movements.classify.direction_mismatch", {
        type: c.movement_type, direction: c.direction, amount: c.amount,
        counterparty: c.counterparty,
      }, "movements")
    }
  }

  // Count stats
  for (const c of classified) {
    stats.by_type[c.movement_type] = (stats.by_type[c.movement_type] ?? 0) + 1
    if (c.pnl_eligible) stats.pnl_eligible++
    if (c.review_needed) stats.review_needed++
  }

  // Step 9: Batch persist
  const BATCH_SIZE = 50
  for (let i = 0; i < classified.length; i += BATCH_SIZE) {
    const batch = classified.slice(i, i + BATCH_SIZE)

    const values: string[] = []
    const params: unknown[] = []
    let paramIdx = 0

    for (const m of batch) {
      const evidenceRefs = JSON.stringify(m.evidence.map((e) => ({ source: e.source, source_type: e.source_type, source_id: e.source_id })))
      // Deterministic hash: sorted source:source_id pairs
      const evidenceHash = m.evidence.map((e) => `${e.source}:${e.source_id}`).sort().join("|")

      const offsets = Array.from({ length: 17 }, (_, k) => `$${paramIdx + k + 1}`)
      values.push(`(${offsets.join(", ")})`)
      params.push(
        userId,
        m.direction,
        m.amount,
        m.date,
        m.movement_type,
        m.pnl_eligible,
        m.cash_account_name,
        m.counterparty,
        m.counterparty_entity_id,
        m.counterparty_entity_type,
        m.linked_internal_account_id,
        m.confidence,
        m.review_needed,
        evidenceHash,
        evidenceRefs,
        m.raw_description,
        JSON.stringify(m.metadata),
      )
      paramIdx += 17
    }

    await query(
      `INSERT INTO movements (
        user_id, direction, amount, date, movement_type, pnl_eligible,
        cash_account_id, counterparty, counterparty_entity_id, counterparty_entity_type,
        linked_internal_account_id, confidence, review_needed, evidence_hash, evidence_refs,
        raw_description, metadata
      )
      VALUES ${values.join(", ")}
      ON CONFLICT (user_id, evidence_hash) DO UPDATE SET
        movement_type = EXCLUDED.movement_type,
        pnl_eligible = EXCLUDED.pnl_eligible,
        counterparty = EXCLUDED.counterparty,
        counterparty_entity_id = EXCLUDED.counterparty_entity_id,
        counterparty_entity_type = EXCLUDED.counterparty_entity_type,
        confidence = EXCLUDED.confidence,
        review_needed = EXCLUDED.review_needed,
        evidence_refs = EXCLUDED.evidence_refs,
        metadata = EXCLUDED.metadata`,
      params,
    )
  }

  log("movements.classify.done", { userId, ...stats }, "movements")
  return stats
}

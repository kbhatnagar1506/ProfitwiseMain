/**
 * Money Movement Classification Engine.
 *
 * Determines what each financial record actually is before any P&L categorization.
 * Phase 1: Rule-based classification (deterministic, no LLM)
 * Phase 2: LLM fallback for ambiguous records
 * Phase 3: P&L eligibility gate
 */

import { query, ensureMovementsSchema } from "./db"
import { log } from "./logger"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

// ─── Types ─────────────────────────────────────────────────────────

const MOVEMENT_CLASSES = [
  "operating_revenue",
  "operating_expense",
  "internal_transfer",
  "settlement",
  "fee",
  "refund",
  "financing",
  "payroll",
  "tax",
  "owner_draw",
  "uncategorized",
  "unresolved_inflow",
  "unresolved_outflow",
  "owner_related_candidate",
  "funding_candidate",
  "transfer_candidate",
] as const
type MovementClass = (typeof MOVEMENT_CLASSES)[number]

const PNL_ELIGIBLE_CLASSES = new Set<MovementClass>([
  "operating_revenue",
  "operating_expense",
  "payroll",
  "tax",
])

type RawMovement = {
  source: "plaid" | "qbo" | "stripe"
  source_type: string
  source_id: string
  date: string
  amount: number
  raw_description: string | null
  counterparty: string | null
  entity_id: string | null
  entity_type: string | null
  from_account: string | null
  to_account: string | null
  plaid_category: string[] | null
  metadata: Record<string, unknown>
}

type ClassifiedMovement = RawMovement & {
  event_id: string
  movement_class: MovementClass
  pnl_eligible: boolean
  statement_impact: string | null
  movement_subclass: string | null
  confidence: number
}

type EventCluster = {
  id: string
  movements: RawMovement[]
}

function groupMovementsIntoEvents(movements: RawMovement[]): EventCluster[] {
  const clusters: EventCluster[] = []
  const used = new Set<number>()

  const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")

  for (let i = 0; i < movements.length; i++) {
    if (used.has(i)) continue
    const m = movements[i]
    const cluster: RawMovement[] = [m]
    used.add(i)

    const date = new Date(m.date)
    const amt = Math.abs(m.amount)
    const cp = norm(m.counterparty)
    const desc = norm(m.raw_description)

    for (let j = i + 1; j < movements.length; j++) {
      if (used.has(j)) continue
      const n = movements[j]
      if (Math.abs(Math.abs(n.amount) - amt) > 0.01) continue

      const d2 = new Date(n.date)
      const diffDays = Math.abs((d2.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
      if (diffDays > 1) continue

      const cp2 = norm(n.counterparty)
      const desc2 = norm(n.raw_description)
      const exactMatch = (cp && cp2 && (cp === cp2 || cp.includes(cp2) || cp2.includes(cp))) ||
        (desc && desc2 && (desc === desc2 || desc.includes(desc2) || desc2.includes(desc)))
      const overlapMatch = desc && desc2 && desc.length >= 6 && desc2.length >= 6 &&
        (desc2.includes(desc.substring(0, 6)) || desc.includes(desc2.substring(0, 6)))
      if (!exactMatch && !overlapMatch) continue

      cluster.push(n)
      used.add(j)
    }

    clusters.push({ id: crypto.randomUUID(), movements: cluster })
  }

  return clusters
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

const FEE_PATTERNS = [
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

const FINANCING_PATTERNS = [
  /\bloan (payment|draw|advance|repay)/i,
  /\bcredit line\b/i,
  /\bline of credit\b/i,
  /\bsba\b/i,
  /\bmortgage\b/i,
  /\binterest (payment|charge)\b/i,
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

const ZELLE_TRANSFER_PATTERNS = [
  /acct-to-acct transfer/i,
  /transfer credit/i,
  /money move/i,
  /zelle/i,
  /miscellaneous (credit|debit).*transfer/i,
]

const OPENING_BALANCE_PATTERNS = [
  /opening balance/i,
  /created by qb online to adjust balance/i,
  /adjust balance for deletion/i,
]

const LIABILITY_PAYMENT_PATTERNS = [
  /payment thank you/i,
  /chase credit crd/i,
  /chase credit card/i,
  /\bepay\b/i,
]

const PLATFORM_SUBSCRIPTION_PATTERNS = [
  /intuit\s*\*qbooks/i,
  /qbooks online/i,
  /google\s*\*workspace/i,
  /zapier\.com/i,
  /docusign/i,
  /amazon\.com/i,
  /amazon mktpl/i,
]

// ─── Phase 1: Extract raw movements from all sources ───────────────

async function extractPlaidMovements(userId: string): Promise<RawMovement[]> {
  const movements: RawMovement[] = []

  const { rows: userAccountIds } = await query<{ account_id: string; name: string | null }>(
    `SELECT pa.account_id, pa.name FROM plaid_accounts pa
     JOIN plaid_items pi ON pi.item_id = pa.item_id
     WHERE pi.user_id = $1`,
    [userId]
  )
  const ownAccountIds = new Set(userAccountIds.map((a) => a.account_id))
  const accountNames = new Map(userAccountIds.map((a) => [a.account_id, a.name ?? a.account_id]))

  const { rows: txns } = await query<{
    transaction_id: string
    account_id: string
    amount: string
    date: string
    name: string | null
    merchant_name: string | null
    category: string[] | null
    pending: boolean
  }>(
    `SELECT pt.transaction_id, pt.account_id, pt.amount, pt.date, pt.name, pt.merchant_name, pt.category, pt.pending
     FROM plaid_transactions pt
     JOIN plaid_items pi ON pi.item_id = pt.item_id
     WHERE pi.user_id = $1 AND pt.pending = false`,
    [userId]
  )

  for (const tx of txns) {
    const desc = tx.merchant_name?.trim() || tx.name?.trim() || null
    const amt = -parseFloat(tx.amount)

    movements.push({
      source: "plaid",
      source_type: "transaction",
      source_id: tx.transaction_id,
      date: tx.date,
      amount: amt,
      raw_description: desc,
      counterparty: null,
      entity_id: null,
      entity_type: null,
      from_account: amt < 0 ? (accountNames.get(tx.account_id) ?? tx.account_id) : null,
      to_account: amt >= 0 ? (accountNames.get(tx.account_id) ?? tx.account_id) : null,
      plaid_category: tx.category,
      metadata: { account_id: tx.account_id, own_account: ownAccountIds.has(tx.account_id) },
    })
  }

  return movements
}

async function extractQboMovements(userId: string): Promise<RawMovement[]> {
  const movements: RawMovement[] = []

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

    let amount = total
    const isInflow = ["Invoice", "Payment", "SalesReceipt", "Deposit", "CreditMemo"].includes(row.entity_type)
    if (!isInflow) amount = -amount

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

    movements.push({
      source: "qbo",
      source_type: row.entity_type,
      source_id: row.entity_id,
      date: txnDate ? txnDate.split("T")[0] : "1970-01-01",
      amount,
      raw_description: memo || counterparty || row.entity_type,
      counterparty,
      entity_id: null,
      entity_type: null,
      from_account: fromAcct,
      to_account: toAcct,
      plaid_category: null,
      metadata: { qbo_type: row.entity_type, doc_number: docNumber },
    })
  }

  return movements
}

async function extractStripeMovements(userId: string): Promise<RawMovement[]> {
  const movements: RawMovement[] = []

  const STRIPE_TXN_TYPES = ["payment_intent", "payout", "balance_transaction", "invoice"]

  const { rows } = await query<{ entity_type: string; entity_id: string; data: Record<string, unknown> }>(
    `SELECT entity_type, entity_id, data FROM stripe_entities
     WHERE user_id = $1 AND entity_type = ANY($2)`,
    [userId, STRIPE_TXN_TYPES]
  )

  for (const row of rows) {
    const d = row.data
    let amount = parseFloat(String(d.amount ?? d.amount_paid ?? 0)) / 100
    const created = d.created ? new Date(Number(d.created) * 1000).toISOString().split("T")[0] : "1970-01-01"

    let counterparty: string | null = null
    let desc: string | null = String(d.description ?? d.statement_descriptor ?? "")
    if (!desc) desc = null

    if (row.entity_type === "payout") {
      amount = parseFloat(String(d.amount ?? 0)) / 100
    } else if (row.entity_type === "balance_transaction") {
      amount = parseFloat(String(d.net ?? d.amount ?? 0)) / 100
    }

    if (d.customer && typeof d.customer === "string") {
      counterparty = d.customer
    }

    const txnType = (d.type ?? row.entity_type) as string

    movements.push({
      source: "stripe",
      source_type: row.entity_type,
      source_id: row.entity_id,
      date: created,
      amount,
      raw_description: desc,
      counterparty,
      entity_id: null,
      entity_type: null,
      from_account: null,
      to_account: null,
      plaid_category: null,
      metadata: { stripe_type: txnType, status: d.status },
    })
  }

  return movements
}

// ─── Phase 2: Link to identity layer ───────────────────────────────

async function linkToIdentities(
  movements: RawMovement[],
  userId: string
): Promise<void> {
  const { rows: entities } = await query<{
    id: string; canonical_name: string; entity_type: string
  }>(
    "SELECT id, canonical_name, entity_type FROM entities WHERE user_id = $1",
    [userId]
  )
  if (entities.length === 0) return

  const { rows: aliases } = await query<{ entity_id: string; alias: string; alias_type: string }>(
    `SELECT entity_id, alias, alias_type FROM entity_aliases WHERE entity_id = ANY($1)`,
    [entities.map((e) => e.id)]
  )

  const nameIndex = new Map<string, { entity_id: string; entity_type: string }>()
  for (const e of entities) {
    nameIndex.set(e.canonical_name.toLowerCase().replace(/[^a-z0-9]/g, ""), { entity_id: e.id, entity_type: e.entity_type })
  }
  for (const a of aliases) {
    if (a.alias_type === "name" || a.alias_type === "merchant_string") {
      const ent = entities.find((e) => e.id === a.entity_id)
      if (ent) {
        nameIndex.set(a.alias.toLowerCase().replace(/[^a-z0-9]/g, ""), { entity_id: ent.id, entity_type: ent.entity_type })
      }
    }
  }

  for (const m of movements) {
    if (!m.counterparty && !m.raw_description) continue
    const search = (m.counterparty ?? m.raw_description ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
    if (search.length < 2) continue

    const exact = nameIndex.get(search)
    if (exact) {
      m.entity_id = exact.entity_id
      m.entity_type = exact.entity_type
      continue
    }

    for (const [key, val] of nameIndex) {
      if (key.length >= 4 && search.length >= 4 && (key.includes(search) || search.includes(key))) {
        m.entity_id = val.entity_id
        m.entity_type = val.entity_type
        break
      }
    }
  }
}

// ─── Phase 3: Rule-based classification ────────────────────────────

type ClassifyResult = { cls: MovementClass; subclass: string | null; confidence: number }

function getStatementImpact(cls: MovementClass, subclass: string | null): string | null {
  if (cls === "operating_revenue") return "pnl_revenue"
  if (cls === "operating_expense" || cls === "payroll" || cls === "tax") return "pnl_expense"
  if (cls === "fee") return "pnl_expense"
  if (cls === "refund") return "pnl_contra_revenue"
  if (cls === "internal_transfer" || cls === "settlement") return "bs_only"
  if (cls === "financing" || subclass === "liability_settlement") return "bs_liability_settlement"
  if (cls === "owner_draw") return "bs_equity_owner"
  if (subclass === "platform_fee") return "pnl_expense"
  return null
}

function classifyByRules(m: RawMovement): ClassifyResult | null {
  const desc = (m.raw_description ?? "").toLowerCase()
  const counterparty = (m.counterparty ?? "").toLowerCase()
  const cats = m.plaid_category ?? []
  const catStr = cats.join(" ").toLowerCase()
  const hasQboInvoice = m.source === "qbo" && ["Invoice", "Payment", "SalesReceipt", "Deposit"].includes(m.source_type)

  // Micro-deposits / verification – never owner draw
  if (desc.includes("acctverify")) {
    return { cls: "uncategorized", subclass: "verification", confidence: 0.92 }
  }

  // Opening balance / setup adjustments – not expense
  if (OPENING_BALANCE_PATTERNS.some((p) => p.test(desc))) {
    return { cls: "unresolved_outflow", subclass: "setup_adjustment", confidence: 0.9 }
  }

  // Bank interest
  if (desc.includes("interest credit") || desc.includes("interest paid")) {
    return { cls: "financing", subclass: "interest_income", confidence: 0.82 }
  }

  // Zelle / Acct-to-Acct / Transfer Credit – never default to revenue without invoice
  const isZelleOrTransferLike = ZELLE_TRANSFER_PATTERNS.some((p) => p.test(desc))
  if (isZelleOrTransferLike) {
    if (m.entity_type === "customer" && hasQboInvoice) {
      return { cls: "operating_revenue", subclass: null, confidence: 0.85 }
    }
    if (m.entity_type === "vendor") {
      return { cls: "operating_expense", subclass: null, confidence: 0.85 }
    }
    if (m.entity_type === "owner" && desc.includes("zelle")) {
      return { cls: "owner_draw", subclass: null, confidence: 0.88 }
    }
    if (m.amount >= 0) return { cls: "owner_related_candidate", subclass: null, confidence: 0.5 }
    return { cls: "owner_related_candidate", subclass: null, confidence: 0.5 }
  }

  // Platform subscriptions (Intuit, Google, Zapier, etc.) – expense, not settlement
  if (PLATFORM_SUBSCRIPTION_PATTERNS.some((p) => p.test(desc))) {
    return { cls: "operating_expense", subclass: "platform_fee", confidence: 0.88 }
  }

  // Chase credit card / liability payments – liability settlement, not processor
  if (LIABILITY_PAYMENT_PATTERNS.some((p) => p.test(desc)) && /jack|rubenstein|credit crd|epay/i.test(desc)) {
    return { cls: "settlement", subclass: "liability_settlement", confidence: 0.9 }
  }

  // QBO Transfer entity type
  if (m.source === "qbo" && m.source_type === "Transfer") {
    return { cls: "internal_transfer", subclass: null, confidence: 0.96 }
  }

  // QBO RefundReceipt, CreditMemo, VendorCredit
  if (m.source === "qbo" && ["RefundReceipt", "CreditMemo", "VendorCredit"].includes(m.source_type)) {
    return { cls: "refund", subclass: null, confidence: 0.91 }
  }

  // Stripe payouts
  if (m.source === "stripe" && m.source_type === "payout") {
    return { cls: "settlement", subclass: "processor_settlement", confidence: 0.95 }
  }

  if (m.source === "stripe" && m.source_type === "balance_transaction") {
    const sType = (m.metadata.stripe_type ?? "") as string
    if (sType === "stripe_fee" || sType === "fee") return { cls: "fee", subclass: null, confidence: 0.95 }
    if (sType === "refund") return { cls: "refund", subclass: null, confidence: 0.95 }
    if (sType === "payout") return { cls: "settlement", subclass: "processor_settlement", confidence: 0.9 }
  }

  // Identity-based (before transfer heuristics)
  if (m.entity_type === "processor") return { cls: "settlement", subclass: "processor_settlement", confidence: 0.9 }
  if (m.entity_type === "employee") return { cls: "payroll", subclass: null, confidence: 0.9 }
  if (m.entity_type === "tax_authority") return { cls: "tax", subclass: null, confidence: 0.9 }
  if (m.entity_type === "lender") return { cls: "financing", subclass: null, confidence: 0.85 }
  if (m.entity_type === "internal") return { cls: "internal_transfer", subclass: null, confidence: 0.85 }

  // Conservative owner_draw: require owner + strong personal pattern
  if (m.entity_type === "owner") {
    if (desc.includes("zelle") || /chase credit crd|epay|wells fargo.*dda to dda/i.test(desc)) {
      return { cls: "owner_draw", subclass: null, confidence: 0.87 }
    }
    return { cls: "owner_related_candidate", subclass: null, confidence: 0.55 }
  }

  if (m.entity_type === "vendor") return { cls: "operating_expense", subclass: null, confidence: 0.82 }
  if (m.entity_type === "customer") return { cls: "operating_revenue", subclass: null, confidence: 0.82 }

  // Customer payments from Plaid (Pivot Culinary, Marlins, etc.) – revenue, not transfer
  if (m.source === "plaid" && m.amount > 0) {
    if (desc.includes("pivot culinary") || desc.includes("marlins") || desc.includes("troubadour") || desc.includes("performance supply")) {
      return { cls: "operating_revenue", subclass: null, confidence: 0.85 }
    }
  }

  // Vendor ACH debits (Mylk Labs, etc.) – expense, not transfer
  if (m.source === "plaid" && m.amount < 0 && desc.includes("invoices") && /mylk|barnana|spread|gnarly|think jerky|neve|cocotaps|realsy|purely|king orchards|untapped|belles/i.test(desc)) {
    return { cls: "operating_expense", subclass: null, confidence: 0.85 }
  }

  // Merchant bankcard ACH – processor settlement
  if (m.source === "plaid" && desc.includes("preauthorized ach") && desc.includes("merchant bankcd/deposit")) {
    return { cls: "settlement", subclass: "processor_settlement", confidence: 0.9 }
  }

  // Plaid category-based
  if (catStr.includes("bank fees")) return { cls: "fee", subclass: null, confidence: 0.86 }
  if (catStr.includes("payroll")) return { cls: "payroll", subclass: null, confidence: 0.85 }
  if (catStr.includes("tax")) return { cls: "tax", subclass: null, confidence: 0.8 }
  if (catStr.includes("loan")) return { cls: "financing", subclass: null, confidence: 0.8 }

  // Transfer patterns – only when NOT customer/vendor evidence
  if (catStr.includes("transfer") && !catStr.includes("wire transfer") && !m.entity_type) {
    return { cls: "internal_transfer", subclass: null, confidence: 0.78 }
  }
  if (TRANSFER_PATTERNS.some((p) => p.test(desc)) && !m.entity_type) {
    return { cls: "internal_transfer", subclass: null, confidence: 0.8 }
  }

  if (FEE_PATTERNS.some((p) => p.test(desc))) return { cls: "fee", subclass: null, confidence: 0.82 }
  if (TAX_PATTERNS.some((p) => p.test(desc))) return { cls: "tax", subclass: null, confidence: 0.8 }
  if (FINANCING_PATTERNS.some((p) => p.test(desc))) return { cls: "financing", subclass: null, confidence: 0.75 }
  if (REFUND_PATTERNS.some((p) => p.test(desc))) return { cls: "refund", subclass: null, confidence: 0.78 }

  const cpNorm = counterparty.replace(/[^a-z0-9]/g, "")
  for (const pp of PAYROLL_PROCESSORS) {
    if (cpNorm.includes(pp.replace(/[^a-z0-9]/g, ""))) return { cls: "payroll", subclass: null, confidence: 0.85 }
  }

  // QBO type fallback
  if (m.source === "qbo") {
    if (["Invoice", "Payment", "SalesReceipt", "Deposit"].includes(m.source_type)) {
      return { cls: "operating_revenue", subclass: null, confidence: 0.78 }
    }
    if (["Bill", "BillPayment", "Purchase"].includes(m.source_type)) {
      return { cls: "operating_expense", subclass: null, confidence: 0.78 }
    }
  }

  if (m.source === "stripe" && (m.source_type === "payment_intent" || m.source_type === "invoice")) {
    return { cls: "operating_revenue", subclass: null, confidence: 0.75 }
  }

  if (m.entity_type === "vendor") return { cls: "operating_expense", subclass: null, confidence: 0.68 }
  if (m.entity_type === "customer") return { cls: "operating_revenue", subclass: null, confidence: 0.68 }

  return null
}

function computeEventConfidence(
  base: number,
  hasCrossSource: boolean,
  movements: RawMovement[],
  cls: MovementClass
): number {
  let c = base
  if (hasCrossSource) c += 0.06
  const sources = new Set(movements.map((m) => m.source))
  if (sources.has("qbo") && sources.has("plaid")) c += 0.04
  const desc = (movements[0]?.raw_description ?? "").toLowerCase()
  if (desc === "deposit" || desc === "deposit deposit") c -= 0.18
  if (cls === "operating_revenue" && !movements[0]?.entity_type && desc.length < 15) c -= 0.15
  return Math.round(Math.min(0.99, Math.max(0.12, c)) * 100) / 100
}

// ─── Phase 4: LLM fallback ─────────────────────────────────────────

type LlmClassResult = {
  source_id: string
  movement_class: string
  confidence: number
}

async function llmClassifyBatch(unclassified: RawMovement[]): Promise<LlmClassResult[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || unclassified.length === 0) return []

  const results: LlmClassResult[] = []
  const batchSize = 40

  for (let i = 0; i < unclassified.length; i += batchSize) {
    const batch = unclassified.slice(i, i + batchSize)
    const numbered = batch.map((m, idx) => {
      const dir = m.amount >= 0 ? "INFLOW" : "OUTFLOW"
      return `${idx + 1}. [${dir}] $${Math.abs(m.amount).toFixed(2)} | ${m.raw_description ?? "(no description)"} | counterparty: ${m.counterparty ?? "unknown"} | source: ${m.source}/${m.source_type} | date: ${m.date}`
    }).join("\n")

    const systemPrompt = `You classify financial movements for a small business. For each record, determine the movement_class.

Classes:
- operating_revenue: customer payments, sales, invoice receipts (only when clearly a sale)
- operating_expense: vendor payments, purchases, services, supplies
- internal_transfer: own-account-to-own-account movements
- settlement: processor payouts (Shopify/Stripe/PayPal → bank)
- fee: bank fees, processor fees, service charges
- refund: returned payments, credit memos, chargebacks
- financing: loan draws/repayments, credit line activity
- payroll: employee compensation, payroll processor debits
- tax: IRS, state tax, sales tax remittance
- owner_draw: owner distributions, personal transfers (only with strong evidence)
- uncategorized: cannot determine
- unresolved_inflow: unclear inflow (Zelle, transfer-like with no invoice link)
- unresolved_outflow: unclear outflow
- owner_related_candidate: possibly owner-related, needs review
- funding_candidate: possibly funding/contribution
- transfer_candidate: possibly internal transfer

NEVER put Zelle, Acct-to-Acct Transfer, or generic "Transfer Credit" inflows into operating_revenue without a clear customer invoice. Prefer owner_related_candidate or unresolved_inflow.

Return a JSON array. Each element:
- "index": the 1-based number
- "movement_class": one of the classes above
- "confidence": 0.0-1.0

Output ONLY valid JSON array. No markdown.`

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Classify these movements:\n${numbered}` },
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
      const parsed = JSON.parse(jsonStr) as Array<{ index: number; movement_class: string; confidence: number }>

      if (Array.isArray(parsed)) {
        for (const p of parsed) {
          const idx = p.index - 1
          if (idx >= 0 && idx < batch.length) {
            results.push({
              source_id: batch[idx].source_id,
              movement_class: MOVEMENT_CLASSES.includes(p.movement_class as MovementClass) ? p.movement_class : "uncategorized",
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
  total: number
  ruleClassified: number
  llmClassified: number
  pnlEligible: number
  byClass: Record<string, number>
}> {
  await ensureMovementsSchema()

  const stats = {
    total: 0, ruleClassified: 0, llmClassified: 0, pnlEligible: 0,
    byClass: {} as Record<string, number>,
  }

  log("movements.classify.start", { userId }, "movements")

  // Extract raw movements from all sources
  const [plaidMvts, qboMvts, stripeMvts] = await Promise.all([
    extractPlaidMovements(userId),
    extractQboMovements(userId),
    extractStripeMovements(userId),
  ])

  const allMovements = [...plaidMvts, ...qboMvts, ...stripeMvts]
  stats.total = allMovements.length

  log("movements.classify.extracted", {
    userId,
    plaid: plaidMvts.length,
    qbo: qboMvts.length,
    stripe: stripeMvts.length,
    total: allMovements.length,
  }, "movements")

  if (allMovements.length === 0) {
    log("movements.classify.done", { userId, ...stats }, "movements")
    return stats
  }

  // Link to identity layer
  await linkToIdentities(allMovements, userId)

  // Group into events
  const clusters = groupMovementsIntoEvents(allMovements)

  const classified: ClassifiedMovement[] = []
  const unclassifiedEvents: EventCluster[] = []

  for (const cluster of clusters) {
    const primary =
      cluster.movements.find((m) => m.source === "qbo") ??
      cluster.movements.find((m) => m.source === "plaid") ??
      cluster.movements[0]

    const rule = classifyByRules(primary)
    if (rule) {
      const cls = rule.cls
      const pnl = PNL_ELIGIBLE_CLASSES.has(cls)
      const statementImpact = getStatementImpact(cls, rule.subclass)
      const hasCrossSource = cluster.movements.length > 1
      const confidence = computeEventConfidence(rule.confidence, hasCrossSource, cluster.movements, cls)

      for (const m of cluster.movements) {
        classified.push({
          ...m,
          event_id: cluster.id,
          movement_class: cls,
          pnl_eligible: pnl,
          statement_impact: statementImpact,
          movement_subclass: rule.subclass,
          confidence,
        })
        stats.byClass[cls] = (stats.byClass[cls] ?? 0) + 1
        if (pnl) stats.pnlEligible++
      }
      stats.ruleClassified += cluster.movements.length
    } else {
      unclassifiedEvents.push(cluster)
    }
  }

  // LLM fallback on primary movement per unclassified event
  if (unclassifiedEvents.length > 0) {
    const primaries: RawMovement[] = unclassifiedEvents.map((cluster) => {
      const p =
        cluster.movements.find((m) => m.source === "qbo") ??
        cluster.movements.find((m) => m.source === "plaid") ??
        cluster.movements[0]
      return p
    })

    const llmResults = await llmClassifyBatch(primaries)
    const llmMap = new Map(llmResults.map((r) => [r.source_id, r]))

    for (let i = 0; i < unclassifiedEvents.length; i++) {
      const cluster = unclassifiedEvents[i]
      const primary = primaries[i]
      const llmResult = llmMap.get(primary.source_id)
      const cls = (llmResult?.movement_class ?? "uncategorized") as MovementClass
      const pnl = PNL_ELIGIBLE_CLASSES.has(cls)
      const statementImpact = getStatementImpact(cls, null)
      const hasCrossSource = cluster.movements.length > 1
      const confidence = computeEventConfidence(llmResult?.confidence ?? 0.42, hasCrossSource, cluster.movements, cls)

      for (const m of cluster.movements) {
        classified.push({
          ...m,
          event_id: cluster.id,
          movement_class: cls,
          pnl_eligible: pnl,
          statement_impact: statementImpact,
          movement_subclass: null,
          confidence,
        })
        stats.byClass[cls] = (stats.byClass[cls] ?? 0) + 1
        if (pnl) stats.pnlEligible++
      }
      if (llmResult) stats.llmClassified += cluster.movements.length
    }
  }

  // Persist
  for (const m of classified) {
    await query(
      `INSERT INTO movements (user_id, event_id, source, source_type, source_id, entity_id, date, amount, raw_description, counterparty, movement_class, pnl_eligible, statement_impact, movement_subclass, from_account, to_account, confidence, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (user_id, source, source_id) DO UPDATE SET
         event_id = EXCLUDED.event_id,
         entity_id = EXCLUDED.entity_id,
         movement_class = EXCLUDED.movement_class,
         pnl_eligible = EXCLUDED.pnl_eligible,
         statement_impact = EXCLUDED.statement_impact,
         movement_subclass = EXCLUDED.movement_subclass,
         counterparty = EXCLUDED.counterparty,
         confidence = EXCLUDED.confidence,
         metadata = EXCLUDED.metadata`,
      [
        userId, m.event_id, m.source, m.source_type, m.source_id,
        m.entity_id, m.date, m.amount, m.raw_description,
        m.counterparty, m.movement_class, m.pnl_eligible,
        m.statement_impact, m.movement_subclass,
        m.from_account, m.to_account, m.confidence,
        JSON.stringify(m.metadata),
      ]
    )
  }

  log("movements.classify.done", { userId, ...stats }, "movements")
  return stats
}

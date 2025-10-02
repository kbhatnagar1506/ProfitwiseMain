/**
 * Money Movement Classification Engine v2.
 *
 * Architecture:
 *   1. Extract raw movements from Plaid, QBO, Stripe
 *   2. Normalize amounts (positive = inflow, negative = outflow)
 *   3. Build MovementIdentityContext from identity layer (clean handoff)
 *   4. Resolve counterparty → identity role for each movement
 *   5. Pair Plaid cross-account transfers
 *   6. Deduplicate across sources (same date ± 1 day, same |amount|, same counterparty)
 *   7. Three-tier classification: structural → identity → heuristic
 *   8. LLM fallback with identity role in prompt
 *   9. P&L eligibility gate
 *  10. Batch persist
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
  amount: number // positive = inflow, negative = outflow (normalized)
  raw_description: string | null
  counterparty: string | null
  entity_id: string | null
  entity_type: string | null
  from_account: string | null
  to_account: string | null
  plaid_category: string[] | null
  metadata: Record<string, unknown>
  _dedup_key?: string // for cross-source dedup
  _paired?: boolean   // true if already paired as transfer
}

type ClassifiedMovement = RawMovement & {
  movement_class: MovementClass
  pnl_eligible: boolean
  confidence: number
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

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "")
}

// ─── Phase 1: Extract raw movements (amounts normalized) ───────────

async function extractPlaidMovements(userId: string): Promise<RawMovement[]> {
  const movements: RawMovement[] = []

  const { rows: userAccounts } = await query<{ account_id: string; name: string | null }>(
    `SELECT pa.account_id, pa.name FROM plaid_accounts pa
     JOIN plaid_items pi ON pi.item_id = pa.item_id
     WHERE pi.user_id = $1`,
    [userId]
  )
  const ownAccountIds = new Set(userAccounts.map((a) => a.account_id))
  const accountNames = new Map(userAccounts.map((a) => [a.account_id, a.name ?? a.account_id]))

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
    // Plaid: positive amount = money left the account (expense), negative = money in
    // Normalize: positive = inflow, negative = outflow
    const amt = -parseFloat(tx.amount)
    const acctName = accountNames.get(tx.account_id) ?? tx.account_id

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
      from_account: amt < 0 ? acctName : null,
      to_account: amt >= 0 ? acctName : null,
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

    // Normalize: positive = inflow, negative = outflow
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

  // Pre-load Stripe customer ID → name map so we can resolve cus_ IDs
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

    // Resolve Stripe customer ID (cus_xxx) to actual name
    if (d.customer && typeof d.customer === "string") {
      counterparty = custIdToName.get(d.customer) ?? d.customer
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
      metadata: { stripe_type: txnType, status: d.status, stripe_customer_id: d.customer ?? null },
    })
  }

  return movements
}

async function extractXeroMovements(userId: string): Promise<RawMovement[]> {
  const movements: RawMovement[] = []

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

    // Normalize: Xero Invoices (ACCREC) = customer owes you = inflow
    // Bills (ACCPAY) = you owe vendor = outflow
    const xeroType = (d.Type as string) ?? row.entity_type
    const isInflow = row.entity_type === "Invoice"
      ? xeroType === "ACCREC"
      : row.entity_type === "Payment"
        ? (d.Invoice as Record<string, unknown> | undefined)?.Type === "ACCREC"
        : row.entity_type === "CreditNote"
          ? xeroType === "ACCREC"
          : false
    const amount = isInflow ? Math.abs(total) : -Math.abs(total)

    // BankTransaction has BankAccount
    let fromAcct: string | null = null
    let toAcct: string | null = null
    if (row.entity_type === "BankTransaction") {
      const bankAcct = d.BankAccount as Record<string, unknown> | undefined
      const acctName = bankAcct?.Name ? String(bankAcct.Name) : null
      if (amount < 0) fromAcct = acctName
      else toAcct = acctName
    }

    const ref = (d.Reference ?? d.InvoiceNumber ?? "") as string

    movements.push({
      source: "qbo", // stored under "qbo" source for dedup compatibility; tagged in metadata
      source_type: `xero_${row.entity_type}`,
      source_id: `xero_${row.entity_id}`,
      date: txnDate ? txnDate.split("T")[0] : "1970-01-01",
      amount,
      raw_description: ref || counterparty || row.entity_type,
      counterparty,
      entity_id: null,
      entity_type: null,
      from_account: fromAcct,
      to_account: toAcct,
      plaid_category: null,
      metadata: { xero_type: row.entity_type, xero_sub_type: xeroType, source_system: "xero" },
    })
  }

  return movements
}

// ─── Phase 2: Resolve counterparty → identity role ─────────────────

function resolveIdentity(
  m: RawMovement,
  ctx: MovementIdentityContext
): MovementIdentityEntry | null {
  const candidates: string[] = []
  if (m.counterparty) candidates.push(m.counterparty)
  if (m.raw_description && m.raw_description !== m.counterparty) candidates.push(m.raw_description)

  for (const c of candidates) {
    const key = normKey(c)
    if (key.length < 2) continue

    // Exact match
    const exact = ctx.get(key)
    if (exact) return exact

    // Substring match (both directions, min 4 chars)
    for (const [k, entry] of ctx) {
      if (k.startsWith("__")) continue // skip special keys
      if (k.length >= 4 && key.length >= 4 && (k.includes(key) || key.includes(k))) {
        return entry
      }
    }
  }

  return null
}

function resolveOwnAccount(
  accountId: string,
  ctx: MovementIdentityContext
): MovementIdentityEntry | null {
  return ctx.get(`__plaid_account__${accountId}`) ?? null
}

// ─── Phase 3: Plaid cross-account transfer pairing ─────────────────

function pairPlaidTransfers(movements: RawMovement[]): void {
  const plaidMvts = movements.filter(
    (m) => m.source === "plaid" && !m._paired
  )

  // Index by |amount| rounded to cents and date
  const byAmountDate = new Map<string, RawMovement[]>()
  for (const m of plaidMvts) {
    const absAmt = Math.abs(m.amount).toFixed(2)
    const key = `${absAmt}`
    const list = byAmountDate.get(key) ?? []
    list.push(m)
    byAmountDate.set(key, list)
  }

  for (const [, group] of byAmountDate) {
    if (group.length < 2) continue

    // Look for opposite-sign pairs on the same date (± 1 day), different accounts
    for (let i = 0; i < group.length; i++) {
      if (group[i]._paired) continue
      for (let j = i + 1; j < group.length; j++) {
        if (group[j]._paired) continue

        const a = group[i]
        const b = group[j]

        // Opposite signs
        if (Math.sign(a.amount) === Math.sign(b.amount)) continue

        // Different accounts
        const aAcct = a.metadata.account_id as string
        const bAcct = b.metadata.account_id as string
        if (aAcct === bAcct) continue

        // Both own accounts
        if (!a.metadata.own_account || !b.metadata.own_account) continue

        // Date within 1 day
        const da = new Date(a.date).getTime()
        const db = new Date(b.date).getTime()
        if (Math.abs(da - db) > 86400000) continue

        // Pair them: outflow side becomes the canonical movement, inflow is marked paired
        const outflow = a.amount < 0 ? a : b
        const inflow = a.amount < 0 ? b : a

        outflow.from_account = outflow.from_account ?? (outflow.metadata.account_id as string)
        outflow.to_account = inflow.to_account ?? (inflow.metadata.account_id as string)
        outflow.metadata = {
          ...outflow.metadata,
          paired_transaction_id: inflow.source_id,
          transfer_type: "cross_account",
        }

        inflow._paired = true
        break
      }
    }
  }
}

// ─── Phase 4: Cross-source dedup ───────────────────────────────────

function dedupAcrossSources(movements: RawMovement[]): RawMovement[] {
  // Build dedup keys: |amount| rounded, date, normalized counterparty prefix
  for (const m of movements) {
    const absAmt = Math.abs(m.amount).toFixed(2)
    const cpKey = normKey(m.counterparty ?? m.raw_description ?? "").slice(0, 12)
    m._dedup_key = `${absAmt}|${m.date}|${cpKey}`
  }

  // Source priority: qbo > stripe > plaid (QBO is richest)
  const PRIORITY: Record<string, number> = { qbo: 3, stripe: 2, plaid: 1 }

  const groups = new Map<string, RawMovement[]>()
  for (const m of movements) {
    if (m._paired) continue // skip paired inflow sides
    const key = m._dedup_key!
    const list = groups.get(key) ?? []
    list.push(m)
    groups.set(key, list)
  }

  const result: RawMovement[] = []
  for (const [, group] of groups) {
    if (group.length === 1) {
      result.push(group[0])
      continue
    }

    // Check if this group has movements from different sources with matching amounts
    const sources = new Set(group.map((m) => m.source))
    if (sources.size === 1) {
      // Same source, keep all (they're different transactions)
      result.push(...group)
      continue
    }

    // Multiple sources — keep the highest-priority one, link others in metadata
    group.sort((a, b) => (PRIORITY[b.source] ?? 0) - (PRIORITY[a.source] ?? 0))
    const primary = group[0]
    const duplicateIds = group.slice(1).map((m) => `${m.source}:${m.source_id}`)
    primary.metadata = { ...primary.metadata, dedup_linked: duplicateIds }

    // Merge counterparty from richer source if primary is missing it
    if (!primary.counterparty) {
      for (const m of group) {
        if (m.counterparty) { primary.counterparty = m.counterparty; break }
      }
    }

    result.push(primary)
  }

  return result
}

// ─── Phase 5: Three-tier classification ────────────────────────────

const ROLE_TO_CLASS: Record<string, MovementClass> = {
  processor: "settlement",
  employee: "payroll",
  tax_authority: "tax",
  owner: "owner_draw",
  lender: "financing",
  internal: "internal_transfer",
  bank_account: "internal_transfer",
  vendor: "operating_expense",
  customer: "operating_revenue",
}

function classifyMovement(
  m: RawMovement,
  identity: MovementIdentityEntry | null
): { cls: MovementClass; confidence: number } | null {
  const desc = (m.raw_description ?? "").toLowerCase()
  const cats = m.plaid_category ?? []
  const catStr = cats.join(" ").toLowerCase()

  // ── Tier 1: Structural certainties (source type is definitional) ──

  if (m.source === "qbo" && m.source_type === "Transfer") {
    return { cls: "internal_transfer", confidence: 0.95 }
  }
  if (m.source === "qbo" && ["RefundReceipt", "CreditMemo", "VendorCredit"].includes(m.source_type)) {
    return { cls: "refund", confidence: 0.9 }
  }
  // Xero CreditNote
  if (m.source_type === "xero_CreditNote") {
    return { cls: "refund", confidence: 0.9 }
  }
  if (m.source === "stripe" && m.source_type === "payout") {
    return { cls: "settlement", confidence: 0.95 }
  }
  if (m.source === "stripe" && m.source_type === "balance_transaction") {
    const sType = (m.metadata.stripe_type ?? "") as string
    if (sType === "stripe_fee" || sType === "fee") return { cls: "fee", confidence: 0.95 }
    if (sType === "refund") return { cls: "refund", confidence: 0.95 }
    if (sType === "payout") return { cls: "settlement", confidence: 0.9 }
  }
  // Already paired as cross-account transfer
  if (m.metadata.transfer_type === "cross_account") {
    return { cls: "internal_transfer", confidence: 0.95 }
  }

  // ── Tier 2: Identity-resolved (role from identity context) ────────

  if (identity && identity.confidence >= 0.6) {
    const cls = ROLE_TO_CLASS[identity.role]
    if (cls) {
      return { cls, confidence: Math.min(0.92, identity.confidence) }
    }
  }

  // ── Tier 3: Heuristics (patterns, categories, source-type fallback)

  // Plaid category
  if (catStr.includes("bank fees")) return { cls: "fee", confidence: 0.85 }
  if (catStr.includes("payroll")) return { cls: "payroll", confidence: 0.85 }
  if (catStr.includes("tax")) return { cls: "tax", confidence: 0.8 }
  if (catStr.includes("transfer") && !catStr.includes("wire transfer")) return { cls: "internal_transfer", confidence: 0.75 }
  if (catStr.includes("loan")) return { cls: "financing", confidence: 0.8 }

  // Description patterns
  if (TRANSFER_PATTERNS.some((p) => p.test(desc))) return { cls: "internal_transfer", confidence: 0.8 }
  if (FEE_PATTERNS.some((p) => p.test(desc))) return { cls: "fee", confidence: 0.8 }
  if (TAX_PATTERNS.some((p) => p.test(desc))) return { cls: "tax", confidence: 0.8 }
  if (FINANCING_PATTERNS.some((p) => p.test(desc))) return { cls: "financing", confidence: 0.75 }
  if (REFUND_PATTERNS.some((p) => p.test(desc))) return { cls: "refund", confidence: 0.75 }

  // Payroll processor name match
  const cpNorm = normKey(m.counterparty ?? "")
  for (const pp of PAYROLL_PROCESSORS) {
    if (cpNorm.includes(pp.replace(/[^a-z0-9]/g, ""))) return { cls: "payroll", confidence: 0.85 }
  }

  // QBO type fallback
  if (m.source === "qbo") {
    if (["Invoice", "Payment", "SalesReceipt", "Deposit"].includes(m.source_type)) {
      return { cls: "operating_revenue", confidence: 0.8 }
    }
    if (["Bill", "BillPayment", "Purchase"].includes(m.source_type)) {
      return { cls: "operating_expense", confidence: 0.8 }
    }
  }

  // Xero type fallback
  const xeroSubType = (m.metadata.xero_sub_type ?? "") as string
  if (m.source_type === "xero_Invoice") {
    return xeroSubType === "ACCPAY"
      ? { cls: "operating_expense", confidence: 0.8 }
      : { cls: "operating_revenue", confidence: 0.8 }
  }
  if (m.source_type === "xero_Bill") return { cls: "operating_expense", confidence: 0.8 }
  if (m.source_type === "xero_Payment") {
    return xeroSubType === "ACCPAY" || m.amount < 0
      ? { cls: "operating_expense", confidence: 0.75 }
      : { cls: "operating_revenue", confidence: 0.75 }
  }
  if (m.source_type === "xero_BankTransaction") {
    return m.amount >= 0
      ? { cls: "operating_revenue", confidence: 0.7 }
      : { cls: "operating_expense", confidence: 0.7 }
  }

  // Stripe type fallback
  if (m.source === "stripe" && (m.source_type === "payment_intent" || m.source_type === "invoice")) {
    return { cls: "operating_revenue", confidence: 0.75 }
  }

  return null
}

// ─── Phase 6: LLM fallback (with identity role in prompt) ──────────

type LlmClassResult = { source_id: string; movement_class: string; confidence: number }

async function llmClassifyBatch(
  unclassified: Array<{ movement: RawMovement; identity: MovementIdentityEntry | null }>
): Promise<LlmClassResult[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || unclassified.length === 0) return []

  const results: LlmClassResult[] = []
  const batchSize = 40

  for (let i = 0; i < unclassified.length; i += batchSize) {
    const batch = unclassified.slice(i, i + batchSize)
    const numbered = batch.map(({ movement: m, identity }, idx) => {
      const dir = m.amount >= 0 ? "INFLOW" : "OUTFLOW"
      const cp = m.counterparty ?? "unknown"
      const roleTag = identity ? ` (${identity.role})` : ""
      return `${idx + 1}. [${dir}] $${Math.abs(m.amount).toFixed(2)} | ${m.raw_description ?? "(no description)"} | counterparty: ${cp}${roleTag} | source: ${m.source}/${m.source_type} | date: ${m.date}`
    }).join("\n")

    const systemPrompt = `You classify financial movements for a small business. For each record, determine the movement_class.

Classes:
- operating_revenue: customer payments, sales, invoice receipts
- operating_expense: vendor payments, purchases, services, supplies
- internal_transfer: own-account-to-own-account movements
- settlement: processor payouts (Shopify/Stripe/PayPal → bank)
- fee: bank fees, processor fees, service charges
- refund: returned payments, credit memos, chargebacks
- financing: loan draws/repayments, credit line activity
- payroll: employee compensation, payroll processor debits
- tax: IRS, state tax, sales tax remittance
- owner_draw: owner distributions, personal transfers
- uncategorized: cannot determine

The counterparty role in parentheses (if present) comes from the identity graph and is a strong signal.

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
              source_id: batch[idx].movement.source_id,
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
  afterDedup: number
  ruleClassified: number
  llmClassified: number
  identityResolved: number
  transfersPaired: number
  pnlEligible: number
  byClass: Record<string, number>
}> {
  await ensureMovementsSchema()

  const stats = {
    total: 0, afterDedup: 0, ruleClassified: 0, llmClassified: 0,
    identityResolved: 0, transfersPaired: 0, pnlEligible: 0,
    byClass: {} as Record<string, number>,
  }

  log("movements.classify.start", { userId }, "movements")

  // Step 1: Extract raw movements from all sources
  const [plaidMvts, qboMvts, stripeMvts, xeroMvts] = await Promise.all([
    extractPlaidMovements(userId),
    extractQboMovements(userId),
    extractStripeMovements(userId),
    extractXeroMovements(userId),
  ])

  const allRaw = [...plaidMvts, ...qboMvts, ...stripeMvts, ...xeroMvts]
  stats.total = allRaw.length

  log("movements.classify.extracted", {
    userId, plaid: plaidMvts.length, qbo: qboMvts.length, stripe: stripeMvts.length, xero: xeroMvts.length, total: allRaw.length,
  }, "movements")

  if (allRaw.length === 0) {
    log("movements.classify.done", { userId, ...stats }, "movements")
    return stats
  }

  // Step 2: Build identity context (auto-seed if empty)
  let identityCtx = await buildMovementIdentityContext(userId)
  if (identityCtx.size === 0) {
    log("movements.classify.identity_empty_seeding", { userId }, "movements")
    await seedIdentityGraph(userId)
    identityCtx = await buildMovementIdentityContext(userId)
  }

  // Step 3: Resolve counterparty → identity for each movement
  for (const m of allRaw) {
    const entry = resolveIdentity(m, identityCtx)
    if (entry) {
      m.entity_id = entry.entity_id
      m.entity_type = entry.role
      m.counterparty = m.counterparty ?? entry.canonical_name
      stats.identityResolved++
    }

    // Resolve Plaid account_id → bank_account entity for from/to
    if (m.source === "plaid" && m.metadata.account_id) {
      const acctEntry = resolveOwnAccount(m.metadata.account_id as string, identityCtx)
      if (acctEntry) {
        if (m.amount < 0 && !m.from_account) m.from_account = acctEntry.canonical_name
        if (m.amount >= 0 && !m.to_account) m.to_account = acctEntry.canonical_name
      }
    }
  }

  // Step 4: Pair Plaid cross-account transfers
  pairPlaidTransfers(allRaw)
  stats.transfersPaired = allRaw.filter((m) => m.metadata.transfer_type === "cross_account").length

  // Step 5: Deduplicate across sources
  const deduped = dedupAcrossSources(allRaw)
  stats.afterDedup = deduped.length

  log("movements.classify.prepared", {
    userId,
    identityResolved: stats.identityResolved,
    transfersPaired: stats.transfersPaired,
    afterDedup: stats.afterDedup,
    identityContextSize: identityCtx.size,
  }, "movements")

  // Step 6: Three-tier classification
  const classified: ClassifiedMovement[] = []
  const unclassified: Array<{ movement: RawMovement; identity: MovementIdentityEntry | null }> = []

  for (const m of deduped) {
    const identity = m.entity_id ? resolveIdentity(m, identityCtx) : null
    const result = classifyMovement(m, identity)
    if (result) {
      classified.push({
        ...m,
        movement_class: result.cls,
        pnl_eligible: PNL_ELIGIBLE_CLASSES.has(result.cls),
        confidence: result.confidence,
      })
      stats.ruleClassified++
    } else {
      unclassified.push({ movement: m, identity })
    }
  }

  // Step 7: LLM fallback with identity role in prompt
  if (unclassified.length > 0) {
    const llmResults = await llmClassifyBatch(unclassified)
    const llmMap = new Map(llmResults.map((r) => [r.source_id, r]))

    for (const { movement: m } of unclassified) {
      const llmResult = llmMap.get(m.source_id)
      const cls = (llmResult?.movement_class ?? "uncategorized") as MovementClass
      classified.push({
        ...m,
        movement_class: cls,
        pnl_eligible: PNL_ELIGIBLE_CLASSES.has(cls),
        confidence: llmResult?.confidence ?? 0.3,
      })
      if (llmResult) stats.llmClassified++
    }
  }

  // Step 8: Batch persist
  const BATCH_SIZE = 50
  for (let i = 0; i < classified.length; i += BATCH_SIZE) {
    const batch = classified.slice(i, i + BATCH_SIZE)

    const values: string[] = []
    const params: unknown[] = []
    let paramIdx = 0

    for (const m of batch) {
      stats.byClass[m.movement_class] = (stats.byClass[m.movement_class] ?? 0) + 1
      if (m.pnl_eligible) stats.pnlEligible++

      const offsets = Array.from({ length: 15 }, (_, k) => `$${paramIdx + k + 1}`)
      values.push(`(${offsets.join(", ")})`)
      params.push(
        userId, m.source, m.source_type, m.source_id,
        m.entity_id, m.date, m.amount, m.raw_description,
        m.counterparty, m.movement_class, m.pnl_eligible,
        m.from_account, m.to_account, m.confidence,
        JSON.stringify(m.metadata),
      )
      paramIdx += 15
    }

    await query(
      `INSERT INTO movements (user_id, source, source_type, source_id, entity_id, date, amount, raw_description, counterparty, movement_class, pnl_eligible, from_account, to_account, confidence, metadata)
       VALUES ${values.join(", ")}
       ON CONFLICT (user_id, source, source_id) DO UPDATE SET
         entity_id = EXCLUDED.entity_id,
         movement_class = EXCLUDED.movement_class,
         pnl_eligible = EXCLUDED.pnl_eligible,
         counterparty = EXCLUDED.counterparty,
         confidence = EXCLUDED.confidence,
         from_account = EXCLUDED.from_account,
         to_account = EXCLUDED.to_account,
         metadata = EXCLUDED.metadata`,
      params,
    )
  }

  log("movements.classify.done", { userId, ...stats }, "movements")
  return stats
}

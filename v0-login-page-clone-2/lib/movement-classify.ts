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

function classifyByRules(m: RawMovement): { cls: MovementClass; confidence: number } | null {
  const desc = (m.raw_description ?? "").toLowerCase()
  const counterparty = (m.counterparty ?? "").toLowerCase()
  const cats = m.plaid_category ?? []
  const catStr = cats.join(" ").toLowerCase()

  // QBO Transfer entity type is always internal_transfer
  if (m.source === "qbo" && m.source_type === "Transfer") {
    return { cls: "internal_transfer", confidence: 0.95 }
  }

  // QBO RefundReceipt, CreditMemo, VendorCredit → refund
  if (m.source === "qbo" && ["RefundReceipt", "CreditMemo", "VendorCredit"].includes(m.source_type)) {
    return { cls: "refund", confidence: 0.9 }
  }

  // Stripe payouts are settlements (processor → bank)
  if (m.source === "stripe" && m.source_type === "payout") {
    return { cls: "settlement", confidence: 0.95 }
  }

  // Stripe balance_transaction with type 'stripe_fee' or 'fee'
  if (m.source === "stripe" && m.source_type === "balance_transaction") {
    const sType = (m.metadata.stripe_type ?? "") as string
    if (sType === "stripe_fee" || sType === "fee") return { cls: "fee", confidence: 0.95 }
    if (sType === "refund") return { cls: "refund", confidence: 0.95 }
    if (sType === "payout") return { cls: "settlement", confidence: 0.9 }
  }

  // Identity-based classification
  if (m.entity_type === "processor") return { cls: "settlement", confidence: 0.9 }
  if (m.entity_type === "employee") return { cls: "payroll", confidence: 0.9 }
  if (m.entity_type === "tax_authority") return { cls: "tax", confidence: 0.9 }
  if (m.entity_type === "owner") return { cls: "owner_draw", confidence: 0.9 }
  if (m.entity_type === "lender") return { cls: "financing", confidence: 0.85 }
  if (m.entity_type === "internal") return { cls: "internal_transfer", confidence: 0.85 }

  // Plaid category-based
  if (catStr.includes("bank fees")) return { cls: "fee", confidence: 0.85 }
  if (catStr.includes("payroll")) return { cls: "payroll", confidence: 0.85 }
  if (catStr.includes("tax")) return { cls: "tax", confidence: 0.8 }
  if (catStr.includes("transfer") && !catStr.includes("wire transfer")) return { cls: "internal_transfer", confidence: 0.75 }
  if (catStr.includes("loan")) return { cls: "financing", confidence: 0.8 }

  // Pattern-based on description
  if (TRANSFER_PATTERNS.some((p) => p.test(desc))) return { cls: "internal_transfer", confidence: 0.8 }
  if (FEE_PATTERNS.some((p) => p.test(desc))) return { cls: "fee", confidence: 0.8 }
  if (TAX_PATTERNS.some((p) => p.test(desc))) return { cls: "tax", confidence: 0.8 }
  if (FINANCING_PATTERNS.some((p) => p.test(desc))) return { cls: "financing", confidence: 0.75 }
  if (REFUND_PATTERNS.some((p) => p.test(desc))) return { cls: "refund", confidence: 0.75 }

  // Payroll processor match
  const cpNorm = counterparty.replace(/[^a-z0-9]/g, "")
  for (const pp of PAYROLL_PROCESSORS) {
    if (cpNorm.includes(pp.replace(/[^a-z0-9]/g, ""))) return { cls: "payroll", confidence: 0.85 }
  }

  // QBO type-based fallback for remaining QBO records
  if (m.source === "qbo") {
    if (["Invoice", "Payment", "SalesReceipt", "Deposit"].includes(m.source_type)) {
      return { cls: "operating_revenue", confidence: 0.8 }
    }
    if (["Bill", "BillPayment", "Purchase"].includes(m.source_type)) {
      return { cls: "operating_expense", confidence: 0.8 }
    }
  }

  // Stripe payment_intent / invoice → revenue
  if (m.source === "stripe" && (m.source_type === "payment_intent" || m.source_type === "invoice")) {
    return { cls: "operating_revenue", confidence: 0.75 }
  }

  // Identity-based: vendor → expense, customer → revenue
  if (m.entity_type === "vendor") return { cls: "operating_expense", confidence: 0.7 }
  if (m.entity_type === "customer") return { cls: "operating_revenue", confidence: 0.7 }

  return null
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

  // Phase 1: Rule-based classification
  const classified: ClassifiedMovement[] = []
  const unclassified: RawMovement[] = []

  for (const m of allMovements) {
    const result = classifyByRules(m)
    if (result) {
      classified.push({
        ...m,
        movement_class: result.cls,
        pnl_eligible: PNL_ELIGIBLE_CLASSES.has(result.cls),
        confidence: result.confidence,
      })
      stats.ruleClassified++
    } else {
      unclassified.push(m)
    }
  }

  // Phase 2: LLM fallback for unclassified
  if (unclassified.length > 0) {
    const llmResults = await llmClassifyBatch(unclassified)
    const llmMap = new Map(llmResults.map((r) => [r.source_id, r]))

    for (const m of unclassified) {
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

  // Phase 3: Persist
  for (const m of classified) {
    stats.byClass[m.movement_class] = (stats.byClass[m.movement_class] ?? 0) + 1
    if (m.pnl_eligible) stats.pnlEligible++

    await query(
      `INSERT INTO movements (user_id, source, source_type, source_id, entity_id, date, amount, raw_description, counterparty, movement_class, pnl_eligible, from_account, to_account, confidence, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (user_id, source, source_id) DO UPDATE SET
         entity_id = EXCLUDED.entity_id,
         movement_class = EXCLUDED.movement_class,
         pnl_eligible = EXCLUDED.pnl_eligible,
         counterparty = EXCLUDED.counterparty,
         confidence = EXCLUDED.confidence,
         metadata = EXCLUDED.metadata`,
      [
        userId, m.source, m.source_type, m.source_id,
        m.entity_id, m.date, m.amount, m.raw_description,
        m.counterparty, m.movement_class, m.pnl_eligible,
        m.from_account, m.to_account, m.confidence,
        JSON.stringify(m.metadata),
      ]
    )
  }

  log("movements.classify.done", { userId, ...stats }, "movements")
  return stats
}

/**
 * Identity resolution engine v4.
 *
 * Key changes from v3:
 * - Signals grouped by source record: email/domain signals from the same QBO/Xero
 *   record always attach to the same entity as the name signal (no standalone email entities)
 * - ledger_account vs bank_account: QBO Accounts split into real bank/CC vs ledger
 * - Evidence-native confidence: P(entity) = 1 - product(1 - signal_i) across all signals
 * - Canonical entity is the resolved node; aliases + assertions are evidence
 */

import { query, ensureIdentitySchema } from "./db"
import { log } from "./logger"
import { normalizeForMatch } from "./alias-normalize"
import { addEntitiesToSupermemory, searchEntityContextFromSupermemory } from "./supermemory"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

// ─── Types ─────────────────────────────────────────────────────────

const ENTITY_TYPES = [
  "vendor", "customer", "employee", "processor", "bank_account",
  "tax_authority", "owner", "lender", "internal", "unknown",
] as const
type EntityType = (typeof ENTITY_TYPES)[number]

type Signal = {
  alias: string
  alias_type: "name" | "email" | "domain" | "merchant_string" | "account_ref" | "phone"
  source: "qbo" | "xero" | "stripe" | "plaid" | "gmail" | "user" | "system"
  source_id: string | null
  entity_type: EntityType
  confidence: number
  extra?: Record<string, unknown>
}

/**
 * A SignalGroup bundles all signals that came from the same source record.
 * The anchor is the name signal; satellites are email, domain, etc.
 * When resolved, all signals in the group attach to the same entity.
 */
type SignalGroup = {
  anchor: Signal
  satellites: Signal[]
}

type LlmNormResult = {
  raw: string
  normalized: string
  entity_type: string
  domain_guess: string | null
  skip: boolean
}

// ─── Known processors & noise filters ──────────────────────────────

const KNOWN_PROCESSORS = new Set([
  "shopify", "melio", "paypal", "square", "stripe", "gusto", "adp",
  "chase", "wells fargo", "intuit", "quickbooks", "bank of america",
  "mercury", "brex", "ramp", "plaid", "wise", "payoneer", "venmo",
  "zelle", "cash app", "apple pay", "google pay", "gateway services",
  "merchant bankcard", "worldpay", "authorize.net", "bill.com",
])

function isKnownProcessor(name: string): boolean {
  const n = normalizeProcessorName(name).toLowerCase().trim()
  for (const p of KNOWN_PROCESSORS) {
    if (n === p || n.startsWith(p + " ") || n.includes(` ${p}`) || n.includes(`${p}/`)) return true
  }
  return false
}

/** Skip creating entities for test data, emails, malformed names. */
function isTestOrNoiseEntity(alias: string, aliasType: string, canonicalName: string): boolean {
  if (aliasType === "email" || /^[^\s]+@[^\s]+\.[^\s]+$/.test(alias)) return true
  const cn = canonicalName.trim().toLowerCase()
  if (/\b(test|jruby|jack\s*test)\b/.test(cn)) return true
  if (cn.length <= 2) return true
  return false
}

function normalizeProcessorName(name: string): string {
  return name
    .replace(/\s*-\s*USD$/i, "")
    .replace(/\s+customer\s*-?\s*$/i, "")
    .replace(/\s+vendor\s*-?\s*$/i, "")
    .replace(/\s*\[wholesale\]\s*$/i, "")
    .trim()
}

const PLAID_NOISE_PATTERNS = [
  /^transfer (credit|debit)/i,
  /^(miscellaneous|misc)\s+(credit|debit|fee)/i,
  /^(interest|dividend)\s+(credit|paid)/i,
  /^(preauthorized ach|ach)\s+(credit|debit)/i,
  /^incoming wire/i,
  /^(debit|credit)\s+\(any type\)/i,
  /balance requirement fee/i,
  /^fee refund/i,
  /^refund balance/i,
  /^rate change/i,
  /^(deposit|withdrawal)$/i,
  /^money (move|market intro)/i,
  /^(sc|miscellaneous fees?)\s/i,
]

function isPlaidNoise(txnName: string): boolean {
  return PLAID_NOISE_PATTERNS.some((p) => p.test(txnName.trim()))
}

const TEST_PATTERNS = [
  /^test$/i, /^test\s/i, /\stest$/i,
  /^sample\s/i, /^demo\s/i, /^fake\s/i, /^dummy\s/i,
]

function isTestEntity(name: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(name.trim()))
}

// ─── Levenshtein distance ──────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

// ─── Self-entity & owner detection ─────────────────────────────────

export type SelfContext = {
  selfNames: string[]
  selfDomains: string[]
  ownerNames: string[]
  ownerEmails: string[]
  userEmail: string | null
}

export async function getSelfContext(userId: string): Promise<SelfContext> {
  const ctx: SelfContext = { selfNames: [], selfDomains: [], ownerNames: [], ownerEmails: [], userEmail: null }

  const { rows: userRows } = await query<{ email: string; company_form: Record<string, string> | null }>(
    "SELECT email, company_form FROM users WHERE id = $1",
    [userId]
  )
  if (userRows[0]) {
    ctx.userEmail = userRows[0].email
    const form = userRows[0].company_form
    if (form) {
      if (form.companyName) ctx.selfNames.push(form.companyName)
      if (form.legalName && form.legalName !== form.companyName) ctx.selfNames.push(form.legalName)
    }
  }

  const { rows: companyInfoRows } = await query<{ data: Record<string, unknown> }>(
    `SELECT e.data FROM qbo_entities e
     JOIN qbo_connections c ON c.realm_id = e.realm_id
     WHERE c.user_id = $1 AND e.entity_type = 'CompanyInfo'
     LIMIT 1`,
    [userId]
  )
  if (companyInfoRows[0]) {
    const d = companyInfoRows[0].data
    const cn = d.CompanyName as string | undefined
    const ln = d.LegalName as string | undefined
    if (cn) ctx.selfNames.push(cn)
    if (ln && ln !== cn) ctx.selfNames.push(ln)

    const email = (d.Email as Record<string, unknown>)?.Address as string | undefined
    if (email) ctx.ownerEmails.push(email.toLowerCase())
    const companyEmail = (d.CompanyEmail as Record<string, unknown>)?.Address as string | undefined
    if (companyEmail) ctx.ownerEmails.push(companyEmail.toLowerCase())

    for (const e of [companyEmail, email]) {
      if (!e) continue
      const domain = e.split("@")[1]?.toLowerCase()
      if (domain && !domain.includes("gmail") && !domain.includes("yahoo") && !domain.includes("hotmail")) {
        ctx.selfDomains.push(domain)
      }
    }
  }

  const { rows: connRows } = await query<{ company_name: string | null }>(
    "SELECT company_name FROM qbo_connections WHERE user_id = $1",
    [userId]
  )
  for (const r of connRows) {
    if (r.company_name) ctx.selfNames.push(r.company_name)
  }

  ctx.selfNames = [...new Set(ctx.selfNames.filter(Boolean))]
  ctx.selfDomains = [...new Set(ctx.selfDomains.filter(Boolean))]
  ctx.ownerEmails = [...new Set(ctx.ownerEmails.filter(Boolean))]

  for (const e of ctx.ownerEmails) {
    const local = e.split("@")[0]
    if (local && local.length > 2) ctx.ownerNames.push(local)
  }
  if (ctx.userEmail) {
    ctx.ownerEmails.push(ctx.userEmail)
    const local = ctx.userEmail.split("@")[0]
    if (local && local.length > 2) ctx.ownerNames.push(local)
  }
  ctx.ownerNames = [...new Set(ctx.ownerNames)]

  return ctx
}

function isSelfEntity(name: string, selfNames: string[]): boolean {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "")
  for (const sn of selfNames) {
    const snNorm = sn.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (!snNorm || !norm) continue
    if (norm === snNorm) return true
    if (norm.length >= 5 && snNorm.length >= 5 && (norm.includes(snNorm) || snNorm.includes(norm))) return true
  }
  return false
}

function isOwnerEntity(name: string, email: string | null, ctx: SelfContext): boolean {
  if (email) {
    for (const oe of ctx.ownerEmails) {
      if (email.toLowerCase() === oe) return true
    }
    const domain = email.split("@")[1]?.toLowerCase()
    if (domain && ctx.selfDomains.includes(domain)) return true
  }
  const normName = name.toLowerCase().replace(/[^a-z0-9]/g, "")
  for (const on of ctx.ownerNames) {
    const onNorm = on.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (onNorm.length >= 4 && normName.length >= 4 && (normName.includes(onNorm) || onNorm.includes(normName))) return true
  }
  return false
}

// ─── Signal extraction (grouped by source record) ──────────────────

function makeGroup(anchor: Signal, satellites: Signal[] = []): SignalGroup {
  return { anchor, satellites }
}

async function extractQboSignalGroups(userId: string, ctx: SelfContext): Promise<SignalGroup[]> {
  const groups: SignalGroup[] = []

  const { rows: customers } = await query<{ entity_id: string; data: Record<string, unknown> }>(
    `SELECT e.entity_id, e.data FROM qbo_entities e
     JOIN qbo_connections c ON c.realm_id = e.realm_id
     WHERE c.user_id = $1 AND e.entity_type = 'Customer'`,
    [userId]
  )
  for (const row of customers) {
    const d = row.data
    const displayName = (d.DisplayName ?? d.FullyQualifiedName ?? "") as string
    if (!displayName || isTestEntity(displayName)) continue

    const email = (d.PrimaryEmailAddr as Record<string, unknown>)?.Address as string | undefined

    let entityType: EntityType = "customer"
    if (isSelfEntity(displayName, ctx.selfNames)) entityType = "internal"
    else if (isKnownProcessor(displayName)) entityType = "processor"
    else if (isOwnerEntity(displayName, email ?? null, ctx)) entityType = "owner"

    const anchor: Signal = { alias: displayName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.9 }
    const sats: Signal[] = []

    const companyName = d.CompanyName as string | undefined
    if (companyName && companyName !== displayName) {
      sats.push({ alias: companyName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.85 })
    }
    if (email) {
      sats.push({ alias: email.toLowerCase(), alias_type: "email", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.95 })
    }
    const web = (d.WebAddr as Record<string, unknown>)?.URI as string | undefined
    if (web) {
      const domain = extractDomain(web)
      if (domain) sats.push({ alias: domain, alias_type: "domain", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.7 })
    }
    groups.push(makeGroup(anchor, sats))
  }

  const { rows: vendors } = await query<{ entity_id: string; data: Record<string, unknown> }>(
    `SELECT e.entity_id, e.data FROM qbo_entities e
     JOIN qbo_connections c ON c.realm_id = e.realm_id
     WHERE c.user_id = $1 AND e.entity_type = 'Vendor'`,
    [userId]
  )
  for (const row of vendors) {
    const d = row.data
    const displayName = (d.DisplayName ?? d.FullyQualifiedName ?? "") as string
    if (!displayName || isTestEntity(displayName)) continue

    const email = (d.PrimaryEmailAddr as Record<string, unknown>)?.Address as string | undefined

    let entityType: EntityType = "vendor"
    if (isSelfEntity(displayName, ctx.selfNames)) entityType = "internal"
    else if (isKnownProcessor(displayName)) entityType = "processor"

    const anchor: Signal = { alias: displayName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.9 }
    const sats: Signal[] = []

    const companyName = d.CompanyName as string | undefined
    if (companyName && companyName !== displayName) {
      sats.push({ alias: companyName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.85 })
    }
    if (email) {
      sats.push({ alias: email.toLowerCase(), alias_type: "email", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.95 })
    }
    groups.push(makeGroup(anchor, sats))
  }

  // QBO Employees
  const { rows: employees } = await query<{ entity_id: string; data: Record<string, unknown> }>(
    `SELECT e.entity_id, e.data FROM qbo_entities e
     JOIN qbo_connections c ON c.realm_id = e.realm_id
     WHERE c.user_id = $1 AND e.entity_type = 'Employee'`,
    [userId]
  )
  for (const row of employees) {
    const d = row.data
    const displayName = (d.DisplayName ?? d.PrintOnCheckName ?? "") as string
    if (!displayName) continue
    const anchor: Signal = { alias: displayName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: "employee", confidence: 0.9 }
    const sats: Signal[] = []
    const email = (d.PrimaryEmailAddr as Record<string, unknown>)?.Address as string | undefined
    if (email) {
      sats.push({ alias: email.toLowerCase(), alias_type: "email", source: "qbo", source_id: row.entity_id, entity_type: "employee", confidence: 0.95 })
    }
    groups.push(makeGroup(anchor, sats))
  }

  // Connected financial accounts from Plaid (real bank/CC accounts with live data)
  const { rows: plaidAccounts } = await query<{ account_id: string; name: string | null; type: string | null; subtype: string | null; mask: string | null }>(
    `SELECT pa.account_id, pa.name, pa.type, pa.subtype, pa.mask
     FROM plaid_accounts pa
     JOIN plaid_items pi ON pi.item_id = pa.item_id
     WHERE pi.user_id = $1`,
    [userId]
  )
  for (const acct of plaidAccounts) {
    const name = acct.name?.trim()
    if (!name) continue
    const label = acct.mask ? `${name} (••${acct.mask})` : name
    groups.push(makeGroup({
      alias: label,
      alias_type: "name",
      source: "plaid",
      source_id: acct.account_id,
      entity_type: "bank_account",
      confidence: 0.95,
      extra: { account_type: acct.type, account_subtype: acct.subtype, mask: acct.mask },
    }))
  }

  return groups
}

async function extractXeroSignalGroups(userId: string, ctx: SelfContext): Promise<SignalGroup[]> {
  const groups: SignalGroup[] = []

  const { rows: contacts } = await query<{ entity_id: string; data: Record<string, unknown> }>(
    `SELECT e.entity_id, e.data FROM xero_entities e
     JOIN xero_connections c ON c.tenant_id = e.tenant_id
     WHERE c.user_id = $1 AND e.entity_type = 'Contact'`,
    [userId]
  )
  for (const row of contacts) {
    const d = row.data
    const name = d.Name as string | undefined
    if (!name || isTestEntity(name)) continue

    const isCustomer = d.IsCustomer === true
    const isSupplier = d.IsSupplier === true
    let entityType: EntityType = isSupplier ? "vendor" : isCustomer ? "customer" : "unknown"
    if (isSelfEntity(name, ctx.selfNames)) entityType = "internal"
    else if (isKnownProcessor(name)) entityType = "processor"

    const anchor: Signal = { alias: name, alias_type: "name", source: "xero", source_id: row.entity_id, entity_type: entityType, confidence: 0.9 }
    const sats: Signal[] = []
    const email = d.EmailAddress as string | undefined
    if (email) {
      sats.push({ alias: email.toLowerCase(), alias_type: "email", source: "xero", source_id: row.entity_id, entity_type: entityType, confidence: 0.95 })
    }
    groups.push(makeGroup(anchor, sats))
  }

  return groups
}

async function extractStripeSignalGroups(userId: string, ctx: SelfContext): Promise<SignalGroup[]> {
  const groups: SignalGroup[] = []

  const { rows: customers } = await query<{ entity_id: string; data: Record<string, unknown> }>(
    `SELECT entity_id, data FROM stripe_entities
     WHERE user_id = $1 AND entity_type = 'customer'`,
    [userId]
  )
  for (const row of customers) {
    const d = row.data
    const name = d.name as string | undefined
    if (!name) continue

    let entityType: EntityType = "customer"
    if (isSelfEntity(name, ctx.selfNames)) entityType = "internal"

    const anchor: Signal = { alias: name, alias_type: "name", source: "stripe", source_id: row.entity_id, entity_type: entityType, confidence: 0.85 }
    const sats: Signal[] = []
    const email = d.email as string | undefined
    if (email) {
      sats.push({ alias: email.toLowerCase(), alias_type: "email", source: "stripe", source_id: row.entity_id, entity_type: entityType, confidence: 0.95 })
    }
    groups.push(makeGroup(anchor, sats))
  }

  return groups
}

async function extractPlaidMerchantStrings(userId: string): Promise<string[]> {
  const { rows } = await query<{ merchant_name: string | null; name: string | null }>(
    `SELECT DISTINCT pt.merchant_name, pt.name
     FROM plaid_transactions pt
     JOIN plaid_items pi ON pi.item_id = pt.item_id
     WHERE pi.user_id = $1`,
    [userId]
  )
  const set = new Set<string>()
  for (const r of rows) {
    const val = r.merchant_name?.trim() || r.name?.trim()
    if (!val) continue
    if (isPlaidNoise(val)) continue
    set.add(val)
  }
  return Array.from(set)
}

async function extractGmailSignalGroups(userId: string): Promise<SignalGroup[]> {
  const groups: SignalGroup[] = []

  const { rows } = await query<{
    message_id: string
    from_email: string | null
    extracted_invoice: { counterparty_name?: string; counterparty_email?: string; counterparty_type?: string } | null
  }>(
    `SELECT message_id, from_email, extracted_invoice
     FROM gmail_synced_messages
     WHERE extracted_invoice IS NOT NULL
     LIMIT 1000`
  )

  for (const row of rows) {
    const inv = row.extracted_invoice
    if (!inv) continue
    const cpType: EntityType = inv.counterparty_type === "vendor" ? "vendor" : inv.counterparty_type === "customer" ? "customer" : "unknown"

    if (inv.counterparty_name) {
      const anchor: Signal = { alias: inv.counterparty_name, alias_type: "name", source: "gmail", source_id: row.message_id, entity_type: cpType, confidence: 0.7 }
      const sats: Signal[] = []
      if (inv.counterparty_email) {
        sats.push({ alias: inv.counterparty_email.toLowerCase(), alias_type: "email", source: "gmail", source_id: row.message_id, entity_type: cpType, confidence: 0.8 })
      }
      groups.push(makeGroup(anchor, sats))
    } else if (inv.counterparty_email) {
      groups.push(makeGroup({ alias: inv.counterparty_email.toLowerCase(), alias_type: "email", source: "gmail", source_id: row.message_id, entity_type: cpType, confidence: 0.8 }))
    }
  }

  return groups
}

// ─── LLM normalization for Plaid merchant strings ──────────────────

/** Existing entity as hint: canonical name + known aliases (merchant strings, names, etc.) */
type EntityHint = { canonical_name: string; aliases: string[] }

async function llmNormalizeMerchants(
  merchants: string[],
  ctx: SelfContext,
  entityHints: EntityHint[] = [],
  userId?: string
): Promise<LlmNormResult[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || merchants.length === 0) return []

  const results: LlmNormResult[] = []
  const batchSize = 50
  const HINTS_PER_BATCH = 150
  const selfNamesStr = ctx.selfNames.length > 0 ? ctx.selfNames.join(", ") : "(not provided)"

  for (let i = 0; i < merchants.length; i += batchSize) {
    const batch = merchants.slice(i, i + batchSize)
    const numbered = batch.map((m, idx) => `${idx + 1}. ${m}`).join("\n")

    // Supermemory: unlimited context — search retrieves relevant entities for this batch
    let entityContext = ""
    if (userId) {
      const supermemoryContext = await searchEntityContextFromSupermemory(userId, batch.join(" "))
      if (supermemoryContext) entityContext = `\n\n${supermemoryContext}`
    }

    // Fallback: DB entity hints (batch + rotate) when Supermemory empty or unavailable
    if (!entityContext && entityHints.length > 0) {
      const batchLower = batch.map((m) => m.toLowerCase())
      const relevant = entityHints.filter((e) =>
        e.aliases.some((a) => {
          const al = a.trim().toLowerCase()
          if (al.length < 3) return false
          return batchLower.some((m) => m.includes(al) || al.includes(m))
        })
      )
      const hintBatchIndex = Math.floor(i / batchSize) % Math.max(1, Math.ceil(entityHints.length / HINTS_PER_BATCH))
      const hintStart = hintBatchIndex * HINTS_PER_BATCH
      const rotating = entityHints.slice(hintStart, hintStart + HINTS_PER_BATCH)
      const seen = new Set(relevant.map((e) => e.canonical_name))
      const extra = rotating.filter((e) => !seen.has(e.canonical_name))
      const hintsToUse = [...relevant, ...extra].slice(0, HINTS_PER_BATCH)
      entityContext = `\n\nExisting entities (use as hints — prefer these canonical names when a raw description matches):\n${hintsToUse
        .map((e) => `- "${e.canonical_name}" (aliases: ${e.aliases.slice(0, 8).join(", ") || "—"})`)
        .join("\n")}\n\nWhen a raw description clearly refers to an existing entity, set normalized to that entity's canonical name.`
    }

    const systemPrompt = `You are a financial identity normalization engine for a business called "${selfNamesStr}".${entityContext}

Given raw bank transaction descriptions, return a JSON array. Each element:
- "raw": the original string (exactly as given)
- "normalized": the clean canonical company/person name
- "entity_type": one of: "vendor", "customer", "employee", "processor", "owner", "internal", "bank_account", "tax_authority", "lender", "unknown"
- "domain_guess": likely website domain or null
- "skip": true if this is NOT a real counterparty (internal transfers between own accounts, bank fees, interest credits, rate changes, deposit/withdrawal labels, generic ACH metadata). These should not become entities.

Entity type rules:
- "internal": the business itself ("${selfNamesStr}") or its own accounts appearing in transactions
- "owner": the business owner(s) — personal transfers, personal credit card payments by the owner
- "processor": payment intermediaries, payment processors, payroll providers, merchant acquirers, and similar financial service entities that move money on behalf of the business
- "bank_account": bank-to-bank transfers, money market movements, account-to-account transfers (set skip=true for these)
- "employee": individuals receiving payroll or reimbursements
- "tax_authority": IRS, state tax agencies, sales tax payments
- "lender": loan providers, credit lines
- "vendor": companies the business pays for goods/services
- "customer": companies/people who pay the business

Normalization rules:
- Strip prefixes: "SQ *", "TST*", "PAYPAL *", "PREAUTHORIZED ACH CREDIT/DEBIT", "MISCELLANEOUS CREDIT/DEBIT", "TRANSFER CREDIT/DEBIT", etc.
- Strip suffixes: reference numbers, routing info, addresses, timestamps, "- USD", "customer -", "vendor -"
- For ACH descriptions like "ACME CORP M/ACH Pmt Invoice 1029...", extract just the company name: "Acme Corp"
- For Zelle transfers like "ZELLE MICHELLE SCHOR", extract just the person name: "Michelle Schor"
- Merge variations of the same entity that appear with different descriptions into a single canonical name
- If the same real entity appears with different descriptions, normalize to the same canonical name
- When existing entities are provided above, prefer their canonical name when the raw string clearly refers to that entity (e.g. alias match, partial match)
- Names with parenthetical context like "Brenna Sleggs (Pittsburgh Penguins)" should normalize to "Brenna Sleggs" with the context preserved in domain_guess or dropped
- Test/sample entries like "test", "Sample Customer", "Test Company", "Demo Vendor" should have skip=true

Output ONLY valid JSON array. No markdown, no explanation.`

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Normalize these transaction descriptions:\n${numbered}` },
          ],
          max_tokens: 4096,
          temperature: 0.05,
        }),
      })

      if (!res.ok) {
        log("identity.llm_normalize.error", { status: res.status, batch: i }, "identity")
        continue
      }

      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content ?? ""
      const jsonStr = content.replace(/```json?\s*/gi, "").replace(/```/g, "").trim()
      const parsed = JSON.parse(jsonStr) as LlmNormResult[]
      if (Array.isArray(parsed)) {
        results.push(...parsed)
      }
      log("identity.llm_normalize.batch_done", { batch: i, count: parsed.length }, "identity")
    } catch (err) {
      log("identity.llm_normalize.parse_error", { batch: i, error: err instanceof Error ? err.message : String(err) }, "identity")
    }
  }

  return results
}

// ─── Resolution engine ─────────────────────────────────────────────

function stripParenthetical(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, "").trim()
}

function extractDomain(urlOrEmail: string): string | null {
  try {
    if (urlOrEmail.includes("@")) return urlOrEmail.split("@")[1]?.toLowerCase() ?? null
    const u = new URL(urlOrEmail.startsWith("http") ? urlOrEmail : `https://${urlOrEmail}`)
    return u.hostname.replace(/^www\./, "")
  } catch {
    return null
  }
}

function validEntityType(t: string): EntityType {
  if ((ENTITY_TYPES as readonly string[]).includes(t)) return t as EntityType
  return "unknown"
}

type EntityRow = { id: string; canonical_name: string; entity_type: string; confidence: number }
type AliasRow = { alias: string; alias_type: string; source: string }

function findCandidateEntity(
  signal: Signal,
  existingEntities: EntityRow[],
  existingAliases: Map<string, AliasRow[]>
): { entityId: string; matchScore: number } | null {
  if (signal.alias_type === "email" || signal.alias_type === "account_ref") {
    for (const ent of existingEntities) {
      const aliases = existingAliases.get(ent.id) ?? []
      for (const a of aliases) {
        if (a.alias_type === signal.alias_type && a.alias.toLowerCase() === signal.alias.toLowerCase()) {
          return { entityId: ent.id, matchScore: 0.95 }
        }
      }
    }
    if (signal.alias_type === "email") {
      const [sigLocal, sigDomain] = signal.alias.toLowerCase().split("@")
      if (sigLocal && sigDomain) {
        for (const ent of existingEntities) {
          const aliases = existingAliases.get(ent.id) ?? []
          for (const a of aliases) {
            if (a.alias_type !== "email") continue
            const [aLocal, aDomain] = a.alias.toLowerCase().split("@")
            if (aDomain === sigDomain && aLocal && levenshtein(sigLocal, aLocal) <= 2 && levenshtein(sigLocal, aLocal) > 0) {
              return { entityId: ent.id, matchScore: 0.85 }
            }
          }
        }
      }
    }
  }

  if (signal.alias_type === "name" || signal.alias_type === "merchant_string") {
    const norm = normalizeForMatch(signal.alias)
    const normStripped = normalizeForMatch(stripParenthetical(signal.alias))
    const normProcessor = normalizeForMatch(normalizeProcessorName(signal.alias))
    if (norm.length < 2) return null

    for (const ent of existingEntities) {
      const entNorm = normalizeForMatch(ent.canonical_name)
      const entNormStripped = normalizeForMatch(stripParenthetical(ent.canonical_name))
      const entNormProcessor = normalizeForMatch(normalizeProcessorName(ent.canonical_name))

      if (entNorm === norm || entNormStripped === normStripped || entNormProcessor === normProcessor) {
        return { entityId: ent.id, matchScore: 0.85 }
      }
      if (norm.length >= 4 && entNorm.length >= 4) {
        if (entNorm.includes(norm) || norm.includes(entNorm)) {
          return { entityId: ent.id, matchScore: 0.75 }
        }
      }

      const aliases = existingAliases.get(ent.id) ?? []
      for (const a of aliases) {
        if (a.alias_type !== "name" && a.alias_type !== "merchant_string") continue
        const aNorm = normalizeForMatch(a.alias)
        const aNormStripped = normalizeForMatch(stripParenthetical(a.alias))
        const aNormProcessor = normalizeForMatch(normalizeProcessorName(a.alias))
        if (aNorm === norm || aNormStripped === normStripped || aNormProcessor === normProcessor) {
          return { entityId: ent.id, matchScore: 0.8 }
        }
        if (norm.length >= 4 && aNorm.length >= 4 && (aNorm.includes(norm) || norm.includes(aNorm))) {
          return { entityId: ent.id, matchScore: 0.7 }
        }
      }
    }
  }

  if (signal.alias_type === "domain") {
    for (const ent of existingEntities) {
      const aliases = existingAliases.get(ent.id) ?? []
      for (const a of aliases) {
        if (a.alias_type === "domain" && a.alias === signal.alias) {
          return { entityId: ent.id, matchScore: 0.7 }
        }
        if (a.alias_type === "email") {
          const emailDomain = a.alias.split("@")[1]?.toLowerCase()
          if (emailDomain === signal.alias) {
            return { entityId: ent.id, matchScore: 0.7 }
          }
        }
      }
    }
  }

  if (signal.alias_type === "email") {
    const domain = extractDomain(signal.alias)
    if (domain) {
      for (const ent of existingEntities) {
        const aliases = existingAliases.get(ent.id) ?? []
        for (const a of aliases) {
          if (a.alias_type === "domain" && a.alias === domain) {
            return { entityId: ent.id, matchScore: 0.65 }
          }
        }
      }
    }
  }

  return null
}

// ─── Evidence-native confidence ────────────────────────────────────

/**
 * Computes confidence from independent evidence signals.
 * P(entity) = 1 - product(1 - signal_i) for all signals attached to this entity.
 * Each unique (source, alias_type) pair contributes independently.
 */
function computeEvidenceConfidence(signals: Signal[]): number {
  if (signals.length === 0) return 0
  let product = 1
  for (const s of signals) {
    product *= (1 - s.confidence)
  }
  return Math.round((1 - product) * 1000) / 1000
}

// ─── Main seed function ────────────────────────────────────────────

export async function seedIdentityGraph(userId: string): Promise<{
  entitiesCreated: number
  entitiesUpdated: number
  aliasesCreated: number
  assertionsCreated: number
  plaidMerchantsNormalized: number
  plaidSkipped: number
  selfEntities: number
  processorsDetected: number
  testSkipped: number
  bankAccounts: number
}> {
  await ensureIdentitySchema()

  const stats = {
    entitiesCreated: 0, entitiesUpdated: 0, aliasesCreated: 0,
    assertionsCreated: 0, plaidMerchantsNormalized: 0, plaidSkipped: 0,
    selfEntities: 0, processorsDetected: 0, testSkipped: 0,
    bankAccounts: 0,
  }

  log("identity.seed.start", { userId }, "identity")

  const ctx = await getSelfContext(userId)
  log("identity.seed.self_context", { userId, selfNames: ctx.selfNames, selfDomains: ctx.selfDomains, ownerEmails: ctx.ownerEmails }, "identity")

  // Phase 1: Collect signal groups from accounting tools + Gmail
  const [qboGroups, xeroGroups, stripeGroups, gmailGroups] = await Promise.all([
    extractQboSignalGroups(userId, ctx),
    extractXeroSignalGroups(userId, ctx),
    extractStripeSignalGroups(userId, ctx),
    extractGmailSignalGroups(userId),
  ])

  // Load existing entities + aliases as hints for LLM (already normalized — helps consistency)
  const existingEntities = (
    await query<{ id: string; canonical_name: string; entity_type: string }>(
      "SELECT id, canonical_name, entity_type FROM entities WHERE user_id = $1",
      [userId]
    )
  ).rows
  const entityHints: EntityHint[] = []
  if (existingEntities.length > 0) {
    const ids = existingEntities.map((e) => e.id)
    const { rows: aliasRows } = await query<{ entity_id: string; alias: string }>(
      "SELECT entity_id, alias FROM entity_aliases WHERE entity_id = ANY($1)",
      [ids]
    )
    const aliasesByEntity = new Map<string, string[]>()
    for (const r of aliasRows) {
      const list = aliasesByEntity.get(r.entity_id) ?? []
      list.push(r.alias)
      aliasesByEntity.set(r.entity_id, list)
    }
    for (const e of existingEntities) {
      const aliases = aliasesByEntity.get(e.id) ?? []
      entityHints.push({ canonical_name: e.canonical_name, aliases: [e.canonical_name, ...aliases] })
    }
  }

  // Sync entities to Supermemory for unlimited context (Supermemory + LLM)
  await addEntitiesToSupermemory(userId, entityHints)

  // Phase 2: LLM-normalize Plaid merchant strings (Supermemory + entity hints for consistency)
  const plaidMerchants = await extractPlaidMerchantStrings(userId)
  const normalized = await llmNormalizeMerchants(plaidMerchants, ctx, entityHints, userId)

  const plaidGroups: SignalGroup[] = []
  for (const n of normalized) {
    if (n.skip) { stats.plaidSkipped++; continue }
    if (isTestEntity(n.normalized)) { stats.testSkipped++; continue }
    stats.plaidMerchantsNormalized++

    let entityType = validEntityType(n.entity_type)
    if (isKnownProcessor(n.normalized)) entityType = "processor"
    if (isSelfEntity(n.normalized, ctx.selfNames)) entityType = "internal"

    if (entityType === "processor") stats.processorsDetected++
    if (entityType === "internal") stats.selfEntities++

    const anchor: Signal = {
      alias: n.normalized,
      alias_type: "name",
      source: "plaid",
      source_id: null,
      entity_type: entityType,
      confidence: 0.8,
      extra: { raw_merchant: n.raw },
    }
    const sats: Signal[] = [
      { alias: n.raw, alias_type: "merchant_string", source: "plaid", source_id: null, entity_type: entityType, confidence: 0.6 },
    ]
    if (n.domain_guess) {
      sats.push({ alias: n.domain_guess, alias_type: "domain", source: "plaid", source_id: null, entity_type: entityType, confidence: 0.6 })
    }
    plaidGroups.push(makeGroup(anchor, sats))
  }

  // Self-entity groups
  const selfGroups: SignalGroup[] = []
  for (const sn of ctx.selfNames) {
    selfGroups.push(makeGroup({ alias: sn, alias_type: "name", source: "system", source_id: null, entity_type: "internal", confidence: 0.99 }))
  }
  for (const sd of ctx.selfDomains) {
    selfGroups.push(makeGroup({ alias: sd, alias_type: "domain", source: "system", source_id: null, entity_type: "internal", confidence: 0.9 }))
  }

  const allGroups = [...selfGroups, ...qboGroups, ...xeroGroups, ...stripeGroups, ...plaidGroups, ...gmailGroups]
  const totalSignals = allGroups.reduce((sum, g) => sum + 1 + g.satellites.length, 0)
  log("identity.seed.signals_collected", {
    userId,
    groups: allGroups.length,
    totalSignals,
    self: selfGroups.length,
    qbo: qboGroups.length,
    xero: xeroGroups.length,
    stripe: stripeGroups.length,
    plaid: plaidGroups.length,
    gmail: gmailGroups.length,
    plaidSkipped: stats.plaidSkipped,
    testSkipped: stats.testSkipped,
  }, "identity")

  // Phase 3: Resolve signal groups into entities
  let entities = (await query<EntityRow>(
    "SELECT id, canonical_name, entity_type, confidence FROM entities WHERE user_id = $1",
    [userId]
  )).rows

  const loadAliases = async (): Promise<Map<string, AliasRow[]>> => {
    if (entities.length === 0) return new Map()
    const ids = entities.map((e) => e.id)
    const { rows } = await query<{ entity_id: string; alias: string; alias_type: string; source: string }>(
      `SELECT entity_id, alias, alias_type, source FROM entity_aliases WHERE entity_id = ANY($1)`,
      [ids]
    )
    const map = new Map<string, AliasRow[]>()
    for (const r of rows) {
      const list = map.get(r.entity_id) ?? []
      list.push({ alias: r.alias, alias_type: r.alias_type, source: r.source })
      map.set(r.entity_id, list)
    }
    return map
  }

  const aliasMap = await loadAliases()

  // Track signals per entity for evidence-native confidence
  const entitySignals = new Map<string, Signal[]>()

  // Sort groups: higher anchor confidence first
  allGroups.sort((a, b) => b.anchor.confidence - a.anchor.confidence)

  for (const group of allGroups) {
    const { anchor, satellites } = group
    if (!anchor.alias || anchor.alias.trim().length === 0) continue

    // Resolve the anchor to find or create the entity
    const candidate = findCandidateEntity(anchor, entities, aliasMap)

    let entityId: string

    if (candidate && candidate.matchScore >= 0.6) {
      entityId = candidate.entityId
      stats.entitiesUpdated++
    } else {
      const canonicalName = anchor.alias_type === "email"
        ? anchor.alias.split("@")[0] ?? anchor.alias
        : anchor.alias_type === "domain"
          ? anchor.alias
          : normalizeProcessorName(stripParenthetical(anchor.alias))

      if (isTestOrNoiseEntity(anchor.alias, anchor.alias_type, canonicalName)) {
        stats.testSkipped = (stats.testSkipped ?? 0) + 1
        continue
      }

      const { rows: inserted } = await query<{ id: string }>(
        `INSERT INTO entities (user_id, entity_type, canonical_name, display_name, confidence)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, canonical_name, entity_type) DO UPDATE SET
           confidence = GREATEST(entities.confidence, EXCLUDED.confidence),
           updated_at = NOW()
         RETURNING id`,
        [userId, anchor.entity_type, canonicalName, anchor.alias, anchor.confidence]
      )
      entityId = inserted[0]?.id
      if (!entityId) continue
      stats.entitiesCreated++
      if (anchor.entity_type === "bank_account") stats.bankAccounts++

      entities.push({ id: entityId, canonical_name: canonicalName, entity_type: anchor.entity_type, confidence: anchor.confidence })
    }

    // Attach ALL signals in the group (anchor + satellites) to this entity
    const allSignals = [anchor, ...satellites]
    const prevSignals = entitySignals.get(entityId) ?? []
    prevSignals.push(...allSignals)
    entitySignals.set(entityId, prevSignals)

    for (const signal of allSignals) {
      if (!signal.alias || signal.alias.trim().length === 0) continue

      // Upsert alias
      await query(
        `INSERT INTO entity_aliases (entity_id, alias, alias_type, source, source_id, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (entity_id, alias, alias_type, source) DO UPDATE SET
           confidence = GREATEST(entity_aliases.confidence, EXCLUDED.confidence)`,
        [entityId, signal.alias, signal.alias_type, signal.source, signal.source_id, signal.confidence]
      )
      stats.aliasesCreated++

      // Auto-derive domain alias from email
      if (signal.alias_type === "email") {
        const domain = extractDomain(signal.alias)
        if (domain) {
          await query(
            `INSERT INTO entity_aliases (entity_id, alias, alias_type, source, source_id, confidence)
             VALUES ($1, $2, 'domain', $3, $4, $5)
             ON CONFLICT (entity_id, alias, alias_type, source) DO NOTHING`,
            [entityId, domain, signal.source, signal.source_id, 0.6]
          )
          const existing = aliasMap.get(entityId) ?? []
          existing.push({ alias: domain, alias_type: "domain", source: signal.source })
          aliasMap.set(entityId, existing)
        }
      }

      // Record assertion
      await query(
        `INSERT INTO identity_assertions (entity_id, assertion_type, source, source_record, value, score)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          entityId,
          signal.alias_type === "email" ? "email_match" : signal.alias_type === "name" ? "name_match" : signal.alias_type === "domain" ? "domain_match" : "source_ref",
          signal.source,
          JSON.stringify({ source_id: signal.source_id, extra: signal.extra }),
          signal.alias,
          signal.confidence,
        ]
      )
      stats.assertionsCreated++

      // Update in-memory alias map
      const existing = aliasMap.get(entityId) ?? []
      existing.push({ alias: signal.alias, alias_type: signal.alias_type, source: signal.source })
      aliasMap.set(entityId, existing)
    }
  }

  // Phase 4: Recompute evidence-native confidence for all touched entities
  for (const [entityId, signals] of entitySignals) {
    const evidenceConf = computeEvidenceConfidence(signals)
    await query(
      `UPDATE entities SET confidence = $1, updated_at = NOW() WHERE id = $2`,
      [evidenceConf, entityId]
    )
    const ent = entities.find((e) => e.id === entityId)
    if (ent) ent.confidence = evidenceConf
  }

  await query(
    `INSERT INTO identity_resolution_decisions (user_id, decision_type, reason)
     VALUES ($1, 'auto_create', $2)`,
    [userId, `v4: ${stats.entitiesCreated} new, ${stats.entitiesUpdated} updated, ${stats.plaidSkipped} noise, ${stats.testSkipped} test, ${stats.bankAccounts} bank, from ${totalSignals} signals in ${allGroups.length} groups`]
  )

  log("identity.seed.done", { userId, ...stats }, "identity")
  return stats
}

// ─── Movement Identity Context ─────────────────────────────────────
// Pre-computed lookup that the movement engine consumes.
// Identity owns resolution; movement owns classification.

export type CounterpartyRole =
  | "vendor" | "customer" | "employee" | "processor"
  | "tax_authority" | "owner" | "lender" | "internal"
  | "bank_account" | "unknown"

export type MovementIdentityEntry = {
  entity_id: string
  role: CounterpartyRole
  canonical_name: string
  confidence: number
  is_self: boolean
  is_own_account: boolean
}

export type MovementIdentityContext = Map<string, MovementIdentityEntry>

/**
 * Builds a pre-computed lookup from every known counterparty string to the
 * identity entry the movement engine needs. The movement engine never touches
 * entity_aliases directly — this function does all the resolution work.
 *
 * Keys in the map: normalized canonical names, name aliases, merchant_string
 * aliases, and plaid account_ids (for own-account detection).
 */
export async function buildMovementIdentityContext(userId: string): Promise<MovementIdentityContext> {
  const ctx: MovementIdentityContext = new Map()

  const { rows: entities } = await query<{
    id: string; canonical_name: string; entity_type: string; confidence: number
  }>(
    "SELECT id, canonical_name, entity_type, confidence FROM entities WHERE user_id = $1",
    [userId]
  )
  if (entities.length === 0) return ctx

  const entityIds = entities.map((e) => e.id)
  const { rows: aliases } = await query<{
    entity_id: string; alias: string; alias_type: string; source: string; source_id: string | null
  }>(
    `SELECT entity_id, alias, alias_type, source, source_id FROM entity_aliases WHERE entity_id = ANY($1)`,
    [entityIds]
  )

  const selfTypes = new Set(["internal"])
  const ownAccountTypes = new Set(["bank_account"])

  const entMap = new Map(entities.map((e) => [e.id, e]))

  const addEntry = (key: string, ent: typeof entities[number]) => {
    const k = normalizeForMatch(key)
    if (k.length < 2) return
    if (ctx.has(k) && (ctx.get(k)!.confidence >= ent.confidence)) return
    ctx.set(k, {
      entity_id: ent.id,
      role: ent.entity_type as CounterpartyRole,
      canonical_name: ent.canonical_name,
      confidence: ent.confidence,
      is_self: selfTypes.has(ent.entity_type),
      is_own_account: ownAccountTypes.has(ent.entity_type),
    })
  }

  for (const ent of entities) {
    addEntry(ent.canonical_name, ent)
    addEntry(stripParenthetical(ent.canonical_name), ent)
    addEntry(normalizeProcessorName(ent.canonical_name), ent)
  }

  for (const a of aliases) {
    const ent = entMap.get(a.entity_id)
    if (!ent) continue

    if (a.alias_type === "name" || a.alias_type === "merchant_string") {
      addEntry(a.alias, ent)
      addEntry(stripParenthetical(a.alias), ent)
      addEntry(normalizeProcessorName(a.alias), ent)
    }

    // Plaid account_id → bank_account entity (for own-account detection)
    if (a.source === "plaid" && a.source_id && ent.entity_type === "bank_account") {
      const acctKey = `__plaid_account__${a.source_id}`
      ctx.set(acctKey, {
        entity_id: ent.id,
        role: "bank_account",
        canonical_name: ent.canonical_name,
        confidence: ent.confidence,
        is_self: false,
        is_own_account: true,
      })
    }

    // Stripe entity_id (cus_xxx) → customer entity (for payment_intent resolution)
    if (a.source === "stripe" && a.source_id) {
      const stripeKey = normalizeForMatch(a.source_id)
      if (stripeKey.length >= 4 && !ctx.has(stripeKey)) {
        ctx.set(stripeKey, {
          entity_id: ent.id,
          role: ent.entity_type as CounterpartyRole,
          canonical_name: ent.canonical_name,
          confidence: ent.confidence,
          is_self: selfTypes.has(ent.entity_type),
          is_own_account: ownAccountTypes.has(ent.entity_type),
        })
      }
    }
  }

  // Owner containment: store owner entries for runtime counterparty → owner name matching
  const ownerEntries = entities
    .filter((e) => e.entity_type === "owner")
    .map((e) => ({
      entity_id: e.id,
      role: "owner" as CounterpartyRole,
      canonical_name: e.canonical_name,
      confidence: e.confidence,
      is_self: false,
      is_own_account: false,
    }))
  ;(ctx as Map<string, MovementIdentityEntry> & { _ownerEntries?: MovementIdentityEntry[] })._ownerEntries = ownerEntries

  return ctx
}

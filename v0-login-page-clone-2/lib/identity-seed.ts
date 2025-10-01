/**
 * Identity resolution engine v2.
 *
 * Extracts identity signals from all raw data stores (QBO, Xero, Stripe, Plaid, Gmail),
 * pre-filters noise (internal transfers, fees, ACH metadata), normalizes via LLM,
 * detects self-entity and known processors, and resolves into a canonical entity graph.
 */

import { query, ensureIdentitySchema } from "./db"
import { log } from "./logger"

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
  "zelle", "cash app", "apple pay", "google pay",
])

function isKnownProcessor(name: string): boolean {
  const n = name.toLowerCase().trim()
  for (const p of KNOWN_PROCESSORS) {
    if (n === p || n.startsWith(p + " ") || n.includes(` ${p}`) || n.includes(`${p}/`)) return true
  }
  return false
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

// ─── Self-entity detection ─────────────────────────────────────────

async function getSelfNames(userId: string): Promise<string[]> {
  const names: string[] = []

  // From QBO CompanyInfo
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
    if (cn) names.push(cn)
    if (ln && ln !== cn) names.push(ln)
  }

  // From qbo_connections.company_name
  const { rows: connRows } = await query<{ company_name: string | null }>(
    "SELECT company_name FROM qbo_connections WHERE user_id = $1",
    [userId]
  )
  for (const r of connRows) {
    if (r.company_name) names.push(r.company_name)
  }

  // From user's company_form
  const { rows: userRows } = await query<{ company_form: Record<string, string> | null }>(
    "SELECT company_form FROM users WHERE id = $1",
    [userId]
  )
  const form = userRows[0]?.company_form
  if (form) {
    if (form.companyName) names.push(form.companyName)
    if (form.legalName && form.legalName !== form.companyName) names.push(form.legalName)
  }

  return [...new Set(names.filter(Boolean))]
}

function isSelfEntity(name: string, selfNames: string[]): boolean {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "")
  for (const sn of selfNames) {
    const snNorm = sn.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (!snNorm || !norm) continue
    if (norm === snNorm) return true
    if (norm.includes(snNorm) || snNorm.includes(norm)) return true
  }
  return false
}

// ─── Signal extraction ─────────────────────────────────────────────

async function extractQboSignals(userId: string, selfNames: string[]): Promise<Signal[]> {
  const signals: Signal[] = []

  const { rows: customers } = await query<{ entity_id: string; data: Record<string, unknown> }>(
    `SELECT e.entity_id, e.data FROM qbo_entities e
     JOIN qbo_connections c ON c.realm_id = e.realm_id
     WHERE c.user_id = $1 AND e.entity_type = 'Customer'`,
    [userId]
  )
  for (const row of customers) {
    const d = row.data
    const displayName = (d.DisplayName ?? d.FullyQualifiedName ?? "") as string
    if (!displayName) continue

    let entityType: EntityType = "customer"
    if (isSelfEntity(displayName, selfNames)) entityType = "internal"
    else if (isKnownProcessor(displayName)) entityType = "processor"

    signals.push({ alias: displayName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.9 })

    const companyName = d.CompanyName as string | undefined
    if (companyName && companyName !== displayName) {
      signals.push({ alias: companyName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.85 })
    }
    const email = (d.PrimaryEmailAddr as Record<string, unknown>)?.Address as string | undefined
    if (email) {
      signals.push({ alias: email.toLowerCase(), alias_type: "email", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.95 })
    }
    const web = (d.WebAddr as Record<string, unknown>)?.URI as string | undefined
    if (web) {
      const domain = extractDomain(web)
      if (domain) signals.push({ alias: domain, alias_type: "domain", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.7 })
    }
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
    if (!displayName) continue

    let entityType: EntityType = "vendor"
    if (isSelfEntity(displayName, selfNames)) entityType = "internal"
    else if (isKnownProcessor(displayName)) entityType = "processor"

    signals.push({ alias: displayName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.9 })

    const companyName = d.CompanyName as string | undefined
    if (companyName && companyName !== displayName) {
      signals.push({ alias: companyName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.85 })
    }
    const email = (d.PrimaryEmailAddr as Record<string, unknown>)?.Address as string | undefined
    if (email) {
      signals.push({ alias: email.toLowerCase(), alias_type: "email", source: "qbo", source_id: row.entity_id, entity_type: entityType, confidence: 0.95 })
    }
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
    signals.push({ alias: displayName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: "employee", confidence: 0.9 })
    const email = (d.PrimaryEmailAddr as Record<string, unknown>)?.Address as string | undefined
    if (email) {
      signals.push({ alias: email.toLowerCase(), alias_type: "email", source: "qbo", source_id: row.entity_id, entity_type: "employee", confidence: 0.95 })
    }
  }

  return signals
}

async function extractXeroSignals(userId: string, selfNames: string[]): Promise<Signal[]> {
  const signals: Signal[] = []

  const { rows: contacts } = await query<{ entity_id: string; data: Record<string, unknown> }>(
    `SELECT e.entity_id, e.data FROM xero_entities e
     JOIN xero_connections c ON c.tenant_id = e.tenant_id
     WHERE c.user_id = $1 AND e.entity_type = 'Contact'`,
    [userId]
  )
  for (const row of contacts) {
    const d = row.data
    const name = d.Name as string | undefined
    if (!name) continue

    const isCustomer = d.IsCustomer === true
    const isSupplier = d.IsSupplier === true
    let entityType: EntityType = isSupplier ? "vendor" : isCustomer ? "customer" : "unknown"
    if (isSelfEntity(name, selfNames)) entityType = "internal"
    else if (isKnownProcessor(name)) entityType = "processor"

    signals.push({ alias: name, alias_type: "name", source: "xero", source_id: row.entity_id, entity_type: entityType, confidence: 0.9 })
    const email = d.EmailAddress as string | undefined
    if (email) {
      signals.push({ alias: email.toLowerCase(), alias_type: "email", source: "xero", source_id: row.entity_id, entity_type: entityType, confidence: 0.95 })
    }
  }

  return signals
}

async function extractStripeSignals(userId: string, selfNames: string[]): Promise<Signal[]> {
  const signals: Signal[] = []

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
    if (isSelfEntity(name, selfNames)) entityType = "internal"

    signals.push({ alias: name, alias_type: "name", source: "stripe", source_id: row.entity_id, entity_type: entityType, confidence: 0.85 })
    const email = d.email as string | undefined
    if (email) {
      signals.push({ alias: email.toLowerCase(), alias_type: "email", source: "stripe", source_id: row.entity_id, entity_type: entityType, confidence: 0.95 })
    }
  }

  return signals
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
    // Prefer merchant_name (cleaner), fall back to name
    const val = r.merchant_name?.trim() || r.name?.trim()
    if (!val) continue
    // Pre-filter noise before sending to LLM
    if (isPlaidNoise(val)) continue
    set.add(val)
  }
  return Array.from(set)
}

async function extractGmailSignals(userId: string): Promise<Signal[]> {
  const signals: Signal[] = []

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
      signals.push({ alias: inv.counterparty_name, alias_type: "name", source: "gmail", source_id: row.message_id, entity_type: cpType, confidence: 0.7 })
    }
    if (inv.counterparty_email) {
      signals.push({ alias: inv.counterparty_email.toLowerCase(), alias_type: "email", source: "gmail", source_id: row.message_id, entity_type: cpType, confidence: 0.8 })
    }
  }

  return signals
}

// ─── LLM normalization for Plaid merchant strings ──────────────────

async function llmNormalizeMerchants(merchants: string[], selfNames: string[]): Promise<LlmNormResult[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || merchants.length === 0) return []

  const results: LlmNormResult[] = []
  const batchSize = 50
  const selfNamesStr = selfNames.length > 0 ? selfNames.join(", ") : "(not provided)"

  for (let i = 0; i < merchants.length; i += batchSize) {
    const batch = merchants.slice(i, i + batchSize)
    const numbered = batch.map((m, idx) => `${idx + 1}. ${m}`).join("\n")

    const systemPrompt = `You are a financial identity normalization engine for a business called "${selfNamesStr}".

Given raw bank transaction descriptions, return a JSON array. Each element:
- "raw": the original string (exactly as given)
- "normalized": the clean canonical company/person name
- "entity_type": one of: "vendor", "customer", "employee", "processor", "owner", "internal", "bank_account", "tax_authority", "lender", "unknown"
- "domain_guess": likely website domain or null
- "skip": true if this is NOT a real counterparty (internal transfers between own accounts, bank fees, interest credits, rate changes, deposit/withdrawal labels, generic ACH metadata). These should not become entities.

Entity type rules:
- "internal": the business itself ("${selfNamesStr}") or its own accounts appearing in transactions
- "owner": the business owner(s) — personal transfers, personal credit card payments by the owner
- "processor": payment intermediaries — Shopify, Melio, PayPal, Square, Stripe, Gusto, ADP, Chase, Wells Fargo, Intuit, Zelle, Venmo, etc.
- "bank_account": bank-to-bank transfers, money market movements, account-to-account transfers (set skip=true for these)
- "employee": individuals receiving payroll or reimbursements
- "tax_authority": IRS, state tax agencies, sales tax payments
- "lender": loan providers, credit lines
- "vendor": companies the business pays for goods/services
- "customer": companies/people who pay the business

Normalization rules:
- Strip prefixes: "SQ *", "TST*", "PAYPAL *", "PREAUTHORIZED ACH CREDIT/DEBIT", "MISCELLANEOUS CREDIT/DEBIT", "TRANSFER CREDIT/DEBIT", etc.
- Strip suffixes: reference numbers, routing info, addresses, timestamps
- For ACH descriptions like "PIVOT CULINARY M/ACH Pmt Invoice 1029...", extract just the company name: "Pivot Culinary"
- For Zelle transfers like "ZELLE MICHELLE SCHOR", extract just the person name: "Michelle Schor"
- Merge variations: "Shopify", "SHOPIFY/SHOPIFY ST-...", "Shopify - USD" → all normalize to "Shopify"
- If the same real entity appears with different descriptions, normalize to the same canonical name
- Names with parenthetical context like "Brenna Sleggs (Pittsburgh Penguins)" should normalize to "Brenna Sleggs" with the context preserved in domain_guess or dropped

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

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").trim()
}

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

async function findCandidateEntity(
  signal: Signal,
  existingEntities: EntityRow[],
  existingAliases: Map<string, AliasRow[]>
): Promise<{ entityId: string; matchScore: number } | null> {
  // 1. Exact alias match (email or account_ref)
  if (signal.alias_type === "email" || signal.alias_type === "account_ref") {
    for (const ent of existingEntities) {
      const aliases = existingAliases.get(ent.id) ?? []
      for (const a of aliases) {
        if (a.alias_type === signal.alias_type && a.alias.toLowerCase() === signal.alias.toLowerCase()) {
          return { entityId: ent.id, matchScore: 0.95 }
        }
      }
    }
  }

  // 2. Normalized name match (exact, then with parenthetical stripped, then substring)
  if (signal.alias_type === "name" || signal.alias_type === "merchant_string") {
    const norm = normalizeForMatch(signal.alias)
    const normStripped = normalizeForMatch(stripParenthetical(signal.alias))
    if (norm.length < 2) return null

    for (const ent of existingEntities) {
      const entNorm = normalizeForMatch(ent.canonical_name)
      const entNormStripped = normalizeForMatch(stripParenthetical(ent.canonical_name))

      // Exact match
      if (entNorm === norm || entNormStripped === normStripped) {
        return { entityId: ent.id, matchScore: 0.85 }
      }
      // Substring: one fully contains the other (handles truncated Plaid names)
      if (norm.length >= 4 && entNorm.length >= 4) {
        if (entNorm.includes(norm) || norm.includes(entNorm)) {
          return { entityId: ent.id, matchScore: 0.75 }
        }
      }

      // Check aliases
      const aliases = existingAliases.get(ent.id) ?? []
      for (const a of aliases) {
        if (a.alias_type !== "name" && a.alias_type !== "merchant_string") continue
        const aNorm = normalizeForMatch(a.alias)
        const aNormStripped = normalizeForMatch(stripParenthetical(a.alias))
        if (aNorm === norm || aNormStripped === normStripped) {
          return { entityId: ent.id, matchScore: 0.8 }
        }
        if (norm.length >= 4 && aNorm.length >= 4 && (aNorm.includes(norm) || norm.includes(aNorm))) {
          return { entityId: ent.id, matchScore: 0.7 }
        }
      }
    }
  }

  // 3. Domain match
  if (signal.alias_type === "domain") {
    for (const ent of existingEntities) {
      const aliases = existingAliases.get(ent.id) ?? []
      for (const a of aliases) {
        if (a.alias_type === "domain" && a.alias === signal.alias) {
          return { entityId: ent.id, matchScore: 0.7 }
        }
      }
    }
  }

  // 4. Email domain cross-match
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
}> {
  await ensureIdentitySchema()

  const stats = {
    entitiesCreated: 0, entitiesUpdated: 0, aliasesCreated: 0,
    assertionsCreated: 0, plaidMerchantsNormalized: 0, plaidSkipped: 0,
    selfEntities: 0, processorsDetected: 0,
  }

  log("identity.seed.start", { userId }, "identity")

  // Detect self-entity names
  const selfNames = await getSelfNames(userId)
  log("identity.seed.self_names", { userId, selfNames }, "identity")

  // Phase 1: Collect signals from accounting tools + Gmail
  const [qboSignals, xeroSignals, stripeSignals, gmailSignals] = await Promise.all([
    extractQboSignals(userId, selfNames),
    extractXeroSignals(userId, selfNames),
    extractStripeSignals(userId, selfNames),
    extractGmailSignals(userId),
  ])

  // Phase 2: LLM-normalize Plaid merchant strings (pre-filtered)
  const plaidMerchants = await extractPlaidMerchantStrings(userId)
  const normalized = await llmNormalizeMerchants(plaidMerchants, selfNames)

  const plaidSignals: Signal[] = []
  for (const n of normalized) {
    if (n.skip) {
      stats.plaidSkipped++
      continue
    }
    stats.plaidMerchantsNormalized++

    let entityType = validEntityType(n.entity_type)

    // Override with known-processor detection
    if (isKnownProcessor(n.normalized)) entityType = "processor"
    if (isSelfEntity(n.normalized, selfNames)) entityType = "internal"

    if (entityType === "processor") stats.processorsDetected++
    if (entityType === "internal") stats.selfEntities++

    plaidSignals.push({
      alias: n.normalized,
      alias_type: "name",
      source: "plaid",
      source_id: null,
      entity_type: entityType,
      confidence: 0.8,
      extra: { raw_merchant: n.raw },
    })
    // Also store the raw string as a merchant_string alias for future matching
    plaidSignals.push({
      alias: n.raw,
      alias_type: "merchant_string",
      source: "plaid",
      source_id: null,
      entity_type: entityType,
      confidence: 0.6,
    })
    if (n.domain_guess) {
      plaidSignals.push({
        alias: n.domain_guess,
        alias_type: "domain",
        source: "plaid",
        source_id: null,
        entity_type: entityType,
        confidence: 0.6,
      })
    }
  }

  // Create self-entity signal if we have self names
  const selfSignals: Signal[] = []
  for (const sn of selfNames) {
    selfSignals.push({
      alias: sn,
      alias_type: "name",
      source: "system",
      source_id: null,
      entity_type: "internal",
      confidence: 0.99,
    })
  }

  const allSignals = [...selfSignals, ...qboSignals, ...xeroSignals, ...stripeSignals, ...plaidSignals, ...gmailSignals]
  log("identity.seed.signals_collected", {
    userId,
    self: selfSignals.length,
    qbo: qboSignals.length,
    xero: xeroSignals.length,
    stripe: stripeSignals.length,
    plaid: plaidSignals.length,
    gmail: gmailSignals.length,
    total: allSignals.length,
    plaidSkipped: stats.plaidSkipped,
  }, "identity")

  // Phase 3: Resolve signals into entities
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

  // Process signals: highest confidence first
  const prioritized = allSignals.sort((a, b) => b.confidence - a.confidence)

  for (const signal of prioritized) {
    if (!signal.alias || signal.alias.trim().length === 0) continue

    const candidate = await findCandidateEntity(signal, entities, aliasMap)

    let entityId: string

    if (candidate && candidate.matchScore >= 0.6) {
      entityId = candidate.entityId
      stats.entitiesUpdated++

      const newConfidence = Math.min(1, candidate.matchScore * 0.5 + signal.confidence * 0.5)
      await query(
        `UPDATE entities SET confidence = GREATEST(confidence, $1), updated_at = NOW() WHERE id = $2`,
        [newConfidence, entityId]
      )
      const ent = entities.find((e) => e.id === entityId)
      if (ent) ent.confidence = Math.max(ent.confidence, newConfidence)
    } else {
      // Use the stripped name as canonical (no parenthetical context)
      const canonicalName = signal.alias_type === "email"
        ? signal.alias.split("@")[0] ?? signal.alias
        : stripParenthetical(signal.alias)

      const { rows: inserted } = await query<{ id: string }>(
        `INSERT INTO entities (user_id, entity_type, canonical_name, display_name, confidence)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, canonical_name, entity_type) DO UPDATE SET
           confidence = GREATEST(entities.confidence, EXCLUDED.confidence),
           updated_at = NOW()
         RETURNING id`,
        [userId, signal.entity_type, canonicalName, signal.alias, signal.confidence]
      )
      entityId = inserted[0]?.id
      if (!entityId) continue
      stats.entitiesCreated++

      entities.push({ id: entityId, canonical_name: canonicalName, entity_type: signal.entity_type, confidence: signal.confidence })
    }

    // Upsert alias
    await query(
      `INSERT INTO entity_aliases (entity_id, alias, alias_type, source, source_id, confidence)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (entity_id, alias, alias_type, source) DO UPDATE SET
         confidence = GREATEST(entity_aliases.confidence, EXCLUDED.confidence)`,
      [entityId, signal.alias, signal.alias_type, signal.source, signal.source_id, signal.confidence]
    )
    stats.aliasesCreated++

    // Add domain alias from email signals
    if (signal.alias_type === "email") {
      const domain = extractDomain(signal.alias)
      if (domain) {
        await query(
          `INSERT INTO entity_aliases (entity_id, alias, alias_type, source, source_id, confidence)
           VALUES ($1, $2, 'domain', $3, $4, $5)
           ON CONFLICT (entity_id, alias, alias_type, source) DO NOTHING`,
          [entityId, domain, signal.source, signal.source_id, 0.6]
        )
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

    // Update alias map for subsequent lookups
    const existing = aliasMap.get(entityId) ?? []
    existing.push({ alias: signal.alias, alias_type: signal.alias_type, source: signal.source })
    aliasMap.set(entityId, existing)
  }

  // Record resolution decision
  await query(
    `INSERT INTO identity_resolution_decisions (user_id, decision_type, reason)
     VALUES ($1, 'auto_create', $2)`,
    [userId, `Seeded ${stats.entitiesCreated} new, updated ${stats.entitiesUpdated}, skipped ${stats.plaidSkipped} noise, from ${allSignals.length} signals`]
  )

  log("identity.seed.done", { userId, ...stats }, "identity")
  return stats
}

/**
 * Identity resolution engine.
 *
 * Extracts identity signals from all raw data stores (QBO, Xero, Stripe, Plaid, Gmail),
 * normalizes noisy merchant strings via LLM, and resolves them into a canonical entity graph.
 */

import { query, ensureIdentitySchema } from "./db"
import { log } from "./logger"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

// ─── Types ─────────────────────────────────────────────────────────

type Signal = {
  alias: string
  alias_type: "name" | "email" | "domain" | "merchant_string" | "account_ref" | "phone"
  source: "qbo" | "xero" | "stripe" | "plaid" | "gmail" | "user"
  source_id: string | null
  entity_type: "vendor" | "customer" | "employee" | "processor" | "internal" | "unknown"
  confidence: number
  extra?: Record<string, unknown>
}

type LlmNormResult = {
  raw: string
  normalized: string
  entity_type: "vendor" | "customer" | "processor" | "unknown"
  domain_guess: string | null
}

// ─── Signal extraction ─────────────────────────────────────────────

async function extractQboSignals(userId: string): Promise<Signal[]> {
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
    if (displayName) {
      signals.push({ alias: displayName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: "customer", confidence: 0.9 })
    }
    const companyName = d.CompanyName as string | undefined
    if (companyName && companyName !== displayName) {
      signals.push({ alias: companyName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: "customer", confidence: 0.85 })
    }
    const email = (d.PrimaryEmailAddr as Record<string, unknown>)?.Address as string | undefined
    if (email) {
      signals.push({ alias: email.toLowerCase(), alias_type: "email", source: "qbo", source_id: row.entity_id, entity_type: "customer", confidence: 0.95 })
    }
    const web = (d.WebAddr as Record<string, unknown>)?.URI as string | undefined
    if (web) {
      const domain = extractDomain(web)
      if (domain) signals.push({ alias: domain, alias_type: "domain", source: "qbo", source_id: row.entity_id, entity_type: "customer", confidence: 0.7 })
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
    if (displayName) {
      signals.push({ alias: displayName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: "vendor", confidence: 0.9 })
    }
    const companyName = d.CompanyName as string | undefined
    if (companyName && companyName !== displayName) {
      signals.push({ alias: companyName, alias_type: "name", source: "qbo", source_id: row.entity_id, entity_type: "vendor", confidence: 0.85 })
    }
    const email = (d.PrimaryEmailAddr as Record<string, unknown>)?.Address as string | undefined
    if (email) {
      signals.push({ alias: email.toLowerCase(), alias_type: "email", source: "qbo", source_id: row.entity_id, entity_type: "vendor", confidence: 0.95 })
    }
  }

  return signals
}

async function extractXeroSignals(userId: string): Promise<Signal[]> {
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
    const isCustomer = d.IsCustomer === true
    const isSupplier = d.IsSupplier === true
    const entityType = isSupplier ? "vendor" : isCustomer ? "customer" : "unknown"

    if (name) {
      signals.push({ alias: name, alias_type: "name", source: "xero", source_id: row.entity_id, entity_type: entityType as Signal["entity_type"], confidence: 0.9 })
    }
    const email = d.EmailAddress as string | undefined
    if (email) {
      signals.push({ alias: email.toLowerCase(), alias_type: "email", source: "xero", source_id: row.entity_id, entity_type: entityType as Signal["entity_type"], confidence: 0.95 })
    }
  }

  return signals
}

async function extractStripeSignals(userId: string): Promise<Signal[]> {
  const signals: Signal[] = []

  const { rows: customers } = await query<{ entity_id: string; data: Record<string, unknown> }>(
    `SELECT entity_id, data FROM stripe_entities
     WHERE user_id = $1 AND entity_type = 'customer'`,
    [userId]
  )
  for (const row of customers) {
    const d = row.data
    const name = d.name as string | undefined
    if (name) {
      signals.push({ alias: name, alias_type: "name", source: "stripe", source_id: row.entity_id, entity_type: "customer", confidence: 0.85 })
    }
    const email = d.email as string | undefined
    if (email) {
      signals.push({ alias: email.toLowerCase(), alias_type: "email", source: "stripe", source_id: row.entity_id, entity_type: "customer", confidence: 0.95 })
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
    const val = r.merchant_name?.trim() || r.name?.trim()
    if (val) set.add(val)
  }
  return Array.from(set)
}

async function extractGmailSignals(userId: string): Promise<Signal[]> {
  const signals: Signal[] = []

  // Gmail connections are not user-scoped in the current schema, so we query all extracted invoices.
  // In a multi-user setup this would need a user_id column on gmail_synced_messages.
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
    const cpType = inv.counterparty_type === "vendor" ? "vendor" : inv.counterparty_type === "customer" ? "customer" : "unknown"
    if (inv.counterparty_name) {
      signals.push({ alias: inv.counterparty_name, alias_type: "name", source: "gmail", source_id: row.message_id, entity_type: cpType as Signal["entity_type"], confidence: 0.7 })
    }
    if (inv.counterparty_email) {
      signals.push({ alias: inv.counterparty_email.toLowerCase(), alias_type: "email", source: "gmail", source_id: row.message_id, entity_type: cpType as Signal["entity_type"], confidence: 0.8 })
    }
  }

  return signals
}

// ─── LLM normalization for Plaid merchant strings ──────────────────

async function llmNormalizeMerchants(merchants: string[]): Promise<LlmNormResult[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || merchants.length === 0) return []

  const results: LlmNormResult[] = []
  const batchSize = 50

  for (let i = 0; i < merchants.length; i += batchSize) {
    const batch = merchants.slice(i, i + batchSize)
    const numbered = batch.map((m, idx) => `${idx + 1}. ${m}`).join("\n")

    const systemPrompt = `You are a financial data normalization engine. Given a list of raw bank transaction merchant strings, return a JSON array where each element has:
- "raw": the original string (exactly as given)
- "normalized": the clean, canonical company/entity name
- "entity_type": one of "vendor", "customer", "processor", "unknown"
- "domain_guess": the likely website domain (e.g. "heroku.com") or null if unknown

Rules:
- Strip transaction prefixes like "SQ *", "TST*", "PAYPAL *", card network codes, location suffixes, and reference numbers.
- "entity_type" should be "processor" for payment intermediaries (PayPal, Square, Stripe, Gusto, ADP, etc.), "vendor" for most merchants, "customer" if it looks like an incoming payment from a client.
- Output ONLY valid JSON array. No markdown, no explanation.`

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Normalize these merchant strings:\n${numbered}` },
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

function extractDomain(urlOrEmail: string): string | null {
  try {
    if (urlOrEmail.includes("@")) return urlOrEmail.split("@")[1]?.toLowerCase() ?? null
    const u = new URL(urlOrEmail.startsWith("http") ? urlOrEmail : `https://${urlOrEmail}`)
    return u.hostname.replace(/^www\./, "")
  } catch {
    return null
  }
}

type EntityRow = { id: string; canonical_name: string; entity_type: string; confidence: number }
type AliasRow = { alias: string; alias_type: string; source: string }

async function findCandidateEntity(
  userId: string,
  signal: Signal,
  existingEntities: EntityRow[],
  existingAliases: Map<string, AliasRow[]>
): Promise<{ entityId: string; matchScore: number } | null> {
  // 1. Exact alias match (email or account_ref → very high confidence)
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

  // 2. Normalized name match
  if (signal.alias_type === "name" || signal.alias_type === "merchant_string") {
    const norm = normalizeForMatch(signal.alias)
    if (norm.length < 2) return null
    for (const ent of existingEntities) {
      if (normalizeForMatch(ent.canonical_name) === norm) {
        return { entityId: ent.id, matchScore: 0.8 }
      }
      const aliases = existingAliases.get(ent.id) ?? []
      for (const a of aliases) {
        if ((a.alias_type === "name" || a.alias_type === "merchant_string") && normalizeForMatch(a.alias) === norm) {
          return { entityId: ent.id, matchScore: 0.75 }
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

  // 4. Email domain cross-match: if signal is a name, check if any entity has an email whose domain contains the normalized name
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
}> {
  await ensureIdentitySchema()

  const stats = { entitiesCreated: 0, entitiesUpdated: 0, aliasesCreated: 0, assertionsCreated: 0, plaidMerchantsNormalized: 0 }

  // Phase 1: Collect all signals from accounting tools + Gmail
  log("identity.seed.start", { userId }, "identity")
  const [qboSignals, xeroSignals, stripeSignals, gmailSignals] = await Promise.all([
    extractQboSignals(userId),
    extractXeroSignals(userId),
    extractStripeSignals(userId),
    extractGmailSignals(userId),
  ])

  // Phase 2: LLM-normalize Plaid merchant strings and convert to signals
  const plaidMerchants = await extractPlaidMerchantStrings(userId)
  const normalized = await llmNormalizeMerchants(plaidMerchants)
  stats.plaidMerchantsNormalized = normalized.length

  const plaidSignals: Signal[] = []
  for (const n of normalized) {
    plaidSignals.push({
      alias: n.normalized,
      alias_type: "name",
      source: "plaid",
      source_id: null,
      entity_type: (n.entity_type === "vendor" || n.entity_type === "customer" || n.entity_type === "processor") ? n.entity_type : "vendor",
      confidence: 0.8,
      extra: { raw_merchant: n.raw },
    })
    // Also store the raw string as a merchant_string alias
    plaidSignals.push({
      alias: n.raw,
      alias_type: "merchant_string",
      source: "plaid",
      source_id: null,
      entity_type: (n.entity_type === "vendor" || n.entity_type === "customer" || n.entity_type === "processor") ? n.entity_type : "vendor",
      confidence: 0.6,
    })
    if (n.domain_guess) {
      plaidSignals.push({
        alias: n.domain_guess,
        alias_type: "domain",
        source: "plaid",
        source_id: null,
        entity_type: (n.entity_type === "vendor" || n.entity_type === "customer" || n.entity_type === "processor") ? n.entity_type : "vendor",
        confidence: 0.6,
      })
    }
  }

  const allSignals = [...qboSignals, ...xeroSignals, ...stripeSignals, ...plaidSignals, ...gmailSignals]
  log("identity.seed.signals_collected", {
    userId,
    qbo: qboSignals.length,
    xero: xeroSignals.length,
    stripe: stripeSignals.length,
    plaid: plaidSignals.length,
    gmail: gmailSignals.length,
    total: allSignals.length,
  }, "identity")

  // Phase 3: Resolve signals into entities
  // Load existing entities for this user
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

  let aliasMap = await loadAliases()

  // Process signals in priority order: accounting tools first (highest confidence), then Plaid, then Gmail
  const prioritized = allSignals.sort((a, b) => b.confidence - a.confidence)

  for (const signal of prioritized) {
    if (!signal.alias || signal.alias.trim().length === 0) continue

    const candidate = await findCandidateEntity(userId, signal, entities, aliasMap)

    let entityId: string

    if (candidate && candidate.matchScore >= 0.6) {
      entityId = candidate.entityId
      stats.entitiesUpdated++

      // Update confidence if this new evidence is stronger
      const newConfidence = Math.min(1, candidate.matchScore * 0.5 + signal.confidence * 0.5)
      await query(
        `UPDATE entities SET confidence = GREATEST(confidence, $1), updated_at = NOW() WHERE id = $2`,
        [newConfidence, entityId]
      )
      const ent = entities.find((e) => e.id === entityId)
      if (ent) ent.confidence = Math.max(ent.confidence, newConfidence)
    } else {
      // Create new entity
      const canonicalName = signal.alias_type === "merchant_string"
        ? signal.alias
        : signal.alias_type === "email"
          ? signal.alias.split("@")[0] ?? signal.alias
          : signal.alias

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
    [userId, `Seeded ${stats.entitiesCreated} entities, updated ${stats.entitiesUpdated}, from ${allSignals.length} signals`]
  )

  log("identity.seed.done", { userId, ...stats }, "identity")
  return stats
}

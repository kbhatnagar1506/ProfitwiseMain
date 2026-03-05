// Test commit: GitHub collaboration verified ✅
// This file is part of the ProfitWise financial intelligence platform
import Supermemory from "supermemory"
import { log } from "./logger"

/** LLM filter prompt for ingestion: company context + financial context (ProfitWise context layer). */
const FILTER_PROMPT = `ProfitWise context layer. Index content that describes the organization and its finances so ProfitWise can deliver accurate insights and AI-assisted decisions.

INCLUDE / EXTRACT:
- Company context: Legal name, DBA, industry, business model, products/services, entity type, fiscal year, locations, org structure, and any description of what the company does and how it makes money.
- How they operate: Core workflows (quote-to-cash, procure-to-pay), approval chains, key systems (ERP, CRM, banking), and who owns finance/ops.
- Vendors & suppliers: Names, categories, contract and payment terms, key contacts, and notes on important or high-spend relationships.
- Financial metrics: Revenue, margins, ARR/MRR, growth rates, KPIs with numbers and time periods.
- Budgets: Headcount, department/project budgets, spend by category, budget vs actual.
- Compliance: Audit outcomes, tax/regulatory deadlines, control findings.
- Policies: Approval thresholds, expense and reimbursement rules, PO and invoice workflows.
- Forecasts: Runway, burn, revenue and cost projections, scenario analysis.

SKIP:
- Speculative market or industry commentary without data backing.
- Duplicate reporting of the same metric across documents.
- Personal financial data of individual employees (salaries, bank details, PII).`

export function getAppBaseUrl(): string {
  // Hardcode production dashboard URL to avoid any localhost misconfiguration
  return "https://dashboard.profitwise.app"
}

export function getOrgFinanceTag(): string {
  return process.env.SUPERMEMORY_DEFAULT_FINANCE_TAG ?? "org_profitwise_finance"
}

function getFinanceTagPrefix(): string {
  return process.env.SUPERMEMORY_DEFAULT_FINANCE_TAG ?? "org_profitwise_finance"
}

/** Per-user container tag so each user's connections and context are isolated. */
export function getUserFinanceTag(userId: string): string {
  const prefix = getFinanceTagPrefix()
  const safe = String(userId).replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 80)
  return `${prefix}_user_${safe}`
}

export type SupermemoryProvider = "google-drive" | "onedrive" | "notion"

let supermemoryClient: Supermemory | null = null

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
  } catch {
    return false
  }
}

function normalizeAuthLink(authLink: string, redirectUrl: string): string {
  try {
    const url = new URL(authLink)
    const callbackParamKeys = [
      "redirect_uri",
      "redirectUri",
      "redirect_url",
      "redirectUrl",
      "callback_url",
      "callbackUrl",
    ]

    let changed = false
    for (const key of callbackParamKeys) {
      const current = url.searchParams.get(key)
      if (current && isLocalhostUrl(current)) {
        url.searchParams.set(key, redirectUrl)
        changed = true
      }
    }

    if (!changed) return authLink
    return url.toString()
  } catch {
    return authLink
  }
}

function getClient(): Supermemory {
  if (!supermemoryClient) {
    const apiKey = process.env.SUPERMEMORY_API_KEY
    if (!apiKey) {
      throw new Error("SUPERMEMORY_API_KEY is not set")
    }
    supermemoryClient = new Supermemory({ apiKey })
  }
  return supermemoryClient
}

/** Ensure org-level LLM filter is set so connector ingestion uses company + financial context. */
async function ensureLLMFilterSettings(): Promise<void> {
  const client = getClient()
  try {
    await client.settings.update({
      shouldLLMFilter: true,
      filterPrompt: FILTER_PROMPT,
    })
    log("supermemory.llm_filter.ensured", undefined, "supermemory")
  } catch (err) {
    log("supermemory.llm_filter.failed", { error: err instanceof Error ? err.message : String(err) }, "supermemory")
    // non-fatal: connection can still be created
  }
}

export async function createSupermemoryConnection(
  provider: SupermemoryProvider,
  userId: string
): Promise<{ authLink: string; id: string; redirectsTo?: string; expiresIn?: string }> {
  const client = getClient()
  const baseUrl = getAppBaseUrl()
  const containerTag = getUserFinanceTag(userId)

  await ensureLLMFilterSettings()

  const redirectUrl = `${baseUrl}/api/supermemory/oauth/${provider}/callback`

  const connection = await client.connections.create(provider, {
    redirectUrl,
    containerTags: [containerTag],
    documentLimit: 10000,
    metadata: {
      source: provider,
      department: "finance",
      region: "us",
    },
  })
  const { authLink, expiresIn, id, redirectsTo } = connection as {
    authLink: string
    expiresIn?: string
    id: string
    redirectsTo?: string
  }

  const normalizedAuthLink = normalizeAuthLink(authLink, redirectUrl)

  if (!normalizedAuthLink || !id) {
    throw new Error("Supermemory connection response missing authLink or id")
  }

  log("connection.create.succeeded", {
    provider,
    id,
    redirectUrl,
    redirectsTo: redirectsTo ?? null,
    authLinkOriginalHost: (() => {
      try {
        return new URL(authLink).host
      } catch {
        return null
      }
    })(),
    authLinkHost: (() => {
      try {
        return new URL(normalizedAuthLink).host
      } catch {
        return null
      }
    })(),
    authLinkRewritten: normalizedAuthLink !== authLink,
  }, "supermemory")
  return {
    authLink: normalizedAuthLink,
    id,
    redirectsTo,
    expiresIn,
  }
}

/** Ingest final context (company + financial merged) into Supermemory so it is searchable. Uses customId so repeated saves update the same document. */
export async function addFinalContextToSupermemory(content: string, customId: string, userId: string): Promise<void> {
  const client = getClient()
  const containerTag = getUserFinanceTag(userId)
  const id = customId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)
  await client.add({
    content,
    containerTag,
    customId: id || `final_context_${Date.now()}`,
    metadata: { source: "profitwise_final_context" },
  })
  log("supermemory.final_context.added", { customId: id }, "supermemory")
}

/** Entity hint for Supermemory: canonical name + aliases. */
export type EntityHintForSupermemory = { canonical_name: string; aliases: string[] }

/** Store all entities in Supermemory for semantic search. Unlimited context — LLM retrieves relevant entities per batch. */
export async function addEntitiesToSupermemory(
  userId: string,
  entityHints: EntityHintForSupermemory[]
): Promise<void> {
  if (entityHints.length === 0) return
  if (!process.env.SUPERMEMORY_API_KEY) return
  try {
    const client = getClient()
    const containerTag = getUserFinanceTag(userId)
    const content = entityHints
      .map(
        (e) =>
          `Entity: "${e.canonical_name}". Aliases: ${e.aliases.slice(0, 20).join(", ") || "—"}. Use this canonical name when normalizing.`
      )
      .join("\n\n")
    await client.add({
      content,
      containerTag,
      customId: `entities_${userId}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
      metadata: { source: "profitwise_entities" },
    })
    log("supermemory.entities.added", { userId, count: entityHints.length }, "supermemory")
  } catch (err) {
    log("supermemory.entities.failed", { userId, error: err instanceof Error ? err.message : String(err) }, "supermemory")
  }
}

/** Search Supermemory for entity context relevant to merchant strings. Returns relevant snippets for LLM. */
export async function searchEntityContextFromSupermemory(
  userId: string,
  merchantStrings: string
): Promise<string> {
  if (!process.env.SUPERMEMORY_API_KEY || !merchantStrings.trim()) return ""
  try {
    const client = getClient()
    const containerTag = getUserFinanceTag(userId)
    const searchRes = await client.search.execute({
      q: merchantStrings.slice(0, 500),
      containerTags: [containerTag],
      limit: 25,
      includeSummary: true,
      chunkThreshold: 0.3,
    })
    const results = (searchRes as { results?: Array<{ chunks?: Array<{ content?: string }>; summary?: string | null; content?: string | null }> })?.results ?? []
    const snippets: string[] = []
    const seen = new Set<string>()
    for (const r of results) {
      if (r.summary && !seen.has(r.summary)) {
        seen.add(r.summary)
        snippets.push(r.summary)
      }
      if (r.content && !seen.has(r.content)) {
        seen.add(r.content)
        snippets.push(r.content)
      }
      for (const ch of r.chunks ?? []) {
        if (ch.content && !seen.has(ch.content)) {
          seen.add(ch.content)
          snippets.push(ch.content)
        }
      }
    }
    if (snippets.length === 0) return ""
    return `Existing entities (use as hints — prefer these canonical names when a raw description matches):\n${snippets.join("\n\n")}\n\nWhen a raw description clearly refers to an existing entity, set normalized to that entity's canonical name.`
  } catch {
    return ""
  }
}

/** Search Supermemory for entity-specific context (contracts, payment terms, relationships). */
export async function searchEntityProfileContext(
  userId: string,
  entityName: string,
  entityType: "customer" | "vendor" | null
): Promise<{ contractTerms: string | null; relationshipNotes: string | null; rawContext: string }> {
  if (!process.env.SUPERMEMORY_API_KEY || !entityName.trim()) {
    return { contractTerms: null, relationshipNotes: null, rawContext: "" }
  }
  try {
    const client = getClient()
    const containerTag = getUserFinanceTag(userId)
    
    // Search for contract terms, payment terms, and relationship context
    const typeHint = entityType === "customer" ? "customer client" : entityType === "vendor" ? "vendor supplier" : ""
    const searchQuery = `${entityName} ${typeHint} contract payment terms agreement relationship`.trim()
    
    const searchRes = await client.search.execute({
      q: searchQuery.slice(0, 500),
      containerTags: [containerTag],
      limit: 15,
      includeSummary: true,
      chunkThreshold: 0.35,
    })
    
    const results = (searchRes as { results?: Array<{ chunks?: Array<{ content?: string }>; summary?: string | null; content?: string | null }> })?.results ?? []
    const snippets: string[] = []
    const seen = new Set<string>()
    
    for (const r of results) {
      if (r.summary && !seen.has(r.summary)) {
        seen.add(r.summary)
        snippets.push(r.summary)
      }
      if (r.content && !seen.has(r.content)) {
        seen.add(r.content)
        snippets.push(r.content)
      }
      for (const ch of r.chunks ?? []) {
        if (ch.content && !seen.has(ch.content)) {
          seen.add(ch.content)
          snippets.push(ch.content)
        }
      }
    }
    
    if (snippets.length === 0) {
      return { contractTerms: null, relationshipNotes: null, rawContext: "" }
    }
    
    const rawContext = snippets.join("\n\n").slice(0, 3000)
    
    // Extract contract terms and relationship notes using simple pattern matching
    let contractTerms: string | null = null
    let relationshipNotes: string | null = null
    
    const lowerContext = rawContext.toLowerCase()
    
    // Look for payment terms patterns
    const paymentTermsPatterns = [
      /net\s*(\d+)/i,
      /payment\s*terms?[:\s]+([^.]+)/i,
      /due\s*in\s*(\d+)\s*days/i,
      /(\d+)\s*days?\s*payment/i,
    ]
    for (const pattern of paymentTermsPatterns) {
      const match = rawContext.match(pattern)
      if (match) {
        contractTerms = match[0].trim()
        break
      }
    }
    
    // Look for relationship context
    if (lowerContext.includes("strategic") || lowerContext.includes("key account") || lowerContext.includes("important")) {
      relationshipNotes = "Strategic/key relationship"
    } else if (lowerContext.includes("preferred") || lowerContext.includes("primary")) {
      relationshipNotes = "Preferred partner"
    } else if (lowerContext.includes("new") && (lowerContext.includes("relationship") || lowerContext.includes("account"))) {
      relationshipNotes = "New relationship"
    }
    
    log("supermemory.entity_profile_context.searched", { 
      userId, 
      entityName, 
      resultsCount: results.length,
      hasContractTerms: !!contractTerms,
      hasRelationshipNotes: !!relationshipNotes,
    }, "supermemory")
    
    return { contractTerms, relationshipNotes, rawContext }
  } catch (err) {
    log("supermemory.entity_profile_context.failed", { 
      userId, 
      entityName, 
      error: err instanceof Error ? err.message : String(err) 
    }, "supermemory")
    return { contractTerms: null, relationshipNotes: null, rawContext: "" }
  }
}

/** Store entity profile in Supermemory for AI chat access. */
export async function addEntityProfileToSupermemory(
  userId: string,
  profile: {
    entityId: string
    canonicalName: string
    entityType: "customer" | "vendor" | null
    archetype: string | null
    lifetimeValue: number | null
    outstandingAmount: number | null
    overdueAmount: number | null
    avgDaysToPay: number | null
    onTimePaymentRate: number | null
    transactionCount: number
    riskScore: number | null
    riskFactors: string[] | null
    aiSummary: string | null
  }
): Promise<void> {
  if (!process.env.SUPERMEMORY_API_KEY) return
  try {
    const client = getClient()
    const containerTag = getUserFinanceTag(userId)
    
    const typeLabel = profile.entityType === "customer" ? "Customer" : profile.entityType === "vendor" ? "Vendor" : "Entity"
    const formatCurrency = (amt: number | null) => {
      if (amt === null || amt === undefined) return "$0"
      if (Math.abs(amt) >= 1000000) return `$${(amt / 1000000).toFixed(1)}M`
      if (Math.abs(amt) >= 1000) return `$${(amt / 1000).toFixed(1)}K`
      return `$${amt.toFixed(0)}`
    }
    
    const content = `
${typeLabel} Profile: ${profile.canonicalName}

Payment Behavior:
- Archetype: ${profile.archetype || "Unknown"}
- Average days to pay: ${profile.avgDaysToPay?.toFixed(0) ?? "N/A"} days
- On-time payment rate: ${profile.onTimePaymentRate != null ? (profile.onTimePaymentRate * 100).toFixed(0) + "%" : "N/A"}
- Total transactions: ${profile.transactionCount}

Financial Summary:
- Lifetime value: ${formatCurrency(profile.lifetimeValue)}
- Outstanding amount: ${formatCurrency(profile.outstandingAmount)}
- Overdue amount: ${formatCurrency(profile.overdueAmount)}

Risk Assessment:
- Risk score: ${profile.riskScore != null ? (profile.riskScore * 100).toFixed(0) + "%" : "N/A"}
- Risk factors: ${profile.riskFactors?.length ? profile.riskFactors.join(", ") : "None identified"}

AI Summary: ${profile.aiSummary || "No summary available"}
`.trim()

    const safeEntityId = profile.entityId.replace(/[^a-zA-Z0-9_-]/g, "_")
    await client.add({
      content,
      containerTag,
      customId: `entity_profile_${safeEntityId}`,
      metadata: { 
        source: "profitwise_entity_profile",
        entity_type: profile.entityType || "unknown",
        entity_name: profile.canonicalName,
      },
    })
    
    log("supermemory.entity_profile.added", { 
      userId, 
      entityId: profile.entityId, 
      entityName: profile.canonicalName 
    }, "supermemory")
  } catch (err) {
    log("supermemory.entity_profile.failed", { 
      userId, 
      entityId: profile.entityId, 
      error: err instanceof Error ? err.message : String(err) 
    }, "supermemory")
  }
}

/** Save a merchant override to Supermemory so future normalizations use it. One document per merchant (customId = merchant_${userId}_${accountId}_${rawName}). */
export async function addMerchantOverrideToSupermemory(
  userId: string,
  accountId: string,
  rawName: string,
  normalizedName: string,
  tag: string,
  transactionType: string
): Promise<void> {
  const client = getClient()
  const containerTag = getUserFinanceTag(userId)
  const safeRaw = rawName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)
  const customId = `merchant_${userId}_${accountId}_${safeRaw}`.replace(/\s+/g, "_")
  const content = `Merchant override (user-confirmed): Raw name "${rawName}" should be normalized as "${normalizedName}", category tag "${tag}", transaction type "${transactionType}". Use this for future categorization.`
  await client.add({
    content,
    containerTag,
    customId,
    metadata: { source: "profitwise_merchant_override" },
  })
  log("supermemory.merchant_override.added", { customId }, "supermemory")
}

/** Search for customer-specific documents in Supermemory. */
export async function searchCustomerDocuments(
  userId: string,
  customerName: string,
  query: string
): Promise<Array<{ id: string; title: string; snippet: string; relevanceScore: number; source: string }>> {
  try {
    const client = getClient()
    const containerTag = getUserFinanceTag(userId)
    
    const searchQuery = `${customerName} ${query}`
    const results = await client.search({
      query: searchQuery,
      containerTag,
      limit: 10,
    })

    if (!results || results.length === 0) {
      return []
    }

    return results.map((result: any, index: number) => ({
      id: result.id || `doc-${index}`,
      title: result.title || "Document",
      snippet: result.snippet || result.content?.slice(0, 200) || "",
      relevanceScore: 75 - (index * 5),
      source: result.source || "Supermemory",
    }))
  } catch (err) {
    log("supermemory.customer_search.failed", { 
      userId, 
      customerName,
      error: err instanceof Error ? err.message : String(err) 
    }, "supermemory")
    return []
  }
}

/** Extract payment terms from document context. */
export function extractPaymentTerms(context: string): string | null {
  if (!context) return null

  const patterns = [
    /Net\s+(\d+)/gi,
    /(\d+)\s+days?(?:\s+(?:net|payment))?/gi,
    /payment\s+terms?:?\s*([^.\n]+)/gi,
    /due\s+(?:within|in)\s+(\d+)\s+days?/gi,
    /(?:payment|invoice)\s+due\s+(?:within|in)\s+(\d+)\s+days?/gi,
  ]

  for (const pattern of patterns) {
    const match = context.match(pattern)
    if (match) {
      return match[0].trim()
    }
  }

  return null
}

/** Classify relationship type based on context. */
export function classifyRelationship(context: string): "Strategic" | "Preferred" | "New" | "At-Risk" {
  if (!context) return "New"

  const lowerContext = context.toLowerCase()

  if (
    lowerContext.includes("strategic") ||
    lowerContext.includes("key account") ||
    lowerContext.includes("major customer") ||
    lowerContext.includes("long-term")
  ) {
    return "Strategic"
  }

  if (
    lowerContext.includes("preferred") ||
    lowerContext.includes("priority") ||
    lowerContext.includes("important")
  ) {
    return "Preferred"
  }

  if (
    lowerContext.includes("at risk") ||
    lowerContext.includes("delinquent") ||
    lowerContext.includes("overdue") ||
    lowerContext.includes("problem")
  ) {
    return "At-Risk"
  }

  return "New"
}


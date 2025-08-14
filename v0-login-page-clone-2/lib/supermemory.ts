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
  provider: SupermemoryProvider
): Promise<{ authLink: string; id: string; redirectsTo?: string; expiresIn?: string }> {
  const client = getClient()
  const baseUrl = getAppBaseUrl()
  const containerTag = getOrgFinanceTag()

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
export async function addFinalContextToSupermemory(content: string, customId: string): Promise<void> {
  const client = getClient()
  const containerTag = getOrgFinanceTag()
  const id = customId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)
  await client.add({
    content,
    containerTag,
    customId: id || `final_context_${Date.now()}`,
    metadata: { source: "profitwise_final_context" },
  })
  log("supermemory.final_context.added", { customId: id }, "supermemory")
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
  const containerTag = getOrgFinanceTag()
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


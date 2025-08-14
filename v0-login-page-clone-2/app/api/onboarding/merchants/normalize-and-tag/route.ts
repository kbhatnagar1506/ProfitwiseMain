import { NextRequest, NextResponse } from "next/server"
import Supermemory from "supermemory"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureAuthSchema, ensureMerchantTagsSchema, ensurePlaidSchema, query } from "@/lib/db"
import { getTransactionsByUserId } from "@/lib/plaid-persistence"
import { getOrgFinanceTag } from "@/lib/supermemory"
import { log } from "@/lib/logger"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"
const DAYS_LAST_2_MONTHS = 60

type MerchantResult = { raw_name: string; normalized_name: string; tag: string; transaction_type: string }

function getSupermemoryClient(): Supermemory | null {
  const apiKey = process.env.SUPERMEMORY_API_KEY
  if (!apiKey) return null
  return new Supermemory({ apiKey })
}

async function fetchCompanyContextFromSupermemory(): Promise<string> {
  const client = getSupermemoryClient()
  if (!client) return ""
  const tag = getOrgFinanceTag()
  const snippets: string[] = []
  const seen = new Set<string>()
  const searchQueries = [
    "vendors suppliers merchants payment terms categories",
    "company expenses categories software subscriptions",
  ]
  try {
    for (const q of searchQueries) {
      const searchRes = await client.search.execute({
        q,
        containerTags: [tag],
        limit: 30,
        includeSummary: true,
        chunkThreshold: 0.4,
      })
      const results = (searchRes as { results?: Array<{ chunks?: Array<{ content?: string }>; summary?: string | null; content?: string | null }> })?.results ?? []
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
    }
  } catch {
    // optional
  }
  return snippets.slice(0, 50).join("\n\n")
}

async function normalizeAndTagWithOpenAI(
  rawMerchants: string[],
  companyContext: string,
  supermemoryContext: string,
  accountLabel: string
): Promise<MerchantResult[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || rawMerchants.length === 0) return []

  const list = rawMerchants.map((m) => `- ${m}`).join("\n")
  const systemPrompt = `You are a financial data normalizer and categorizer.

Use the following company context (and any vendor/category context from the knowledge base) to make consistent decisions:
${companyContext ? `\nCompany context:\n${companyContext.slice(0, 8000)}\n` : ""}
${supermemoryContext ? `\nKnowledge base excerpts (vendors/categories):\n${supermemoryContext.slice(0, 4000)}\n` : ""}

Tasks:
1. NORMALIZE: For each raw merchant/payee name, output a clean, canonical name (e.g. "AMZN*MKTPLACE" -> "Amazon", "STARBUCKS #12345" -> "Starbucks"). Use the same normalized name for the same business.
2. TAG: Assign each a short category tag (1-2 words): Software, Marketing, Office, Travel, Payroll, Insurance, Utilities, Professional Services, Subscriptions, Rent, Supplies, Food & Drink, Retail, Banking, Transfer, Revenue, Client Payment, Refund, etc.
3. TRANSACTION TYPE: Classify each as one of: "Recurring subscription" (e.g. SaaS, streaming, memberships), "Recurring (other)" (e.g. rent, utilities, payroll), or "One-time". Use company context when ambiguous.

Account being processed: ${accountLabel || "Default"}

Return a JSON array only, no other text: [{"raw_name": "exact raw string", "normalized_name": "Canonical Name", "tag": "Tag", "transaction_type": "Recurring subscription"|"Recurring (other)"|"One-time"}]`

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Raw merchant/payee names for this account:\n${list}` },
      ],
      max_tokens: 4096,
      temperature: 0.2,
    }),
  })
  if (!res.ok) return []
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const raw = data.choices?.[0]?.message?.content?.trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim()) as MerchantResult[]
    return Array.isArray(parsed)
      ? parsed.map((p) => ({
          ...p,
          transaction_type: p.transaction_type && ["Recurring subscription", "Recurring (other)", "One-time"].includes(p.transaction_type)
            ? p.transaction_type
            : "One-time",
        }))
      : []
  } catch {
    return []
  }
}

/** GET /api/onboarding/merchants/normalize-and-tag — Return merchant tags for the current user (for Excel-style table). */
export async function GET(_req: NextRequest) {
  const token = _req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    await ensureAuthSchema()
    await ensurePlaidSchema()
    await ensureMerchantTagsSchema()
  } catch {
    return NextResponse.json({ rows: [] })
  }
  const { rows } = await query<{
    account_id: string
    account_name: string
    raw_name: string
    normalized_name: string
    tag: string
    transaction_type: string
  }>(
    `SELECT mt.account_id,
     COALESCE(
       (SELECT pa.name FROM plaid_accounts pa JOIN plaid_items pi ON pi.item_id = pa.item_id
        WHERE pi.user_id = mt.user_id AND pa.account_id = mt.account_id LIMIT 1),
       mt.account_id
     ) AS account_name,
     mt.raw_name, mt.normalized_name, mt.tag,
     COALESCE(mt.transaction_type, 'One-time') AS transaction_type
     FROM merchant_tags mt
     WHERE mt.user_id = $1
     ORDER BY account_name, mt.normalized_name, mt.raw_name`,
    [user.id]
  )
  return NextResponse.json({ rows: rows ?? [] })
}

/**
 * POST /api/onboarding/merchants/normalize-and-tag
 * Uses company context (users.final_context), Supermemory, and OpenAI to normalize
 * merchant names and tag them by category for the last 2 months of transactions, per account.
 */
export async function POST(_req: NextRequest) {
  const token = _req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await ensureAuthSchema()
    await ensurePlaidSchema()
    await ensureMerchantTagsSchema()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("merchants.normalize.schema_failed", { userId: user.id, error: message }, "db")
    return NextResponse.json({ error: "Database setup failed" }, { status: 500 })
  }

  const startDate = new Date(Date.now() - DAYS_LAST_2_MONTHS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const endDate = new Date().toISOString().slice(0, 10)

  const transactions = await getTransactionsByUserId(user.id, {
    startDate,
    endDate,
    limit: 3000,
  })

  const byAccount = new Map<string, Set<string>>()
  for (const t of transactions) {
    const name = (t.merchant_name || t.name || "Unknown").trim()
    if (!name) continue
    if (!byAccount.has(t.account_id)) byAccount.set(t.account_id, new Set())
    byAccount.get(t.account_id)!.add(name)
  }

  const { rows: accountRows } = await query<{ account_id: string; name: string | null }>(
    `SELECT pa.account_id, pa.name FROM plaid_accounts pa
     JOIN plaid_items pi ON pi.item_id = pa.item_id WHERE pi.user_id = $1`,
    [user.id]
  )
  const accountNames = new Map(accountRows.map((r) => [r.account_id, r.name || r.account_id]))

  const { rows: userRows } = await query<{ final_context: string | null }>(
    "SELECT final_context FROM users WHERE id = $1",
    [user.id]
  )
  const companyContext = userRows[0]?.final_context ?? ""

  const supermemoryContext = await fetchCompanyContextFromSupermemory()

  let totalNormalized = 0
  const accountSummaries: { account_id: string; account_name: string; merchants: number }[] = []

  for (const [accountId, rawNames] of byAccount) {
    const names = Array.from(rawNames)
    if (names.length === 0) continue
    const accountName = accountNames.get(accountId) ?? accountId
    const results = await normalizeAndTagWithOpenAI(
      names,
      companyContext,
      supermemoryContext,
      accountName
    )
    for (const r of results) {
      try {
        await query(
          `INSERT INTO merchant_tags (user_id, account_id, raw_name, normalized_name, tag, transaction_type, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (user_id, account_id, raw_name) DO UPDATE SET
             normalized_name = EXCLUDED.normalized_name,
             tag = EXCLUDED.tag,
             transaction_type = EXCLUDED.transaction_type,
             updated_at = NOW()`,
          [user.id, accountId, r.raw_name, r.normalized_name, r.tag, r.transaction_type ?? "One-time"]
        )
        totalNormalized += 1
      } catch {
        // skip duplicate or constraint
      }
    }
    accountSummaries.push({
      account_id: accountId,
      account_name: accountName,
      merchants: results.length,
    })
  }

  log("merchants.normalize.succeeded", {
    userId: user.id,
    accountsProcessed: byAccount.size,
    totalNormalized,
    accountSummaries,
  })

  return NextResponse.json({
    ok: true,
    accountsProcessed: byAccount.size,
    totalNormalized,
    accountSummaries,
    windowDays: DAYS_LAST_2_MONTHS,
  })
}

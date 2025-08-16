import { NextRequest, NextResponse } from "next/server"
import Supermemory from "supermemory"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureAuthSchema, query } from "@/lib/db"
import { getOrgFinanceTag } from "@/lib/supermemory"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

function getSupermemoryClient(): Supermemory | null {
  const apiKey = process.env.SUPERMEMORY_API_KEY
  if (!apiKey) return null
  return new Supermemory({ apiKey })
}

async function fetchSupermemoryContext(): Promise<string> {
  const client = getSupermemoryClient()
  if (!client) return ""
  const tag = getOrgFinanceTag()
  const snippets: string[] = []
  const seen = new Set<string>()
  try {
    const searchRes = await client.search.execute({
      q: "vendors suppliers merchants categories subscriptions",
      containerTags: [tag],
      limit: 20,
      includeSummary: true,
      chunkThreshold: 0.4,
    })
    const results = (searchRes as { results?: Array<{ summary?: string | null; content?: string | null }> })?.results ?? []
    for (const r of results) {
      if (r.summary && !seen.has(r.summary)) {
        seen.add(r.summary)
        snippets.push(r.summary)
      }
      if (r.content && !seen.has(r.content)) {
        seen.add(r.content)
        snippets.push(r.content)
      }
    }
  } catch {
    // optional
  }
  return snippets.slice(0, 30).join("\n\n")
}

/**
 * POST /api/onboarding/merchants/suggest
 * Body: { raw_name, normalized_name, tag, transaction_type, user_message }
 * Returns AI-suggested { normalized_name, tag, transaction_type } using company context + Supermemory.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  let body: {
    raw_name?: string
    normalized_name?: string
    tag?: string
    transaction_type?: string
    user_message?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const raw_name = typeof body.raw_name === "string" ? body.raw_name.trim() : ""
  const user_message = typeof body.user_message === "string" ? body.user_message.trim() : ""
  if (!raw_name || !user_message) {
    return NextResponse.json(
      { error: "raw_name and user_message are required" },
      { status: 400 }
    )
  }
  const normalized_name = typeof body.normalized_name === "string" ? body.normalized_name.trim() : raw_name
  const tag = typeof body.tag === "string" ? body.tag.trim() : "Uncategorized"
  const transaction_type =
    typeof body.transaction_type === "string" && ["Recurring subscription", "Recurring (other)", "One-time"].includes(body.transaction_type)
      ? body.transaction_type
      : "One-time"

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: "OpenAI not configured" }, { status: 503 })
  }

  try {
    await ensureAuthSchema()
  } catch {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 })
  }

  const { rows: userRows } = await query<{ final_context: string | null }>(
    "SELECT final_context FROM users WHERE id = $1",
    [user.id]
  )
  const companyContext = userRows[0]?.final_context ?? ""
  const supermemoryContext = await fetchSupermemoryContext()

  const systemPrompt = `You are a financial data normalizer. Given a merchant/transaction and the user's request, suggest updated values.

Company context (use for consistency):
${companyContext ? companyContext.slice(0, 6000) : "None provided."}

Knowledge base (vendors/categories):
${supermemoryContext ? supermemoryContext.slice(0, 3000) : "None."}

Rules:
- normalized_name: clean, canonical business name (e.g. "Amazon", "Starbucks").
- tag: 1-2 word category: Software, Marketing, Travel, Food & Drink, Retail, Banking, Transfer, Revenue, Subscriptions, etc.
- transaction_type: exactly one of "Recurring subscription", "Recurring (other)", "One-time".

Respond with a JSON object only, no other text: {"normalized_name": "...", "tag": "...", "transaction_type": "..."}`

  const userPrompt = `Merchant raw name: ${raw_name}
Current: normalized_name="${normalized_name}", tag="${tag}", transaction_type="${transaction_type}"

User request: ${user_message}

Return JSON only: {"normalized_name": "...", "tag": "...", "transaction_type": "..."}`

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
        { role: "user", content: userPrompt },
      ],
      max_tokens: 256,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: "OpenAI request failed" }, { status: 502 })
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content?.trim() ?? ""
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  const jsonStr = jsonMatch ? jsonMatch[0] : content
  let suggested: { normalized_name?: string; tag?: string; transaction_type?: string }
  try {
    suggested = JSON.parse(jsonStr) as { normalized_name?: string; tag?: string; transaction_type?: string }
  } catch {
    return NextResponse.json({ error: "Could not parse AI response" }, { status: 502 })
  }
  const out = {
    normalized_name:
      typeof suggested.normalized_name === "string" && suggested.normalized_name.trim()
        ? suggested.normalized_name.trim()
        : normalized_name,
    tag:
      typeof suggested.tag === "string" && suggested.tag.trim()
        ? suggested.tag.trim()
        : tag,
    transaction_type:
      typeof suggested.transaction_type === "string" &&
      ["Recurring subscription", "Recurring (other)", "One-time"].includes(suggested.transaction_type)
        ? suggested.transaction_type
        : transaction_type,
  }
  return NextResponse.json(out)
}

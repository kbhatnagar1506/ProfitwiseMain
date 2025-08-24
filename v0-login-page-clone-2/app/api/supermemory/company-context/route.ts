import { NextRequest, NextResponse } from "next/server"
import Supermemory from "supermemory"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getUserFinanceTag } from "@/lib/supermemory"

// Use gpt-5 for best quality (set OPENAI_COMPANY_CONTEXT_MODEL=gpt-5); gpt-4o default for compatibility
const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

function getSupermemoryClient(): Supermemory {
  const apiKey = process.env.SUPERMEMORY_API_KEY
  if (!apiKey) throw new Error("SUPERMEMORY_API_KEY is not set")
  return new Supermemory({ apiKey })
}

async function callOpenAI(
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  temperature = 0.3
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set")
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
        { role: "user", content: userContent || "No content provided." },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI error: ${res.status} ${err}`)
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content?.trim()
  return content ?? "Unable to generate."
}

const SYSTEM_SUMMARIZE = `You are an expert business analyst. Given raw excerpts from a company's documents (contracts, Notion, Drive, OneDrive, etc.), write a single, exhaustive "Company context" document as a summary. Be thorough and precise.

DO NOT DISPLAY SENSITIVE INFORMATION. Never include: EIN, SSN, tax IDs, full street addresses, account numbers, passwords, API keys, exact salaries, bank account details, or any personally identifiable financial data. Summarize such details in general terms only (e.g., "incorporated in Delaware" not "EIN 41-3148159"; "headquartered in Georgia" not full address).

OUTPUT FORMAT: Write everything as a flowing summary in narrative prose. Do NOT use markdown headings (#, ##, ###), bullet lists, or numbered lists. Use only paragraphs. Organize by topic with clear paragraph breaks. Write in clear, readable prose—like a well-structured executive summary.

PRIORITIZE OPERATIONS—how the company actually operates day to day:
- **How they operate:** Step-by-step workflows (quote-to-cash, procure-to-pay, order-to-cash, etc.), who does what, when, and in what order. Approval chains, handoffs, and decision points.
- **Where:** Locations, offices, regions, remote vs on-site, where work happens.
- **What:** Every process, system, tool, and integration used (ERP, CRM, banking, accounting, spend tools, communication). What each system is used for.
- **How:** Methods, cadences (weekly closes, monthly reviews), SLAs, turnaround times, how often things run.
- **Who:** People in the company—names, roles, titles, departments. Who owns finance, ops, approvals. Team structure, key personnel, escalation paths. Founders, executives, and key contributors.
- **When:** Fiscal year, close dates, reporting cadences, deadlines, recurring events.
- **Stage:** Company stage—pre-seed, seed, Series A/B/C, growth, profitability, etc. Funding raised, runway, headcount trajectory. Where they are in their lifecycle and what they’re building toward.
- **Additional:** Any other relevant context—culture, values, recent changes, strategic priorities, challenges, or notable facts from the documents.

Also include:
- Legal identity: name, DBA, entity type, incorporation
- Products, services, business model, how they make money
- Org structure, key people, departments
- Revenue, margins, ARR/MRR, KPIs (with numbers when present)
- Vendors, suppliers, contract terms, payment terms
- Budgets, compliance, policies, forecasts

Cover these topics in order as prose: legal identity (name, DBA, entity type, incorporation—no EIN or addresses), company overview, operations (how, where, what, who, when, stage), products/services, org structure, revenue model, vendors, budgets, compliance, conclusion. Do not invent facts—only summarize what appears in the excerpts.

CRITICAL: Extract every detail. Do not omit anything. Include every name, number, date, process, and fact. Prioritize completeness over brevity. If in doubt, include it. Leave nothing out—even seemingly minor details may be important. Aim for the most comprehensive, minute detail possible with heavy focus on operations. Write a long, thorough document. Multiple paragraphs per topic are expected. Do not summarize away detail—preserve specifics.`

async function summarizeWithOpenAI(rawSnippets: string[]): Promise<string> {
  const text = rawSnippets.slice(0, 200).join("\n\n---\n\n")
  return callOpenAI(SYSTEM_SUMMARIZE, text, 16384, 0.2)
}

const SYSTEM_REFINE = `You are an expert editor. The user will provide: (1) the current "Company context" text, and (2) their edit instructions or requested changes. Your job is to output a revised, complete Company context that incorporates their edits. Preserve all unrelated content; only change what they ask to change. Output the full revised document as flowing summary prose—paragraphs only, no markdown headings (#, ##, ###), no bullet or numbered lists. Do not include sensitive info (EIN, addresses, account numbers, etc.). Do not output a diff or instructions.`

async function refineWithOpenAI(currentContext: string, userMessage: string): Promise<string> {
  const userContent = `Current company context:\n\n${currentContext}\n\n---\n\nUser's edit request: ${userMessage}`
  return callOpenAI(SYSTEM_REFINE, userContent, 16384, 0.3)
}

/** GET /api/supermemory/company-context — Supermemory search + OpenAI summary for onboarding step 6. */
export async function GET(_req: NextRequest) {
  const token = _req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const containerTag = getUserFinanceTag(user.id)
  const client = getSupermemoryClient()
  const snippets: string[] = []
  const seen = new Set<string>()

  const searchQueries = [
    "company overview business model products services revenue how we make money",
    "people team roles employees founders executives key personnel org structure",
    "funding stage runway headcount investors seed series growth trajectory",
    "processes workflows operations approvals procure-to-pay quote-to-cash order-to-cash",
    "vendors suppliers contracts payment terms key relationships",
    "budgets forecasts headcount spend by category budget vs actual",
    "KPIs metrics revenue ARR MRR margins growth rates targets",
    "tools systems ERP CRM accounting banking software integrations",
    "legal incorporation entity type DBA fiscal year compliance audit",
    "customers clients segments go-to-market sales channels",
  ]

  try {
    for (const q of searchQueries) {
      const searchRes = await client.search.execute({
        q,
        containerTags: [containerTag],
        limit: 80,
        includeSummary: true,
        chunkThreshold: 0.35,
      })
      const results = (searchRes as { results?: Array<{ chunks?: Array<{ content?: string }>; title?: string | null; summary?: string | null; content?: string | null }> })?.results ?? []
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
    // No memory or search error → return empty context message below
  }

  if (snippets.length === 0) {
    return NextResponse.json({
      context:
        "No company context found yet. Connect Google Drive, OneDrive, or Notion in the previous step so we can read your docs and show a summary here.",
    })
  }

  try {
    const context = await summarizeWithOpenAI(snippets)
    return NextResponse.json({ context })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: "Failed to generate company summary", details: message },
      { status: 500 }
    )
  }
}

/** POST /api/supermemory/company-context — Refine company context with user edits (chat). */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { currentContext?: string; userMessage?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    )
  }
  const currentContext = typeof body.currentContext === "string" ? body.currentContext : ""
  const userMessage = typeof body.userMessage === "string" ? body.userMessage.trim() : ""
  if (!userMessage) {
    return NextResponse.json(
      { error: "userMessage is required" },
      { status: 400 }
    )
  }

  try {
    const context = await refineWithOpenAI(currentContext, userMessage)
    return NextResponse.json({ context })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: "Failed to refine company context", details: message },
      { status: 500 }
    )
  }
}

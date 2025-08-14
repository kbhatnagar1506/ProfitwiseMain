import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getAppBaseUrl } from "@/lib/supermemory"
import { buildFinancialContext, type FinancialContext } from "@/lib/financial-context"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

async function callOpenAI(
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  temperature = 0.2
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
        { role: "user", content: userContent },
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

const SYSTEM_MERGE = `You will receive:
1. **Business context** — what the company does, how it operates, who they are, products, org, processes, etc. (from their docs).
2. **Financial context** — cash flow and spending data: major expenses, vendors, inflows, payments (last 90 days).

Your job: Produce a single "Final Context" document that combines business and financial information as **context only**. Do NOT add analysis, interpretation, or recommendations.

- Include: what the company does (from business context); what money came in and went out (amounts, vendor/source names, categories); how expenses and inflows are labeled or categorized. State facts only.
- Do NOT include: what the numbers "mean" or "suggest," implications for scale/stage/operations, opinions, or advice. No "this indicates…," "this implies…," or similar.

OUTPUT FORMAT: Flowing prose only. No markdown headings (#, ##, ###), no bullet or numbered lists. Use paragraphs. Preserve specifics (names, amounts, categories). Do not include sensitive info (EIN, addresses, account numbers).`

/** GET /api/context/final — Business context + financial context merged into final context. */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? getAppBaseUrl()).replace(/\/$/, "")
  const cookie = req.cookies.getAll().map((c) => `${c.name}=${c.value}`).join("; ")

  let companyContext = ""
  let financialContext: FinancialContext

  try {
    const [companyRes, fc] = await Promise.all([
      fetch(`${base}/api/supermemory/company-context`, {
        headers: { Cookie: cookie },
      }),
      buildFinancialContext(user.id),
    ])
    financialContext = fc
    if (companyRes.ok) {
      try {
        const data = (await companyRes.json()) as { context?: string }
        companyContext = data.context ?? ""
      } catch {
        // ignore parse error
      }
    } else {
      const body = await companyRes.text()
      console.error("[context/final] company-context failed", companyRes.status, body.slice(0, 200))
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: "Failed to fetch context", details: msg },
      { status: 500 }
    )
  }

  if (!companyContext) {
    return NextResponse.json({
      finalContext: financialContext.summary
        ? `No business context found yet. Connect Google Drive, OneDrive, or Notion in the previous step. Financial summary (last 90 days): ${financialContext.summary}`
        : "No company or financial context found yet. Connect your bank accounts and context layer (Drive, OneDrive, Notion) in the previous steps.",
      companyContext: "",
      financialContext,
    })
  }

  const financialSummary = [
    `Total outflows (90 days): $${financialContext.totalOutflows60Days.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    `Total inflows: $${(financialContext.totalInflows60Days ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    `Top expenses: ${(financialContext.majorExpenses as { vendor: string; amount: number; tag?: string }[]).slice(0, 30).map((e) => `${e.vendor} $${e.amount.toLocaleString()}${e.tag ? ` [${e.tag}]` : ""}`).join("; ")}`,
    `Top money received from: ${((financialContext.majorInflows ?? []) as { source: string; amount: number; tag?: string }[]).slice(0, 30).map((e) => `${e.source} $${e.amount.toLocaleString()}${e.tag ? ` [${e.tag}]` : ""}`).join("; ") || "None"}`,
    `Payments out: ${(financialContext.paymentsLast60Days as unknown[]).length}, payments in: ${(financialContext.paymentsReceivedLast60Days ?? []).length}`,
  ].join(". ")

  const financialNarrative = financialContext.narrative
    ? `\n\nFinancial narrative (pre-generated):\n${financialContext.narrative}\n\n`
    : ""
  const userContent = `Business context:\n\n${companyContext}\n\n---\n\nFinancial context (last 90 days):${financialNarrative}Summary: ${financialSummary}\n\nStructured financial data:\n${JSON.stringify(financialContext, null, 2)}`

  try {
    const finalContext = await callOpenAI(SYSTEM_MERGE, userContent, 16384)
    return NextResponse.json({
      finalContext,
      companyContext,
      financialContext,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: "Failed to generate final context", details: message },
      { status: 500 }
    )
  }
}

const SYSTEM_REFINE = `You are an expert editor. The user will provide: (1) the current "Final context" (company + financial context only), and (2) their edit instructions. Output a revised, complete Final context that incorporates their edits. Preserve unrelated content. Keep the output as context only—no analysis, interpretation, or recommendations. Output as flowing prose—paragraphs only, no markdown headings or lists. No sensitive info.`

/** POST /api/context/final — Refine final context with user edits. */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  let body: { currentFinalContext?: string; userMessage?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const current = typeof body.currentFinalContext === "string" ? body.currentFinalContext : ""
  const userMessage = typeof body.userMessage === "string" ? body.userMessage.trim() : ""
  if (!userMessage) {
    return NextResponse.json({ error: "userMessage required" }, { status: 400 })
  }
  try {
    const userContent = `Current final context:\n\n${current}\n\n---\n\nUser edit: ${userMessage}`
    const finalContext = await callOpenAI(SYSTEM_REFINE, userContent, 16384)
    return NextResponse.json({ finalContext })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: "Refine failed", details: message }, { status: 500 })
  }
}

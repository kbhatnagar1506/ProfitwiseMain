import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getOrgFinanceTag } from "@/lib/supermemory"
import Supermemory from "supermemory"
import type { CompanyFormData } from "../route"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

const FORM_KEYS = [
  "companyName",
  "legalName",
  "industry",
  "businessModel",
  "productsServices",
  "annualRevenue",
  "teamSize",
  "fiscalYearEnd",
  "hqLocation",
  "fundingStage",
  "primaryBanks",
  "accountingSystem",
  "monthlyBurnRunway",
  "currency",
  "financeOwnerContact",
  "departmentsCostCenters",
  "auditFiscalCalendar",
  "keyReportingDates",
  "website",
  "yearFounded",
  "primaryCustomerType",
] as const

const JSON_SCHEMA_PROMPT = `You are a data extractor. You will receive context from a company's knowledge base (Supermemory). Fill the following JSON object using only that context. Use only the keys specified. Use empty string "" if not found or unclear. Do not invent data.

Required JSON shape (use exactly these keys):
{
  "companyName": "common or brand name",
  "legalName": "legal/registered name if mentioned",
  "industry": "e.g. Technology, Retail, Healthcare",
  "businessModel": "e.g. B2B SaaS, marketplace",
  "productsServices": "short description of what they sell/offer",
  "annualRevenue": "e.g. $2M, Series A stage",
  "teamSize": "e.g. 15, 10-20",
  "fiscalYearEnd": "e.g. December, March 31",
  "hqLocation": "city, state/country if mentioned",
  "fundingStage": "e.g. Bootstrapped, Seed, Series A, Series B, Series C",
  "primaryBanks": "main banking partners (e.g. Mercury, Brex, Chase)",
  "accountingSystem": "e.g. QuickBooks, Xero, NetSuite",
  "monthlyBurnRunway": "e.g. $50k burn, 18 months runway",
  "currency": "e.g. USD, EUR, GBP",
  "financeOwnerContact": "name or title of who owns finance/ops",
  "departmentsCostCenters": "e.g. Engineering, Sales, G&A",
  "auditFiscalCalendar": "e.g. Audit in Q2, Board in March",
  "keyReportingDates": "e.g. Board pack by 5th, Close by 10th",
  "website": "company website URL",
  "yearFounded": "e.g. 2020",
  "primaryCustomerType": "e.g. SMB, Enterprise, Consumer"
}

Respond with only valid JSON, no markdown or explanation.`

function getSupermemoryClient(): Supermemory {
  const apiKey = process.env.SUPERMEMORY_API_KEY
  if (!apiKey) throw new Error("SUPERMEMORY_API_KEY is not set")
  return new Supermemory({ apiKey })
}

/** POST /api/onboarding/company-form/autofill — Supermemory search + OpenAI: return JSON prefilled form. Saves only when user clicks Finish. */
export async function POST(_req: NextRequest) {
  const token = _req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    const containerTag = getOrgFinanceTag()
    const client = getSupermemoryClient()
    const snippets: string[] = []
    const seen = new Set<string>()

    const searchQueries = [
      "company overview business model products services revenue how we make money",
      "people team roles employees founders executives key personnel org structure",
      "funding stage runway headcount investors seed series growth trajectory",
      "processes workflows operations approvals procure-to-pay quote-to-cash",
      "vendors suppliers contracts payment terms key relationships",
      "budgets forecasts headcount spend by category",
      "KPIs metrics revenue ARR MRR margins growth rates targets",
      "tools systems ERP CRM accounting banking software integrations",
      "legal incorporation entity type DBA fiscal year compliance audit",
      "customers clients segments go-to-market sales channels",
    ]

    for (const q of searchQueries) {
      try {
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
      } catch {
        // skip failed query
      }
    }

    const contextText = snippets.length > 0 ? snippets.slice(0, 200).join("\n\n---\n\n") : ""
    if (!contextText.trim()) {
      return NextResponse.json(
        { error: "No context in Supermemory yet. Connect Google Drive, OneDrive, or Notion in step 4.", form: {} },
        { status: 400 }
      )
    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: "OpenAI not configured", form: {} }, { status: 500 })
    }

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: JSON_SCHEMA_PROMPT },
          { role: "user", content: `Context from knowledge base:\n\n${contextText.slice(0, 24000)}` },
        ],
        max_tokens: 2048,
        temperature: 0.2,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json(
        { error: "Failed to generate form", details: err, form: {} },
        { status: 500 }
      )
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const raw = data.choices?.[0]?.message?.content?.trim() ?? ""
    const parsed: CompanyFormData = {}
    try {
      const cleaned = raw.replace(/^```json\s*|\s*```$/g, "").trim()
      const obj = JSON.parse(cleaned) as Record<string, unknown>
      for (const key of FORM_KEYS) {
        if (typeof obj[key] === "string") parsed[key] = String(obj[key])
        else parsed[key] = ""
      }
    } catch {
      for (const key of FORM_KEYS) parsed[key] = ""
    }
    return NextResponse.json({ form: parsed })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: "Autofill failed", details: message, form: {} },
      { status: 500 }
    )
  }
}

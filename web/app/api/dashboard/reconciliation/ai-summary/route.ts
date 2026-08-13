import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"

const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o-mini"
const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY

async function callLLM(
  messages: { role: string; content: string }[],
  maxTokens = 600
): Promise<string | null> {
  if (!API_KEY) return null
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.35,
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content?.trim() ?? null
  } catch {
    return null
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}

export async function POST(req: NextRequest) {
  const jar = await cookies()
  const token = jar.get(getSessionCookieName())?.value
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const user = await getUserBySessionToken(token)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const body = await req.json()

    const {
      totalUnmatched = 0,
      unmatchedCount = 0,
      reconciledCount = 0,
      reconciledAmount = 0,
      excludedCount = 0,
      excludedAmount = 0,
      arTotal = 0,
      arPaid = 0,
      arOutstanding = 0,
      arInvoiceCount = 0,
      arPaidCount = 0,
      arOpenCount = 0,
      arMatchRate = 0,
      arMatchedCount = 0,
      arBankVerified = 0,
      apTotal = 0,
      apPaid = 0,
      apOutstanding = 0,
      apBillCount = 0,
      apPaidCount = 0,
      apOpenCount = 0,
      apMatchRate = 0,
      apMatchedCount = 0,
      apBankVerified = 0,
    } = body

    const prompt = `You are a friendly financial advisor explaining a business's cash reconciliation status in plain English. Write a concise 3-4 paragraph overview that a non-finance person can understand. Use specific numbers from the data. Be encouraging where things look good, and flag areas that need attention with clear, actionable language. Do not use bullet points or headers—write flowing paragraphs. Do not use jargon. Speak as if you're explaining to the business owner over coffee.

Here is the reconciliation data:

CASH STATUS:
- Unmatched cash (bank transactions not yet linked to any invoice/bill): ${fmt(totalUnmatched)} across ${unmatchedCount} transactions
- Already matched to the books: ${reconciledCount} transactions totaling ${fmt(reconciledAmount)}
- Excluded from stats (internal transfers, bank fees, etc.): ${excludedCount} transactions totaling ${fmt(excludedAmount)}

ACCOUNTS RECEIVABLE (money customers owe the business):
- Total invoiced: ${fmt(arTotal)} across ${arInvoiceCount} invoices
- Collected (paid): ${fmt(arPaid)} (${arPaidCount} invoices)
- Still waiting to be paid: ${fmt(arOutstanding)} (${arOpenCount} open invoices)
- ${arMatchedCount} invoices have been verified against actual bank deposits (${arMatchRate.toFixed(0)}% match rate)
- Bank-verified amount: ${fmt(arBankVerified)}

ACCOUNTS PAYABLE (money the business owes to vendors):
- Total billed: ${fmt(apTotal)} across ${apBillCount} bills
- Already paid: ${fmt(apPaid)} (${apPaidCount} bills)
- Still owed: ${fmt(apOutstanding)} (${apOpenCount} open bills)
- ${apMatchedCount} bills have been verified against actual bank payments (${apMatchRate.toFixed(0)}% match rate)
- Bank-verified amount: ${fmt(apBankVerified)}

Write the overview now. Keep it warm, clear, and under 200 words.`

    const result = await callLLM([
      { role: "system", content: "You are a plain-English financial narrator. No markdown, no bullet points, no headers. Just clear paragraphs." },
      { role: "user", content: prompt },
    ])

    if (!result) {
      return NextResponse.json({ error: "AI unavailable" }, { status: 503 })
    }

    return NextResponse.json({ summary: result, generatedAt: new Date().toISOString() })
  } catch (err) {
    console.error("[recon-ai-summary]", err)
    return NextResponse.json({ error: "Failed to generate summary" }, { status: 500 })
  }
}

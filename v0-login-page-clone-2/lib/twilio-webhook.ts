import { NextRequest, NextResponse } from "next/server"
import Twilio from "twilio"
import Supermemory from "supermemory"
import { getTwilio, getWhatsAppFrom, getTwilioAuthToken } from "@/lib/twilio"
import { getOrgFinanceTag } from "@/lib/supermemory"
import { query } from "@/lib/db"
import {
  normalizePhoneE164,
  getUserIdByWhatsAppPhone,
  getPendingOtpByPhone,
  markWhatsAppVerified,
} from "@/lib/whatsapp-user"
import {
  getTransactionContextForUser,
  getBalancesAndConnectionsContextForUser,
} from "@/lib/transaction-context"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {}
  for (const pair of body.split("&")) {
    const [key, value] = pair.split("=").map((s) => decodeURIComponent(s.replace(/\+/g, " ")))
    if (key && value !== undefined) params[key] = value
  }
  return params
}

async function fetchSupermemoryContext(): Promise<string> {
  const apiKey = process.env.SUPERMEMORY_API_KEY
  if (!apiKey) return ""
  const client = new Supermemory({ apiKey })
  const tag = getOrgFinanceTag()
  const snippets: string[] = []
  const seen = new Set<string>()
  const queries = [
    "vendors suppliers merchants categories subscriptions",
    "balance revenue expenses financial context company",
  ]
  try {
    for (const q of queries) {
      const searchRes = await client.search.execute({
        q,
        containerTags: [tag],
        limit: 15,
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
    }
  } catch {
    // optional
  }
  return snippets.slice(0, 40).join("\n\n")
}

async function getAiReply(userMessage: string, userId?: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return ""

  let systemPrompt =
    "You are the ProfitWise AI assistant. Reply in 1-3 short sentences. Be helpful and professional. If the question is about finances, budgeting, or ProfitWise, answer briefly. Otherwise say you're here to help with financial questions."

  if (userId) {
    const [userRows, supermemoryContext, transactionContext, balancesContext] = await Promise.all([
      query<{ final_context: string | null }>("SELECT final_context FROM users WHERE id = $1", [userId]),
      fetchSupermemoryContext(),
      getTransactionContextForUser(userId),
      getBalancesAndConnectionsContextForUser(userId),
    ])
    const companyContext = userRows.rows[0]?.final_context ?? ""
    systemPrompt = `You are the ProfitWise AI assistant for this user. You have full access to their company context, Supermemory knowledge base, bank balances, connected integrations, and recent transactions. Use this data to give accurate, personalized answers. Reply in 1-3 short sentences; keep it conversational for WhatsApp.

Company context:
${companyContext ? companyContext.slice(0, 5000) : "None provided."}

Supermemory knowledge base (vendors, categories, financial context):
${supermemoryContext ? supermemoryContext.slice(0, 4000) : "None."}

${balancesContext ? `\n${balancesContext}\n` : ""}

${transactionContext ? `\n${transactionContext.slice(0, 4000)}\n` : ""}

Use the above to answer questions about balances, spend, categories, merchants, accounts, or recent activity. If the question is outside finance or unclear, say you're here to help with their business finances and ProfitWise.`
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
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: 200,
    }),
  })
  if (!res.ok) return ""
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content?.trim()
  return content ?? ""
}

export async function handleWhatsAppWebhook(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text()
  const params = parseFormBody(rawBody)

  const authToken = getTwilioAuthToken()
  if (authToken) {
    const signature = req.headers.get("x-twilio-signature") ?? ""
    const url = req.nextUrl ? new URL(req.url).href : req.url
    if (!Twilio.validateRequest(authToken, signature, url, params)) {
      return new NextResponse("Forbidden", { status: 403 })
    }
  }

  const from = params.From
  const body = (params.Body ?? "").trim()

  if (!from) {
    return new NextResponse(null, { status: 204 })
  }

  const client = getTwilio()
  const fromNumber = getWhatsAppFrom()
  if (!client || !fromNumber) {
    return new NextResponse(null, { status: 204 })
  }

  const phoneE164 = normalizePhoneE164(from)
  const sendReply = async (text: string) => {
    if (!text) return
    try {
      await client!.messages.create({
        from: fromNumber!,
        to: from,
        body: text,
      })
    } catch {
      // log but don't fail webhook
    }
  }

  // Verified user: reply with their context (only one message: the AI reply)
  const link = phoneE164 ? await getUserIdByWhatsAppPhone(phoneE164) : null
  if (link?.verified) {
    const replyText = body ? await getAiReply(body, link.userId) : ""
    if (replyText) await sendReply(replyText)
    return new NextResponse(null, { status: 204 })
  }

  // Pending OTP: if they reply with the code, verify and confirm
  if (phoneE164 && body) {
    const pending = await getPendingOtpByPhone(phoneE164)
    const code = body.replace(/\s/g, "").replace(/\D/g, "")
    if (pending && code.length >= 6 && pending.code === code.slice(0, 6)) {
      await markWhatsAppVerified(pending.userId)
      await sendReply("You're all set! You can now chat with ProfitWise here. Send any question about your finances or business.")
      return new NextResponse(null, { status: 204 })
    }
  }

  // Not linked / not verified: instruct to connect in dashboard
  if (body) {
    const reply =
      "This number isn't linked to a ProfitWise account. Add your number in the dashboard (Communication Channels), then reply here with the 6-digit code we send you to connect."
    await sendReply(reply)
  }

  return new NextResponse(null, { status: 204 })
}

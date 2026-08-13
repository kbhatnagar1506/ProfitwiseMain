/**
 * Shared AI reply with full user context (company, Supermemory, transactions, balances).
 * Used by Slack; WhatsApp keeps its own logic in lib/twilio-webhook.ts (unchanged).
 */

import Supermemory from "supermemory"
import { getUserFinanceTag } from "@/lib/supermemory"
import { query } from "@/lib/db"
import {
  getTransactionContextForUser,
  getBalancesAndConnectionsContextForUser,
} from "@/lib/transaction-context"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

async function fetchSupermemoryContext(userId: string): Promise<string> {
  const apiKey = process.env.SUPERMEMORY_API_KEY
  if (!apiKey) return ""
  const client = new Supermemory({ apiKey })
  const tag = getUserFinanceTag(userId)
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

/**
 * Get an AI reply for a ProfitWise user with full context (company, Supermemory, transactions, balances).
 * Used by Slack (and can be used by other channels); WhatsApp uses its own implementation.
 */
export async function getAiReplyForUser(userId: string, userMessage: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return ""

  const [userRows, supermemoryContext, transactionContext, balancesContext] = await Promise.all([
    query<{ final_context: string | null }>("SELECT final_context FROM users WHERE id = $1", [userId]),
    fetchSupermemoryContext(userId),
    getTransactionContextForUser(userId),
    getBalancesAndConnectionsContextForUser(userId),
  ])
  const companyContext = userRows.rows[0]?.final_context ?? ""
  const systemPrompt = `You are the ProfitWise AI assistant for this user. You have full access to their company context, Supermemory knowledge base, bank balances, connected integrations, and recent transactions. Use this data to give accurate, personalized answers. Reply in 1-3 short sentences; keep it conversational (e.g. for Slack).

Company context:
${companyContext ? companyContext.slice(0, 5000) : "None provided."}

Supermemory knowledge base (vendors, categories, financial context):
${supermemoryContext ? supermemoryContext.slice(0, 4000) : "None."}

${balancesContext ? `\n${balancesContext}\n` : ""}

${transactionContext ? `\n${transactionContext.slice(0, 4000)}\n` : ""}

Use the above to answer questions about balances, spend, categories, merchants, accounts, or recent activity. If the question is outside finance or unclear, say you're here to help with their business finances and ProfitWise.`

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

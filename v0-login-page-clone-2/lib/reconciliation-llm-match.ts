/**
 * Batch LLM matching: given unmatched transactions and outstanding invoices/bills,
 * suggest mappings. Does NOT auto-apply; user confirms each.
 */

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

export type UnmatchedInflow = { movement_id: string; amount: number; date: string; counterparty: string | null; raw_description: string | null }
export type UnmatchedOutflow = { movement_id: string; amount: number; date: string; counterparty: string | null; raw_description: string | null }
export type InvoiceForMatch = { invoice_id: string; customer_name: string; amount_due: number; due_date: string | null }
export type BillForMatch = { bill_id: string; obligation_id: string; vendor_name: string; amount_due: number; due_date: string | null }

export type ARMatchSuggestion = { movement_id: string; invoice_id: string; confidence: "high" | "medium" | "low"; reasoning: string }
export type APMatchSuggestion = { movement_id: string; obligation_id: string; confidence: "high" | "medium" | "low"; reasoning: string }

export type BatchMatchResult = { ar: ARMatchSuggestion[]; ap: APMatchSuggestion[] }

async function callLLM(messages: { role: string; content: string }[], maxTokens = 2000): Promise<string | null> {
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
        temperature: 0.2,
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content?.trim() ?? null
  } catch {
    return null
  }
}

function parseARMatchLines(content: string, movementIds: Set<string>, invoiceIds: Set<string>): ARMatchSuggestion[] {
  const out: ARMatchSuggestion[] = []
  const seen = new Set<string>()
  const lines = content.split("\n").filter((l) => l.trim())
  for (const line of lines) {
    const mid = [...movementIds].find((id) => line.includes(id))
    const iid = [...invoiceIds].find((id) => line.includes(id))
    const confMatch = line.match(/\b(high|medium|low)\b/i)
    const conf = (confMatch?.[1] ?? "medium").toLowerCase() as "high" | "medium" | "low"
    const reasonParts = line.split(/:|->/).slice(2).join(":").trim()
    const reason = reasonParts || "LLM suggested match"
    if (mid && iid && !seen.has(`${mid}:${iid}`)) {
      seen.add(`${mid}:${iid}`)
      out.push({ movement_id: mid, invoice_id: iid, confidence: conf, reasoning: reason })
    }
  }
  return out
}

function parseAPMatchLines(content: string, movementIds: Set<string>, obligationIds: Set<string>): APMatchSuggestion[] {
  const out: APMatchSuggestion[] = []
  const seen = new Set<string>()
  const lines = content.split("\n").filter((l) => l.trim())
  for (const line of lines) {
    const mid = [...movementIds].find((id) => line.includes(id))
    const oid = [...obligationIds].find((id) => line.includes(id))
    const confMatch = line.match(/\b(high|medium|low)\b/i)
    const conf = (confMatch?.[1] ?? "medium").toLowerCase() as "high" | "medium" | "low"
    const reasonParts = line.split(/:|->/).slice(2).join(":").trim()
    const reason = reasonParts || "LLM suggested match"
    if (mid && oid && !seen.has(`${mid}:${oid}`)) {
      seen.add(`${mid}:${oid}`)
      out.push({ movement_id: mid, obligation_id: oid, confidence: conf, reasoning: reason })
    }
  }
  return out
}

/**
 * Batch match: send all unmatched transactions + invoices/bills to LLM with criteria.
 * Returns suggested mappings.
 */
export async function batchLLMMatch(
  inflows: UnmatchedInflow[],
  outflows: UnmatchedOutflow[],
  invoices: InvoiceForMatch[],
  bills: BillForMatch[],
): Promise<BatchMatchResult> {
  const result: BatchMatchResult = { ar: [], ap: [] }
  if (!API_KEY) return result

  const inflowIds = new Set(inflows.map((i) => i.movement_id))
  const outflowIds = new Set(outflows.map((o) => o.movement_id))
  const invoiceIds = new Set(invoices.map((i) => i.invoice_id))
  const obligationIds = new Set(bills.map((b) => b.obligation_id))

  const criteria = [
    "Entity/counterparty name: same customer (AR) or vendor (AP), or fuzzy match (e.g. Gina DiRenzo = Gina Direnzo)",
    "Amount: within ±5% (covers processor fees). Payment amount = net; invoice amount = gross.",
    "Date: AR: payment within 45 days of invoice due date. AP: payment within 14 days of bill due date.",
    "One-to-one: each payment maps to at most one invoice/bill. Prefer best match.",
  ].join("\n")

  const systemPrompt = `You are a reconciliation assistant. Given unmatched bank transactions and outstanding invoices/bills, suggest the best mappings.

MATCHING CRITERIA:
${criteria}

OUTPUT FORMAT (one line per suggestion):
AR: movement_id -> invoice_id: confidence (high|medium|low): brief reasoning
AP: movement_id -> obligation_id: confidence (high|medium|low): brief reasoning

Only suggest matches that meet the criteria. Order by confidence. Do not guess wildly.`

  const inflowSection = inflows.length > 0
    ? `Unmatched inflows (AR payments):
${inflows.map((i) => `  ${i.movement_id}: $${i.amount.toFixed(2)} on ${i.date}, counterparty: ${i.counterparty ?? i.raw_description ?? "—"}`).join("\n")}`
    : ""

  const outflowSection = outflows.length > 0
    ? `Unmatched outflows (AP payments):
${outflows.map((o) => `  ${o.movement_id}: $${o.amount.toFixed(2)} on ${o.date}, counterparty: ${o.counterparty ?? o.raw_description ?? "—"}`).join("\n")}`
    : ""

  const invoiceSection = invoices.length > 0
    ? `Outstanding invoices (AR):
${invoices.map((i) => `  ${i.invoice_id}: ${i.customer_name}, $${i.amount_due.toFixed(2)} due ${i.due_date ?? "—"}`).join("\n")}`
    : ""

  const billSection = bills.length > 0
    ? `Outstanding bills (AP) - use obligation_id:
${bills.map((b) => `  ${b.obligation_id}: ${b.vendor_name}, $${b.amount_due.toFixed(2)} due ${b.due_date ?? "—"}`).join("\n")}`
    : ""

  const userPrompt = `Match the following. Output one line per suggestion.

${inflowSection}${inflowSection && (outflowSection || invoiceSection || billSection) ? "\n\n" : ""}
${outflowSection}${outflowSection && (invoiceSection || billSection) ? "\n\n" : ""}
${invoiceSection}${invoiceSection && billSection ? "\n\n" : ""}
${billSection}

Suggest matches (one per line):`

  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ])
  if (!content) return result

  const arLines = content.split("\n").filter((l) => /AR\s*:/.test(l) || /movement_id.*invoice_id/i.test(l))
  const apLines = content.split("\n").filter((l) => /AP\s*:/.test(l) || /movement_id.*obligation_id/i.test(l))
  if (arLines.length > 0) {
    result.ar = parseARMatchLines(arLines.join("\n"), inflowIds, invoiceIds)
  } else {
    result.ar = parseARMatchLines(content, inflowIds, invoiceIds)
  }
  if (apLines.length > 0) {
    result.ap = parseAPMatchLines(apLines.join("\n"), outflowIds, obligationIds)
  } else {
    result.ap = parseAPMatchLines(content, outflowIds, obligationIds)
  }

  return result
}

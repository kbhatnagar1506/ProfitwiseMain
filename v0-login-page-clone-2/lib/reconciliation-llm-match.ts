/**
 * LLM-assisted reconciliation matching for transactions that rule-based stages couldn't match.
 * 
 * Handles cases where entity names differ between bank and accounting systems:
 * - Organization name vs contact name (bank shows company, invoice under person)
 * - Abbreviations and variations
 * - Aggregated payments covering multiple invoices
 * 
 * High-confidence matches can be auto-applied; lower confidence requires review.
 */

import { query } from "@/lib/db"
import { createAttribution, type CreateAttributionOpts } from "@/lib/attribution-persist"

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

export type UnmatchedInflow = { movement_id: string; amount: number; date: string; counterparty: string | null; raw_description: string | null }
export type UnmatchedOutflow = { movement_id: string; amount: number; date: string; counterparty: string | null; raw_description: string | null }
export type InvoiceForMatch = { invoice_id: string; customer_name: string; amount_due: number; due_date: string | null; entity_id?: string }
export type BillForMatch = { bill_id: string; obligation_id: string; vendor_name: string; amount_due: number; due_date: string | null; entity_id?: string }

export type ARMatchSuggestion = { movement_id: string; invoice_id: string; confidence: "high" | "medium" | "low"; reasoning: string; amount_matched?: number }
export type APMatchSuggestion = { movement_id: string; obligation_id: string; confidence: "high" | "medium" | "low"; reasoning: string; amount_matched?: number }

export type BatchMatchResult = { ar: ARMatchSuggestion[]; ap: APMatchSuggestion[] }

export type LLMMatchApplyResult = {
  applied: number
  skipped: number
  errors: string[]
}

async function callLLM(messages: { role: string; content: string }[], maxTokens = 4000): Promise<string | null> {
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
        temperature: 0.1,
      }),
    })
    if (!res.ok) {
      console.error("[LLM-Match] API error:", res.status, await res.text().catch(() => ""))
      return null
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content?.trim() ?? null
  } catch (e) {
    console.error("[LLM-Match] fetch error:", e)
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
    const amountMatch = line.match(/\$?([\d,]+\.?\d*)\s*(?:matched|applied|allocated)/i)
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, "")) : undefined
    const reasonParts = line.split(/:|->/).slice(2).join(":").trim()
    const reason = reasonParts || "LLM suggested match based on entity and amount analysis"
    if (mid && iid && !seen.has(`${mid}:${iid}`)) {
      seen.add(`${mid}:${iid}`)
      out.push({ movement_id: mid, invoice_id: iid, confidence: conf, reasoning: reason, amount_matched: amount })
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
    const amountMatch = line.match(/\$?([\d,]+\.?\d*)\s*(?:matched|applied|allocated)/i)
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, "")) : undefined
    const reasonParts = line.split(/:|->/).slice(2).join(":").trim()
    const reason = reasonParts || "LLM suggested match based on entity and amount analysis"
    if (mid && oid && !seen.has(`${mid}:${oid}`)) {
      seen.add(`${mid}:${oid}`)
      out.push({ movement_id: mid, obligation_id: oid, confidence: conf, reasoning: reason, amount_matched: amount })
    }
  }
  return out
}

/**
 * Batch match: send unmatched transactions + invoices/bills to LLM for entity matching.
 * Handles cases where rule-based matching fails due to name variations.
 */
export async function batchLLMMatch(
  inflows: UnmatchedInflow[],
  outflows: UnmatchedOutflow[],
  invoices: InvoiceForMatch[],
  bills: BillForMatch[],
): Promise<BatchMatchResult> {
  const result: BatchMatchResult = { ar: [], ap: [] }
  if (!API_KEY) {
    console.warn("[LLM-Match] No API key configured, skipping LLM matching")
    return result
  }

  const inflowIds = new Set(inflows.map((i) => i.movement_id))
  const outflowIds = new Set(outflows.map((o) => o.movement_id))
  const invoiceIds = new Set(invoices.map((i) => i.invoice_id))
  const obligationIds = new Set(bills.map((b) => b.obligation_id))

  const systemPrompt = `You are a financial reconciliation assistant. Match bank transactions to invoices/bills.

CONTEXT:
- Bank transactions often show organization names while invoices are under contact names
- Example: Bank shows "ABC Corp" but invoice is under "John Smith (ABC Corp)"
- Aggregated payments may cover multiple invoices from the same customer
- Payment amounts may differ slightly due to processor fees (typically 2-4%)

MATCHING RULES:
1. Entity match: Organization name in bank description should match organization in parentheses of customer/vendor name, OR be a clear variation
2. Amount: Payment within ±5% of invoice amount (accounts for fees). For aggregated payments, sum of matched invoices should approximate payment
3. Date: Payment should be within reasonable time of due date (45 days for AR, 14 days for AP)
4. Prefer exact or near-exact amount matches over partial matches

OUTPUT FORMAT (one line per match):
AR: [movement_id] -> [invoice_id]: [high|medium|low]: [brief reason]
AP: [movement_id] -> [obligation_id]: [high|medium|low]: [brief reason]

CONFIDENCE LEVELS:
- high: Clear entity match AND amount within 3%
- medium: Likely entity match OR amount within 5%
- low: Possible match requiring human review

Only output matches you're confident about. Do not guess.`

  const inflowSection = inflows.length > 0
    ? `UNMATCHED BANK DEPOSITS (AR):
${inflows.map((i) => `  ${i.movement_id}: $${i.amount.toFixed(2)} on ${i.date} | ${i.counterparty ?? ""} | ${(i.raw_description ?? "").slice(0, 80)}`).join("\n")}`
    : ""

  const outflowSection = outflows.length > 0
    ? `UNMATCHED BANK PAYMENTS (AP):
${outflows.map((o) => `  ${o.movement_id}: $${o.amount.toFixed(2)} on ${o.date} | ${o.counterparty ?? ""} | ${(o.raw_description ?? "").slice(0, 80)}`).join("\n")}`
    : ""

  const invoiceSection = invoices.length > 0
    ? `OUTSTANDING INVOICES (AR):
${invoices.map((i) => `  ${i.invoice_id}: ${i.customer_name} | $${i.amount_due.toFixed(2)} | due ${i.due_date ?? "N/A"}`).join("\n")}`
    : ""

  const billSection = bills.length > 0
    ? `OUTSTANDING BILLS (AP):
${bills.map((b) => `  ${b.obligation_id}: ${b.vendor_name} | $${b.amount_due.toFixed(2)} | due ${b.due_date ?? "N/A"}`).join("\n")}`
    : ""

  const userPrompt = `Match the following transactions to their corresponding invoices/bills.

${inflowSection}${inflowSection && (outflowSection || invoiceSection || billSection) ? "\n\n" : ""}${outflowSection}${outflowSection && (invoiceSection || billSection) ? "\n\n" : ""}${invoiceSection}${invoiceSection && billSection ? "\n\n" : ""}${billSection}

Output matches (one per line):`

  console.log("[LLM-Match] Sending request with", inflows.length, "inflows,", outflows.length, "outflows,", invoices.length, "invoices,", bills.length, "bills")
  
  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ])
  
  if (!content) {
    console.warn("[LLM-Match] No response from LLM")
    return result
  }

  console.log("[LLM-Match] Raw response:", content.slice(0, 500))

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

  console.log("[LLM-Match] Parsed", result.ar.length, "AR matches,", result.ap.length, "AP matches")
  return result
}

/**
 * Apply high-confidence LLM matches automatically.
 * Creates attributions for matches with confidence >= minConfidence.
 */
export async function applyLLMMatches(
  userId: string,
  matches: BatchMatchResult,
  invoiceMap: Map<string, InvoiceForMatch>,
  billMap: Map<string, BillForMatch>,
  movementAmounts: Map<string, number>,
  minConfidence: "high" | "medium" | "low" = "high",
): Promise<LLMMatchApplyResult> {
  const result: LLMMatchApplyResult = { applied: 0, skipped: 0, errors: [] }
  const confidenceOrder = { high: 3, medium: 2, low: 1 }
  const minLevel = confidenceOrder[minConfidence]

  for (const ar of matches.ar) {
    if (confidenceOrder[ar.confidence] < minLevel) {
      result.skipped++
      continue
    }

    const invoice = invoiceMap.get(ar.invoice_id)
    if (!invoice) {
      result.errors.push(`Invoice ${ar.invoice_id} not found`)
      continue
    }

    const movementAmount = movementAmounts.get(ar.movement_id) ?? 0
    const grossAmount = ar.amount_matched ?? invoice.amount_due
    const netAmount = Math.min(movementAmount, grossAmount)
    const feeAmount = Math.max(0, grossAmount - netAmount)

    try {
      const opts: CreateAttributionOpts = {
        userId,
        movementId: ar.movement_id,
        component_type: "ar",
        entity_id: invoice.entity_id ?? `ar://invoice/qbo/${ar.invoice_id}`,
        reference_id: ar.invoice_id,
        gross_amount: grossAmount,
        net_amount: netAmount,
        confidence: ar.confidence === "high" ? 0.88 : ar.confidence === "medium" ? 0.75 : 0.6,
        source: "llm",
        metadata: {
          match_method: "llm_entity_match",
          waterfall_stage: "llm_stage4",
          llm_confidence: ar.confidence,
          llm_reasoning: ar.reasoning,
          fee_amount: feeAmount,
        },
      }
      await createAttribution(opts)

      if (feeAmount > 0.01) {
        await createAttribution({
          userId,
          movementId: ar.movement_id,
          component_type: "fee",
          entity_id: "fee://processor",
          reference_id: null,
          gross_amount: 0,
          net_amount: -feeAmount,
          confidence: opts.confidence,
          source: "llm",
          metadata: {
            match_method: "llm_entity_match",
            waterfall_stage: "llm_stage4_fee",
            fee_amount: feeAmount,
          },
        })
      }

      result.applied++
    } catch (e) {
      result.errors.push(`AR ${ar.movement_id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  for (const ap of matches.ap) {
    if (confidenceOrder[ap.confidence] < minLevel) {
      result.skipped++
      continue
    }

    const bill = billMap.get(ap.obligation_id)
    if (!bill) {
      result.errors.push(`Bill ${ap.obligation_id} not found`)
      continue
    }

    const movementAmount = movementAmounts.get(ap.movement_id) ?? 0
    const grossAmount = ap.amount_matched ?? bill.amount_due
    const netAmount = Math.min(movementAmount, grossAmount)

    try {
      const opts: CreateAttributionOpts = {
        userId,
        movementId: ap.movement_id,
        component_type: "ap",
        entity_id: bill.entity_id ?? ap.obligation_id,
        reference_id: bill.bill_id,
        gross_amount: grossAmount,
        net_amount: netAmount,
        confidence: ap.confidence === "high" ? 0.88 : ap.confidence === "medium" ? 0.75 : 0.6,
        source: "llm",
        metadata: {
          match_method: "llm_entity_match",
          waterfall_stage: "llm_stage4",
          llm_confidence: ap.confidence,
          llm_reasoning: ap.reasoning,
        },
      }
      await createAttribution(opts)
      result.applied++
    } catch (e) {
      result.errors.push(`AP ${ap.movement_id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  console.log("[LLM-Match] Applied", result.applied, "matches, skipped", result.skipped, ", errors:", result.errors.length)
  return result
}

/**
 * Run LLM matching on Stage 4 flagged movements and auto-apply high-confidence matches.
 * This is called after the rule-based waterfall completes.
 */
export async function runLLMStage4(
  userId: string,
  pendingMovements: Array<{
    movement_id: string
    amount: number
    date: string
    counterparty: string | null
    raw_description: string | null
    direction: "inflow" | "outflow"
  }>,
  invoices: InvoiceForMatch[],
  bills: BillForMatch[],
  autoApplyMinConfidence: "high" | "medium" | "low" = "high",
): Promise<{ matches: BatchMatchResult; applied: LLMMatchApplyResult }> {
  const inflows = pendingMovements
    .filter((m) => m.direction === "inflow")
    .map((m) => ({
      movement_id: m.movement_id,
      amount: m.amount,
      date: m.date,
      counterparty: m.counterparty,
      raw_description: m.raw_description,
    }))

  const outflows = pendingMovements
    .filter((m) => m.direction === "outflow")
    .map((m) => ({
      movement_id: m.movement_id,
      amount: m.amount,
      date: m.date,
      counterparty: m.counterparty,
      raw_description: m.raw_description,
    }))

  console.log("[LLM-Stage4] Processing", inflows.length, "inflows,", outflows.length, "outflows")

  const matches = await batchLLMMatch(inflows, outflows, invoices, bills)

  const invoiceMap = new Map(invoices.map((i) => [i.invoice_id, i]))
  const billMap = new Map(bills.map((b) => [b.obligation_id, b]))
  const movementAmounts = new Map(pendingMovements.map((m) => [m.movement_id, m.amount]))

  const applied = await applyLLMMatches(userId, matches, invoiceMap, billMap, movementAmounts, autoApplyMinConfidence)

  if (applied.applied > 0) {
    await query(
      `UPDATE movements 
       SET metadata = metadata - 'reconciliation_waterfall_review'
       WHERE user_id = $1::uuid 
         AND id = ANY($2::uuid[])
         AND metadata ? 'reconciliation_waterfall_review'`,
      [userId, [...new Set([...matches.ar.map((a) => a.movement_id), ...matches.ap.map((a) => a.movement_id)])]]
    )
  }

  return { matches, applied }
}

/**
 * AI-powered movement edit: parses user intent and returns structured edit plan.
 * User says "change all Gusto to payroll" → LLM returns which movements to match + what to change.
 *
 * Requires OPENAI_API_KEY. Uses same pattern as forecast-llm.
 */

const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"
const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY

const VALID_MOVEMENT_TYPES = [
  "cash_in_customer", "cash_out_vendor", "cash_out_operating_expense",
  "cash_out_payroll", "cash_out_tax", "cash_out_bank_fee", "bank_fee_refund",
  "cash_in_refund", "cash_out_refund", "cash_in_interest", "cash_out_interest",
  "processor_fee_settlement", "processor_payout", "internal_transfer",
  "owner_contribution", "owner_draw", "credit_card_payment",
  "merchant_deposit_unresolved", "merchant_deposit_resolved",
  "unknown_inflow", "unknown_outflow", "unknown_transfer_candidate",
  "review_candidate_revenue", "other_operating",
  "account_verification", "opening_balance", "settlement_in", "settlement_adjustment",
] as const

export type MovementEditPlan = {
  match: {
    /** Match by counterparty/description containing this (case-insensitive) */
    counterparty_contains?: string
    /** Match by movement_type */
    movement_type?: string
    /** Match by raw_description containing this */
    description_contains?: string
    /** Match specific movement IDs (when user selected rows) */
    movement_ids?: string[]
  }
  changes: {
    movement_type?: string
    counterparty?: string
    /** Set confidence to 0.95 for user-confirmed edits */
    confidence?: number
  }
  summary: string
}

export type MovementSummary = {
  id: string
  direction: string
  amount: number
  raw_description: string | null
  counterparty: string | null
  movement_type: string
}

async function callLLM(messages: { role: string; content: string }[], maxTokens = 1200): Promise<string | null> {
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
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content?.trim()
    return content ?? null
  } catch {
    return null
  }
}

/**
 * Parse user intent into a structured edit plan.
 * movements: sample of user's movements for context (id, direction, amount, counterparty, movement_type).
 */
export async function parseEditIntent(
  userIntent: string,
  movements: MovementSummary[],
  selectedMovementIds?: string[],
): Promise<MovementEditPlan | null> {
  if (!userIntent.trim()) return null

  const sample = movements.slice(0, 80).map((m) =>
    `id=${m.id} dir=${m.direction} amt=${m.amount} counterparty="${m.counterparty ?? ""}" desc="${(m.raw_description ?? "").slice(0, 60)}" type=${m.movement_type}`,
  ).join("\n")

  const systemPrompt = `You parse a user's natural language edit request for their bank/accounting transactions into a structured plan.

VALID movement_type values (use exactly): ${VALID_MOVEMENT_TYPES.join(", ")}

Common mappings:
- "payroll" / "Gusto" / "ADP" → cash_out_payroll
- "vendor" / "supplier" → cash_out_vendor
- "customer payment" / "sales" → cash_in_customer
- "transfer" between own accounts → internal_transfer
- "bank fee" → cash_out_bank_fee
- "tax" → cash_out_tax
- "processor fee" / "Stripe fee" → processor_fee_settlement
- "owner contribution" → owner_contribution
- "owner draw" → owner_draw

Output ONLY a single JSON object with this exact schema (no markdown, no code fence):
{
  "match": {
    "counterparty_contains": "string or null - substring to match in counterparty/description",
    "movement_type": "string or null - match only this type",
    "description_contains": "string or null - substring in raw_description",
    "movement_ids": ["uuid1","uuid2"] or null - when user selected specific rows
  },
  "changes": {
    "movement_type": "string or null",
    "counterparty": "string or null",
    "confidence": 0.95
  },
  "summary": "One sentence describing what will change"
}

Rules:
- If user says "change X to Y", set match.counterparty_contains = X (or description_contains) and changes.movement_type = mapped Y.
- If user provides movement_ids, use match.movement_ids.
- Omit null fields from output.
- summary must be human-readable, e.g. "Change all Gusto payments to payroll (5 transactions)".
- Be conservative: only match what user clearly asked for.`

  const userContent = selectedMovementIds?.length
    ? `User request: "${userIntent}"\n\nSelected movement IDs: ${selectedMovementIds.join(", ")}\n\nApply to these specific movements only.`
    : `User request: "${userIntent}"\n\nSample movements:\n${sample}\n\nIdentify which movements match and what to change.`

  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ])

  if (!content) return null

  try {
    const jsonStr = content.replace(/```json?\s*/gi, "").replace(/```/g, "").trim()
    const parsed = JSON.parse(jsonStr) as MovementEditPlan

    if (!parsed.match || !parsed.changes) return null
    if (Object.keys(parsed.changes).length === 0) return null

    // Validate movement_type if present
    if (parsed.changes.movement_type && !VALID_MOVEMENT_TYPES.includes(parsed.changes.movement_type as any)) {
      parsed.changes.movement_type = undefined
    }
    if (parsed.match.movement_type && !VALID_MOVEMENT_TYPES.includes(parsed.match.movement_type as any)) {
      parsed.match.movement_type = undefined
    }

    return parsed
  } catch {
    return null
  }
}

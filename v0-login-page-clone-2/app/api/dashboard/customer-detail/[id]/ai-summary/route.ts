import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/require-session"
import { query } from "@/lib/db"
import { searchEntityProfileContext } from "@/lib/supermemory"

const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o-mini"
const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY

interface AISummaryResponse {
  summary: string
  paymentBehavior: string
  riskAssessment: string
  seasonality: string
  trends: string
  recommendations: string[]
  contractContext: string
  generatedAt: string
}

async function callLLM(
  messages: { role: string; content: string }[],
  maxTokens = 800
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
        temperature: 0.3,
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content?.trim() ?? null
  } catch {
    return null
  }
}

function formatCurrency(amount: number | string | null | undefined): string {
  let num: number
  if (amount === null || amount === undefined) {
    num = 0
  } else if (typeof amount === "string") {
    num = parseFloat(amount)
    if (isNaN(num)) num = 0
  } else if (typeof amount === "number" && !isNaN(amount)) {
    num = amount
  } else {
    num = 0
  }
  if (num >= 1000000) return `$${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `$${(num / 1000).toFixed(1)}K`
  return `$${num.toFixed(0)}`
}

function formatMonths(months: number[]): string {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return months.map((m) => names[m - 1]).join(", ")
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = session.id
    const entityId = params.id

    // Fetch entity and profile data
    const entityResult = await query<{
      canonical_name: string
      display_name: string | null
      entity_type: string
    }>(
      `SELECT canonical_name, display_name, entity_type FROM entities WHERE id = $1::uuid AND user_id = $2::uuid`,
      [entityId, userId]
    )

    if (entityResult.rows.length === 0) {
      return NextResponse.json({ error: "Entity not found" }, { status: 404 })
    }

    const entity = entityResult.rows[0]
    const entityName = entity.display_name || entity.canonical_name
    const entityType = entity.entity_type

    // Fetch payment profile
    const profileResult = await query<{
      transaction_count: number
      lifetime_value: number | string
      outstanding_amount: number | string
      overdue_amount: number | string
      avg_days_to_pay: number | null
      on_time_payment_rate: number | null
      early_payment_rate: number | null
      avg_payment_amount: number | string | null
      amount_trend: string | null
      transactions_per_month: number | null
      peak_months: number[] | null
      low_months: number[] | null
      risk_score: number | null
      risk_factors: string[] | null
      archetype: string | null
    }>(
      `SELECT 
        transaction_count,
        lifetime_value,
        outstanding_amount,
        overdue_amount,
        avg_days_to_pay,
        on_time_payment_rate,
        early_payment_rate,
        avg_payment_amount,
        amount_trend,
        transactions_per_month,
        peak_months,
        low_months,
        risk_score,
        risk_factors,
        archetype
       FROM entity_payment_profiles
       WHERE entity_id = $1::uuid AND user_id = $2::uuid`,
      [entityId, userId]
    )

    const profile = profileResult.rows[0]
    if (!profile) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 })
    }

    // Fetch Supermemory context
    let supermemoryContext = ""
    try {
      const smContext = await searchEntityProfileContext(userId, entity.canonical_name, entityType as any)
      if (smContext?.rawContext) {
        supermemoryContext = smContext.rawContext.slice(0, 1500)
      }
    } catch (err) {
      console.warn(`[ai-summary] Supermemory context fetch failed:`, err)
    }

    // Build comprehensive prompt
    const systemPrompt = `You are a financial analyst providing comprehensive insights about customer/vendor payment behavior and financial health.
Your responses should be:
- Clear and actionable for a business owner
- Data-driven but easy to understand
- Incorporate contract terms and relationship context when available
- Provide specific, numbered recommendations

Respond in JSON format with exactly these fields:
{
  "summary": "2-3 sentence behavioral overview",
  "paymentBehavior": "Detailed payment pattern analysis",
  "riskAssessment": "Risk factors and mitigation strategies",
  "seasonality": "Seasonal patterns if any",
  "trends": "Amount and frequency trends",
  "recommendations": ["Specific action 1", "Specific action 2", "Specific action 3"],
  "contractContext": "Contract terms and relationship notes"
}`

    const userPrompt = `Analyze this ${entityType}'s financial profile comprehensively:

Entity: ${entityName}
Type: ${entityType}
Archetype: ${profile.archetype || "Unknown"}
Lifetime Value: ${formatCurrency(profile.lifetime_value)}
Outstanding: ${formatCurrency(profile.outstanding_amount)}
Overdue: ${formatCurrency(profile.overdue_amount)}

Payment Metrics:
- Transaction count: ${profile.transaction_count}
- Avg days to pay: ${profile.avg_days_to_pay?.toFixed(1) || "N/A"}
- On-time rate: ${profile.on_time_payment_rate ? (profile.on_time_payment_rate * 100).toFixed(0) + "%" : "N/A"}
- Early payment rate: ${profile.early_payment_rate ? (profile.early_payment_rate * 100).toFixed(0) + "%" : "N/A"}
- Avg amount: ${formatCurrency(profile.avg_payment_amount)}
- Amount trend: ${profile.amount_trend || "stable"}
- Transactions per month: ${profile.transactions_per_month?.toFixed(1) || "N/A"}

Risk Assessment:
- Risk score: ${profile.risk_score ? (profile.risk_score * 100).toFixed(0) + "%" : "N/A"}
- Risk factors: ${profile.risk_factors?.length ? profile.risk_factors.join(", ") : "None"}

Seasonality:
- Peak months: ${profile.peak_months?.length ? formatMonths(profile.peak_months) : "None detected"}
- Low months: ${profile.low_months?.length ? formatMonths(profile.low_months) : "None detected"}

${supermemoryContext ? `\nDocument Context (from company files):\n${supermemoryContext}` : ""}`

    const response = await callLLM(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      800
    )

    if (!response) {
      return NextResponse.json(
        {
          summary: "Unable to generate AI summary at this time",
          paymentBehavior: "Payment data available but AI analysis unavailable",
          riskAssessment: "Risk assessment unavailable",
          seasonality: "Seasonality analysis unavailable",
          trends: "Trend analysis unavailable",
          recommendations: [],
          contractContext: "",
          generatedAt: new Date().toISOString(),
        },
        { status: 200 }
      )
    }

    try {
      const parsed = JSON.parse(response) as Partial<AISummaryResponse>
      return NextResponse.json({
        summary: parsed.summary || "Analysis complete",
        paymentBehavior: parsed.paymentBehavior || "",
        riskAssessment: parsed.riskAssessment || "",
        seasonality: parsed.seasonality || "",
        trends: parsed.trends || "",
        recommendations: parsed.recommendations || [],
        contractContext: parsed.contractContext || "",
        generatedAt: new Date().toISOString(),
      })
    } catch {
      return NextResponse.json(
        {
          summary: response.slice(0, 200),
          paymentBehavior: response.slice(200, 400),
          riskAssessment: response.slice(400, 600),
          seasonality: "",
          trends: "",
          recommendations: [],
          contractContext: "",
          generatedAt: new Date().toISOString(),
        },
        { status: 200 }
      )
    }
  } catch (error) {
    // Re-throw Next.js redirect (thrown by requireSession when unauthenticated)
    if (error instanceof Error && error.message === "NEXT_REDIRECT") throw error
    console.error("[ai-summary] Error:", error)
    return NextResponse.json(
      { error: "Failed to generate AI summary" },
      { status: 500 }
    )
  }
}

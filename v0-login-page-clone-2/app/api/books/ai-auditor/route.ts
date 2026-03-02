import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"

const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o-mini"
const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY

const ACCOUNT_NAMES: Record<string, string> = {
  customer_receipt: "Customer Receipts",
  settlement_in: "Settlement Income",
  vendor_payment: "Vendor Payments",
  payroll: "Payroll",
  bank_fee: "Bank Fees",
  processor_fee: "Processor Fees",
  tax: "Taxes",
  debt_payment: "Debt Payments",
  owner_draw: "Owner Draws",
  interest: "Interest",
}

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureMovementsSchema()

  const now = new Date()
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1).toISOString().slice(0, 10)

  const [monthlyRows, suspenseRows, dataIntegrityRows, currentMonthRows] = await Promise.all([
    // Monthly totals per economic_class over last 12 months (for anomaly detection)
    query<{ economic_class: string; yr: string; mo: string; total: string }>(
      `SELECT mt.economic_class,
              EXTRACT(YEAR FROM m.date)::text AS yr,
              EXTRACT(MONTH FROM m.date)::text AS mo,
              SUM(ABS(m.amount))::text AS total
       FROM movements m
       JOIN movement_tags mt ON mt.movement_id = m.id AND mt.user_id = m.user_id
       WHERE m.user_id = $1 AND m.duplicate_of IS NULL AND m.date >= $2
         AND mt.economic_class IN (
           'customer_receipt','settlement_in','vendor_payment','payroll','bank_fee',
           'processor_fee','tax','debt_payment','owner_draw','interest'
         )
       GROUP BY mt.economic_class, yr, mo`,
      [user.id, twelveMonthsAgo]
    ).then(r => r.rows),

    // Suspense/unclassified balance
    query<{ count: string; total: string }>(
      `SELECT COUNT(*)::text AS count, COALESCE(SUM(ABS(ma.net_amount)), 0)::text AS total
       FROM movement_attributions ma
       WHERE ma.user_id = $1 AND ma.component_type = 'unknown'`,
      [user.id]
    ).then(r => r.rows[0]),

    // Data integrity: paid cash_events with outstanding > 0
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM cash_events
       WHERE user_id = $1 AND status = 'paid' AND outstanding_amount > 0.01`,
      [user.id]
    ).then(r => r.rows[0]),

    // Current month totals per economic_class
    query<{ economic_class: string; total: string }>(
      `SELECT mt.economic_class, SUM(ABS(m.amount))::text AS total
       FROM movements m
       JOIN movement_tags mt ON mt.movement_id = m.id AND mt.user_id = m.user_id
       WHERE m.user_id = $1 AND m.duplicate_of IS NULL AND m.date >= $2
         AND mt.economic_class IN (
           'customer_receipt','settlement_in','vendor_payment','payroll','bank_fee',
           'processor_fee','tax','debt_payment','owner_draw','interest'
         )
       GROUP BY mt.economic_class`,
      [user.id, currentMonthStart]
    ).then(r => r.rows),
  ])

  // Build historical averages per economic_class (exclude current month)
  const historyMap: Record<string, number[]> = {}
  const currYr = now.getFullYear().toString()
  const currMo = (now.getMonth() + 1).toString()

  for (const r of monthlyRows) {
    if (r.yr === currYr && r.mo === currMo) continue // skip current month in avg calc
    if (!historyMap[r.economic_class]) historyMap[r.economic_class] = []
    historyMap[r.economic_class].push(parseFloat(r.total))
  }

  const avgMap: Record<string, number> = {}
  for (const [cls, vals] of Object.entries(historyMap)) {
    avgMap[cls] = vals.reduce((s, v) => s + v, 0) / Math.max(vals.length, 1)
  }

  // Current month totals
  const currentMap: Record<string, number> = {}
  for (const r of currentMonthRows) currentMap[r.economic_class] = parseFloat(r.total)

  // Detect anomalies
  const anomalies: Array<{ severity: "warning" | "error"; code: string; message: string }> = []

  for (const [cls, currentAmt] of Object.entries(currentMap)) {
    const avg = avgMap[cls] ?? 0
    if (avg > 100 && currentAmt > avg * 2.5) {
      anomalies.push({
        severity: "warning",
        code: `spike_${cls}`,
        message: `${ACCOUNT_NAMES[cls] ?? cls}: ${fmt(currentAmt)} this month vs. ${fmt(avg)} historical average (${Math.round(currentAmt / avg)}× normal)`,
      })
    }
  }

  const suspenseTotal = parseFloat(suspenseRows?.total ?? "0")
  const suspenseCount = parseInt(suspenseRows?.count ?? "0")
  if (suspenseTotal > 0.01) {
    anomalies.push({
      severity: "error",
      code: "suspense_balance",
      message: `Suspense / Unclassified account has a balance of ${fmt(suspenseTotal)} across ${suspenseCount} entries. These should be classified before closing.`,
    })
  }

  const dataIntegrityCount = parseInt(dataIntegrityRows?.count ?? "0")
  if (dataIntegrityCount > 0) {
    anomalies.push({
      severity: "error",
      code: "data_integrity",
      message: `${dataIntegrityCount} invoices/bills are marked "paid" in the system but still show outstanding balances > $0. This indicates a data sync issue.`,
    })
  }

  if (anomalies.length === 0) {
    return NextResponse.json({
      anomalies: [],
      narrative: "Books look clean. No anomalies detected for the current period.",
      generated_at: new Date().toISOString(),
    })
  }

  // Call LLM for plain-English narrative
  let narrative = anomalies.map(a => `• ${a.message}`).join("\n")

  if (API_KEY) {
    try {
      const prompt = `You are an expert CFO reviewing a client's books. You found the following anomalies:

${anomalies.map((a, i) => `${i + 1}. [${a.severity.toUpperCase()}] ${a.message}`).join("\n")}

Write a concise, plain-English audit summary (3-5 sentences) explaining what these mean in practical terms for a non-finance business owner. Be direct. Flag what needs immediate attention vs. what is informational. Do not use jargon. Do not use markdown headers.`

      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 300,
          temperature: 0.3,
        }),
      })

      if (res.ok) {
        const json = await res.json()
        narrative = json.choices?.[0]?.message?.content ?? narrative
      }
    } catch {
      // fallback to bullet list
    }
  }

  return NextResponse.json({
    anomalies,
    narrative,
    generated_at: new Date().toISOString(),
  })
}

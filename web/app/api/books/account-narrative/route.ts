import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"

const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o-mini"
const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

export async function GET(request: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const accountCode = searchParams.get("code")

  if (!accountCode) {
    return NextResponse.json({ error: "account code required" }, { status: 400 })
  }

  await ensureMovementsSchema()

  // Map account codes to entity types and queries
  const accountMap: Record<string, { name: string; type: "ar" | "ap" | "expense" | "revenue" }> = {
    "1100": { name: "Accounts Receivable", type: "ar" },
    "2001": { name: "Accounts Payable", type: "ap" },
    "5001": { name: "Vendor Payments", type: "expense" },
    "4001": { name: "Customer Receipts", type: "revenue" },
  }

  const account = accountMap[accountCode]
  if (!account) {
    return NextResponse.json({ error: "account not found" }, { status: 404 })
  }

  // Fetch relevant data based on account type
  let narrative = ""
  let keyMetrics: Record<string, unknown> = {}
  let riskFlags: string[] = []

  if (account.type === "ar") {
    // AR: Get top customers, payment reliability, overdue items
    const [arData, topCustomers, overdueItems] = await Promise.all([
      query<{ total: string; count: string }>(
        `SELECT COALESCE(SUM(outstanding_amount), 0)::text AS total, COUNT(*)::text AS count
         FROM cash_events WHERE user_id = $1 AND event_type = 'ar' AND status != 'paid'`,
        [user.id]
      ).then(r => r.rows[0]),

      query<{ entity_name: string; outstanding: string; reliability: string }>(
        `SELECT e.canonical_name as entity_name, 
                COALESCE(SUM(ce.outstanding_amount), 0)::text AS outstanding,
                COALESCE(epp.reliability_score::text, '0.5') AS reliability
         FROM cash_events ce
         JOIN entities e ON e.id::text = ce.entity_id
         LEFT JOIN entity_payment_profiles epp ON epp.entity_id = e.id AND epp.user_id = e.user_id
         WHERE ce.user_id = $1 AND ce.event_type = 'ar' AND ce.status != 'paid'
         GROUP BY e.id, e.canonical_name, epp.reliability_score
         ORDER BY outstanding DESC
         LIMIT 5`,
        [user.id]
      ).then(r => r.rows),

      query<{ entity_name: string; days_overdue: string; amount: string }>(
        `SELECT e.canonical_name as entity_name,
                EXTRACT(DAY FROM NOW() - ce.expected_date)::text AS days_overdue,
                ce.outstanding_amount::text AS amount
         FROM cash_events ce
         JOIN entities e ON e.id::text = ce.entity_id
         WHERE ce.user_id = $1 AND ce.event_type = 'ar' AND ce.status != 'paid'
           AND ce.expected_date < NOW()
         ORDER BY ce.expected_date ASC
         LIMIT 10`,
        [user.id]
      ).then(r => r.rows),
    ])

    const totalAr = parseFloat(arData?.total ?? "0")
    const countAr = parseInt(arData?.count ?? "0")
    const topCustomerPct = topCustomers.length > 0 ? (parseFloat(topCustomers[0].outstanding) / totalAr * 100) : 0

    keyMetrics = {
      total_outstanding: fmt(totalAr),
      invoice_count: countAr,
      top_customer: topCustomers[0]?.entity_name,
      top_customer_pct: Math.round(topCustomerPct),
      avg_reliability: Math.round(
        topCustomers.reduce((s, c) => s + parseFloat(c.reliability), 0) / Math.max(topCustomers.length, 1) * 100
      ),
    }

    if (topCustomerPct > 50) {
      riskFlags.push(`Concentration risk: Top customer represents ${Math.round(topCustomerPct)}% of AR`)
    }

    if (overdueItems.length > 0) {
      const totalOverdue = overdueItems.reduce((s, i) => s + parseFloat(i.amount), 0)
      riskFlags.push(`${overdueItems.length} overdue invoices totaling ${fmt(totalOverdue)}`)
    }

    const prompt = `You are a CFO analyzing accounts receivable. Provide a 2-3 sentence plain-English explanation of the AR situation:

Account: Accounts Receivable
Total Outstanding: ${fmt(totalAr)}
Number of Invoices: ${countAr}
Top Customers: ${topCustomers.map(c => `${c.entity_name} ($${parseFloat(c.outstanding).toFixed(0)})`).join(", ")}
Average Customer Reliability: ${keyMetrics.avg_reliability}%
Overdue Items: ${overdueItems.length} invoices totaling ${fmt(overdueItems.reduce((s, i) => s + parseFloat(i.amount), 0))}

${riskFlags.length > 0 ? `Risk Flags: ${riskFlags.join("; ")}` : ""}

Explain what this means for the business and any recommended actions.`

    if (API_KEY) {
      try {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${API_KEY}`,
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 200,
            temperature: 0.3,
          }),
        })

        if (res.ok) {
          const json = await res.json()
          narrative = json.choices?.[0]?.message?.content ?? ""
        }
      } catch (e) {
        console.error("LLM error:", e)
      }
    }
  } else if (account.type === "ap") {
    // AP: Get top vendors, payment timing, upcoming obligations
    const [apData, topVendors, upcomingPayments] = await Promise.all([
      query<{ total: string; count: string }>(
        `SELECT COALESCE(SUM(outstanding_amount), 0)::text AS total, COUNT(*)::text AS count
         FROM cash_events WHERE user_id = $1 AND event_type = 'ap' AND status != 'paid'`,
        [user.id]
      ).then(r => r.rows[0]),

      query<{ entity_name: string; outstanding: string; avg_days_to_pay: string }>(
        `SELECT e.canonical_name as entity_name,
                COALESCE(SUM(ce.outstanding_amount), 0)::text AS outstanding,
                COALESCE(epp.avg_days_to_pay::text, '0') AS avg_days_to_pay
         FROM cash_events ce
         JOIN entities e ON e.id::text = ce.entity_id
         LEFT JOIN entity_payment_profiles epp ON epp.entity_id = e.id AND epp.user_id = e.user_id
         WHERE ce.user_id = $1 AND ce.event_type = 'ap' AND ce.status != 'paid'
         GROUP BY e.id, e.canonical_name, epp.avg_days_to_pay
         ORDER BY outstanding DESC
         LIMIT 5`,
        [user.id]
      ).then(r => r.rows),

      query<{ entity_name: string; days_until_due: string; amount: string }>(
        `SELECT e.canonical_name as entity_name,
                EXTRACT(DAY FROM ce.expected_date - NOW())::text AS days_until_due,
                ce.outstanding_amount::text AS amount
         FROM cash_events ce
         JOIN entities e ON e.id::text = ce.entity_id
         WHERE ce.user_id = $1 AND ce.event_type = 'ap' AND ce.status != 'paid'
           AND ce.expected_date BETWEEN NOW() AND NOW() + INTERVAL '30 days'
         ORDER BY ce.expected_date ASC
         LIMIT 10`,
        [user.id]
      ).then(r => r.rows),
    ])

    const totalAp = parseFloat(apData?.total ?? "0")
    const countAp = parseInt(apData?.count ?? "0")
    const topVendorPct = topVendors.length > 0 ? (parseFloat(topVendors[0].outstanding) / totalAp * 100) : 0

    keyMetrics = {
      total_outstanding: fmt(totalAp),
      bill_count: countAp,
      top_vendor: topVendors[0]?.entity_name,
      top_vendor_pct: Math.round(topVendorPct),
      avg_payment_days: Math.round(
        topVendors.reduce((s, v) => s + parseFloat(v.avg_days_to_pay), 0) / Math.max(topVendors.length, 1)
      ),
    }

    if (topVendorPct > 50) {
      riskFlags.push(`Concentration risk: Top vendor represents ${Math.round(topVendorPct)}% of AP`)
    }

    const upcomingTotal = upcomingPayments.reduce((s, p) => s + parseFloat(p.amount), 0)
    if (upcomingTotal > 0) {
      riskFlags.push(`${upcomingPayments.length} payments due in next 30 days totaling ${fmt(upcomingTotal)}`)
    }

    const prompt = `You are a CFO analyzing accounts payable. Provide a 2-3 sentence plain-English explanation of the AP situation:

Account: Accounts Payable
Total Outstanding: ${fmt(totalAp)}
Number of Bills: ${countAp}
Top Vendors: ${topVendors.map(v => `${v.entity_name} ($${parseFloat(v.outstanding).toFixed(0)})`).join(", ")}
Average Payment Terms: ${keyMetrics.avg_payment_days} days
Upcoming Payments (30 days): ${fmt(upcomingTotal)}

${riskFlags.length > 0 ? `Risk Flags: ${riskFlags.join("; ")}` : ""}

Explain what this means for cash flow and any recommended actions.`

    if (API_KEY) {
      try {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${API_KEY}`,
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 200,
            temperature: 0.3,
          }),
        })

        if (res.ok) {
          const json = await res.json()
          narrative = json.choices?.[0]?.message?.content ?? ""
        }
      } catch (e) {
        console.error("LLM error:", e)
      }
    }
  }

  return NextResponse.json({
    account_code: accountCode,
    account_name: account.name,
    narrative: narrative || "Unable to generate narrative at this time.",
    key_metrics: keyMetrics,
    risk_flags: riskFlags,
    generated_at: new Date().toISOString(),
  })
}

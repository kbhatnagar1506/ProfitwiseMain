import { getTransactionsByUserId } from "./plaid-persistence"

export type FinancialContext = {
  majorExpenses: { vendor: string; amount: number; count: number; tag?: string }[]
  vendors: { name: string; totalPaid: number; count: number; tag?: string }[]
  paymentsLast60Days: { date: string; amount: number; payee: string; tag?: string }[]
  totalOutflows60Days: number
  majorInflows: { source: string; amount: number; count: number; tag?: string }[]
  paymentsReceivedLast60Days: { date: string; amount: number; source: string; tag?: string }[]
  totalInflows60Days: number
  summary: string
  /** Rich narrative of financial activity (last 90 days) for merge. */
  narrative?: string
}

// Configuration constants
const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"
const LLM_MAX_TOKENS = 1024
const LLM_TEMPERATURE = 0.2
const DAYS_WINDOW = 90
const TOP_EXPENSES_LIMIT = 40
const TOP_INFLOWS_LIMIT = 40

async function pretagExpenses(
  expenses: { vendor: string; amount: number; count: number }[]
): Promise<{ vendor: string; tag: string }[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.warn("[financial-context] Missing OPENAI_API_KEY for expense tagging")
    return []
  }
  if (expenses.length === 0) return []
  const list = expenses.map((e) => `${e.vendor}: $${e.amount.toLocaleString()} (${e.count} txns)`).join("\n")
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: `You are a financial categorizer. Given a list of vendors/merchants and their spend, assign each a short tag (1-2 words) such as: Software, Marketing, Office, Travel, Payroll, Insurance, Utilities, Professional Services, Subscriptions, Rent, Supplies, etc. Return a JSON array: [{"vendor": "exact vendor name", "tag": "Tag"}]`,
        },
        { role: "user", content: list },
      ],
      max_tokens: LLM_MAX_TOKENS,
      temperature: LLM_TEMPERATURE,
  inflows: { source: string; amount: number; count: number }[]
): Promise<{ source: string; tag: string }[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.warn("[financial-context] Missing OPENAI_API_KEY for inflow tagging")
    return []
  }
  if (inflows.length === 0) return []
  const list = inflows.map((e) => `${e.source}: $${e.amount.toLocaleString()} (${e.count} txns)`).join("\n")
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: `You are a financial categorizer. Given a list of payment sources (money received) and amounts, assign each a short tag (1-2 words) such as: Revenue, Client Payment, Customer, Refund, Transfer, Interest, Grant, Investment, etc. Return a JSON array: [{"source": "exact source name", "tag": "Tag"}]`,
        },
        { role: "user", content: list },
      ],
      max_tokens: LLM_MAX_TOKENS,
      temperature: LLM_TEMPERATURE,
    }),
  })
  if (!res.ok) return []
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const raw = data.choices?.[0]?.message?.content?.trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim()) as { source: string; tag: string }[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const DAYS_WINDOW = 90

async function generateFinancialNarrative(
  totalOut: number,
  totalIn: number,
  expenses: { vendor: string; amount: number; tag?: string }[],
  inflows: { source: string; amount: number; tag?: string }[]
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.warn("[financial-context] Missing OPENAI_API_KEY for narrative generation")
    return ""
  }
  const userContent = [
    `Total outflows (last ${DAYS_WINDOW} days): $${totalOut.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    `Total inflows: $${totalIn.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    `Top expenses by vendor: ${expenses.slice(0, 30).map((e) => `${e.vendor} ($${e.amount.toLocaleString()}${e.tag ? `, ${e.tag}` : ""})`).join("; ")}`,
    `Top money received from: ${inflows.slice(0, 30).map((e) => `${e.source} ($${e.amount.toLocaleString()}${e.tag ? `, ${e.tag}` : ""})`).join("; ") || "None"}`,
  ].join("\n")
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: `You are summarizing financial data. Given totals and lists of vendors (money out) and sources (money in), write a factual 3–5 paragraph summary of the company's financial activity. Include only context: total outflows and inflows, major vendors and amounts, major inflow sources and amounts, and category tags. Use flowing prose only; no bullet points or headings. Do NOT add analysis, interpretation, or what the numbers "mean" or "suggest." State facts only. Do not include sensitive data (account numbers, etc.).`,
        },
        { role: "user", content: userContent },
      ],
      max_tokens: 2048,
      temperature: LLM_TEMPERATURE,
    }),
  })
  if (!res.ok) return ""
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const raw = data.choices?.[0]?.message?.content?.trim()
  return raw ?? ""
}

/** Build financial context from Plaid transactions stored in DB (last 90 days). */
export async function buildFinancialContext(userId: string): Promise<FinancialContext> {
  const startDate = new Date(Date.now() - DAYS_WINDOW * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const endDate = new Date().toISOString().slice(0, 10)

  const vendorsMap = new Map<string, { totalPaid: number; count: number }>()
  const paymentsLast60Days: { date: string; amount: number; payee: string }[] = []
  let totalOutflows60Days = 0
  const inflowsMap = new Map<string, { totalReceived: number; count: number }>()
  const paymentsReceivedLast60Days: { date: string; amount: number; source: string }[] = []
  let totalInflows60Days = 0

  const plaidTx = await getTransactionsByUserId(userId, {
    startDate,
    endDate,
    limit: 1000,
  })
  for (const t of plaidTx) {
    const amt = Number(t.amount)
    const source = t.merchant_name || t.name || "Unknown"
    if (amt < 0) {
      const absAmt = Math.abs(amt)
      totalOutflows60Days += absAmt
      const cur = vendorsMap.get(source) ?? { totalPaid: 0, count: 0 }
      cur.totalPaid += absAmt
      cur.count += 1
      vendorsMap.set(source, cur)
      paymentsLast60Days.push({ date: t.date, amount: absAmt, payee: source })
    } else if (amt > 0) {
      totalInflows60Days += amt
      const cur = inflowsMap.get(source) ?? { totalReceived: 0, count: 0 }
      cur.totalReceived += amt
      cur.count += 1
      inflowsMap.set(source, cur)
      paymentsReceivedLast60Days.push({ date: t.date, amount: amt, source })
    }
  }

  const majorExpensesRaw: { vendor: string; amount: number; count: number }[] = []
  for (const [vendor, data] of vendorsMap) {
    if (data.totalPaid > 0) {
      majorExpensesRaw.push({ vendor, amount: data.totalPaid, count: data.count })
    }
  }
  majorExpensesRaw.sort((a, b) => b.amount - a.amount)
  const topExpensesRaw = majorExpensesRaw.slice(0, TOP_EXPENSES_LIMIT)

  const tags = await pretagExpenses(topExpensesRaw)
  const tagMap = new Map(tags.map((t) => [t.vendor, t.tag]))

  const majorExpenses = topExpensesRaw.map((e) => ({
    ...e,
    tag: tagMap.get(e.vendor),
  }))
  const vendorsList = majorExpenses.map((e) => ({
    name: e.vendor,
    totalPaid: e.amount,
    count: e.count,
    tag: e.tag,
  }))

  const paymentTagMap = new Map(tags.map((t) => [t.vendor, t.tag]))
  const paymentsTagged = paymentsLast60Days
    .sort((a, b) => (b.date > a.date ? 1 : -1))
    .slice(0, 100)
    .map((p) => ({ ...p, tag: paymentTagMap.get(p.payee) }))

  const inflowsRaw: { source: string; amount: number; count: number }[] = []
  for (const [source, data] of inflowsMap) {
    if (data.totalReceived > 0) {
      inflowsRaw.push({ source, amount: data.totalReceived, count: data.count })
    }
  }
  inflowsRaw.sort((a, b) => b.amount - a.amount)
  const topInflowsRaw = inflowsRaw.slice(0, TOP_INFLOWS_LIMIT)
  const inflowTags = await pretagInflows(topInflowsRaw)
  const inflowTagMap = new Map(inflowTags.map((t) => [t.source, t.tag]))
  const majorInflows = topInflowsRaw.map((e) => ({
    ...e,
    tag: inflowTagMap.get(e.source),
  }))
  const paymentsReceivedTagged = paymentsReceivedLast60Days
    .sort((a, b) => (b.date > a.date ? 1 : -1))
    .slice(0, 100)
    .map((p) => ({ ...p, tag: inflowTagMap.get(p.source) }))

  const summary = [
    `Total outflows (last ${DAYS_WINDOW} days): $${totalOutflows60Days.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    `Total inflows: $${totalInflows60Days.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    `Top vendors by spend: ${majorExpenses.slice(0, 10).map((e) => `${e.vendor}${e.tag ? ` [${e.tag}]` : ""} ($${e.amount.toLocaleString()})`).join(", ") || "None"}`,
    `Top money received from: ${majorInflows.slice(0, 10).map((e) => `${e.source}${e.tag ? ` [${e.tag}]` : ""} ($${e.amount.toLocaleString()})`).join(", ") || "None"}`,
    `Payments out: ${paymentsLast60Days.length}, payments in: ${paymentsReceivedLast60Days.length}`,
  ].join(". ")

  const narrative = await generateFinancialNarrative(
    totalOutflows60Days,
    totalInflows60Days,
    majorExpenses,
    majorInflows
  )

  return {
    majorExpenses,
    vendors: vendorsList,
    paymentsLast60Days: paymentsTagged,
    totalOutflows60Days,
    majorInflows,
    paymentsReceivedLast60Days: paymentsReceivedTagged,
    totalInflows60Days,
    summary,
    narrative: narrative || undefined,
  }
}

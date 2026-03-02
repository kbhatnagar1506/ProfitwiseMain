import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"

const ACCOUNT_NAMES: Record<string, string> = {
  customer_receipt: "Customer Receipts / AR",
  settlement_in: "Settlement Income",
  refund: "Refunds",
  interest: "Interest",
  vendor_payment: "Vendor Payments / AP",
  payroll: "Payroll",
  bank_fee: "Bank Fees",
  bank_fee_refund: "Bank Fee Refunds",
  processor_fee: "Processor Fees",
  tax: "Taxes",
  debt_payment: "Debt Payments",
  owner_contribution: "Owner Contributions",
  owner_draw: "Owner Draws",
  transfer: "Transfers",
  processor_payout: "Processor Payouts",
  settlement_adjustment: "Settlement Adjustments",
  opening_balance: "Opening Balances",
  account_verification: "Account Verification",
  system_adjustment: "System Adjustments",
  unknown: "Suspense",
}

export interface JELine {
  account: string
  account_code: string
  debit: number | null
  credit: number | null
  entity_name: string | null
  source: string
  component_type: string | null
  reference_id: string | null
}

export interface JournalEntry {
  id: string
  date: string
  memo: string
  bank_account: string | null
  direction: string
  lines: JELine[]
  total_debit: number
  total_credit: number
  is_balanced: boolean
  anomalies?: Array<{ type: string; severity: "warning" | "error"; message: string }>
}

export async function GET(request: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureMovementsSchema()

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"))
  const limit = Math.min(100, parseInt(searchParams.get("limit") ?? "50"))
  const offset = (page - 1) * limit
  const account = searchParams.get("account") ?? ""
  const dateFrom = searchParams.get("dateFrom") ?? ""
  const dateTo = searchParams.get("dateTo") ?? ""
  const entity = searchParams.get("entity") ?? ""
  const search = searchParams.get("search") ?? ""

  // Build WHERE clause for filters
  const conditions: string[] = ["m.user_id = $1", "m.duplicate_of IS NULL"]
  const params: unknown[] = [user.id]
  let pIdx = 2

  if (account) {
    conditions.push(`mt.economic_class = $${pIdx++}`)
    params.push(account)
  }
  if (dateFrom) {
    conditions.push(`m.date >= $${pIdx++}`)
    params.push(dateFrom)
  }
  if (dateTo) {
    conditions.push(`m.date <= $${pIdx++}`)
    params.push(dateTo)
  }
  if (search) {
    conditions.push(`(m.raw_description ILIKE $${pIdx} OR m.counterparty ILIKE $${pIdx})`)
    params.push(`%${search}%`)
    pIdx++
  }

  const whereClause = conditions.join(" AND ")

  // Get total count of unique movements
  const countRows = await query<{ total: string }>(
    `SELECT COUNT(DISTINCT m.id)::text AS total
     FROM movements m
     LEFT JOIN movement_tags mt ON mt.movement_id = m.id AND mt.user_id = m.user_id
     WHERE ${whereClause}`,
    params
  )
  const total = parseInt(countRows.rows[0]?.total ?? "0")

  // Fetch movements with optional entity filter
  const entityCondition = entity ? `AND e.canonical_name ILIKE '%${entity.replace(/'/g, "''")}%'` : ""

  const rows = await query<{
    movement_id: string
    date: string
    amount: string
    direction: string
    raw_description: string
    counterparty: string | null
    economic_class: string | null
    bank_account_name: string | null
    component_type: string | null
    gross_amount: string | null
    net_amount: string | null
    entity_name: string | null
    reference_id: string | null
    attribution_source: string | null
  }>(
    `SELECT
       m.id AS movement_id,
       m.date::text,
       ABS(m.amount)::text AS amount,
       m.direction,
       COALESCE(m.raw_description, m.counterparty, 'Unknown') AS raw_description,
       m.counterparty,
       mt.economic_class,
       pa.name AS bank_account_name,
       ma.component_type,
       ma.gross_amount::text,
       ma.net_amount::text,
       e.canonical_name AS entity_name,
       ma.reference_id,
       ma.source AS attribution_source
     FROM movements m
     LEFT JOIN movement_tags mt ON mt.movement_id = m.id AND mt.user_id = m.user_id
     LEFT JOIN LATERAL (
       SELECT component_type, gross_amount, net_amount, entity_id, reference_id, source
       FROM movement_attributions
       WHERE movement_id = m.id AND user_id = m.user_id
       LIMIT 5
     ) ma ON true
     LEFT JOIN entities e ON e.id::text = ma.entity_id ${entityCondition}
     LEFT JOIN LATERAL (
       SELECT account_id FROM movement_observations WHERE movement_id = m.id LIMIT 1
     ) mo ON true
     LEFT JOIN plaid_accounts pa ON pa.account_id = mo.account_id
     WHERE ${whereClause}
     ORDER BY m.date DESC, m.id
     LIMIT $${pIdx} OFFSET $${pIdx + 1}`,
    [...params, limit, offset]
  )

  // Group rows by movement_id into JournalEntry objects
  const jeMap = new Map<string, JournalEntry>()

  for (const r of rows.rows) {
    if (!jeMap.has(r.movement_id)) {
      const amount = parseFloat(r.amount)
      // Cash line (always present): debit if inflow, credit if outflow
      const cashLine: JELine = {
        account: r.bank_account_name ?? "Bank / Cash",
        account_code: "1001",
        debit: r.direction === "inflow" ? amount : null,
        credit: r.direction === "outflow" ? amount : null,
        entity_name: null,
        source: "bank",
        component_type: null,
        reference_id: null,
      }
      jeMap.set(r.movement_id, {
        id: r.movement_id,
        date: r.date,
        memo: r.raw_description,
        bank_account: r.bank_account_name,
        direction: r.direction,
        lines: [cashLine],
        total_debit: cashLine.debit ?? 0,
        total_credit: cashLine.credit ?? 0,
        is_balanced: false,
      })
    }

    const je = jeMap.get(r.movement_id)!
    if (r.component_type) {
      const econClass = r.economic_class ?? "unknown"
      const isInflow = r.direction === "inflow"
      const lineAmt = parseFloat(r.gross_amount ?? r.amount)
      const line: JELine = {
        account: ACCOUNT_NAMES[econClass] ?? econClass,
        account_code: econClass,
        debit: isInflow ? null : lineAmt,
        credit: isInflow ? lineAmt : null,
        entity_name: r.entity_name ?? r.counterparty,
        source: r.attribution_source ?? "ai",
        component_type: r.component_type,
        reference_id: r.reference_id,
      }
      je.lines.push(line)
      je.total_debit += line.debit ?? 0
      je.total_credit += line.credit ?? 0
    } else if (je.lines.length === 1) {
      // No attribution — add suspense line
      const amount = parseFloat(r.amount)
      const isInflow = r.direction === "inflow"
      const suspenseLine: JELine = {
        account: "Suspense / Unclassified",
        account_code: "9999",
        debit: isInflow ? null : amount,
        credit: isInflow ? amount : null,
        entity_name: r.entity_name ?? r.counterparty,
        source: "system",
        component_type: "unknown",
        reference_id: null,
      }
      je.lines.push(suspenseLine)
      je.total_debit += suspenseLine.debit ?? 0
      je.total_credit += suspenseLine.credit ?? 0
    }
  }

  // Mark balanced entries and detect anomalies
  const entries = Array.from(jeMap.values()).map(je => {
    const anomalies: Array<{ type: string; severity: "warning" | "error"; message: string }> = []
    const amount = Math.max(je.total_debit, je.total_credit)

    // Check for unmatched/suspense entries
    if (je.lines.some(l => l.component_type === "unknown")) {
      anomalies.push({
        type: "unmatched",
        severity: "warning",
        message: "This entry contains unmatched/suspense amounts. Reconcile before closing.",
      })
    }

    // Check for low classification confidence (if available in tag_data)
    if (je.lines.some(l => l.source === "ai" && !l.reference_id)) {
      anomalies.push({
        type: "low_confidence",
        severity: "warning",
        message: "AI-suggested classification. Verify this is correct.",
      })
    }

    return {
      ...je,
      is_balanced: Math.abs(je.total_debit - je.total_credit) < 0.02,
      anomalies: anomalies.length > 0 ? anomalies : undefined,
    }
  })

  return NextResponse.json({ entries, total, page, limit, pages: Math.ceil(total / limit) })
}

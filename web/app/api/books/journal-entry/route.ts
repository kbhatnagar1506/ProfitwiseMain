import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query, withTransaction } from "@/lib/db"

interface JELine {
  account_code: string
  description: string
  debit: number
  credit: number
  entity_id?: string | null
}

interface JournalEntryRequest {
  memo: string
  date: string
  lines: JELine[]
  auto_reverse?: boolean
}

export async function POST(request: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body: JournalEntryRequest = await request.json()
  const { memo, date, lines, auto_reverse = false } = body

  if (!memo || !date || !lines || lines.length < 2) {
    return NextResponse.json({ error: "memo, date, and at least 2 lines required" }, { status: 400 })
  }

  const totalDebits = lines.reduce((s, l) => s + (l.debit ?? 0), 0)
  const totalCredits = lines.reduce((s, l) => s + (l.credit ?? 0), 0)

  if (Math.abs(totalDebits - totalCredits) > 0.01) {
    return NextResponse.json({
      error: "Journal entry is not balanced",
      total_debits: totalDebits,
      total_credits: totalCredits,
      difference: totalDebits - totalCredits,
    }, { status: 400 })
  }

  await ensureMovementsSchema()

  // Create a synthetic movement to anchor the JE
  const result = await withTransaction(async (client) => {
    // Insert synthetic movement as the JE anchor
    const mvRow = await client.query(
      `INSERT INTO movements (
         user_id, direction, amount, date, movement_type, pnl_eligible,
         provenance, raw_description, counterparty, metadata
       ) VALUES ($1, $2, $3, $4, 'manual_je', false, 'manual', $5, 'Manual JE', $6)
       RETURNING id`,
      [
        user.id,
        totalDebits > 0 ? "inflow" : "outflow",
        Math.max(totalDebits, totalCredits),
        date,
        memo,
        JSON.stringify({ manual_je: true, auto_reverse, lines }),
      ]
    )
    const movementId = mvRow.rows[0].id

    // Insert each line as an attribution
    for (const line of lines) {
      const isDebit = (line.debit ?? 0) > 0
      const amount = isDebit ? line.debit : line.credit
      await client.query(
        `INSERT INTO movement_attributions (
           user_id, movement_id, component_type, entity_id, gross_amount, net_amount,
           confidence, source, metadata
         ) VALUES ($1, $2, $3, $4, $5, $5, 1.0, 'user', $6)`,
        [
          user.id,
          movementId,
          "unknown", // generic manual JE component
          line.entity_id ?? "manual",
          amount,
          JSON.stringify({
            account_code: line.account_code,
            description: line.description,
            is_debit: isDebit,
            is_credit: !isDebit,
            auto_reverse,
            je_memo: memo,
            je_date: date,
          }),
        ]
      )
    }

    // If auto_reverse, schedule a reversal entry on 1st of next month
    if (auto_reverse) {
      const jeDate = new Date(date)
      const reverseDate = new Date(jeDate.getFullYear(), jeDate.getMonth() + 1, 1)
        .toISOString().slice(0, 10)

      const rvRow = await client.query(
        `INSERT INTO movements (
           user_id, direction, amount, date, movement_type, pnl_eligible,
           provenance, raw_description, counterparty, metadata
         ) VALUES ($1, $2, $3, $4, 'manual_je', false, 'manual', $5, 'Manual JE (Auto-Reversal)', $6)
         RETURNING id`,
        [
          user.id,
          totalDebits > 0 ? "outflow" : "inflow",
          Math.max(totalDebits, totalCredits),
          reverseDate,
          `[REVERSAL] ${memo}`,
          JSON.stringify({ manual_je: true, auto_reverse: false, is_reversal: true, reversal_of: movementId, lines }),
        ]
      )
      const reversalMovementId = rvRow.rows[0].id

      // Reversed lines (debits ↔ credits flipped)
      for (const line of lines) {
        const wasDebit = (line.debit ?? 0) > 0
        const amount = wasDebit ? line.debit : line.credit
        await client.query(
          `INSERT INTO movement_attributions (
             user_id, movement_id, component_type, entity_id, gross_amount, net_amount,
             confidence, source, metadata
           ) VALUES ($1, $2, $3, $4, $5, $5, 1.0, 'user', $6)`,
          [
            user.id,
            reversalMovementId,
            "unknown",
            line.entity_id ?? "manual",
            amount,
            JSON.stringify({
              account_code: line.account_code,
              description: line.description,
              is_debit: !wasDebit, // flipped
              is_credit: wasDebit,  // flipped
              auto_reverse: false,
              is_reversal: true,
              je_memo: `[REVERSAL] ${memo}`,
              je_date: reverseDate,
            }),
          ]
        )
      }

      return { movement_id: movementId, reversal_id: reversalMovementId, reversal_date: reverseDate }
    }

    return { movement_id: movementId }
  })

  return NextResponse.json({ success: true, ...result })
}

// GET: recent manual journal entries
export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureMovementsSchema()

  const rows = await query<{
    id: string
    date: string
    raw_description: string
    amount: string
    metadata: unknown
  }>(
    `SELECT id, date::text, raw_description, amount::text AS amount, metadata
     FROM movements
     WHERE user_id = $1
       AND movement_type = 'manual_je'
       AND duplicate_of IS NULL
     ORDER BY date DESC
     LIMIT 50`,
    [user.id]
  )

  const entries = rows.rows.map(r => {
    const meta = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>
    return {
      id: r.id,
      date: r.date,
      memo: r.raw_description,
      amount: parseFloat(r.amount),
      auto_reverse: meta.auto_reverse ?? false,
      is_reversal: meta.is_reversal ?? false,
      lines: (meta.lines as JELine[]) ?? [],
    }
  })

  return NextResponse.json({ entries })
}

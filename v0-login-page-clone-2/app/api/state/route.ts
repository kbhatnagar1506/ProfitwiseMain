import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"
import { toMovementClass, computeStatePolicy } from "@/lib/movement-types"
import { getAccountsWithBalancesByUserId } from "@/lib/plaid-persistence"
import {
  computeRevenueState,
  computeSpendState,
  computeLiquidityState,
} from "@/lib/state"
import type { TaggedMovementInput, AccountBalanceInput } from "@/lib/state"

type DbMovementRow = {
  id: string
  direction: string
  amount: string
  date: string
  movement_type: string
  cash_account_id: string | null
  counterparty_entity_id: string | null
  counterparty: string | null
  confidence: Record<string, number>
  review_needed: boolean
  metadata: Record<string, unknown>
}

type TagRow = {
  movement_id: string
  economic_class: string
  cashflow_bucket: string
  counterparty_role: string
  tag_data: Record<string, unknown>
}

const CLASS_TO_ECONOMIC: Record<string, string> = {
  customer_cash_in: "customer_receipt",
  vendor_cash_out: "vendor_payment",
  internal_transfer: "transfer",
  processor_fee: "processor_fee",
  processor_payout: "processor_payout",
  owner_contribution: "owner_contribution",
  owner_draw: "owner_draw",
  credit_card_payment: "debt_payment",
  bank_fee: "bank_fee",
  bank_fee_refund: "adjustment",
  refund: "refund",
  interest: "interest",
  merchant_deposit: "processor_payout",
  opening_balance: "adjustment",
}

function toTaggedMovement(row: DbMovementRow, tag: TagRow | null): TaggedMovementInput {
  const amount = parseFloat(row.amount)
  const tagData = tag?.tag_data ?? {}
  const mc = toMovementClass(row.movement_type)
  const conf = row.confidence ?? {}
  const confScore = conf.score ?? 0.5
  const evStrength = conf.evidence_strength ?? 0
  const policy = tag
    ? ((tagData.state_inclusion_policy as TaggedMovementInput["tag"]["state_inclusion_policy"]) ?? computeStatePolicy(confScore, evStrength, row.review_needed))
    : computeStatePolicy(confScore, evStrength, row.review_needed)

  return {
    id: row.id,
    amount: Math.abs(amount),
    direction: row.direction as "inflow" | "outflow",
    occurred_at: row.date,
    account_id: row.cash_account_id,
    entity_id: row.counterparty_entity_id,
    metadata: { ...(row.metadata ?? {}), counterparty: row.counterparty ?? (row.metadata as Record<string, unknown>)?.counterparty },
    tag: {
      economic_class: tag?.economic_class ?? CLASS_TO_ECONOMIC[mc] ?? "unknown",
      cashflow_bucket: tag?.cashflow_bucket ?? "unknown",
      counterparty_role: tag?.counterparty_role ?? "unknown",
      state_inclusion_policy: policy,
      customer_id: (tagData.customer_id as string | null) ?? null,
      vendor_id: (tagData.vendor_id as string | null) ?? null,
      is_recurring: (tagData.is_recurring as boolean) ?? false,
      is_first_seen_counterparty: (tagData.is_first_seen_counterparty as boolean) ?? false,
      classification_confidence: (tagData.classification_confidence as number) ?? confScore,
      evidence_strength: (tagData.evidence_strength as number) ?? evStrength,
    },
  }
}

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await ensureMovementsSchema()
  } catch {
    return NextResponse.json({ revenue: null, spend: null, liquidity: null, error: "Schema not ready" })
  }

  const userId = user.id

  const dbRows = await query<DbMovementRow>(
    `SELECT m.id, m.direction, m.amount, m.date, m.movement_type, m.cash_account_id,
            m.counterparty_entity_id, m.counterparty, m.confidence, m.review_needed, m.metadata
     FROM movements m WHERE m.user_id = $1 ORDER BY m.date DESC`,
    [userId],
  ).then((r) => r.rows)

  const tagRows = await query<TagRow>(
    `SELECT movement_id, economic_class, cashflow_bucket, counterparty_role, tag_data
     FROM movement_tags WHERE movement_id IN (SELECT id FROM movements WHERE user_id = $1)`,
    [userId],
  ).then((r) => r.rows)

  const tagMap = new Map<string, TagRow>()
  for (const t of tagRows) tagMap.set(t.movement_id, t)

  const tagged: TaggedMovementInput[] = []
  for (const row of dbRows) {
    const tag = tagMap.get(row.id)
    tagged.push(toTaggedMovement(row, tag))
  }

  const accounts = await getAccountsWithBalancesByUserId(userId)
  const accountBalances: AccountBalanceInput[] = accounts.map((a) => ({
    account_id: a.account_id,
    name: a.name,
    type: a.type,
    subtype: a.subtype,
    current_balance: a.current_balance != null ? Number(a.current_balance) : null,
    available_balance: a.available_balance != null ? Number(a.available_balance) : null,
    currency_code: a.currency_code,
  }))

  const revenue = computeRevenueState(tagged)
  const spend = computeSpendState(tagged)
  const liquidity = computeLiquidityState(tagged, { accountBalances })

  return NextResponse.json({ revenue, spend, liquidity })
}

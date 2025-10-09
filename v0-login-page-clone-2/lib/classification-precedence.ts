/**
 * Strict classification precedence — runs before classifyNonPnl / classifyOperating / LLM.
 *
 * Order: scrub → processor rails → P2P (Zelle/Venmo) → canonical alias → (null → legacy pipeline)
 */

import { scrubMovementText } from "./text-cleaner"
import { interceptProcessor } from "./processor-rules"
import {
  tryResolveCanonicalAliasFromRows,
  type AliasRole,
  type UserClassificationSignatureRow,
} from "./entity-resolution"
import type { SelfContext, MovementIdentityEntry } from "./identity-seed"

/** Minimal movement shape to avoid importing movement-classify (circular). */
export type PrecedenceMovement = {
  direction: "inflow" | "outflow"
  amount: number
  raw_description: string | null
  counterparty: string | null
  metadata: Record<string, unknown>
}

export type PrecedenceResult = {
  movement_type: string
  pnl_eligible: boolean
  pattern_strength: number
  source: string
  /** Extra metadata on classified movement */
  extra_metadata?: Record<string, unknown>
}

const ZELLE_VENMO = /\bZELLE\b|\bVENMO\b/i

function isStructuralInternalTransfer(m: PrecedenceMovement): boolean {
  const tt = m.metadata?.transfer_type as string | undefined
  return tt === "cross_account" || tt === "qbo_transfer"
}

function movementFromAliasRole(
  role: AliasRole,
  direction: "inflow" | "outflow"
): { type: string; pnl: boolean } | null {
  switch (role) {
    case "customer":
      return direction === "inflow"
        ? { type: "cash_in_customer", pnl: true }
        : { type: "cash_out_vendor", pnl: true }
    case "owner":
      return direction === "inflow"
        ? { type: "owner_contribution", pnl: false }
        : { type: "owner_draw", pnl: false }
    case "vendor":
      return direction === "outflow"
        ? { type: "cash_out_vendor", pnl: true }
        : { type: "cash_in_customer", pnl: true }
    case "bank":
      return direction === "outflow"
        ? { type: "credit_card_payment", pnl: false }
        : { type: "cash_in_customer", pnl: true }
    case "processor":
      return direction === "inflow"
        ? { type: "processor_payout", pnl: false }
        : { type: "processor_fee_settlement", pnl: true }
    default:
      return null
  }
}

/**
 * Apply deterministic precedence. Returns null to use existing classifyNonPnl → operating → … pipeline.
 */
export function applyClassificationPrecedence(
  m: PrecedenceMovement,
  _identity: MovementIdentityEntry | null,
  _selfCtx: SelfContext,
  signatureRows: UserClassificationSignatureRow[],
): PrecedenceResult | null {
  if (process.env.CLASSIFICATION_PRECEDENCE === "false") return null

  const scrubbed = scrubMovementText(m.raw_description, m.counterparty)
  if (!scrubbed) return null

  // Paired cross-account and QBO transfers stay in structural path
  if (isStructuralInternalTransfer(m)) return null

  // 1) Processor rails (merchant / Shopify / POS settlement)
  const proc = interceptProcessor(scrubbed, m.amount, m.direction)
  if (proc) {
    const pnl = proc.movement_type === "processor_payout" ? false : true
    return {
      movement_type: proc.movement_type,
      pnl_eligible: pnl,
      pattern_strength: proc.confidence,
      source: `processor_interceptor:${proc.reason}`,
    }
  }

  // 2) Zelle / Venmo — person-to-person / payee; never generic internal transfer from text alone
  if (ZELLE_VENMO.test(scrubbed)) {
    if (m.direction === "inflow") {
      return {
        movement_type: "cash_in_customer",
        pnl_eligible: true,
        pattern_strength: 0.88,
        source: "p2p_interceptor:zelle_venmo_inflow",
      }
    }
    return {
      movement_type: "cash_out_vendor",
      pnl_eligible: true,
      pattern_strength: 0.88,
      source: "p2p_interceptor:zelle_venmo_outflow",
    }
  }

  // 3) Tenant canonical signatures (substring match on scrubbed text)
  const alias = tryResolveCanonicalAliasFromRows(scrubbed, signatureRows)
  if (alias) {
    const mapped = movementFromAliasRole(alias.role, m.direction)
    if (mapped) {
      return {
        movement_type: mapped.type,
        pnl_eligible: mapped.pnl,
        pattern_strength: 0.95,
        source: `canonical_alias:${alias.canonical_id}`,
        extra_metadata: {
          canonical_alias_id: alias.canonical_id,
          alias_signature: alias.matched_signature,
        },
      }
    }
  }

  return null
}

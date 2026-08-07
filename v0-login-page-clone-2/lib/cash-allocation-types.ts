/** Shared types for movement allocations / attributions (API compatibility). */

import type { ConfidenceEnvelope } from "./confidence"

export type MatchMethod = "exact" | "tolerance" | "llm_suggested" | "manual" | "stripe_payout_match"

export type AllocationTargetType = "ar" | "ap" | "fee" | "transfer" | "unknown"

export type MovementAllocation = {
  id: string
  user_id: string
  movement_id: string
  entity_type: AllocationTargetType
  entity_id: string
  gross_applied: number
  fee_amount: number
  net_applied: number
  confidence: number
  match_method: MatchMethod
  created_at: string
  source_id?: string | null
  synthetic_invoice?: boolean
  reconcile_at?: string | null
}

export type CreateAllocationOpts = {
  userId: string
  movementId: string
  entity_type: AllocationTargetType
  entity_id: string
  gross_applied: number
  fee_amount: number
  net_applied: number
  confidence: number
  match_method: MatchMethod
  source_id?: string | null
  synthetic_invoice?: boolean
  reconcile_at?: Date
  /** Optional structured confidence (stored on movement_attributions.confidence_detail). */
  confidenceEnvelope?: ConfidenceEnvelope | null
}

export type MovementDetailStatusBadge =
  | "included_pnl"
  | "included_non_pnl"
  | "excluded_needs_review"
  | "unresolved"

export type MovementDetailResponse = {
  headline: {
    movement_id: string
    amount: number
    currency: string
    direction: "inflow" | "outflow"
    date: string
    canonical_entity_name: string | null
    raw_counterparty: string | null
    status_badge: MovementDetailStatusBadge
  }
  economic_semantics: {
    movement_type: string
    economic_class: string | null
    cashflow_bucket: string | null
    counterparty_role: string | null
    flags: {
      hits_pnl: boolean
      hits_working_capital: boolean
      is_recurring: boolean
      is_owner_related: boolean
      needs_review: boolean
    }
    policy_status: string | null
  }
  evidence_trail: {
    observations: Array<{
      source: string
      source_type: string
      source_id: string
      date: string | null
      amount: number | null
      raw_description: string | null
      counterparty: string | null
      account_name: string | null
      account_id: string | null
      metadata: Record<string, unknown>
    }>
    coalesced_group_id: string | null
    provenance: string
  }
  confidence_engine: {
    overall: {
      classification_score: number
      evidence_strength: number
    }
    breakdown: {
      entity_confidence: number | null
      amount_match: number | null
      date_match: number | null
      source_agreement: number | null
      source_authority: number | null
      pattern_strength: number | null
      history: number | null
      directional_consistency: number | null
      account_resolution: number | null
    }
    reasons: string[]
    explanation_lines: string[]
  }
  normalized_bank_info: {
    raw_bank_text: string | null
    scrubbed_bank_text: string
    normalized_display_name: string | null
    resolution_path: {
      classification_precedence: string | null
      canonical_alias_id: string | null
      alias_signature: string | null
      counterparty_entity_id: string | null
      counterparty_entity_type: string | null
    }
  }
  controls: {
    can_recategorize: boolean
    can_unmerge_entity: boolean
    can_split_movement: boolean
    can_force_policy: boolean
    current_overrides: {
      forced_include: boolean
      forced_exclude: boolean
      manual_movement_type: string | null
    }
  }
}

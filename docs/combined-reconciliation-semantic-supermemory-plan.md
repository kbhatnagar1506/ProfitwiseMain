# Combined Reconciliation Overhaul + Semantic Matching + Supermemory Integration

**Status**: Planning Phase  
**Objective**: Fix polarity issues, implement semantic matching, prevent greedy sweeping, and leverage Supermemory for intelligent LLM-based reconciliation

---

## Executive Summary

This plan combines three initiatives:

1. **Polarity Audit Fixes** - Handle vendor credits, signed values, blind zero-boundaries
2. **Semantic Matching Architecture** - Replace fuzzy matching with strict entity validation
3. **Supermemory Integration** - Use memory layer for entity profiles, decision history, and semantic graphs

**Expected Outcome**: 51% → 80%+ match rate with zero cross-entity contamination

---

## Architecture Overview

```
Bank Movement
    ↓
[Economic Class Validation] ← Category-based filtering
    ↓
[Supermemory Entity Lookup] ← Entity profiles + payment history
    ↓
[Semantic Validation] ← Levenshtein + organization matching
    ↓
[LLM Semantic Matching] ← Enhanced with Supermemory context
    ↓
[Confidence Recalculation] ← Multi-factor scoring
    ↓
[Apply with Validation] ← Entity-aware, no greedy sweeping
    ↓
Movement Attribution (Reconciliation Result)
```

---

## Phase 1: Polarity & Vendor Credit Handling

### Objective

Fix blind zero-boundary issues and properly handle vendor credits (negative amounts).

### Changes

1. **Update cash_events schema** (`lib/cash-events-build.ts`):
  - Add `amount_signed` column (positive for AR inflows, negative for AP outflows)
  - Add `credit_type` enum: "none" | "vendor_credit" | "customer_overpayment"
  - Migrate: `amount_signed = direction === 'inflow' ? amount : -amount`
2. **Fix polarity audit issues**:
  - `lib/invoices-fetch.ts` (lines 112, 152, 410): Remove `amount_due > 0` filters
  - `lib/bills-fetch.ts` (lines 71, 114): Remove `amount_due > 0` filters
  - `lib/state/forecast-engine.ts` (lines 2762, 4058): Use `Math.abs(amount_due) > 0`
  - `app/dashboard/p-and-l/page.tsx` (lines 511, 513): Fix waterfall chart polarity
3. **Create vendor credit matching** (`lib/vendor-credit-match.ts` - new):
  - Match negative outstanding amounts to overpayments
  - Track credit application history
  - Support credit carryforward

### Files Modified

- `lib/cash-events-build.ts`
- `lib/invoices-fetch.ts`
- `lib/bills-fetch.ts`
- `lib/state/forecast-engine.ts`
- `app/dashboard/p-and-l/page.tsx`
- `lib/vendor-credit-match.ts` (new)

---

## Phase 2: Category-Based Matching

### Objective

Add economic class and category awareness to prevent cross-category matching.

### Changes

1. **Enhance movement_attributions schema**:
  - Add `category` column (e.g., "office_supplies", "raw_materials")
  - Add `cost_type` column: "cogs" | "opex" | "capex" | null
  - Add `vendor_id` column for vendor consistency
2. **Create category-aware filtering** (`lib/reconciliation-waterfall.ts`):
  - Extract category from `tag_data.category`
  - Extract cost_type from `tag_data.cost_type`
  - Extract vendor_id from `tag_data.vendor_id`
  - Validate: economic class matches direction, category matches if available, cost type matches
3. **Modify Stage 3 FIFO**:
  - Replace generic filtering with category-aware filtering
  - Prioritize exact category matches
  - Add confidence boost for category matches: +0.05
  - Add confidence penalty for category mismatches: -0.10

### Files Modified

- `lib/reconciliation-waterfall.ts`
- `lib/db.ts`
- `lib/movement-classify.ts`

---

## Phase 3: Prevent Greedy Partial-Payment Sweeping

### Objective

Limit Stage 3 FIFO to prevent single movements from being sliced across too many invoices.

### Changes

1. **Add matching limits**:
  - `MAX_MATCHES_PER_MOVEMENT = 3`
  - `MAX_PARTIAL_MATCHES_PER_MOVEMENT = 1`
  - Add match counter in Stage 3 loop
2. **Implement match limiting logic**:
  - Break loop if `matchCount >= MAX_MATCHES_PER_MOVEMENT`
  - Skip if `isPartialMatch && partialMatchCount >= MAX_PARTIAL_MATCHES_PER_MOVEMENT`
3. **Add confidence penalties**:
  - 1st match: base confidence (0.82)
  - 2nd match: -0.05 penalty (0.77)
  - 3rd match: -0.10 penalty (0.72)
  - 4th+ match: rejected (moved to Stage 4)
4. **Flag multi-match scenarios**:
  - Add `multi_match_flag` to attribution metadata
  - Add `match_sequence` (1, 2, 3) to track order
  - Display warning in UI

### Files Modified

- `lib/reconciliation-waterfall.ts`

---

## Phase 4: Semantic Matching with Supermemory Integration

### Objective

Replace fuzzy matching with strict semantic matching enhanced by Supermemory entity profiles and decision history.

### Changes

1. **Create Supermemory entity profile layer** (`lib/supermemory-entity-profiles.ts` - new):
  ```typescript
   interface EntityMemoryProfile {
     entity_id: string
     entity_name: string
     aliases: string[]                    // Known name variations
     payment_history: {
       avg_amount: number
       amount_range: [min, max]
       typical_payment_days: number[]
       frequency: "daily" | "weekly" | "monthly" | "quarterly"
     }
     semantic_patterns: {
       bank_description_patterns: string[]
       organization_name: string
       common_prefixes: string[]
     }
     reconciliation_history: {
       successful_matches: number
       failed_matches: number
       cross_entity_rejections: number
     }
   }
  ```
2. **Store entity profiles in Supermemory**:
  - On first match: Create profile with entity name, organization
  - On successful match: Update payment history, patterns
  - On failed match: Track rejection reason
  - Query: Get profile by entity_id or entity_name
3. **Create Supermemory decision history** (`lib/supermemory-decision-history.ts` - new):
  ```typescript
   interface ReconciliationDecision {
     movement_id: string
     bank_description: string
     matched_entity: string
     matched_invoice: string
     confidence: number
     match_type: "exact" | "organization" | "fuzzy" | "rejected"
     reason: string
     timestamp: Date
     outcome: "success" | "failure" | "manual_override"
   }
  ```
4. **Store decision history in Supermemory**:
  - After each match attempt: Store decision
  - Query: Get similar past decisions for current movement
  - Learn: What worked before, what didn't
5. **Create semantic entity graph** (`lib/supermemory-entity-graph.ts` - new):
  ```typescript
   interface EntityRelationship {
     entity_a: string
     entity_b: string
     relationship_type: "same_customer" | "same_vendor" | "related" | "unrelated"
     confidence: number
     evidence: string[]
   }
  ```
6. **Implement semantic validation with Supermemory** (`lib/semantic-validation-supermemory.ts` - new):
  ```typescript
   async function validateSemanticMatchWithMemory(
     bankDescription: string,
     entityName: string,
     invoiceAmount: number,
     bankAmount: number,
     supermemoryContext: SuprememoryContext
   ): Promise<SemanticValidation> {
     // Step 1: Query entity profile from Supermemory
     const profile = await supermemoryContext.getEntityProfile(entityName)

     // Step 2: Check if bank description matches known patterns
     const patternMatch = profile?.semantic_patterns.bank_description_patterns
       .some(pattern => bankDescription.includes(pattern))

     // Step 3: Check payment history for amount reasonableness
     const amountReasonable = profile?.payment_history.amount_range
       ? bankAmount >= profile.payment_history.amount_range[0] &&
         bankAmount <= profile.payment_history.amount_range[1]
       : true

     // Step 4: Query similar past decisions
     const pastDecisions = await supermemoryContext.getSimilarDecisions(
       bankDescription,
       entityName
     )

     // Step 5: Apply Levenshtein distance
     const similarity = levenshteinSimilarity(bankDescription, entityName)

     // Step 6: Combine signals
     return {
       valid: patternMatch && amountReasonable && similarity > 0.75,
       confidence: calculateConfidence(patternMatch, amountReasonable, similarity, pastDecisions),
       reason: generateReason(patternMatch, amountReasonable, similarity),
       matchType: determineMatchType(similarity, patternMatch)
     }
   }
  ```
7. **Implement Levenshtein distance** (`lib/levenshtein.ts` - new):
  - Calculate edit distance between normalized names
  - Require >85% similarity for fuzzy match
  - Prevent "Sarah Katz" matching "David Vaughn"
8. **Implement confidence recalculation** (`lib/confidence-recalculation.ts` - new):
  ```typescript
   function recalculateConfidence(factors: ConfidenceFactors): number {
     return (
       factors.semanticMatch * 0.4 +      // Entity name match (most important)
       factors.amountMatch * 0.3 +        // Amount discrepancy
       factors.dateMatch * 0.2 +          // Timing alignment
       factors.entityMatch * 0.1          // Entity ID match
     )
   }
  ```

### Files Modified/Created

- `lib/supermemory-entity-profiles.ts` (new)
- `lib/supermemory-decision-history.ts` (new)
- `lib/supermemory-entity-graph.ts` (new)
- `lib/semantic-validation-supermemory.ts` (new)
- `lib/levenshtein.ts` (new)
- `lib/confidence-recalculation.ts` (new)
- `lib/reconciliation-llm-match.ts` (modified)
- `lib/reconciliation-waterfall.ts` (modified)

---

## Phase 5: Enforce Entity Validation in Apply Logic

### Objective

Prevent cross-entity matches from being applied to financial records.

### Changes

1. **Add entity validation to `applyLLMMatches`**:
  - Validate semantic match before applying
  - Reject if entities don't align
  - Store validation reason in metadata
2. **Add entity validation to Stage 3 FIFO**:
  - Before matching invoice to movement, validate semantic match
  - Reject if entities don't align
  - Store validation reason in metadata
3. **Add entity validation to manual matching**:
  - When user manually matches, validate semantic match
  - Warn if confidence < 0.75
  - Allow override but flag for review
4. **Create validation metadata**:
  - Store `semantic_validation` in attribution metadata
  - Include `match_type` (exact/organization/fuzzy/rejected)
  - Include `validation_reason` for audit trail

### Files Modified

- `lib/reconciliation-llm-match.ts`
- `lib/reconciliation-waterfall.ts`
- `app/api/dashboard/reconciliation/apply-match/route.ts`

---

## Phase 6: Prevent Greedy Sweeping with Entity Awareness

### Objective

Limit Stage 3 FIFO to prevent single movements from being matched to multiple unrelated entities.

### Changes

1. **Add entity tracking to Stage 3 FIFO**:
  ```typescript
   const matchedEntities = new Set<string>()

   for (const event of sortedEvents) {
     // Check if entity already matched
     if (matchedEntities.has(event.entity_id)) {
       continue  // Skip - already matched to different entity
     }

     // ... existing match logic ...

     // Track matched entity
     matchedEntities.add(event.entity_id)
   }
  ```
2. **Enforce one-entity-per-movement rule**:
  - Single movement can match multiple invoices from SAME entity
  - Single movement cannot match invoices from DIFFERENT entities
3. **Add entity validation before each match**:
  - Validate semantic match before applying
  - Reject if entity doesn't match
  - Store rejection reason in metadata

### Files Modified

- `lib/reconciliation-waterfall.ts`

---

## Phase 7: Component-Based Confidence Scoring

### Objective

Break down confidence into components with reasoning.

### Changes

1. **Create confidence breakdown structure**:
  ```typescript
   interface ConfidenceBreakdown {
     overall: number
     components: {
       amount: { score: number; reasoning: string; weight: number }
       date: { score: number; reasoning: string; weight: number }
       entity: { score: number; reasoning: string; weight: number }
       history: { score: number; reasoning: string; weight: number }
     }
   }
  ```
2. **Store component breakdown in `confidence_detail` JSONB**
3. **Calculate overall confidence as weighted average**

### Files Modified

- `lib/confidence-scoring.ts` (new)
- `lib/reconciliation-waterfall.ts`

---

## Phase 8: Update UI to Display Confidence Components

### Objective

Show confidence breakdown and reasoning in the reconciliation UI.

### Changes

1. **Update reconciliation API**:
  - Return `confidence_detail` in API response
  - Include `metadata.llm_reasoning` in response
  - Include `metadata.match_method` in response
2. **Update Command Queue display**:
  - Add "Confidence Breakdown" card showing component scores
  - Display horizontal bars for each component
  - Show reasoning text for each component
3. **Update matches table**:
  - Add "Confidence" column with tier badge
  - Add click handler to expand component breakdown
  - Show fee confidence separately if applicable
4. **Create confidence detail component** (`components/confidence-breakdown.tsx` - new):
  - Reusable component showing component breakdown
  - Displays overall score + component bars
  - Shows reasoning tooltips

### Files Modified

- `app/api/dashboard/reconciliation/route.ts`
- `app/dashboard/reconciliation/page.tsx`
- `components/confidence-breakdown.tsx` (new)

---

## Phase 9: Supermemory Learning Loop

### Objective

Continuously improve matching by learning from reconciliation decisions.

### Changes

1. **Create learning pipeline** (`lib/supermemory-learning-loop.ts` - new):
  - After each match: Store decision in Supermemory
  - Periodically: Analyze patterns in successful vs failed matches
  - Update: Entity profiles with new patterns
  - Improve: LLM prompts based on learned patterns
2. **Implement feedback loop**:
  - User confirms/rejects match → Update Supermemory
  - System learns: What worked, what didn't
  - Next time: Better decisions based on history
3. **Create pattern analysis**:
  - Analyze successful matches: What patterns led to success?
  - Analyze failed matches: What patterns led to failure?
  - Update entity profiles with learned patterns

### Files Modified/Created

- `lib/supermemory-learning-loop.ts` (new)
- `app/api/dashboard/reconciliation/apply-match/route.ts` (add feedback)
- `app/api/dashboard/reconciliation/unmatch/route.ts` (add feedback)

---

## Implementation Sequence

1. **Week 1**: Phase 1 (Polarity) + Phase 2 (Category-Based)
2. **Week 2**: Phase 3 (Greedy Sweeping) + Phase 4 (Semantic + Supermemory)
3. **Week 3**: Phase 5 (Enforce Validation) + Phase 6 (Entity Awareness)
4. **Week 4**: Phase 7 (Confidence Scoring) + Phase 8 (UI)
5. **Week 5**: Phase 9 (Learning Loop) + Testing & Deployment

---

## Testing Strategy

- **Unit Tests**: Semantic validation, Levenshtein, confidence calculation, Supermemory queries
- **Integration Tests**: End-to-end matching with validation and Supermemory
- **Regression Tests**: Existing data should produce same or better results
- **Data Quality Tests**: Verify cross-entity contamination eliminated
- **Performance Tests**: Ensure Supermemory queries don't slow down matching
- **Learning Tests**: Verify learning loop improves over time

---

## Success Metrics


| Metric                     | Current     | Target           | Improvement    |
| -------------------------- | ----------- | ---------------- | -------------- |
| Match Rate                 | 51%         | 80%+             | +29%+          |
| Cross-Entity Contamination | 20-30 cases | 0                | 100%           |
| Partial Matches > Bill     | 5-10 cases  | 0                | 100%           |
| Confidence Accuracy        | 60%         | 95%              | +35%           |
| Unmatched Cash             | $75,677     | $10,000-15,000   | 80%+ reduction |
| User Trust                 | Low         | High             | Restored       |
| Learning Improvement       | N/A         | +5-10% per month | Continuous     |


---

## Supermemory Integration Benefits

1. **Entity Profiles**: Know typical payment amounts, patterns, naming variations
2. **Decision History**: Learn from past matches, avoid repeating mistakes
3. **Semantic Graphs**: Understand relationships between entities
4. **Pattern Recognition**: Identify what works, what doesn't
5. **Continuous Learning**: Improve over time with each reconciliation
6. **LLM Context**: Provide rich context to LLM for better semantic matching
7. **Audit Trail**: Complete history of why each match was made

---

## Rollout Plan

1. **Canary**: Deploy to 10% of users, monitor for issues
2. **Staged**: Increase to 50%, then 100% over 2 weeks
3. **Monitoring**: Track match rate, validation rejections, confidence scores, learning improvements
4. **Rollback**: If issues detected, revert to previous version

---

## Files Summary

### New Files

- `lib/supermemory-entity-profiles.ts`
- `lib/supermemory-decision-history.ts`
- `lib/supermemory-entity-graph.ts`
- `lib/semantic-validation-supermemory.ts`
- `lib/levenshtein.ts`
- `lib/confidence-recalculation.ts`
- `lib/confidence-scoring.ts`
- `lib/vendor-credit-match.ts`
- `lib/supermemory-learning-loop.ts`
- `components/confidence-breakdown.tsx`

### Modified Files

- `lib/reconciliation-waterfall.ts`
- `lib/reconciliation-llm-match.ts`
- `lib/cash-events-build.ts`
- `lib/invoices-fetch.ts`
- `lib/bills-fetch.ts`
- `lib/state/forecast-engine.ts`
- `lib/movement-classify.ts`
- `lib/db.ts`
- `app/dashboard/p-and-l/page.tsx`
- `app/api/dashboard/reconciliation/route.ts`
- `app/api/dashboard/reconciliation/apply-match/route.ts`
- `app/dashboard/reconciliation/page.tsx`

---

## Next Steps

1. Review and approve combined plan
2. Begin Phase 1 implementation
3. Set up Supermemory integration
4. Create test data for validation
5. Deploy to canary users


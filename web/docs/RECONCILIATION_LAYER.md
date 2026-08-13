# Unified Reconciliation Layer

## Overview

The reconciliation system is now fully unified and self-contained. When you run reconciliation, **everything** is part of one cohesive flow:

```
runFullReconciliation(userId)
  ├─ Stage 0-3: Deterministic Waterfall
  │  ├─ Stage 0: Direct link matching (movement_id → cash_event_id)
  │  ├─ Stage 1: Exact amount matching
  │  ├─ Stage 2: Category-based matching
  │  └─ Stage 3: FIFO with tolerance + greedy sweep prevention
  │
  └─ Stage 4: LLM Semantic Matching
     ├─ Fetch unreconciled movements
     ├─ Prepare invoice/bill context
     └─ Run LLM matching on remaining unmatched
```

## Entry Points

### 1. **Full Reconciliation** (Recommended)
```typescript
import { runFullReconciliation } from "@/lib/full-reconciliation"

const result = await runFullReconciliation(userId)
// Returns: {
//   waterfall: {...},           // Stages 0-3 results
//   llm: {...},                 // Stage 4 results
//   totalAttributions: number,  // Total matches created
//   remainingUnmatched: number, // Unmatched after all stages
//   executionTimeMs: number,
//   warnings: string[]
// }
```

### 2. **Waterfall Only** (Stages 0-3)
```typescript
import { runReconciliationWaterfall } from "@/lib/reconciliation-waterfall"

const result = await runReconciliationWaterfall(userId)
```

### 3. **LLM Only** (Stage 4)
```typescript
import { runLLMStage4 } from "@/lib/reconciliation-llm-match"

const result = await runLLMStage4(userId, movements, invoices, bills, "high")
```

## What's Included in Each Stage

### Stage 0: Direct Link Matching
- **File**: `lib/reconciliation-waterfall.ts` (lines ~700-750)
- **Logic**: Matches movements to cash_events via `movement_id` field
- **Confidence**: Deterministic (1.0)

### Stage 1: Exact Amount Matching
- **File**: `lib/reconciliation-waterfall.ts` (lines ~750-850)
- **Logic**: Matches movements to outstanding invoices/bills with exact amount
- **Confidence**: High (0.88+)

### Stage 2: Category-Based Matching
- **File**: `lib/reconciliation-waterfall.ts` (lines ~45-55, ~1000-1100)
- **Logic**: Filters candidates by economic class category, applies confidence boost/penalty
- **Confidence**: Adjusted based on category match

### Stage 3: FIFO with Tolerance
- **File**: `lib/reconciliation-waterfall.ts` (lines ~1100-1300)
- **Logic**: 
  - Matches movements to invoices/bills in FIFO order
  - Allows partial matches within tolerance (5%)
  - Prevents greedy sweeping (max 3 matches per movement)
  - Computes detailed confidence breakdown per match
- **Confidence**: Computed via `buildSyncConfidenceBreakdown`

### Stage 4: LLM Semantic Matching
- **File**: `lib/reconciliation-llm-match.ts`
- **Logic**:
  - Fetches all unreconciled movements
  - Sends to GPT-4o with semantic validation
  - Applies high-confidence matches automatically
  - Skips low-confidence matches for manual review
- **Confidence**: LLM-generated (0.0-1.0)

## Confidence Scoring

All stages use the unified confidence system:

```typescript
// Synchronous (hot path - Stage 3)
const breakdown = buildSyncConfidenceBreakdown({
  movementAmount,
  targetAmount,
  bankDescription,
  entityName,
  movementDate,
  invoiceDueDate,
  categoryAdjustment,
  matchSequenceIndex,
  waterfallStage,
  matchMethod,
})

// Asynchronous (full scoring - Stage 4)
const breakdown = await buildConfidenceBreakdown({
  ...params,
  userId,
  entityId,
})
```

**Signals**:
- Amount (40% weight): Exact vs tolerance-based match
- Entity Name (30% weight): Levenshtein similarity
- Date Proximity (20% weight): Days between movement and due date
- History (5% weight): Past reconciliation success rate
- Category (3% weight): Economic class match
- Match Sequence (2% weight): Penalty for Nth match on same movement

## Audit Logging

Every attribution is logged to `reconciliation_audit_log`:

```sql
INSERT INTO reconciliation_audit_log (
  user_id,
  movement_id,
  match_method,
  confidence,
  entity_id,
  reference_id,
  amount_matched,
  semantic_valid,
  cross_entity_flag,
  created_at
)
```

## Greedy Sweep Prevention

Stage 3 enforces:
- **MAX_MATCHES_PER_MOVEMENT = 3**: One movement can match at most 3 invoices/bills
- **MAX_PARTIAL_MATCHES_PER_MOVEMENT = 1**: Only 1 partial match per movement
- **Cross-entity check**: First matched entity is locked; subsequent matches must be same entity

## Semantic Validation

Before applying LLM matches, the system validates:
- Entity name similarity (Levenshtein distance)
- Amount tolerance (within 5%)
- Date proximity (within 30 days)
- Cross-entity contamination check

## API Integration

The unified reconciliation is triggered via:

```bash
GET /api/ar-ap-step?run=true
```

This:
1. Acquires a database lock (prevents concurrent runs)
2. Starts `runReconciliationInBackground`
3. Calls `runFullReconciliation(userId)`
4. Releases lock when complete
5. Returns `is_reconciling: true` immediately

## Monitoring

### Daily Health Check
```bash
npm run canary:health-check
```

Evaluates:
- Match rate ≥ 70%
- Cross-entity contamination = 0
- Confidence accuracy ≥ 80%
- Error rate < 1%

### Full Rollout
```bash
npm run deploy:full-rollout
```

Deploys to 100% of users and logs metrics.

## Files in the Reconciliation Layer

**Core**:
- `lib/reconciliation-waterfall.ts` — Stages 0-3
- `lib/reconciliation-llm-match.ts` — Stage 4
- `lib/full-reconciliation.ts` — Unified entry point

**Confidence & Scoring**:
- `lib/confidence-scoring.ts` — Breakdown computation
- `lib/confidence-recalculation.ts` — Signal scoring
- `lib/confidence.ts` — Legacy envelope format

**Semantic Matching**:
- `lib/levenshtein.ts` — String similarity
- `lib/semantic-validation-supermemory.ts` — Advanced validation

**Supermemory Integration**:
- `lib/supermemory-entity-profiles.ts` — Entity context
- `lib/supermemory-decision-history.ts` — Historical decisions

**Utilities**:
- `lib/vendor-credit-match.ts` — Credit handling
- `lib/reconciliation-audit-log.ts` — Audit logging
- `lib/attribution-persist.ts` — Attribution storage

**UI**:
- `components/confidence-breakdown.tsx` — Confidence display
- `app/dashboard/reconciliation/page.tsx` — Dashboard

**API**:
- `app/api/ar-ap-step/route.ts` — Reconciliation trigger
- `app/api/dashboard/reconciliation/apply-match/route.ts` — Manual match application

## Summary

✅ **Everything is in the waterfall.** When you run reconciliation, all stages (0-4) execute as one unified flow with:
- Deterministic matching (Stages 0-3)
- LLM semantic matching (Stage 4)
- Unified confidence scoring
- Comprehensive audit logging
- Greedy sweep prevention
- Cross-entity contamination detection
- Semantic validation

**No external dependencies.** The reconciliation layer is self-contained and ready for production.

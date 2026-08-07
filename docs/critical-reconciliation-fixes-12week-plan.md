# Critical Reconciliation Fixes - 12-Week Implementation Plan

## Executive Summary

This is a **realistic, achievable 12-week plan** that addresses all critical flaws found in the brutal code review. It prioritizes:
1. **Safety first** (fix injection vulnerabilities, add fallbacks)
2. **Deterministic matching** (Stages 0-3 before LLM)
3. **Incremental deployment** (canary rollouts, monitoring)
4. **Realistic targets** (72% → 80%, not 51% → 80%)

---

## Phase A: LLM Layer Hardening (Weeks 1-2)

### Objective
Fix critical vulnerabilities in LLM matching before any deployment.

### Week 1: Prompt Injection & Output Validation

**Task A1.1: Implement Prompt Escaping**
- File: `lib/reconciliation-llm-match.ts`
- Add `escapePromptText()` function
- Escape all user data before LLM prompt:
  - `raw_description` (bank data)
  - `counterparty` (bank data)
  - `customer_name` (entity data)
  - `vendor_name` (entity data)
  - `bank_description_patterns` (Supermemory data)
- Test: Verify injection payloads are neutralized

**Task A1.2: Fix LLM Output Parsing**
- File: `lib/reconciliation-llm-match.ts` (lines 79-98)
- Replace substring matching with strict regex:
  ```typescript
  const match = line.match(/^AR:\s*([a-f0-9\-]+)\s*->\s*([a-f0-9\-]+)\s*:\s*(high|medium|low)\s*:\s*(.+)$/i)
  ```
- Validate IDs exist in input sets before accepting
- Log hallucinated IDs as warnings
- Test: Verify invalid IDs are rejected

**Task A1.3: Add Hallucination Detection**
- File: `lib/reconciliation-llm-match.ts`
- Track hallucinated IDs per LLM call
- Alert if hallucination rate > 5%
- Test: Verify alerts trigger on bad LLM responses

### Week 2: Retry Logic & Circuit Breaker

**Task A2.1: Implement Retry with Exponential Backoff**
- File: `lib/reconciliation-llm-match.ts` (lines 42-77)
- Add `callLLMWithRetry()` wrapper
- Retry on: 5xx errors, 429 (rate limit), timeouts
- Don't retry on: 4xx errors (invalid request)
- Backoff: 1s, 2s, 4s, 8s, 16s (max 3 retries)
- Test: Verify retries work, backoff increases

**Task A2.2: Implement Circuit Breaker**
- File: `lib/reconciliation-llm-match.ts`
- Track failures per minute
- Open circuit after 3 consecutive failures
- Half-open after 60 seconds
- Fall back to old matching logic when open
- Test: Verify circuit opens/closes correctly

**Task A2.3: Add Rate Limiting**
- File: `lib/reconciliation-llm-match.ts`
- Use `p-limit` to enforce max 1 concurrent LLM call
- Track API calls per minute
- Queue requests if rate limit exceeded
- Test: Verify rate limiting works

**Task A2.4: Fix Entity Profile Loading Bug**
- File: `lib/reconciliation-llm-match.ts` (line 203)
- Current: `getEntityProfile(userId, "")` ← passes empty entityId
- Fix: Query entity by name first, then load profile
- Add validation: Check profile data is valid before using
- Test: Verify profiles are loaded correctly

### Deliverables
- ✅ Prompt injection fixed
- ✅ LLM output validation strict
- ✅ Retry logic with backoff
- ✅ Circuit breaker pattern
- ✅ Rate limiting
- ✅ Entity profile bug fixed
- ✅ All tests passing

---

## Phase B: Database Migration Refactor (Weeks 3-4)

### Objective
Implement safe, reversible database migrations with proper versioning.

### Week 3: Migration Framework & Versioning

**Task B1.1: Create Migration Versioning System**
- File: `lib/db.ts`
- Create `schema_migrations` table:
  ```sql
  CREATE TABLE schema_migrations (
    version INT PRIMARY KEY,
    name TEXT NOT NULL,
    executed_at TIMESTAMPTZ DEFAULT NOW(),
    execution_time_ms INT,
    status TEXT CHECK (status IN ('pending', 'running', 'completed', 'failed'))
  )
  ```
- Implement migration runner:
  - Check which migrations have run
  - Run pending migrations in order
  - Track execution time
  - Rollback on failure

**Task B1.2: Implement Atomic Backfill with Locking**
- File: `lib/db.ts`
- Create `backfillWithBatching()` function:
  - Lock table in EXCLUSIVE mode
  - Batch updates (10,000 rows at a time)
  - Release locks between batches
  - Commit after each batch
  - Log progress
- Test: Verify no table locks > 1 second

**Task B1.3: Add Pre/Post Migration Validation**
- File: `lib/db.ts`
- Before migration: Count rows, check constraints
- After migration: Verify no NULLs, verify values correct
- Fail migration if validation fails
- Test: Verify validation catches errors

### Week 4: Constraints, Indexes, Rollback

**Task B2.1: Add Constraints to New Columns**
- File: `lib/db.ts`
- Add CHECK constraint on `cost_type`:
  ```sql
  CHECK (cost_type IS NULL OR cost_type IN ('cogs', 'opex', 'capex'))
  ```
- Add FOREIGN KEY on `vendor_id` (if applicable)
- Add NOT NULL constraints where appropriate
- Test: Verify constraints prevent invalid data

**Task B2.2: Add Missing Indexes**
- File: `lib/db.ts`
- Add composite index for category-aware filtering:
  ```sql
  CREATE INDEX idx_attributions_user_component_category 
  ON movement_attributions (user_id, component_type, category)
  ```
- Add index for cost_type filtering:
  ```sql
  CREATE INDEX idx_attributions_user_cost_type 
  ON movement_attributions (user_id, cost_type)
  ```
- Test: Verify queries use indexes (EXPLAIN ANALYZE)

**Task B2.3: Create Rollback Procedures**
- File: `lib/db.ts`
- Document rollback for each migration
- Create rollback scripts
- Test rollback on staging
- Example:
  ```sql
  -- Rollback: Remove amount_signed column
  ALTER TABLE cash_events DROP COLUMN amount_signed
  ```

**Task B2.4: Add Migration Monitoring**
- File: `lib/db.ts`
- Log migration start/end
- Log execution time
- Alert if migration takes > 5 minutes
- Alert if migration fails
- Test: Verify alerts trigger

### Deliverables
- ✅ Migration versioning system
- ✅ Atomic backfill with batching
- ✅ Pre/post validation
- ✅ Constraints and indexes
- ✅ Rollback procedures
- ✅ Migration monitoring
- ✅ All tests passing

---

## Phase C: Stages 0-3 Deployment (Weeks 5-6)

### Objective
Deploy deterministic waterfall (Stages 0-3) to achieve 72% match rate safely.

### Week 5: Deterministic Waterfall Implementation

**Task C1.1: Implement Stage 0 (Direct Link)**
- File: `lib/reconciliation-waterfall.ts`
- Match via `tag_data.invoice_id/bill_id`
- Confidence: 0.98
- Test: Verify direct links work

**Task C1.2: Implement Stage 1 (Exact Match)**
- File: `lib/reconciliation-waterfall.ts`
- Match via exact amount (tolerance 0.01)
- Confidence: 0.90-0.92
- Test: Verify exact matches work

**Task C1.3: Implement Stage 2 (Processor Fee)**
- File: `lib/reconciliation-waterfall.ts`
- Match with 1-5% fee variance (AR only)
- Confidence: 0.88
- Test: Verify fee matching works

**Task C1.4: Implement Stage 3 (Tolerance Match)**
- File: `lib/reconciliation-waterfall.ts`
- Amount: ±5%, Date: ±45d (AR) / ±14d (AP)
- Entity: ID match or fuzzy name match
- Confidence: 0.75-0.85
- **CRITICAL**: Add entity tracking to prevent greedy sweeping
  - Track `matchedEntities` per movement
  - Reject matches if entity already matched
  - Limit to 3 matches per movement
- Test: Verify tolerance matching works, no greedy sweeping

### Week 6: Monitoring & Canary Deployment

**Task C2.1: Implement Basic Monitoring**
- File: `lib/monitoring.ts` (new)
- Track metrics:
  - Match rate (overall, by stage, by entity type)
  - Error rate (by stage)
  - API latency (Supermemory, LLM)
  - Cross-entity contamination rate
- Dashboard: Display metrics in real-time
- Test: Verify metrics are accurate

**Task C2.2: Implement Alerting**
- File: `lib/monitoring.ts`
- Alert if match rate drops below 70%
- Alert if error rate > 5%
- Alert if API latency > 5s
- Alert if cross-entity contamination detected
- Test: Verify alerts trigger

**Task C2.3: Canary Deployment (10%)**
- Deploy to 10% of users
- Monitor for 3 days
- Target: 72% match rate
- Success criteria:
  - Match rate ≥ 70%
  - Error rate < 5%
  - No cross-entity contamination
  - User override rate < 15%
- If success: Proceed to 100%
- If failure: Rollback and debug

**Task C2.4: Full Deployment (100%)**
- Deploy to 100% of users
- Monitor for 1 week
- Verify metrics stable
- Gather user feedback

### Deliverables
- ✅ Stages 0-3 implemented
- ✅ 72% match rate achieved
- ✅ Basic monitoring
- ✅ Alerting
- ✅ Canary deployment successful
- ✅ Full deployment successful

---

## Phase D: LLM Fixes & Testing (Weeks 7-11)

### Objective
Thoroughly test LLM Stage 4 before deployment. Fix all issues found in Phase A.

### Weeks 7-8: LLM Stage 4 Implementation

**Task D1.1: Deploy Phase A Fixes to Stage 4**
- File: `lib/reconciliation-llm-match.ts`
- Apply all fixes from Phase A:
  - Prompt injection escaping
  - Output validation
  - Retry logic
  - Circuit breaker
  - Rate limiting
- Test: Verify all fixes work

**Task D1.2: Implement Confidence Calibration**
- File: `lib/confidence-scoring.ts` (new)
- Replace hardcoded confidence (0.88, 0.75, 0.6)
- Implement multi-factor scoring:
  - Semantic match: 0.4 weight
  - Amount match: 0.3 weight
  - Date match: 0.2 weight
  - Entity match: 0.1 weight
- Calibrate weights based on historical accuracy
- Test: Verify confidence scores are accurate

**Task D1.3: Implement Hallucination Detection**
- File: `lib/reconciliation-llm-match.ts`
- Track hallucinated IDs per LLM call
- Validate LLM reasoning makes sense
- Reject matches if reasoning is nonsensical
- Test: Verify hallucinations are detected

### Weeks 9-10: Extensive Testing

**Task D2.1: Unit Tests**
- Test Levenshtein distance calculation
- Test confidence scoring
- Test entity matching logic
- Test hallucination detection
- Coverage: > 90%

**Task D2.2: Integration Tests**
- Test end-to-end matching with LLM
- Test with 1,000 real transactions
- Verify match rate ≥ 75%
- Verify no cross-entity contamination
- Verify confidence scores are calibrated

**Task D2.3: Regression Tests**
- Test with historical data
- Verify existing matches still work
- Verify no data corruption
- Verify no performance degradation

**Task D2.4: Data Quality Tests**
- Test with edge cases:
  - Zero amounts
  - Negative amounts
  - Very large amounts
  - Null values
  - Special characters
- Verify no crashes, no data corruption

**Task D2.5: Performance Tests**
- Test with 10,000 concurrent requests
- Verify Supermemory API doesn't get rate-limited
- Verify LLM API doesn't timeout
- Verify database queries are fast
- Target: < 2s per match

### Week 11: Staging Deployment

**Task D3.1: Deploy to Staging**
- Deploy all Phase D changes to staging
- Run full test suite
- Verify all tests pass
- Gather metrics

**Task D3.2: Staging Validation**
- Run for 1 week
- Monitor metrics
- Verify match rate ≥ 75%
- Verify no issues
- Get sign-off from team

### Deliverables
- ✅ LLM Stage 4 implemented
- ✅ Confidence calibration
- ✅ Hallucination detection
- ✅ Extensive testing (unit, integration, regression, data quality, performance)
- ✅ Staging deployment successful
- ✅ All metrics verified

---

## Phase E: Stage 4 Deployment (Week 12)

### Objective
Deploy LLM Stage 4 to production. Target: 80% match rate.

### Task E1: Canary Deployment (5%)

**E1.1: Deploy to 5% of Users**
- Deploy LLM Stage 4
- Monitor for 2 days
- Target: 78-80% match rate
- Success criteria:
  - Match rate ≥ 78%
  - Error rate < 5%
  - No cross-entity contamination
  - User override rate < 15%
  - Confidence scores calibrated

**E1.2: Canary Validation**
- If success: Proceed to 25%
- If failure: Rollback and debug

### Task E2: Staged Rollout

**E2.1: Deploy to 25% of Users**
- Monitor for 2 days
- Verify metrics stable
- If success: Proceed to 100%

**E2.2: Deploy to 100% of Users**
- Monitor for 1 week
- Verify metrics stable
- Gather user feedback

### Task E3: Full Monitoring

**E3.1: Activate Full Monitoring**
- Track all metrics
- Real-time dashboard
- Alerting active
- Audit trail active

**E3.2: Success Criteria**
- ✅ Match rate ≥ 80%
- ✅ Error rate < 5%
- ✅ Cross-entity contamination < 10 cases
- ✅ User override rate < 15%
- ✅ Confidence accuracy ≥ 75%
- ✅ No production incidents

### Deliverables
- ✅ LLM Stage 4 deployed to 100%
- ✅ 80% match rate achieved
- ✅ Full monitoring active
- ✅ All success criteria met

---

## Risk Mitigation Summary

| Risk | Mitigation | Phase |
|------|-----------|-------|
| Prompt injection | Escape all user data | A |
| LLM hallucination | Validate IDs, detect hallucinations | A, D |
| API failures | Retry logic, circuit breaker | A |
| Rate limiting | Rate limiter, queue requests | A |
| Database corruption | Migration versioning, atomic backfill | B |
| Table locks | Batch updates, release locks | B |
| Supermemory down | Circuit breaker, fallback to old logic | A |
| Canary failure | Staged rollout, automated rollback | C, E |
| Data quality | Comprehensive testing | D |
| Performance | Load testing, monitoring | D, E |

---

## Timeline Summary

| Phase | Duration | Key Deliverables | Risk Level |
|-------|----------|------------------|-----------|
| A | 2 weeks | LLM hardening, retry, circuit breaker | 🟢 LOW |
| B | 2 weeks | Migration versioning, atomic backfill | 🟢 LOW |
| C | 2 weeks | Stages 0-3, 72% match rate, monitoring | 🟡 MEDIUM |
| D | 5 weeks | LLM testing, confidence calibration | 🟡 MEDIUM |
| E | 1 week | Stage 4 deployment, 80% match rate | 🟡 MEDIUM |
| **TOTAL** | **12 weeks** | **Full reconciliation system** | **🟢 LOW** |

---

## Success Metrics

### Phase C (Stages 0-3)
- ✅ Match rate: 72% (from 51%)
- ✅ Error rate: < 5%
- ✅ Cross-entity contamination: 0
- ✅ User override rate: < 15%

### Phase E (Stage 4)
- ✅ Match rate: 80% (from 72%)
- ✅ Error rate: < 5%
- ✅ Cross-entity contamination: < 10 cases
- ✅ User override rate: < 15%
- ✅ Confidence accuracy: ≥ 75%

---

## What's Different From Original Plan

| Aspect | Original | New Plan | Reason |
|--------|----------|----------|--------|
| Timeline | 5 weeks | 12 weeks | Realistic, accounts for testing |
| Match rate target | 80% | 72% (Phase C), 80% (Phase E) | Incremental, achievable |
| LLM deployment | Week 4 | Week 12 | Extensive testing first |
| Fallback logic | None | Circuit breaker + old logic | Handles failures gracefully |
| Monitoring | Minimal | Comprehensive | Catch issues early |
| Testing | 1 week | 5 weeks | Prevent production incidents |
| Canary | 10% | 5% → 25% → 100% | Staged, safer rollout |

---

## Next Steps

1. **Week 1**: Start Phase A (LLM hardening)
2. **Week 3**: Start Phase B (database migrations)
3. **Week 5**: Start Phase C (Stages 0-3 deployment)
4. **Week 7**: Start Phase D (LLM testing)
5. **Week 12**: Start Phase E (Stage 4 deployment)

This plan is **realistic, achievable, and safe**. It prioritizes stability over speed.

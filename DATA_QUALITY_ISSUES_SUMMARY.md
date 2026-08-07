# Data Quality Issues - Executive Summary & Action Plan

**Date:** April 5, 2026  
**Status:** 🔴 CRITICAL - Immediate Action Required

---

## Quick Summary

The reconciliation data has **CRITICAL quality issues** that make current financial reporting **UNRELIABLE**. Three major problems require immediate attention:

1. **Duplicate Transactions** - Same customer, same amount, same date appearing multiple times
2. **Status Anomalies** - All AR/AP marked "Paid" but 93 items are unmatched (impossible)
3. **Partial Match Failures** - Matched amounts exceed bill amounts by up to 1,586% (data corruption)

**Current Match Rate: 51%** (Target: 85-90%)  
**Data Quality Score: 4/10** (Target: 9/10)

---

## Critical Issues Requiring Immediate Action

### Issue #1: Duplicate Transactions (🔴 CRITICAL)

**What's Happening:**
- Kelsee Gomes: $493.95 appears multiple times on May 9 and May 3
- Geordan Stapleton: Multiple entries on May 25 and May 7
- Conner Blake: Multiple entries on May 10 and May 2

**Why It Matters:**
- Inflates AR/AP totals by 2-3x for affected customers
- Creates false "unmatched" items
- Makes reconciliation impossible

**How to Fix (2-3 hours):**
```sql
-- Step 1: Identify duplicates
SELECT customer_name, amount, date, COUNT(*) as count
FROM cash_events
WHERE duplicate_of IS NULL
GROUP BY customer_name, amount, date
HAVING COUNT(*) > 1;

-- Step 2: Mark duplicates
UPDATE cash_events
SET duplicate_of = (
  SELECT id FROM cash_events ce2 
  WHERE ce2.user_id = cash_events.user_id
  AND ce2.amount = cash_events.amount
  AND ce2.expected_date = cash_events.expected_date
  AND ce2.id < cash_events.id
  LIMIT 1
)
WHERE duplicate_of IS NULL
AND (customer_name, amount, expected_date) IN (
  SELECT customer_name, amount, expected_date
  FROM cash_events
  GROUP BY customer_name, amount, expected_date
  HAVING COUNT(*) > 1
);
```

---

### Issue #2: Status Anomaly - All Marked "Paid" But Unmatched (🔴 CRITICAL)

**What's Happening:**
```
AR Invoices: 187 total, ALL marked "Paid", Outstanding = $0
But: 73 are unmatched to bank transactions
AP Bills: 55 total, ALL marked "Paid", Outstanding = $0
But: 20 are unmatched to bank transactions
```

**Why It's Impossible:**
- If all are paid, there should be 0 unmatched items
- If there are unmatched items, they must be unpaid
- Status field is stale and unreliable

**Why It Matters:**
- Financial reports show $0 outstanding when significant amounts are actually outstanding
- Users can't identify which invoices need follow-up
- Audit trail is compromised

**How to Fix (1-2 hours):**
```sql
-- Recalculate status based on actual outstanding amounts
UPDATE cash_events
SET status = CASE 
  WHEN outstanding_amount <= 0 THEN 'paid'
  WHEN expected_date < NOW()::date THEN 'overdue'
  ELSE 'open'
END
WHERE user_id = $1;
```

---

### Issue #3: Partial Match Amounts Exceed Bill Amounts (🔴 CRITICAL)

**What's Happening:**
- Pearson Ranch Jerky: $134.99 bill matched to $269.98 (100% over)
- King Orchards: $428.60 bill matched to $7,228.00 (1,586% over!)

**Why It's Impossible:**
- You can't collect more than you invoiced
- Matched amount should never exceed bill amount (except for fees)

**Why It Matters:**
- Financial statements show more collected than invoiced
- Reconciliation waterfall is broken
- Match rate calculations are invalid

**How to Fix (2-3 hours):**
```sql
-- Identify the problem
SELECT 
  ce.id,
  ce.metadata->>'customer_name' as customer,
  ce.amount::float as bill_amount,
  SUM(ABS(ma.net_amount::float)) as matched_amount,
  COUNT(ma.id) as match_count
FROM cash_events ce
LEFT JOIN movement_attributions ma ON ma.entity_id = ce.entity_id
WHERE ce.user_id = $1 AND ce.event_type = 'ar'
GROUP BY ce.id, ce.amount
HAVING SUM(ABS(ma.net_amount::float)) > ce.amount::float * 1.02;

-- Likely cause: Multiple invoices matched to single payment
-- Solution: Review each case and correct the matching
```

---

## High Priority Issues (This Week)

### Issue #4: Entity Name Mismatches (🟠 HIGH)

**What's Happening:**
- "Kelsee Gomes" vs "Kelsee Gomes (NY Yankees)"
- "Geordan Stapleton" vs "Geordan Stapleton (Astros)"
- Bank shows one format, invoices show another

**Impact:**
- Reduces match rate by 10-20%
- Creates false "unmatched" items

**How to Fix (4-6 hours):**
1. Create canonical entity name mapping
2. Implement fuzzy matching (Levenshtein distance)
3. Consolidate duplicate entities

---

### Issue #5: Unclassified Transactions (🟠 HIGH)

**What's Happening:**
- 355 transactions are unclassified
- System can't match what hasn't been classified

**Impact:**
- Prevents matching of 40-50% of transactions
- Artificially lowers match rate

**How to Fix (4-8 hours):**
1. Create classification rules for common patterns
2. Auto-classify transfers, fees, operational expenses
3. Manually review edge cases

---

## Action Plan

### TODAY (4 hours)
- [ ] Run duplicate detection query
- [ ] Mark duplicate cash events
- [ ] Recalculate status field
- [ ] Validate matched + outstanding = total
- [ ] Document findings

### THIS WEEK (12-16 hours)
- [ ] Audit 59 partially matched transactions
- [ ] Standardize entity names
- [ ] Classify 355 unclassified transactions
- [ ] Add missing descriptions
- [ ] Re-run reconciliation

### NEXT SPRINT (6-8 hours)
- [ ] Implement data validation framework
- [ ] Add data quality flags
- [ ] Create monitoring dashboard
- [ ] Train team on best practices

---

## Expected Improvements

| Action | Current | Target | Effort |
|--------|---------|--------|--------|
| Fix duplicates | 51% | 55-60% | 2-3 hrs |
| Fix status anomalies | 51% | 55-60% | 1-2 hrs |
| Fix partial matches | 51% | 55-60% | 2-3 hrs |
| Standardize entity names | 51% | 65-70% | 4-6 hrs |
| Classify transactions | 51% | 70-75% | 4-8 hrs |
| **TOTAL** | **51%** | **85-90%** | **13-22 hrs** |

---

## Key Metrics to Monitor

### Before Cleanup
- Match Rate: 51%
- Duplicate Count: 10-20
- Status Anomalies: 242
- Data Quality: 4/10

### After Cleanup (Target)
- Match Rate: 85-90%
- Duplicate Count: 0
- Status Anomalies: 0
- Data Quality: 9/10

---

## Important Notes

⚠️ **DO NOT** use current reconciliation data for financial reporting until these issues are resolved.

⚠️ **DO NOT** run reconciliation again until duplicates are marked and status is recalculated.

✅ **DO** start with Phase 1 (immediate fixes) today.

✅ **DO** notify stakeholders of data quality issues.

---

## Next Steps

1. **Review this analysis** with the team
2. **Run the duplicate detection query** to confirm findings
3. **Execute Phase 1 fixes** (4 hours)
4. **Re-run reconciliation** after cleanup
5. **Monitor data quality** going forward

For detailed analysis, see: `DATA_QUALITY_ANALYSIS_DETAILED.md`

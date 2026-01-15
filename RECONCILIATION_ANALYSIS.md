# Reconciliation Dashboard Data Consistency & Completeness Analysis

**Date:** April 5, 2026  
**Scope:** Verification of reconciliation dashboard data consistency across AR, AP, and bank transaction APIs

---

## Executive Summary

The reconciliation dashboard has **significant data consistency issues** and **missing validations** that could lead to incorrect financial reporting. The analysis identified **10 critical issues** and **8 recommendations** for improvement.

**Key Findings:**
- ❌ AR/AP summary calculations use different data sources than invoices/bills dashboards
- ❌ Outstanding amount calculations are inconsistent between cash_events and movement_attributions
- ❌ No validation that matched + outstanding = total
- ❌ Internal transfers are hardcoded to 0 instead of being calculated
- ❌ Match rates use different denominators across dashboards
- ⚠️ No breakdown by economic class in reconciliation summary
- ⚠️ Reconciled vs unreconciled counts are present but not validated
- ⚠️ No data quality flags or anomaly detection

---

## Detailed Findings

### 1. ❌ CRITICAL: AR Summary Mismatch Between Dashboards

**Issue:** The reconciliation dashboard calculates AR summary differently than the invoices dashboard.

**Reconciliation API** (`/api/dashboard/reconciliation`):
```typescript
// Lines 54-68: Uses movement_attributions for AR summary
const arSummary = await query(
  `SELECT
    COUNT(DISTINCT ma.entity_id) as total_invoiced,
    SUM(CASE WHEN ma.component_type = 'ar' THEN ABS(ma.net_amount::float) ELSE 0 END)::text as total_matched,
    ...
   FROM movement_attributions ma
   WHERE ma.user_id = $1 AND ma.component_type = 'ar'`
)

// Then uses cash_events for outstanding
const arCashEvents = await query(
  `SELECT SUM(ce.outstanding_amount)::text as total_outstanding, ...
   FROM cash_events ce
   WHERE ce.user_id = $1 AND ce.event_type = 'ar'`
)
```

**Invoices API** (`/api/dashboard/invoices`):
```typescript
// Lines 39-53: Uses cash_events directly
const invoiceRows = await query(
  `SELECT ce.id, ce.entity_id, ce.amount, ce.outstanding_amount, ...
   FROM cash_events ce
   WHERE ce.user_id = $1 AND ce.event_type = 'ar'`
)

// Calculates totals from cash_events
const totals = {
  total_outstanding: invoices.reduce((sum, inv) => sum + inv.outstanding_amount, 0),
  ...
}
```

**Problem:**
- Reconciliation uses `movement_attributions` for matched amounts (which is reconciliation data)
- Invoices uses `cash_events` for all amounts (which is expectation data)
- These are **two different data sources** and may not align
- `movement_attributions` only contains matched/attributed movements
- `cash_events` contains all invoices regardless of matching status

**Impact:** 
- `ar_total_matched` in reconciliation may not equal the sum of collected amounts in invoices
- Users see different "collected" amounts in different dashboards
- Reconciliation summary doesn't reflect actual invoice status

**Recommendation:**
- Align both dashboards to use the same source for matched amounts
- Consider: Should "matched" mean "has a movement_attribution" or "outstanding_amount < amount"?
- Add validation query to compare both sources

---

### 2. ❌ CRITICAL: AP Summary Mismatch Between Dashboards

**Issue:** Same as AR but for AP/Bills.

**Reconciliation API:**
```typescript
// Uses movement_attributions for AP matched amounts
const apSummary = await query(
  `SELECT ... SUM(CASE WHEN ma.component_type = 'ap' THEN ABS(ma.net_amount::float) ELSE 0 END)::text as total_matched ...
   FROM movement_attributions ma
   WHERE ma.user_id = $1 AND ma.component_type = 'ap'`
)

// Uses cash_events for outstanding
const apCashEvents = await query(
  `SELECT SUM(ce.outstanding_amount)::text as total_outstanding ...
   FROM cash_events ce
   WHERE ce.user_id = $1 AND ce.event_type = 'ap'`
)
```

**Bills API:**
```typescript
// Uses cash_events for all amounts
const billRows = await query(
  `SELECT ce.id, ce.entity_id, ce.amount, ce.outstanding_amount ...
   FROM cash_events ce
   WHERE ce.user_id = $1 AND ce.event_type = 'ap'`
)
```

**Problem:** Same as AR - two different data sources

**Impact:** Bills dashboard and reconciliation dashboard show different "paid" amounts

---

### 3. ❌ CRITICAL: Match Rate Calculation Inconsistency

**Reconciliation API** (Lines 157, 162, 166):
```typescript
ar_match_rate: arTotal > 0 ? Math.round((arMatched / arTotal) * 100) : 0,
ap_match_rate: apTotal > 0 ? Math.round((apMatched / apTotal) * 100) : 0,
overall_match_rate: totalAmount > 0 ? Math.round(((arMatched + apMatched) / totalAmount) * 100) : 0,
```

**Where:**
- `arMatched` = sum of `movement_attributions` with `component_type = 'ar'`
- `arTotal` = sum of `cash_events.amount` with `event_type = 'ar'`

**Problem:**
- `arMatched` is from movement_attributions (reconciliation data)
- `arTotal` is from cash_events (expectation data)
- These are **different data sources** and may not be comparable
- The denominator (arTotal) includes all invoices, even those with no matching movements

**Example Scenario:**
```
cash_events (invoices):
- Invoice A: $1000
- Invoice B: $500
Total: $1500

movement_attributions (matched):
- Invoice A matched to payment: $1000
Total matched: $1000

Match rate = 1000 / 1500 = 66.7%

But what if Invoice B is partially paid?
- Invoice B outstanding: $200
- Invoice B paid: $300

Should match rate be:
- 1000 / 1500 = 66.7% (current)
- 1300 / 1500 = 86.7% (including partial)
- 1000 / 1300 = 76.9% (matched / total paid)
```

**Recommendation:**
- Define match rate clearly: matched / total OR matched / total_paid?
- Use consistent data sources
- Document the calculation in the API response

---

### 4. ❌ CRITICAL: No Validation of matched + outstanding = total

**Current Code:**
```typescript
// Reconciliation API doesn't validate this relationship
const summary: ReconciliationSummary = {
  ar_total_outstanding: arOutstanding,
  ar_total_matched: arMatched,
  ar_match_rate: arTotal > 0 ? Math.round((arMatched / arTotal) * 100) : 0,
  // No validation that arMatched + arOutstanding = arTotal
}
```

**Problem:**
- No assertion that `matched + outstanding = total`
- If data is corrupted or inconsistent, users won't know
- Silent data quality issues

**Expected Relationship:**
```
For AR:
- total_invoiced = total_matched + total_outstanding
- If Invoice A is $1000 and $600 is matched, outstanding should be $400

For AP:
- total_billed = total_matched + total_outstanding
```

**Recommendation:**
- Add validation query to verify this relationship
- Return a `data_quality_flags` array in the response
- Flag if discrepancy > 0.01 (1 cent)

---

### 5. ❌ CRITICAL: Outstanding Amount Calculation Inconsistency

**Reconciliation API** (Lines 114-130):
```typescript
// Gets outstanding from cash_events
const arCashEvents = await query(
  `SELECT SUM(ce.outstanding_amount)::text as total_outstanding ...
   FROM cash_events ce
   WHERE ce.user_id = $1 AND ce.event_type = 'ar'`
)
```

**Invoices API** (Lines 69-70):
```typescript
// Calculates outstanding from individual invoices
const outstandingAmount = parseFloat(String(row.outstanding_amount || 0))
const totals = {
  total_outstanding: invoices.reduce((sum, inv) => sum + inv.outstanding_amount, 0),
}
```

**Problem:**
- Both use `cash_events.outstanding_amount` but may aggregate differently
- If a cash_event has `outstanding_amount = NULL`, reconciliation sums it as 0, invoices may handle it differently
- Rounding differences in aggregation vs. individual summation

**Current Handling:**
```typescript
// Reconciliation: parseFloat(String(arCashEvents?.total_outstanding || 0))
// Invoices: parseFloat(String(row.outstanding_amount || 0))
```

**Recommendation:**
- Ensure NULL handling is consistent
- Use database-level SUM with COALESCE
- Add test case for NULL outstanding_amount values

---

### 6. ❌ CRITICAL: Internal Transfers Hardcoded to 0

**Current Code** (Lines 168-169):
```typescript
internal_transfers_count: 0,
internal_transfers_amount: 0,
```

**Problem:**
- These are hardcoded to 0 instead of being calculated
- The reconciliation page displays these values but they're always 0
- Bank accounts API correctly calculates internal transfers:

```typescript
// bank-accounts/route.ts (Lines 53-54)
COALESCE(COUNT(CASE WHEN m.movement_type = 'internal_transfer' THEN 1 END), 0)::int AS internal_transfer_count,
COALESCE(SUM(CASE WHEN m.movement_type = 'internal_transfer' THEN m.amount ELSE 0 END), 0)::numeric AS total_inflow,
```

**Impact:**
- Users can't see how many internal transfers are in their reconciliation
- Reconciliation summary is incomplete
- Misleading data quality

**Recommendation:**
- Calculate internal transfers from movements table
- Query: `WHERE m.user_id = $1 AND m.movement_type = 'internal_transfer'`
- Add to summary

---

### 7. ⚠️ MAJOR: No Breakdown by Economic Class

**Current Reconciliation Summary:**
```typescript
type ReconciliationSummary = {
  ar_total_outstanding: number
  ar_total_matched: number
  ar_match_rate: number
  // ... no breakdown by economic class
}
```

**Transactions API** (Lines 150-165):
```typescript
// Transactions API provides breakdown by economic class
const byEconomicClassResult = await query(
  `SELECT mt.economic_class, COUNT(*)::text AS count
   FROM movements m
   LEFT JOIN movement_tags mt ON mt.movement_id = m.id
   WHERE ${whereClause}
   GROUP BY mt.economic_class`
)
```

**Problem:**
- Reconciliation doesn't show which economic classes are matched/outstanding
- Can't identify if certain types of transactions (e.g., "customer_receipt" vs "refund") have different match rates
- Reconciliation waterfall filters by economic class but summary doesn't reflect this

**Reconciliation Waterfall** (Lines 19-33):
```typescript
// AR-eligible: movements that can match to invoices
const AR_ELIGIBLE_CLASSES = new Set<string | null>([
  "customer_receipt",
  "refund",
  null,
])

// AP-eligible: movements that can match to bills
const AP_ELIGIBLE_CLASSES = new Set<string | null>([
  "vendor_payment",
  "payroll",
  "tax",
  "debt_payment",
  null,
])
```

**Recommendation:**
- Add `by_economic_class` breakdown to reconciliation summary
- Show match rates by class
- Identify which classes have low match rates

---

### 8. ⚠️ MAJOR: Reconciled vs Unreconciled Counts Not Validated

**Current Code** (Lines 170-171):
```typescript
bank_reconciled_count: bankTransactions.filter((t) => t.status === "reconciled").length,
bank_unreconciled_count: bankTransactions.filter((t) => t.status === "not_reconciled").length,
```

**Problem:**
- These counts are calculated from the 500-transaction limit (Line 109)
- If there are more than 500 transactions, counts are incomplete
- No validation that reconciled + unreconciled = total

**Current Query** (Lines 88-111):
```typescript
const bankTransactions = await query<ReconciliationDetail>(
  `SELECT ... FROM movements m
   LEFT JOIN movement_attributions ma ON ma.movement_id = m.id AND ma.user_id = m.user_id
   WHERE m.user_id = $1 AND m.direction IN ('inflow', 'outflow') AND m.duplicate_of IS NULL
   GROUP BY m.id, m.direction, m.amount, m.date, m.counterparty, m.raw_description
   ORDER BY m.date DESC
   LIMIT 500`,  // <-- Only 500 transactions!
  [userId]
).then((r) => r.rows)
```

**Impact:**
- Reconciliation counts are incomplete for users with >500 transactions
- Summary statistics are misleading
- No indication that data is truncated

**Recommendation:**
- Return total count separately from limited results
- Add `total_transactions` to summary
- Add `is_truncated` flag if results exceed limit
- Consider pagination or filtering

---

### 9. ⚠️ MAJOR: No Validation of Excluded Transaction Types

**Excluded from Reconciliation** (reconciliation-waterfall.ts, Lines 36-50):
```typescript
const EXCLUDED_FROM_RECON = new Set<string>([
  "transfer",
  "owner_contribution",
  "owner_draw",
  "bank_fee",
  "bank_fee_refund",
  "interest",
  "opening_balance",
  "account_verification",
  "system_adjustment",
  "processor_fee",
  "processor_payout",
  "settlement_in",
  "settlement_adjustment",
])
```

**Problem:**
- Reconciliation API doesn't filter by these excluded types
- Bank transactions query includes all directions but doesn't exclude these types
- Reconciliation summary may include transactions that shouldn't be reconciled

**Current Query** (Lines 104-106):
```typescript
FROM movements m
LEFT JOIN movement_attributions ma ON ma.movement_id = m.id AND ma.user_id = m.user_id
WHERE m.user_id = $1 AND m.direction IN ('inflow', 'outflow') AND m.duplicate_of IS NULL
// Missing: AND m.movement_type NOT IN (excluded types)
```

**Impact:**
- Bank fees, transfers, and other non-AR/AP transactions are included in reconciliation
- Match rates are artificially low
- Users see unreconcilable transactions in the reconciliation dashboard

**Recommendation:**
- Add filter: `AND m.movement_type NOT IN (...EXCLUDED_FROM_RECON...)`
- Or use the same eligibility logic as reconciliation waterfall
- Document which transaction types are included/excluded

---

### 10. ⚠️ MAJOR: No Data Quality Flags or Anomaly Detection

**Current Response:**
```typescript
return NextResponse.json({
  summary,
  transactions: bankTransactions,
})
```

**Missing:**
- No data quality indicators
- No anomaly flags
- No warnings about data inconsistencies
- No indication of data freshness

**Recommended Additions:**
```typescript
type DataQualityFlag = {
  severity: "error" | "warning" | "info"
  code: string
  message: string
  affected_field: string
  suggested_action: string
}

return NextResponse.json({
  summary,
  transactions: bankTransactions,
  data_quality: {
    flags: [
      {
        severity: "warning",
        code: "MATCHED_OUTSTANDING_MISMATCH",
        message: "AR matched + outstanding ($X) != total ($Y)",
        affected_field: "ar_total_matched, ar_total_outstanding",
        suggested_action: "Review reconciliation waterfall for data corruption"
      }
    ],
    last_reconciliation_run: "2026-04-05T10:30:00Z",
    is_truncated: false,
    total_transactions: 1250,
    returned_transactions: 500
  }
})
```

---

## Comparison Matrix: Data Sources Across Dashboards

| Metric | Reconciliation | Invoices | Bills | Transactions |
|--------|---|---|---|---|
| **Total AR** | `cash_events.amount` (AR) | `cash_events.amount` (AR) | N/A | N/A |
| **AR Outstanding** | `cash_events.outstanding_amount` (AR) | `cash_events.outstanding_amount` (AR) | N/A | N/A |
| **AR Matched** | `movement_attributions.net_amount` (AR) | Calculated from outstanding | N/A | N/A |
| **Total AP** | `cash_events.amount` (AP) | N/A | `cash_events.amount` (AP) | N/A |
| **AP Outstanding** | `cash_events.outstanding_amount` (AP) | N/A | `cash_events.outstanding_amount` (AP) | N/A |
| **AP Matched** | `movement_attributions.net_amount` (AP) | N/A | Calculated from outstanding | N/A |
| **By Economic Class** | ❌ Not shown | ❌ Not shown | ❌ Not shown | ✅ Shown |
| **Internal Transfers** | ❌ Hardcoded 0 | ❌ Not shown | ❌ Not shown | ✅ Filtered out |
| **Excluded Types** | ❌ Not filtered | ✅ Implicit (cash_events) | ✅ Implicit (cash_events) | ✅ Filtered |

---

## Validation Queries to Add

### Query 1: Verify matched + outstanding = total for AR
```sql
SELECT
  SUM(ce.amount)::float as total_invoiced,
  SUM(ce.outstanding_amount)::float as total_outstanding,
  SUM(CASE WHEN ma.component_type = 'ar' THEN ABS(ma.net_amount::float) ELSE 0 END)::float as total_matched,
  (SUM(ce.outstanding_amount)::float + SUM(CASE WHEN ma.component_type = 'ar' THEN ABS(ma.net_amount::float) ELSE 0 END)::float) as calculated_total,
  ABS(SUM(ce.amount)::float - (SUM(ce.outstanding_amount)::float + SUM(CASE WHEN ma.component_type = 'ar' THEN ABS(ma.net_amount::float) ELSE 0 END)::float)) as discrepancy
FROM cash_events ce
LEFT JOIN movement_attributions ma ON ma.user_id = ce.user_id AND ma.component_type = 'ar'
WHERE ce.user_id = $1 AND ce.event_type = 'ar'
```

### Query 2: Verify excluded transaction types are not in reconciliation
```sql
SELECT COUNT(*) as excluded_in_reconciliation
FROM movements m
WHERE m.user_id = $1 
  AND m.movement_type IN ('transfer', 'owner_contribution', 'owner_draw', 'bank_fee', 'bank_fee_refund', 'interest', 'opening_balance', 'account_verification', 'system_adjustment', 'processor_fee', 'processor_payout', 'settlement_in', 'settlement_adjustment')
  AND EXISTS (
    SELECT 1 FROM movement_attributions ma 
    WHERE ma.movement_id = m.id AND ma.user_id = m.user_id
  )
```

### Query 3: Verify reconciliation counts match actual totals
```sql
SELECT
  COUNT(*) as total_movements,
  COUNT(CASE WHEN EXISTS (SELECT 1 FROM movement_attributions ma WHERE ma.movement_id = m.id) THEN 1 END) as reconciled,
  COUNT(CASE WHEN NOT EXISTS (SELECT 1 FROM movement_attributions ma WHERE ma.movement_id = m.id) THEN 1 END) as unreconciled
FROM movements m
WHERE m.user_id = $1 AND m.direction IN ('inflow', 'outflow') AND m.duplicate_of IS NULL
```

---

## Recommendations Summary

### Priority 1: Critical (Fix Immediately)
1. **Align AR/AP data sources** - Use consistent source for matched amounts across all dashboards
2. **Add matched + outstanding validation** - Ensure they sum to total
3. **Calculate internal transfers** - Remove hardcoded 0 values
4. **Filter excluded transaction types** - Don't include transfers, fees, etc. in reconciliation
5. **Fix match rate calculation** - Use consistent data sources and document the formula

### Priority 2: High (Fix This Sprint)
6. **Add economic class breakdown** - Show match rates by transaction type
7. **Add data quality flags** - Return warnings about inconsistencies
8. **Fix transaction count truncation** - Return total count and pagination info
9. **Add reconciliation status validation** - Verify reconciled + unreconciled = total

### Priority 3: Medium (Fix Next Sprint)
10. **Add anomaly detection** - Flag unusual match rates or amounts
11. **Add data freshness indicator** - Show when reconciliation was last run
12. **Add reconciliation history** - Track changes over time
13. **Add drill-down capability** - Link from summary to detailed transactions

---

## Testing Checklist

- [ ] Verify AR summary matches invoices dashboard
- [ ] Verify AP summary matches bills dashboard
- [ ] Verify matched + outstanding = total for both AR and AP
- [ ] Verify match rates are calculated consistently
- [ ] Verify internal transfers are calculated correctly
- [ ] Verify excluded transaction types are not included
- [ ] Verify economic class breakdown is accurate
- [ ] Verify data quality flags are returned when appropriate
- [ ] Verify reconciliation counts match actual totals
- [ ] Verify no NULL values cause calculation errors

---

## Implementation Notes

### Data Source Alignment Strategy
1. **Option A: Use cash_events for everything**
   - Pros: Single source of truth, simpler queries
   - Cons: Doesn't show actual reconciliation status
   - Use case: Expectation-based reporting

2. **Option B: Use movement_attributions for matched, cash_events for outstanding**
   - Pros: Shows actual reconciliation status
   - Cons: Two data sources, more complex
   - Use case: Reconciliation-focused reporting (current approach)

3. **Option C: Denormalize reconciliation status into cash_events**
   - Pros: Single source, fast queries
   - Cons: Requires maintaining denormalization
   - Use case: High-performance reporting

**Recommendation:** Stick with Option B but ensure consistency across all dashboards.

### Match Rate Definition
Recommend defining match rate as:
```
Match Rate = (Sum of matched movement amounts) / (Sum of total invoice/bill amounts)
```

Where:
- "Matched" = has a movement_attribution record
- "Total" = sum of all cash_events for the period

This shows what percentage of expected cash has been reconciled to actual bank movements.

---

## Appendix: Code References

- Reconciliation API: `/app/api/dashboard/reconciliation/route.ts`
- Invoices API: `/app/api/dashboard/invoices/route.ts`
- Bills API: `/app/api/dashboard/bills/route.ts`
- Transactions API: `/app/api/dashboard/transactions/route.ts`
- Reconciliation Waterfall: `/lib/reconciliation-waterfall.ts`
- AR/AP State: `/lib/state/ar-ap.ts`
- Cash Events Build: `/lib/cash-events-build.ts`

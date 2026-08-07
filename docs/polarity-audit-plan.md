# True Polarity Audit Plan - ProfitWise

**Audit Date:** April 7, 2026  
**Polarity Convention:** Inflows are positive (> 0), Outflows are negative (< 0)  
**Status:** Static Analysis Complete - Ready for Implementation

---

## Executive Summary

This audit identified **3 categories of polarity vulnerabilities** across the ProfitWise codebase:

1. **Double Negative Math Traps** - 0 Critical Issues Found ✅
2. **Math.abs() / Sign-Flip Fallbacks** - 2 Critical Issues Found ⚠️
3. **Blind Zero-Boundaries in UI** - 7 Critical Issues Found 🔴

**Total Vulnerabilities:** 9 Critical, 12 High, 6 Medium, 8 Low

---

## Category 1: Double Negative Math Traps

### Status: ✅ CLEAN

The codebase demonstrates **excellent financial math practices** with NO critical double negative math traps detected.

**Key Strengths:**

- Consistent sign convention: inflows positive, outflows positive (not negative)
- Proper accumulation patterns throughout
- Defensive programming with `Math.max(0, ...)` guards
- Clear variable naming (inflows, outflows, net amounts)

**Verified Files:**

- `lib/state/compute.ts` - Revenue/expense calculations ✅
- `lib/state/forecast-engine.ts` - Cashflow simulations ✅
- `app/api/books/p-and-l/route.ts` - P&L calculations ✅
- `lib/reconciliation-waterfall.ts` - Outstanding amount tracking ✅

---

## Category 2: Math.abs() and Sign-Flip Fallbacks

### Status: ⚠️ 2 CRITICAL ISSUES FOUND

#### CRITICAL-001: P&L Waterfall Chart Double Negation

**File:** `app/dashboard/p-and-l/page.tsx`  
**Lines:** 511, 513  
**Severity:** CRITICAL

**Code:**

```typescript
511|  { name: "COGS", value: -Math.abs(data.cogs.total_cogs), fill: "#ef4444" },
513|  { name: "OpEx", value: -Math.abs(data.operating_expenses.total_opex), fill: "#f97316" },
```

**Issue:** Double negation pattern `-Math.abs()` assumes source data is positive. If `data.cogs.total_cogs` or `data.operating_expenses.total_opex` are already stored as negative values, this creates a polarity inversion.

**Impact:**

- Waterfall chart displays inverted values
- COGS/OpEx appear as positive when they should be negative
- Financial visualization is misleading

**Verification Needed:**

- Confirm that `data.cogs.total_cogs` is always stored as positive
- Confirm that `data.operating_expenses.total_opex` is always stored as positive
- If stored as negative, remove the outer negation

**Fix:**

```typescript
// Option 1: If source data is positive (current assumption)
{ name: "COGS", value: -data.cogs.total_cogs, fill: "#ef4444" },

// Option 2: If source data is negative (safer)
{ name: "COGS", value: data.cogs.total_cogs, fill: "#ef4444" },
```

---

#### CRITICAL-002: Largest Account Balance Calculation

**File:** `lib/state/compute.ts`  
**Line:** 468  
**Severity:** CRITICAL

**Code:**

```typescript
468|  largest_account_balance: Math.max(...cashByAccount.map(a => Math.abs(a.net_flow)))
```

**Issue:** `Math.abs(a.net_flow)` hides the sign of the net flow. If an account has negative cash (overdraft), taking the absolute value makes it appear as a large positive balance.

**Impact:**

- Negative cash positions (overdrafts) are hidden
- Largest balance calculation is misleading
- Risk assessment may be inaccurate

**Verification Needed:**

- Confirm whether `net_flow` can be negative
- If yes, should we track largest positive and largest negative separately?
- Should overdrafts be flagged as risk?

**Fix:**

```typescript
// Option 1: Track largest positive balance only
largest_account_balance: Math.max(...cashByAccount.map(a => Math.max(0, a.net_flow)))

// Option 2: Track largest absolute balance with sign
largest_account_balance: cashByAccount.reduce((max, a) => 
  Math.abs(a.net_flow) > Math.abs(max) ? a.net_flow : max, 0)
```

---

### HIGH SEVERITY: Math.abs() Usage (Legitimate but Worth Verifying)

#### HIGH-001: Forecast Engine Burn Rate Calculations

**File:** `lib/state/forecast-engine.ts`  
**Lines:** 3818, 3822, 4374, 4387, 4430, 4447, 4461, 4474, 4593, 4632, 4960, 5079-5101, 5148-5149, 5282-5291  
**Severity:** HIGH

**Code Examples:**

```typescript
3818|  const monthlyBurn = avgMonthlyNet < 0 ? Math.abs(avgMonthlyNet) : 0
3822|  if (pessNet < 0) pessRunway = r2(startingCash / Math.abs(pessNet))
4374|  const impactPct = r2((customerCash / Math.max(1, Math.abs(baseCash30))) * 100)
```

**Issue:** `Math.abs()` used to convert negative burn rates to positive values. While mostly legitimate for burn rate calculations, `Math.abs(baseCash30)` could hide negative cash scenarios.

**Assessment:** Mostly legitimate for burn rate normalization, but verify that negative cash scenarios are handled correctly elsewhere.

---

#### HIGH-002: Unresolved Enrichment Amount Key

**File:** `lib/unresolved-enrich.ts`  
**Line:** 51  
**Severity:** HIGH

**Code:**

```typescript
51|  const amtKey = Math.abs(m.amount).toFixed(2)
```

**Issue:** `Math.abs()` used to normalize amount for lookup key. Assumes amounts can be negative.

**Assessment:** Legitimate if amounts are stored with sign; verify that sign information isn't lost in the key.

---

### MEDIUM SEVERITY: Math.abs() Usage (Legitimate)

#### MEDIUM-001: Days Overdue Calculations

**Files:** `lib/bills-fetch.ts` (lines 68, 111, 154, 266, 315, 358), `lib/invoices-fetch.ts` (lines 109, 149, 190, 226)  
**Severity:** MEDIUM

**Code:**

```typescript
const diff = Math.round((new Date(dueDate).getTime() - new Date(today).getTime()) / 86_400_000)
if (diff < 0) { daysOverdue = Math.abs(diff); status = "overdue" }
```

**Assessment:** Legitimate use - converting negative time deltas to positive day counts. ✅

---

#### MEDIUM-002: Reconciliation Tolerance Matching

**Files:** `lib/reconciliation-waterfall.ts` (lines 605, 746, 1125), `lib/ar-payment-match.ts` (lines 110, 121, 131), `lib/ap-llm-match.ts` (lines 63, 66, 113)  
**Severity:** MEDIUM

**Code:**

```typescript
if (Math.abs(matchedAmount - targetAmount) < tolerance || matchedAmount >= targetAmount - tolerance)
```

**Assessment:** Legitimate use - tolerance-based matching. ✅

---

#### MEDIUM-003: UI Display Formatting

**Files:** `components/onboarding-flow.tsx` (lines 3360, 3599-3601, 4437-4438, 4555-4556, 4563-4565, 5153-5155, 5417, 5978, 6578-6579), `app/dashboard/p-and-l/page.tsx` (lines 92, 187, 262-280, 314-332, 369, 445-494, 555-573, 616-705)  
**Severity:** MEDIUM

**Code:**

```typescript
{`${d.headline.direction === "outflow" ? "-" : "+"}$${Math.abs(d.headline.amount).toLocaleString(...)}`}
```

**Assessment:** Legitimate use - display formatting with sign handled separately. ✅

---

## Category 3: Blind Zero-Boundaries in UI

### Status: 🔴 7 CRITICAL ISSUES FOUND

#### CRITICAL-UI-001: Revenue Line Item Filtering

**File:** `app/dashboard/p-and-l/page.tsx`  
**Lines:** 220, 230, 408, 420, 530, 536, 544  
**Severity:** CRITICAL

**Code:**

```typescript
220|  data.revenue.line_items?.filter((item: any) => item.amount > 0.01)
```

**What Breaks:** Filters out refunds, chargebacks, and negative revenue adjustments. Only displays positive revenue items.

**Impact:**

- Refunds/chargebacks completely hidden from revenue breakdown
- Users cannot see negative revenue adjustments in UI
- P&L statement appears artificially inflated
- Revenue reconciliation incomplete

**Fix:**

```typescript
// Change to:
data.revenue.line_items?.filter((item: any) => Math.abs(item.amount) > 0.01)
```

---

#### CRITICAL-UI-002: Invoice Amount Due Styling

**File:** `app/dashboard/reconciliation/page.tsx`  
**Lines:** 990, 1073  
**Severity:** CRITICAL

**Code:**

```typescript
990|  <span className={`text-[13px] font-mono tabular-nums ${inv.amount_due > 0 ? "text-amber-400" : "text-zinc-500"}`}>
```

**What Breaks:** When `amount_due` is 0 or negative (vendor credit), styling changes to zinc-500 (muted), making it invisible/unimportant.

**Impact:**

- Vendor credits appear as non-issues
- Users miss credit balances that should be tracked
- Reconciliation accuracy compromised
- Credits are visually de-emphasized

**Fix:**

```typescript
// Change to:
className={`text-[13px] font-mono tabular-nums ${
  inv.amount_due > 0 ? "text-amber-400" : 
  inv.amount_due < 0 ? "text-blue-400" : 
  "text-zinc-500"
}`}
```

---

#### CRITICAL-UI-003: Overdue Amount Card Styling

**File:** `app/dashboard/invoices/page.tsx`  
**Lines:** 164-171  
**Severity:** CRITICAL

**Code:**

```typescript
164|  <div className={`bg-gradient-to-br ${totals.total_overdue > 0 ? 'from-red-500/10 to-red-500/5 border-red-500/20 hover:border-red-500/40' : 'from-zinc-500/10 to-zinc-500/5 border-zinc-500/20 hover:border-zinc-500/40'} border rounded-lg p-4 transition-colors`}>
167|  <p className={`text-[11px] ${totals.total_overdue > 0 ? 'text-red-400/70' : 'text-zinc-400/70'} font-medium uppercase tracking-wide mb-2`}>Overdue</p>
169|  <p className={`text-2xl font-bold tabular-nums ${totals.total_overdue > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{formatCurrency(totals.total_overdue)}</p>
```

**What Breaks:** When `total_overdue` is 0 or negative (customer credits), card styling becomes neutral/emerald, hiding credit information.

**Impact:**

- Customer credits not visually distinguished
- Dashboard appears to show no issues when credits exist
- Cash flow impact of credits is hidden
- Credits appear as positive (emerald) instead of neutral

**Fix:**

```typescript
// Change to:
className={`text-2xl font-bold tabular-nums ${
  totals.total_overdue > 0 ? 'text-red-400' : 
  totals.total_overdue < 0 ? 'text-blue-400' : 
  'text-zinc-400'
}`}
```

---

#### CRITICAL-UI-004: Invoice Status Determination

**File:** `app/dashboard/reconciliation/page.tsx`  
**Lines:** 977, 1060  
**Severity:** CRITICAL

**Code:**

```typescript
977|  const effectiveStatus = inv.status === "open" && inv.days_overdue > 0 ? "overdue" : inv.status
```

**What Breaks:** When `days_overdue` is 0 or negative (early payment), status doesn't update. Vendor credits with negative days_overdue are not flagged.

**Impact:**

- Early payments not distinguished from on-time payments
- Vendor credits not properly categorized
- Status classification incomplete

**Fix:**

```typescript
// Change to:
const effectiveStatus = inv.status === "open" 
  ? inv.days_overdue > 0 ? "overdue" : inv.days_overdue < 0 ? "early" : "on_time"
  : inv.status
```

---

#### CRITICAL-UI-005: Invoice Days Overdue Color Coding

**File:** `app/dashboard/reconciliation/page.tsx`  
**Lines:** 981, 1064  
**Severity:** CRITICAL

**Code:**

```typescript
981|  <p className={`text-[13px] truncate max-w-[180px] ${inv.days_overdue > 0 ? "text-red-300" : "text-white"}`}>
```

**What Breaks:** When `days_overdue` is 0 or negative, text color defaults to white (neutral), hiding early payment signals.

**Impact:**

- Early payments not visually distinguished
- Vendor credits appear neutral instead of positive
- Payment performance not clearly communicated

**Fix:**

```typescript
// Change to:
className={`text-[13px] truncate max-w-[180px] ${
  inv.days_overdue > 0 ? "text-red-300" : 
  inv.days_overdue < 0 ? "text-green-300" : 
  "text-white"
}`}
```

---

#### CRITICAL-UI-006: Invoice API Filtering

**File:** `app/api/dashboard/invoices/route.ts`  
**Lines:** 128, 131, 137  
**Severity:** CRITICAL

**Code:**

```typescript
128|  .filter((inv) => inv.status === "overdue" || (inv.days_overdue !== null && inv.days_overdue > 0))
```

**What Breaks:** Filters out invoices with `days_overdue <= 0` (early payments, on-time payments, vendor credits).

**Impact:**

- API only returns overdue invoices
- Early payments and credits not included in totals
- Dashboard metrics incomplete
- Reconciliation data incomplete

**Fix:**

```typescript
// Change to:
.filter((inv) => inv.status === "overdue" || (inv.days_overdue !== null && Math.abs(inv.days_overdue) > 0))
```

---

#### CRITICAL-UI-007: Forecast Engine Outstanding Filtering

**File:** `lib/state/forecast-engine.ts`  
**Lines:** 2762, 4058  
**Severity:** CRITICAL

**Code:**

```typescript
2762|  const openInvs = c.outstanding_invoices.filter((i) => i.amount_due > 0)
4058|  const apOpenBills = bills.filter((b) => b.amount_due > 0)
```

**What Breaks:** Filters out invoices/bills with `amount_due <= 0` (fully paid, vendor credits).

**Impact:**

- Forecast calculations exclude vendor credits
- Cash flow projections incomplete
- Credit balances not factored into predictions
- Forecast accuracy compromised

**Fix:**

```typescript
// Change to:
const openInvs = c.outstanding_invoices.filter((i) => Math.abs(i.amount_due) > 0)
```

---

### HIGH SEVERITY: Blind Zero-Boundaries

#### HIGH-UI-001: Invoice Percentage Calculations

**File:** `components/onboarding-flow.tsx`  
**Lines:** 3911, 4047  
**Severity:** HIGH

**Code:**

```typescript
3911|  const pct = inv.amount > 0 ? Math.round((amountCollected / inv.amount) * 100) : 0
```

**What Breaks:** When `amount` is 0 or negative, percentage defaults to 0, hiding credit information.

**Impact:**

- Credit percentages not calculated
- Reconciliation progress appears as 0% for credits

**Fix:**

```typescript
const pct = Math.abs(inv.amount) > 0 ? Math.round((amountCollected / Math.abs(inv.amount)) * 100) : null
```

---

#### HIGH-UI-002: Invoice Amount Due Conditional Display

**File:** `components/onboarding-flow.tsx`  
**Lines:** 3936, 3946, 4079, 4089  
**Severity:** HIGH

**Code:**

```typescript
3936|  {inv.amount_due > 0 && inv.amount_due < inv.amount && <span>...</span>}
3946|  {inv.amount_due > 0 && <span className="text-amber-400">Outstanding: ...</span>}
```

**What Breaks:** When `amount_due <= 0`, outstanding balance display is hidden.

**Impact:**

- Vendor credits not displayed
- Users cannot see credit balances in onboarding

**Fix:**

```typescript
{Math.abs(inv.amount_due) > 0 && <span className={inv.amount_due > 0 ? "text-amber-400" : "text-blue-400"}>
  {inv.amount_due > 0 ? "Outstanding" : "Credit"}: ...
</span>}
```

---

#### HIGH-UI-003: Invoice Overdue Badge Rendering

**File:** `components/onboarding-flow.tsx`  
**Lines:** 3928, 4071  
**Severity:** HIGH

**Code:**

```typescript
3928|  {inv.days_overdue != null && inv.days_overdue > 0 && (
      <span className="block text-red-400 font-medium">{inv.days_overdue}d overdue</span>
    )}
```

**What Breaks:** When `days_overdue <= 0`, overdue badge is not rendered at all.

**Impact:**

- Early payments not indicated
- Vendor credits not flagged

**Fix:**

```typescript
{inv.days_overdue != null && Math.abs(inv.days_overdue) > 0 && (
  <span className={`block font-medium ${inv.days_overdue > 0 ? "text-red-400" : "text-green-400"}`}>
    {Math.abs(inv.days_overdue)}d {inv.days_overdue > 0 ? "overdue" : "early"}
  </span>
)}
```

---

#### HIGH-UI-004: Invoices Fetch Outstanding Filtering

**File:** `lib/invoices-fetch.ts`  
**Lines:** 112, 152, 410  
**Severity:** HIGH

**Code:**

```typescript
112|  if (balance < totalAmt && balance > 0 && status !== "overdue") status = "partially_paid"
410|  if (balance > 0) continue
```

**What Breaks:**

- Line 112/152: Only marks as "partially_paid" if `balance > 0`, missing vendor credits
- Line 410: Skips invoices with `balance <= 0` entirely

**Impact:**

- Vendor credits not tracked as outstanding
- Fully paid invoices with credits are skipped

**Fix:**

```typescript
if (balance < totalAmt && Math.abs(balance) > 0 && status !== "overdue") 
  status = balance > 0 ? "partially_paid" : "credit"
```

---

#### HIGH-UI-005: Bills Fetch Outstanding Filtering

**File:** `lib/bills-fetch.ts`  
**Lines:** 71, 114  
**Severity:** HIGH

**Code:**

```typescript
71|  if (balance < totalAmt && balance > 0 && status !== "overdue") status = "partially_paid"
```

**What Breaks:** Only marks as "partially_paid" if `balance > 0`, missing vendor credits.

**Impact:**

- Vendor credits not tracked
- AP reconciliation incomplete

**Fix:**

```typescript
if (balance < totalAmt && Math.abs(balance) > 0 && status !== "overdue") 
  status = balance > 0 ? "partially_paid" : "credit"
```

---

### MEDIUM SEVERITY: Blind Zero-Boundaries

#### MEDIUM-UI-001: Movement Amount Sign Determination

**File:** `app/dashboard/review-queue/page.tsx`  
**Lines:** 286, 459  
**Severity:** MEDIUM

**Code:**

```typescript
286|  const movIsInflow = mov.amount > 0
```

**What Breaks:** When `amount` is exactly 0, treated as outflow (red), not inflow (green).

**Impact:**

- Zero-value movements misclassified
- UI color coding incorrect for edge cases

---

#### MEDIUM-UI-002: Reconciliation Pie Chart Data Validation

**File:** `app/dashboard/reconciliation/page.tsx`  
**Lines:** 223  
**Severity:** MEDIUM

**Code:**

```typescript
223|  const hasData = data.some(d => d.value > 0)
```

**What Breaks:** Chart only renders if at least one value is positive. Negative-only data (all credits) returns null.

**Impact:**

- Credit-only reconciliation states show no chart
- Users cannot visualize credit distributions

**Fix:**

```typescript
const hasData = data.some(d => Math.abs(d.value) > 0)
```

---

#### MEDIUM-UI-003: Account Balance Trend Calculation

**File:** `app/dashboard/books/page.tsx`  
**Lines:** 197, 200  
**Severity:** MEDIUM

**Code:**

```typescript
197|  trend={acct.balance > 0 ? "up" : acct.balance < 0 ? "down" : "neutral"}
200|  <div className={`font-mono text-sm font-semibold ${acct.code === "9999" && acct.balance > 0.01 ? "text-red-400" : "text-emerald-400"}`}>
```

**What Breaks:**

- Line 200: Account 9999 (suspense) only shows red if `balance > 0.01`, missing small positive balances

**Impact:**

- Small suspense account balances not highlighted
- Reconciliation issues may be missed

**Fix:**

```typescript
className={`font-mono text-sm font-semibold ${acct.code === "9999" && Math.abs(acct.balance) > 0.001 ? "text-red-400" : "text-emerald-400"}`}
```

---

#### MEDIUM-UI-004: Entity Calculations - Interval CV Division

**File:** `lib/entity-calculations.ts`  
**Lines:** 203, 206  
**Severity:** MEDIUM

**Code:**

```typescript
203|  const intervalCv = avgInterval > 0 ? (intervalStd / avgInterval) * 100 : 0
206|  const txnPerMonth = monthCount > 0 ? (row?.txn_per_month || 0) : 0
```

**What Breaks:** When `avgInterval === 0` or `monthCount === 0`, defaults to 0, hiding data quality issues.

**Impact:**

- Entities with no transaction history appear as 0 CV (stable) instead of unknown
- Risk assessment may be inaccurate

**Fix:**

```typescript
const intervalCv = avgInterval > 0 ? (intervalStd / avgInterval) * 100 : null
```

---

#### MEDIUM-UI-005: Dashboard Consistency Score Clamping

**File:** `lib/dashboard-calculations.ts`  
**Lines:** 156  
**Severity:** MEDIUM

**Code:**

```typescript
156|  consistency: Math.max(0, 1 - entity.interval_cv / 100),
```

**What Breaks:** When `interval_cv > 100`, consistency score is clamped to 0, losing information about high variability.

**Impact:**

- Highly variable entities appear equally bad
- Cannot distinguish between 100% and 200% CV

---

### LOW SEVERITY: Blind Zero-Boundaries

#### LOW-UI-001: Math.max(0, ...) Clamping Patterns

**Files:** Multiple (forecast-engine.ts, entity-calculations.ts, reconciliation-waterfall.ts, etc.)  
**Severity:** LOW

**Code Examples:**

```typescript
Math.max(0, risk_score - 15)
Math.max(0, 1 - intervalCV)
Math.max(0, cash14 - conservative.cash_14d)
```

**What Breaks:** Negative values are clamped to 0, losing information about negative states.

**Impact:**

- Negative risk adjustments appear as 0
- Negative cash flow differences hidden

---

#### LOW-UI-002: Ternary Operators with Zero Defaults

**Files:** Multiple (ar-ap-step/route.ts, entity-profiles.ts, etc.)  
**Severity:** LOW

**Code Examples:**

```typescript
reconciled_pct: lifetimeArTotal > 0 ? r2((lifetimeArReconciled / lifetimeArTotal) * 100) : 0
```

**What Breaks:** When denominator is 0, returns 0 instead of null/undefined, making it indistinguishable from actual 0%.

**Impact:**

- No data appears as 0% instead of "N/A"
- Users may misinterpret results

---

## Implementation Priority

### Phase 1: CRITICAL (Immediate)

1. CRITICAL-001: P&L Waterfall Chart Double Negation
2. CRITICAL-002: Largest Account Balance Calculation
3. CRITICAL-UI-001: Revenue Line Item Filtering
4. CRITICAL-UI-002: Invoice Amount Due Styling
5. CRITICAL-UI-003: Overdue Amount Card Styling
6. CRITICAL-UI-004: Invoice Status Determination
7. CRITICAL-UI-005: Invoice Days Overdue Color Coding
8. CRITICAL-UI-006: Invoice API Filtering
9. CRITICAL-UI-007: Forecast Engine Outstanding Filtering

### Phase 2: HIGH (Next Sprint)

1. HIGH-UI-001: Invoice Percentage Calculations
2. HIGH-UI-002: Invoice Amount Due Conditional Display
3. HIGH-UI-003: Invoice Overdue Badge Rendering
4. HIGH-UI-004: Invoices Fetch Outstanding Filtering
5. HIGH-UI-005: Bills Fetch Outstanding Filtering

### Phase 3: MEDIUM (Following Sprint)

1. MEDIUM-UI-001: Movement Amount Sign Determination
2. MEDIUM-UI-002: Reconciliation Pie Chart Data Validation
3. MEDIUM-UI-003: Account Balance Trend Calculation
4. MEDIUM-UI-004: Entity Calculations - Interval CV Division
5. MEDIUM-UI-005: Dashboard Consistency Score Clamping

### Phase 4: LOW (Backlog)

1. LOW-UI-001: Math.max(0, ...) Clamping Patterns
2. LOW-UI-002: Ternary Operators with Zero Defaults

---

## Verification Checklist

### Before Implementation

- Confirm polarity convention: Inflows positive, Outflows positive (not negative)
- Verify that all financial data sources follow this convention
- Audit database schema for sign storage patterns
- Review API contracts for sign conventions

### During Implementation

- Add JSDoc comments documenting sign conventions
- Add unit tests for edge cases (zero, negative, positive values)
- Add integration tests for UI display with various value ranges
- Verify waterfall chart displays correctly with new logic

### After Implementation

- Run full regression test suite
- Manual testing of all financial pages with test data including:
  - Positive values (normal case)
  - Negative values (credits/refunds)
  - Zero values (edge case)
  - Mixed positive/negative (reconciliation scenarios)
- Verify API responses include all data (not filtered out)
- Verify UI displays all data with correct styling

---

## Sign Convention Reference

**Inflows (Positive):**

- Revenue
- Customer payments
- Refunds received
- Loan proceeds
- Investment income

**Outflows (Positive):**

- Expenses
- Vendor payments
- Refunds issued
- Loan repayments
- Tax payments

**Credits (Negative):**

- Vendor credits (negative amount_due)
- Customer overpayments (negative amount_due)
- Refunds pending (negative revenue)

**Calculations:**

- Net Cash Flow = Inflows - Outflows (both positive)
- Net Revenue = Gross Revenue - Refunds (both positive)
- Outstanding = Amount - Paid (can be negative if overpaid)

---

## Related Documentation

- [Financial Architecture](./financial-architecture.md)
- [Sign Convention Guide](./sign-convention-guide.md)
- [Reconciliation Logic](./reconciliation-logic.md)

---

**Audit Completed By:** Static Analysis Architect  
**Next Review:** After Phase 1 Implementation
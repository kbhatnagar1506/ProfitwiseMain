# Profitwise: Full Concept Check Report

**Post–Raw Data: Every Step, Calculation, and Detail**

---

## Table of Contents

1. [Raw Data Sources](#1-raw-data-sources)
2. [Movement Classification Pipeline](#2-movement-classification-pipeline)
3. [Movement Tagging Pipeline](#3-movement-tagging-pipeline)
4. [Reconciliation Pipeline](#4-reconciliation-pipeline)
5. [Cash Explanation Computation](#5-cash-explanation-computation)
6. [Entity Payment Memory](#6-entity-payment-memory)
7. [Merchant Deposit Pipeline](#7-merchant-deposit-pipeline)
8. [Thresholds & Constants Reference](#8-thresholds--constants-reference)

---

## 1. Raw Data Sources

### 1.1 Bank (Plaid)
- **Table**: `plaid_transactions` (or equivalent)
- **Fields used**: `date`, `amount`, `name`, `merchant_name`, `category`, `personal_finance_category`, `payment_channel`, `account_id`
- **Normalization**: amount positive = inflow, negative = outflow

### 1.2 Accounting (QBO, Xero)
- **Invoices**: `qbo_entities` / `xero_entities` where `entity_type = 'Invoice'`
- **Bills**: same tables, `entity_type = 'Bill'`
- **Fields**: Balance/AmountDue, TotalAmt/Total, CustomerRef/Contact, DueDate, VendorRef

### 1.3 Stripe
- **Entities**: `stripe_entities` (entity_type: customer, invoice, subscription, payment_intent, payout, balance_transaction)
- **Payout fee**: When syncing payouts, uses `expand[]=data.balance_transaction`; copies `fee` (cents) from balance_transaction into payout data
- **File**: `lib/stripe-sync.ts`

### 1.4 Gmail
- Invoice emails parsed for AR/AP

---

## 2. Movement Classification Pipeline

**Trigger**: `POST /api/movements/classify`  
**File**: `lib/movement-classify.ts`

### 2.1 Pipeline Steps (Overview)

| Step | Name | Purpose |
|------|------|---------|
| 1 | Extract source observations | Plaid, QBO, Stripe, Xero → SourceObservation[] |
| 2 | Coalesce | Cross-source dedup (date-window matching) |
| 2b | Pair Plaid transfers | Cross-account transfer pairing |
| 3 | Resolve accounts | Map account IDs |
| 4 | Resolve counterparty identity | Entity graph, alias normalization |
| 5 | Classify non-P&L | Transfers, settlements, fees, equity, financing |
| 6 | Classify operating | Customer, vendor, refund, interest |
| 6b | Provisional classes | merchant_deposit_unresolved, owner_contribution_candidate |
| 7 | Fallback | unknown_inflow, unknown_outflow, unknown_transfer_candidate, review_candidate_revenue |
| 7b | Family-level learning | Recurring pattern recognition |
| 8 | LLM assist | Low-confidence upgrade |
| 8b | Direction/type consistency | Validate inflow vs outflow types |
| 9 | Batch persist | Write to movements + metadata |

### 2.2 Movement Type Taxonomy

**Non-P&L**: `internal_transfer`, `processor_payout`, `credit_card_payment`, `loan_funding`, `loan_principal_payment`, `owner_contribution`, `owner_draw`, `account_verification`, `opening_balance`, `balance_adjustment`, `merchant_deposit_resolved`

**P&L**: `cash_in_customer`, `cash_out_vendor`, `cash_out_operating_expense`, `processor_fee_settlement`, `cash_out_refund`, `cash_in_refund`, `cash_in_interest`, `cash_out_interest`, `cash_out_bank_fee`, `bank_fee_refund`, `cash_out_payroll`, `cash_out_tax`, `other_operating`

**Provisional**: `merchant_deposit_unresolved`, `owner_contribution_candidate`

**Fallback**: `unknown_inflow`, `unknown_outflow`, `unknown_transfer_candidate`, `review_candidate_revenue`

### 2.3 Confidence Computation

**File**: `lib/movement-classify.ts` — `computeConfidence(signals, movementSeed)`

#### 2.3.1 Input Signals

| Signal | Range | Meaning |
|--------|-------|---------|
| `entity_confidence` | 0–1 or -1 | Identity resolution quality (-1 = N/A) |
| `account_resolution` | 0–1 | How well we know the cash account |
| `pattern_strength` | 0–1 | Description pattern match strength |
| `source_authority` | 0–1 | Trust of primary source |
| `source_agreement` | 0–1 or -1 | Cross-source agreement (-1 = single source) |
| `history` | 0–1 or -1 | Family/recurring pattern strength |
| `directional_consistency` | 0–1 | Direction matches type |

#### 2.3.2 Source Authority (by source)

| Source | Authority |
|--------|-----------|
| plaid | 0.90 |
| stripe | 0.90 |
| qbo | 0.80 |
| xero | 0.80 |
| email | 0.40 |

#### 2.3.3 Classification Confidence Formula

```
signalEntries = [
  { value: pattern_strength, weight: 0.25 },
  { value: account_resolution, weight: 0.15 },
  { value: source_authority, weight: 0.20 },
  { value: directional_consistency, weight: 0.10 },
  { value: entity_confidence, weight: 0.15 }  // only if e >= 0
  { value: source_agreement, weight: 0.10 }   // only if s >= 0
  { value: history, weight: 0.05 }            // only if h >= 0
]
totalWeight = sum(weights of present signals)
classificationConfidence = min(1, max(0, sum(value * weight / totalWeight)))
// Add deterministic jitter ±4% via movementSeed
classificationConfidence += deterministicJitter(movementSeed, 0.04)
```

#### 2.3.4 Evidence Strength Formula

```
evidenceStrength = min(1, max(0,
  (entity_confidence >= 0 ? entity_confidence : 0) * 0.20 +
  account_resolution * 0.15 +
  (source_agreement >= 0 ? source_agreement : 0) * 0.30 +
  (history >= 0 ? history : 0) * 0.20 +
  source_authority * 0.05 +
  directional_consistency * 0.10
))
// Add jitter ±5% via movementSeed + "ev"
```

### 2.4 Review Flags

| Condition | review_reasons added |
|-----------|----------------------|
| `conf.score < 0.55` | `weak_classification` |
| `conf.evidence_strength < 0.20` | `low_evidence` |
| Provisional class | `provisional_classification` |
| Fallback class | `weak_classification` |
| LLM upgraded | `llm_fallback` |
| Direction/type mismatch | `direction_type_mismatch` |
| Owner vs processor collision | `owner_vs_processor_conflict` |

### 2.5 Direction/Type Consistency

- **Inflow types**: cash_in_customer, cash_in_refund, cash_in_interest, bank_fee_refund, loan_funding, owner_contribution, owner_contribution_candidate, merchant_deposit_*, unknown_inflow, review_candidate_revenue
- **Outflow types**: cash_out_vendor, cash_out_operating_expense, cash_out_refund, cash_out_bank_fee, cash_out_payroll, cash_out_tax, cash_out_interest, credit_card_payment, loan_principal_payment, owner_draw, unknown_outflow
- If `direction === "inflow"` but type is outflow-only → `review_needed`, `direction_type_mismatch`, pattern_strength capped at 0.3

### 2.6 Persist Output

- **movements** table: id, user_id, date, direction, amount, counterparty, counterparty_entity_id, raw_description, etc.
- **metadata**: `review_reasons`, `classification_rule_version`
- **movement_tags**: populated by separate tagging pipeline (see §3)

---

## 3. Movement Tagging Pipeline

**Trigger**: `POST /api/movements/tag` (after classify)  
**File**: `lib/movement-tag-enrich.ts`

### 3.1 Purpose

Maps internal `movement_type` → public `movement_class` and adds `economic_class`, `cashflow_bucket`, `counterparty_role`, policy flags.

### 3.2 Internal Type → Movement Class

| Internal Type | Movement Class |
|---------------|----------------|
| cash_in_customer | customer_cash_in |
| cash_out_vendor, cash_out_operating_expense, cash_out_payroll, cash_out_tax | vendor_cash_out |
| internal_transfer | internal_transfer |
| processor_fee_settlement | processor_fee |
| processor_payout | processor_payout |
| owner_contribution, owner_contribution_candidate | owner_contribution |
| owner_draw | owner_draw |
| credit_card_payment | credit_card_payment |
| cash_out_bank_fee | bank_fee |
| bank_fee_refund | bank_fee_refund |
| cash_in_refund, cash_out_refund | refund |
| cash_in_interest, cash_out_interest | interest |
| opening_balance, balance_adjustment, account_verification | opening_balance |
| merchant_deposit_unresolved, merchant_deposit_resolved | merchant_deposit |
| unknown_inflow, unknown_outflow, unknown_transfer_candidate, review_candidate_revenue | unknown |

### 3.3 Economic Class (from tag engine)

Used for reconciliation filtering. Key mappings:
- `customer_receipt` → AR_COLLECTION
- `vendor_payment`, `payroll`, `debt_payment`, `tax` → AP_PAYMENT
- `processor_payout`, `settlement_in` → PROCESSOR_SETTLEMENT
- `transfer` → INTERNAL_TRANSFER
- etc.

### 3.4 Policy Status

| Condition | policy_status |
|-----------|---------------|
| transfer + cross_account | included |
| economic_class === unknown | unresolved |
| synthetic label OR owner vs processor collision OR exclude_and_review | excluded_for_review |
| else | included |

### 3.5 Settlement Subtype

- `settlement` + merchant_adjustment → `settlement_adjustment`, `economic_class: settlement_adjustment`
- `settlement` else → `economic_class: settlement_in`

---

## 4. Reconciliation Pipeline

**Trigger**: `GET /api/ar-ap-reconciliation`  
**Files**: `lib/reconciliation-run.ts`, `app/api/ar-ap-reconciliation/route.ts`

### 4.1 Cache & Job Flow

1. Check `reconciliation_cache` for (user_id, ar_ap_only, merchant_only)
2. If status = ready and age < 300s → return cached data
3. If status = processing → return `{ status: "processing" }` (client polls)
4. Else: set status = processing, start `runReconciliationJob` in background
5. On success: set status = ready, data = result
6. On error: set status = error, error_message

### 4.2 Job Inputs

- **Movements**: `SELECT id, direction, amount, date, counterparty, counterparty_entity_id, raw_description FROM movements WHERE user_id = $1 AND duplicate_of IS NULL`
- **Movement tags**: `SELECT movement_id, economic_class FROM movement_tags` → `economicClassByMovement`
- **Allocations**: `getAllocationsForUser(userId)`
- **Invoices**: `fetchInvoicesForReconciliation(userId)` (QBO, Xero, Stripe, Gmail outstanding)
- **Bills**: `fetchOutstandingBills(userId)`
- **Entity profiles**: `computeEntityPaymentProfiles(userId)`

### 4.3 AR Matching (Inflows → Invoices)

**File**: `lib/ar-payment-match.ts`

#### 4.3.1 Match Criteria (ALL must pass)

| Criterion | Rule |
|-----------|------|
| Entity/Name | `payment.entity_id === invoice.entity_id` OR `namesMatch(counterparty, customer_name)` |
| Amount | `payment.amount / invoice.amount_due` in [0.95, 1.05] (±5%) |
| Date | `|daysBetween(payment.date, invoice.due_date)|` ≤ 45 |

#### 4.3.2 Name Match (fuzzy)

```
normalize(s) = s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim()
namesMatch(a, b) = 
  normalize(a) === normalize(b) OR
  one contains the other OR
  token overlap >= min(|tokensA|, |tokensB|, 2)
```

#### 4.3.3 Confidence Formula (AR)

```
ratio = payment.amount / invoice.amount_due
amountMatch = 1 - |ratio - 1|
dateMatch = 1 - (diffDays / 45)
entityScore = entityMatch ? 1 : nameMatch ? 0.85 : 0.5
confidence = (amountMatch + dateMatch + entityScore) / 3
```

#### 4.3.4 Entity Payment Memory Boost

If `entityProfiles` provided and invoice has profile:
```
entityUri = invoice.entity_uri ?? toEntityUriAr(source, invoice_id)
avgRatio = profiles.get(entityUri)?.avg_payment_ratio ?? 1
if avgRatio !== 1 AND |ratio - avgRatio| < 0.02:
  confidence = min(1, confidence + 0.05)
```

#### 4.3.5 Match Method

- `exact`: ratio in [0.99, 1.01] AND diffDays ≤ 3
- `tolerance`: else

#### 4.3.6 Actions by Confidence

| Confidence | Action |
|------------|--------|
| ≥ 0.78 | Auto-allocate (AR + fee if inferred) |
| [0.65, 0.78) | Add to ar_suggestions |
| < 0.65 | No match |

#### 4.3.7 Allocation Semantics (AR)

- **AR allocation**: `gross_applied = invoice.amount_due`, `fee_amount = 0`, `net_applied = gross_applied` (invoice satisfied)
- **Fee allocation** (if fee > 0): `gross_applied = 0`, `fee_amount = fee`, `net_applied = -fee`
- **Sum**: AR net + Fee net = movement amount

### 4.4 AP Matching (Outflows → Bills)

**File**: `lib/ap-llm-match.ts`

#### 4.4.1 Obligations

- From `computeAPStateFromBills(bills)` → `APObligation[]`
- `obligation_id = toEntityUriApBill(source, bill_id)` e.g. `ap://bill/qbo/123`

#### 4.4.2 Match Criteria (ALL must pass)

| Criterion | Rule |
|-----------|------|
| Amount | `payment.amount / obligation.amount_due` in [0.95, 1.05] |
| Date | `|payDate - dueDate| / 86400000` ≤ 14 days |
| Entity/Name | entity_id match OR namesMatch(counterparty, vendor_name) |

#### 4.4.3 Confidence Formula (AP)

```
amountMatch = 1 - |amountRatio - 1|
dateMatch = 1 - (diffDays / 14)
entityScore = entityMatch ? 1 : nameMatch ? 0.85 : 0.5
confidence = (amountMatch + dateMatch + entityScore) / 3
```

#### 4.4.4 Deterministic Threshold

- `DETERMINISTIC_THRESHOLD = 0.8` (AP requires 80% to be considered; reconciliation uses 0.78 for auto-allocate)

#### 4.4.5 Actions by Confidence

| Confidence | Action |
|------------|--------|
| ≥ 0.78 | Auto-allocate |
| [0.65, 0.78) | Add to ap_suggestions |
| < 0.65 | No match |

### 4.5 AR/AP Filtering (arApOnly)

When `arApOnly = true`, only movements with `payment_class` in {AR_COLLECTION, AP_PAYMENT, PROCESSOR_SETTLEMENT} are included in the result.  
`payment_class = getPaymentClass(economic_class)`.

### 4.6 Merchant Deposit Pipeline (when arApOnly = false)

See §7.

---

## 5. Cash Explanation Computation

**File**: `lib/reconciliation-run.ts` (lines ~387–425)

### 5.1 Per-Movement Logic

For each movement:
```
amount = |movement.amount|
allocs = allocations for this movement
allocSum = sum(allocs.net_applied)
diff = |amount - |allocSum||
```

| Condition | Category | Running total |
|-----------|----------|---------------|
| allocs.length === 0 | unexplained | unexplained += amount |
| diff ≤ 0.01 * amount OR diff ≤ 0.01 | fully_explained | fullyExplained += amount |
| else | partially_explained | partiallyExplained += amount |

### 5.2 Breakdown (for fully explained only)

For each allocation on a fully-explained movement:
```
if entity_type === "ar": arExplained += net_applied
if entity_type === "ap": apExplained += net_applied
if entity_type === "fee": feeExplained += |net_applied|
```

### 5.3 Final Metrics

```
totalCash = fullyExplained + partiallyExplained + unexplained
explanation_pct = totalCash > 0 ? (fullyExplained / totalCash) * 100 : 100
```

---

## 6. Entity Payment Memory

**File**: `lib/entity-payment-profiles.ts`

### 6.1 Compute Profiles

1. Load all allocations for user
2. For each AR allocation with `gross_applied > 0`:
   - `ratio = net_applied / gross_applied`
   - Group by `entity_id`, collect ratios
3. For entities with ≥ 2 ratios:
   - `avg = mean(ratios)`
   - `variance = mean((r - avg)^2)`
   - Store `{ entity_id, avg_payment_ratio: avg, payment_count, variance }`

### 6.2 Usage

- `getEntityPaymentRatio(profiles, entityUri)` returns `avg_payment_ratio` or 1 if no profile
- Used in AR matching: if `|ratio - avgRatio| < 0.02`, boost confidence by 0.05

---

## 7. Merchant Deposit Pipeline

**File**: `lib/merchant-deposit-pipeline.ts`

### 7.1 When It Runs

- Only when `arApOnly = false`
- After AR/AP matching
- On still-unmatched inflows

### 7.2 Filter Merchant Deposits

```
economic_class = movement_tags.economic_class for movement
payment_class = getPaymentClass(economic_class)
if payment_class === "PROCESSOR_SETTLEMENT" → include
```

### 7.3 Processor Detection

- `processor_payout` or `settlement_in` → Stripe (or Shopify if economic_class = shopify_payout)
- Currently only Stripe is supported for payout matching

### 7.4 Payout Match

For each deposit, find Stripe payout where:
- `|payoutAmount - depAmount| / max(depAmount, 1) ≤ 0.02` (±2%)
- `|payoutDate - depDate| ≤ 86400000` (±1 day)
- status in {paid, in_transit}

Payout amount from `data.amount / 100` (cents → dollars).  
Fee from `data.fee` (cents) / 100 if present (from Stripe sync expand).

### 7.5 Allocations Created

1. **AR (synthetic)**:
   - `entity_id = ar://invoice/synthetic/stripe_settlement/{payout_id}`
   - `gross_applied = amount + fee` (or amount if no fee)
   - `fee_amount = 0`, `net_applied = amount`
   - `match_method = "stripe_payout_match"`, `synthetic_invoice = true`

2. **Fee** (if fee > 0):
   - `entity_id = fee://stripe`
   - `gross_applied = 0`, `fee_amount = fee`, `net_applied = -fee`

---

## 8. Thresholds & Constants Reference

### 8.1 Reconciliation

| Constant | Value | Meaning |
|----------|-------|---------|
| AUTO_ALLOCATE_CONFIDENCE | 0.78 | Auto-allocate AR/AP when match ≥ 78% |
| SUGGEST_CONFIDENCE_MIN | 0.65 | Show suggestion when 65–78% |
| AR AMOUNT_TOLERANCE_PCT | 0.05 | ±5% |
| AR_DATE_TOLERANCE_DAYS | 45 | ±45 days |
| AP AMOUNT_TOLERANCE_PCT | 0.05 | ±5% |
| AP DATE_TOLERANCE_DAYS | 14 | ±14 days |
| Merchant AMOUNT_TOLERANCE | 0.02 | ±2% |
| Merchant DATE_TOLERANCE_MS | 86400000 | ±1 day |
| Cash explanation EPSILON | 0.01 | 1% or $0.01 diff for fully explained |

### 8.2 AR Matching (internal)

| Constant | Value |
|----------|-------|
| DETERMINISTIC_THRESHOLD | 0.7 (min to consider) |
| PROFILE_RATIO_TOLERANCE | 0.02 |
| PROFILE_CONFIDENCE_BOOST | 0.05 |

### 8.3 AP Matching (internal)

| Constant | Value |
|----------|-------|
| DETERMINISTIC_THRESHOLD | 0.8 |

### 8.4 Classification

| Constant | Value |
|----------|-------|
| weak_classification | score < 0.55 |
| low_evidence | evidence_strength < 0.20 |
| needs_llm | score < 0.6 (for rule/provisional) |

### 8.5 Cache

| Constant | Value |
|----------|-------|
| CACHE_FRESH_SEC | 300 (5 min) |

---

## 9. Entity URIs

| Type | Format | Example |
|------|--------|---------|
| AR invoice | ar://invoice/{source}/{id} | ar://invoice/stripe/inv_xxx |
| AR synthetic | ar://invoice/synthetic/stripe_settlement/{payout_id} | ar://invoice/synthetic/stripe_settlement/po_xxx |
| AP bill | ap://bill/{source}/{id} | ap://bill/qbo/123 |
| AP inferred | ap://inferred/{entity_id}/{date} | ap://inferred/ent_xxx/2026-03-15 |
| Fee | fee://{processor} | fee://stripe |

---

## 10. Data Flow Summary

```
Raw Data (Plaid, QBO, Xero, Stripe, Gmail)
    ↓
Movement Classify (extract → coalesce → identity → classify → LLM → persist)
    ↓
movements table + metadata (movement_type, confidence, review_reasons)
    ↓
Movement Tag (economic_class, cashflow_bucket, policy_status)
    ↓
movement_tags table
    ↓
Reconciliation Job
    ├── Load movements, allocations, invoices, bills, entity profiles
    ├── AR match (inflows) → auto-allocate ≥78%, suggest 65–78%
    ├── AP match (outflows) → auto-allocate ≥78%, suggest 65–78%
    ├── Merchant deposit pipeline (if !arApOnly) → Stripe payout match
    └── Cash explanation (fully/partially/unexplained, AR/AP/fee breakdown)
    ↓
reconciliation_cache (status, data)
    ↓
UI: Cash Explanation, Suggested matches, Payments table, Link modal
```

---

*End of report. For implementation details, see the referenced source files.*

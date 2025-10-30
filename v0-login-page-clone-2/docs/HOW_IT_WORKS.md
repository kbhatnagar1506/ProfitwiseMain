# How Profitwise Works — End-to-End

This document describes the full flow from data ingestion through reconciliation to the UI.

---

## 1. Data Ingestion

### Bank movements
- **Plaid**: Transactions synced from connected bank accounts → `movements` table
- **QuickBooks / Xero**: Invoices and bills synced via OAuth
- **Stripe**: Invoices, payouts, balance_transactions synced
- **Gmail**: Invoice emails parsed for AR/AP

### Stripe payout fee extraction
When syncing Stripe payouts (`lib/stripe-sync.ts`):
- Fetches payouts with `expand[]=data.balance_transaction`
- Copies `fee` (cents) from balance_transaction into payout data
- Merchant deposit pipeline reads this fee for fee allocations

---

## 2. Movement Classification

### Tagging (`/api/movements/tag`)
- Each movement gets an `economic_class` (e.g. `processor_payout`, `customer_cash_in`, `vendor_cash_out`, `unknown`)
- Stored in `movement_tags`
- Used to filter AR/AP vs all payments, and to detect merchant deposits

### Classification (`/api/movements/classify`)
- Assigns `movement_class`, `confidence`, `evidence_strength`, `needs_review`, `review_reasons`
- `needs_review` = true when confidence low or evidence weak
- `review_reasons`: `low_evidence`, `llm_fallback`, `weak_classification`, `owner_vs_processor_conflict`, etc.

---

## 3. Reconciliation Job

**Trigger**: `GET /api/ar-ap-reconciliation` (or with `?arApOnly=false` for full run)

**Flow**:
1. Check `reconciliation_cache` — if fresh (< 5 min), return cached result
2. If stale or missing: set status `processing`, start background job
3. Client polls every 2s until status `ready`
4. Job writes result to cache

### Job steps (`lib/reconciliation-run.ts`)

#### 3.1 Load data
- Movements (bank transactions)
- **Attributions** (`movement_attributions`) — canonical per-movement decomposition (AR/AP/fee/transfer/settlement/unknown). The allocation API reads/writes this table; legacy `movement_allocations` is no longer written.
- Invoices (AR from QBO, Xero, Stripe, Gmail)
- Bills (AP from QBO, Xero, Gmail)
- Entity payment profiles (for AR confidence boost)

**Attribution engine** (`lib/attribution-engine.ts`): ordered passes — AR inflows, AP outflows, merchant settlement (`runMerchantDepositPipeline`). `runReconciliationJob` wraps the engine, builds cache payload, then **syncs `cash_events`** from open invoices + bill obligations and **refreshes entity cash profile** aggregates from attributions.

**Financial brain** (`POST /api/brain`, `lib/financial-brain.ts`): runs attribution + optional cash_events sync + profile refresh in one call.

#### 3.2 AR matching (inflows → invoices)
For each **unmatched inflow**:
- Call `matchARPayment(payment, invoices, entityProfiles)`
- **Match criteria** (all must pass):
  - Entity/name: counterparty matches invoice customer (exact entity_id or fuzzy name)
  - Amount: payment within ±5% of invoice amount_due
  - Date: payment within ±45 days of invoice due date
- **Confidence** = (amountMatch + dateMatch + entityScore) / 3
- **Entity payment memory**: If invoice has profile and payment ratio matches `avg_payment_ratio`, boost confidence +0.05

**Actions**:
- **≥ 78%**: Auto-allocate (create AR allocation; if fee inferred, create fee allocation)
- **65–78%**: Add to `ar_suggestions` (user applies manually)
- **< 65%**: No match

#### 3.3 AP matching (outflows → bills)
For each **unmatched outflow**:
- Obligations from `computeAPStateFromBills(bills)`
- Call `matchAPPayment(payment, obligations)`
- **Match criteria**: amount ±5%, date ±14 days, entity/name match
- **≥ 78%**: Auto-allocate
- **65–78%**: Add to `ap_suggestions`
- **< 65%**: No match

#### 3.4 Merchant deposit pipeline (when `arApOnly=false`)
- Filter inflows with `economic_class` = processor_payout / settlement_in
- Match to Stripe payouts (amount ±2%, date ±1 day)
- Create synthetic AR allocation (`ar://invoice/synthetic/stripe_settlement/{payout_id}`)
- If payout has `fee` in data, create fee allocation

#### 3.5 Build result
- Matched vs unmatched inflows/outflows
- Cash explanation (fully/partially/unexplained, AR/AP/fee breakdown)
- `ar_suggestions`, `ap_suggestions`

---

## 4. Cash Explanation

**Definition**:
- **Fully explained**: Bank movement with allocations that sum to movement amount
- **Partially explained**: Allocations exist but don’t fully cover amount
- **Unexplained**: No allocations

**Breakdown**:
- **AR reconciled**: Sum of AR allocation amounts on fully-explained movements
- **AP reconciled**: Sum of AP allocation amounts
- **Fees**: Sum of fee allocation amounts

**Formula**: `explanation_pct` = fully_explained / (fully + partially + unexplained)

---

## 5. Reconciliation UI (`/reconciliation`)

### Cash Explanation cards
- Fully explained, Partially explained, Unexplained, Explanation %
- AR reconciled, AP reconciled, Fees (breakdown row)

### Suggested matches (65–78%)
- Section: "Suggested matches (65–85% confidence)"
- Each: amount → customer/vendor, confidence %, **Apply** button
- Apply → `POST /api/ar-match` or `POST /api/ap-match` with `invoice_id` / `obligation_id`
- On success: refresh reconciliation

### Payments table
- Matched (with allocations) vs Unmatched
- Filter: All / Matched / Unmatched
- Toggle: AR/AP only / All payments
- **Link** on unmatched → fetch suggestions, user picks match

### LLM suggestions
- When unmatched exist, `POST /api/ar-ap-reconciliation/llm-match` runs
- Modal with LLM-suggested AR/AP matches
- Apply → same ar-match / ap-match APIs

---

## 6. Money Movements & Review Queue (Onboarding Step 10)

### Review queue
- Shows movements with `needs_review = true`
- Sorted by amount (high-value first)
- Columns: Date, Amount, Counterparty, Class, Flags
- Flags: `low_evidence`, `llm_fallback`, `owner_vs_processor_conflict`, etc.
- Owner vs processor conflicts highlighted

### P&L Eligible
- Customer Cash In, Vendor Cash Out, Bank Fee, Refund, etc.
- Table with full columns

### Non-P&L
- Internal Transfer, Processor Payout, Owner Contribution, etc.

### Removed
- "Unclassified (Needs Review)" section (redundant with Review queue)

---

## 7. Key Thresholds

| Parameter              | Value  | Meaning                                      |
|------------------------|--------|----------------------------------------------|
| AUTO_ALLOCATE_CONFIDENCE | 0.78 | Auto-reconcile when match ≥ 78%              |
| SUGGEST_CONFIDENCE_MIN   | 0.65 | Show as suggestion when 65–78%               |
| AR amount tolerance      | ±5%  | Payment vs invoice                           |
| AR date tolerance        | ±45d | Payment vs invoice due                       |
| AP date tolerance        | ±14d | Payment vs bill due                          |
| Merchant amount tolerance| ±2%  | Bank deposit vs Stripe payout                |
| Merchant date tolerance  | ±1d  | Bank deposit vs Stripe payout                |

---

## 8. Entity URIs

- **AR**: `ar://invoice/{source}/{id}` (e.g. `ar://invoice/stripe/inv_xxx`)
- **AR synthetic**: `ar://invoice/synthetic/stripe_settlement/{payout_id}`
- **AP bill**: `ap://bill/{source}/{id}`
- **AP inferred**: `ap://inferred/{entity_id}/{date}`
- **Fee**: `fee://stripe`, `fee://processor`

---

## 9. API Summary

| Endpoint                         | Method | Purpose                                      |
|----------------------------------|--------|----------------------------------------------|
| `/api/ar-ap-reconciliation`      | GET    | Run/poll reconciliation                      |
| `/api/ar-ap-reconciliation/llm-match` | POST | LLM suggestions for unmatched                |
| `/api/ar-match`                  | POST   | Suggest or confirm AR match                   |
| `/api/ap-match`                  | POST   | Suggest or confirm AP match                  |
| `/api/movements`                 | GET    | List movements                               |
| `/api/movements/tag`             | POST   | Tag movements                                |
| `/api/movements/classify`        | POST   | Classify movements                           |
| `/api/movements/edit`            | POST   | AI bulk edit                                 |

---

## 10. File Map

| File                          | Role                                      |
|-------------------------------|-------------------------------------------|
| `lib/reconciliation-run.ts`   | Main reconciliation job                   |
| `lib/ar-payment-match.ts`    | AR matching + entity payment memory      |
| `lib/ap-llm-match.ts`        | AP matching                               |
| `lib/merchant-deposit-pipeline.ts` | Stripe payout → AR + fee             |
| `lib/entity-payment-profiles.ts`  | Per-entity payment ratio history     |
| `lib/stripe-sync.ts`          | Stripe sync + payout fee extraction       |
| `lib/allocation-persist.ts`   | Create/read allocations                   |
| `app/reconciliation/page.tsx` | Cash Explanation + reconciliation UI      |
| `components/onboarding-flow.tsx` | Money movements + Review queue        |

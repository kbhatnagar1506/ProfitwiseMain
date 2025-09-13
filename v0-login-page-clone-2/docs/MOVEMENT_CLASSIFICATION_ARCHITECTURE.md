# Money Movement Classification Architecture

## Executive Summary

The current classification system conflates **economic event type**, **statement impact**, **cash movement role**, and **review state** into a single `movement_class` field. This creates bad financial truth: wrong labels (owner draw vs contribution), underspecified buckets (Settlement), and mixed semantics (Revenue vs Transfer vs Needs Review).

**The fix**: Separate into four independent axes. Each movement/event answers four distinct questions:

1. **What happened economically?** (event_type)
2. **How did money move mechanically?** (movement_mechanic)
3. **What statement does it affect?** (statement_impact)
4. **How confident are we?** (review_status)

---

## Current State: What’s Wrong

### 1. Single-field taxonomy mixes levels

| Current class | Problem |
|---------------|---------|
| Revenue / Expense | Statement-impact classes |
| Transfer / Settlement | Movement mechanics |
| Refund | Economic event type |
| Fee | Sub-type / cost event |
| Owner Draw | Ownership/equity movement |
| Unresolved inflow | Uncertainty state, not economic class |

One field cannot answer all of these.

### 2. Settlement is underspecified

"Settlement" currently includes:
- Shopify debits → processor fee or reserve
- Chase credit card payments → liability settlement / internal cash movement
- Gateway debits → likely fee expense
- Processor sweeps → payout adjustment

These need distinct treatment.

### 3. Owner Draw vs Owner Contribution

- **Owner Draw**: Money leaving business → owner (debit from business cash)
- **Owner Contribution**: Money entering business ← owner (credit to business cash)

Current data shows +$200 credits labeled "Owner Draw" — that is **Owner Contribution**. The label is wrong.

### 4. Financing vs Interest Income

- **Financing**: Loan proceeds, loan repayments, LOC draws, interest expense on debt
- **Interest Income**: Bank interest credited (e.g. "INTEREST CREDIT Interest Paid +$24.14")

Bank interest is **Other Income / Interest Income**, not financing.

### 5. Owner-related (review) is a garbage bucket

Currently mixes:
- Probable owner transfers
- Zelle-type personal movements
- Test entries
- Actual business income
- Inter-account transfers

Needs split into candidate states: contribution, draw, internal transfer, non-business personal, test/manual artifact.

### 6. Deleted entities in reporting

"Amazon (deleted)", "Google Workspace (deleted)" — QBO returns deleted entity names. Users should see canonical names (Amazon, Google Workspace), not "(deleted)" in financial views.

### 7. Zero-dollar events

Rate changes, QB balance adjustments, etc. should be segregated as:
- Non-posting operational artifact
- Bookkeeping adjustment artifact
- Memo / system event

---

## Target Architecture: Four Axes

### Axis 1: Economic event type (`event_type`)

What happened economically?

| Value | Description |
|-------|-------------|
| `sale` | Customer sale / invoice receipt |
| `purchase` | Vendor purchase / expense |
| `refund` | Refund, credit memo, chargeback |
| `fee` | Fee (bank, processor, platform) |
| `transfer` | Internal transfer between own accounts |
| `owner_contribution` | Owner puts money into business |
| `owner_draw` | Owner takes money out of business |
| `debt_draw` | Loan proceeds, LOC draw |
| `debt_repayment` | Loan repayments |
| `tax_payment` | Tax remittance |
| `payroll` | Employee compensation |
| `processor_settlement` | Processor payout (Shopify/Stripe → bank) |
| `liability_settlement` | Credit card payment, ACH payment to liability |
| `adjustment` | Bookkeeping adjustment |
| `verification` | Micro-deposit, ACCTVERIFY |
| `unknown` | Cannot determine |

### Axis 2: Statement impact (`statement_impact`)

Where does it hit?

| Value | Description |
|-------|-------------|
| `pnl_revenue` | P&L revenue |
| `pnl_expense` | P&L expense |
| `pnl_contra_revenue` | Refund / contra-revenue |
| `pnl_other_income` | Interest income, other income |
| `bs_only` | Balance sheet only (asset/liability movement) |
| `bs_equity` | Equity (owner contribution, draw) |
| `bs_liability_settlement` | Liability payment |
| `non_posting` | Memo, system artifact, no posting |
| `mixed` | Multiple effects |

### Axis 3: Cash movement role (`movement_mechanic`)

What kind of money movement is this mechanically?

| Value | Description |
|-------|-------------|
| `customer_receipt` | Customer payment received |
| `vendor_payout` | Payment to vendor |
| `processor_payout` | Processor payout to bank |
| `processor_debit` | Processor fee, reserve, adjustment |
| `internal_transfer` | Own-account transfer |
| `credit_card_payment` | Credit card / liability payment |
| `bank_fee` | Bank fee, service charge |
| `reserve_adjustment` | Reserve hold/release |
| `reimbursement` | Reimbursement |
| `reversal` | Refund, chargeback |
| `owner_in` | Owner contribution |
| `owner_out` | Owner draw |
| `transfer_in` | Generic transfer in |
| `transfer_out` | Generic transfer out |

### Axis 4: Review state (`review_status`)

How certain are we?

| Value | Description |
|-------|-------------|
| `confirmed` | High confidence, rule or cross-source match |
| `provisional` | Reasonable, may need review |
| `needs_review` | Ambiguous, needs human review |
| `conflicting_evidence` | Sources disagree |
| `excluded` | Excluded from financial statements |

---

## Target UI Buckets

Top-level buckets (derived from axes, not a single field):

### P&L-impacting
- Revenue
- Cost of Goods Sold
- Operating Expense
- Fees
- Refunds / Contra-revenue
- Other Income (interest, etc.)
- Other Expense

### Non-P&L
- Internal Transfers
- Processor Settlements
- Credit Card / Liability Payments
- Owner Contributions
- Owner Draws
- Debt / Financing Movements
- Tax Balance Movements
- Verification / System Artifacts

### Needs Review
- Ambiguous Inflows
- Ambiguous Outflows
- Owner-related Ambiguous
- Identity Conflicts
- Duplicate / Deleted Entity Issues

---

## Schema Changes

### `movements` table

| Column | Current | Target |
|--------|---------|--------|
| `movement_class` | Single catch-all | Deprecated; keep for migration |
| `movement_subclass` | Ad-hoc | Deprecated |
| `statement_impact` | Exists | Keep, refine values |
| `event_type` | — | Add | 
| `movement_mechanic` | — | Add |
| `review_status` | — | Add |
| `canonical_entity_id` | — | Add (FK to entities) |

### Migration

1. Add `event_type`, `movement_mechanic`, `review_status`, `canonical_entity_id` columns.
2. Backfill from `movement_class` + `movement_subclass` using mapping rules.
3. Update classification engine to populate all four axes.
4. Update UI to use axes; keep `movement_class` for backward compatibility until migration complete.

---

## Specific Corrections

### 1. Owner Draw → Owner Contribution

**Rule**: If `amount >= 0` (credit into business) and pattern matches owner transfer (Zelle, Wells Fargo DDA to DDA, etc.) → `event_type: owner_contribution`, `statement_impact: bs_equity`.

### 2. Interest Credit → Other Income

**Rule**: "interest credit", "interest paid" (bank crediting) → `event_type: other_income`, `movement_mechanic: bank_interest`, `statement_impact: pnl_other_income`. Not financing.

### 3. Split Settlement

| Pattern | event_type | movement_mechanic | statement_impact |
|---------|------------|-------------------|-----------------|
| Chase credit card, EPAY | liability_settlement | credit_card_payment | bs_liability_settlement |
| Shopify debit | platform_fee or processor_debit | processor_debit | pnl_expense or bs_only |
| Merchant bankcard ACH credit | processor_settlement | processor_payout | bs_only |
| Gateway Services | fee | processor_debit | pnl_expense |

### 4. Split Owner-related (review)

| Pattern | candidate | review_status |
|---------|-----------|---------------|
| Zelle, credit, no invoice | owner_contribution_candidate | needs_review |
| Zelle, debit | owner_draw_candidate | needs_review |
| Transfer, unclear | internal_transfer_candidate | needs_review |
| Personal-looking | non_business_candidate | needs_review |
| Test/jack test | test_artifact_candidate | needs_review |

### 5. Deleted entities

- When displaying counterparty: if raw string ends with `(deleted)`, strip ` (deleted)` and use `canonical_name` from `entities` if linked via `entity_id`.
- If no entity link: display `Amazon` (strip suffix) — never show "Amazon (deleted)" in financial reports.
- Identity layer: maintain alias history; tombstoned entities map to surviving canonical.

### 6. Zero-dollar events

- Rate change, DEBIT (ANY TYPE) Rate Change → `event_type: adjustment`, `statement_impact: non_posting`, `review_status: excluded` (or separate `system_artifact` bucket).
- QB balance adjustment: same treatment.
- Segregate in UI: "System / Non-posting" section, not mixed with economic events.

---

## Implementation Phases

### Phase 1: Schema + Backfill (low risk)
- Add `event_type`, `movement_mechanic`, `review_status` columns.
- Add mapping from `movement_class` + `movement_subclass` to new axes.
- Backfill existing rows.

### Phase 2: Classification engine (medium risk)
- Refactor `classifyByRules()` to output all four axes.
- Update `getStatementImpact()` to use `event_type` + `movement_mechanic`.
- Fix owner draw vs contribution, interest vs financing, settlement split.

### Phase 3: Deleted entity handling (low risk)
- Counterparty display: strip ` (deleted)`, prefer `entities.canonical_name`.
- Identity resolution: map deleted QBO aliases to canonical entities.

### Phase 4: Zero-dollar segregation (low risk)
- Detect $0 artifacts; set `statement_impact: non_posting`.
- UI: separate "System / Non-posting" section.

### Phase 5: UI refactor (medium risk)
- Derive buckets from axes instead of `movement_class`.
- Group by `statement_impact` + `event_type` where appropriate.

---

## Example: Correct classification

### Shopify debit
- `event_type`: platform_fee
- `movement_mechanic`: processor_debit
- `statement_impact`: pnl_expense
- `review_status`: confirmed

### Chase credit card payment
- `event_type`: liability_settlement
- `movement_mechanic`: credit_card_payment
- `statement_impact`: bs_liability_settlement
- `review_status`: confirmed

### Incoming owner bank transfer (+$200)
- `event_type`: owner_contribution
- `movement_mechanic`: owner_in
- `statement_impact`: bs_equity
- `review_status`: provisional

### Bank interest credit (+$24.14)
- `event_type`: other_income
- `movement_mechanic`: bank_interest
- `statement_impact`: pnl_other_income
- `review_status`: confirmed

---

## Principle

**For every movement/event, the system must answer separately:**

1. What happened economically?
2. How did money move mechanically?
3. What statement does it affect?
4. How confident are we?

Enforce that, and the architecture becomes clean.

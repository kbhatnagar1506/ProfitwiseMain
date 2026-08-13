# Forecast Engine Roadmap: From Trustworthy to Elite

## Core Principle: Hierarchy of Truth

```
1. Transaction truth     ← foundation (classification, entity resolution)
2. State truth           ← revenue, spend, liquidity (already improved)
3. Forecast truth        ← event models, calibration, uncertainty
4. UI polish             ← last, not first
```

**If layer 1 is shaky, layer 4 lies beautifully.** Stop optimizing UI before model truth.

---

## Phase 1: Make It Trustworthy

### 1.1 One Final State Per Transaction
- [ ] Ensure every movement has a single, stable classification
- [ ] No duplicate semantics (e.g. same spend counted twice)
- [ ] Cross-bucket dedup already in place; verify completeness

### 1.2 Clean Entity Canonicals
- [x] UUID resolution to canonical names (done)
- [ ] Alias hiding, owner/test labels
- [ ] Raw invoice sludge removal
- [ ] Synthetic merged labels cleanup

### 1.3 Stable Transfer/Settlement/Owner Rules
- [x] Merchant deposit evidence-based classification (done)
- [ ] Transfer policy: deterministic, no contamination of operating forecast
- [ ] Settlement vs revenue-in separation

### 1.4 Remove False Precision
- [x] Honest state confidence (excluded, provisional, low-conf)
- [ ] Forecast confidence from components, not one magic score
- [ ] Never show 100% when uncertainty exists

### 1.5 Strong Backtesting
- [ ] Current: `runBacktest()` in forecast-engine.ts
- [ ] Extend: event occurrence accuracy, cash path accuracy, low-point/runway accuracy
- [ ] Evaluate by horizon: 7d, 14d, 30d, 60d, 90d
- [ ] Evaluate by segment: clockwork vs volatile vs sparse customers, recurring vs episodic vendors

---

## Phase 2: Make It Smart

### 2.1 Separate Models (Not One Blended Engine)

| Model | Job | Current State | Target |
|-------|-----|---------------|--------|
| **Inflow likelihood** | Will customer pay in horizon? | Heuristic in `buildInvoiceForecasts` | Dedicated model: days overdue, payer delay, repeat count, invoice vs norm, seasonality |
| **Inflow timing** | When will payment happen? | Rule-based day offsets | Survival/hazard model — "when does event happen" |
| **Outflow obligation** | Contractual vs AP vs discretionary | Single vendor model | Split: contractual recurring, AP due, soft recurring, episodic, noise |
| **Settlement timing** | Processor payout delays | Basic settlement model | Net-vs-gross timing, payout cadence |
| **Treasury movement** | Transfers | Mixed with operating | Separate: treasury policy, not operating behavior |

### 2.2 Event Classification Before Forecasting

**Inflows:**
- clockwork receivable
- likely receivable
- overdue receivable
- sporadic receivable
- processor settlement
- owner support
- treasury transfer
- unknown

**Outflows:**
- contractual recurring
- AP due date driven
- payroll-like fixed
- processor fees
- bank fees
- discretionary vendor spend
- owner draw
- treasury transfer
- unknown

**Forecast by class, not by one generic engine.**

### 2.3 Survival / Hazard Models for Timing

- Probability payment occurs by day t
- Conditioned on: invoice age, payer, amount, due status
- For vendor/AP: due date, vendor behavior, cash posture, payment batch patterns
- Better than naive time-series: event timing, not just sequence prediction

### 2.4 Separate Amount vs Timing vs Event

- **Event model** = whether at all
- **Timing model** = when
- **Amount model** = how much

Do not make one model predict both. Easier debugging.

### 2.5 Probability Calibration

- Isotonic regression or Platt-like calibration for event probabilities
- Per-segment: overdue invoices, recurring vendors, processor settlement, sparse entities
- Target: 70% event happens ~70% of the time
- Current: `CalibrationResult` in backtest; extend with per-segment calibration

### 2.6 Forecast Confidence from Components

Compose from:
- transaction tagging quality
- entity resolution quality
- inflow model quality
- outflow model quality
- recurrence quality
- calibration quality
- horizon length penalty
- unresolved exposure

Current: `computeForecastConfidence()` — extend to explicit components.

### 2.7 Benchmark Baselines

Compare against:
- naive carry-forward
- rolling average inflow/outflow
- due-date only heuristic
- simple recurrence engine
- ARIMA/Prophet baseline for aggregate cash
- no-model "last cycle repeat"

**If fancy engine does not beat these, it's not better.**

### 2.8 Feature Store Expansion

**Customer features:**
- avg DSO, DSO variance
- percent overdue paid
- amount elasticity
- monthly cadence
- order/invoice cadence
- invoice size percentile
- payer reliability cluster
- last 3 payment intervals
- organizational seasonality

**Vendor features:**
- due-date adherence
- payment batching pattern
- skipped month frequency
- amount volatility
- minimum spend floor
- discretionary vs required
- month-end concentration

**Cash posture:**
- current cash balance
- days since last transfer
- recent owner support
- recent payment compression
- recent spend anomaly
- current AP load

### 2.9 Recurrence Overhaul

- Recurrence confidence from: interval stability, amount stability, counterparty consistency, due-date consistency, class consistency
- Not just repeated appearance
- Current: `classifyRecurrence()` in forecast-engine.ts

### 2.10 Sparse Entity Handling

- Hierarchical priors
- Segment defaults
- Shrinkage to cohort behavior
- Example: sparse sports-team buyer inherits from similar institutional payers

### 2.11 Behavioral Archetypes (Extended)

**Customer:** clockwork, slow_reliable, volatile, one-off, seasonal, distressed/low_data (current: partial)

**Vendor:** hard due-date, soft recurring, one-off AP, spend-on-demand, batch supplier, treasury-linked

Forecast by archetype first, then entity.

### 2.12 Separate Business vs Treasury Cashflow

**Outputs:**
- operating forecast
- settlement forecast
- treasury forecast
- owner-financing forecast

Then combine. Answer: "is the business healthy?" vs "did treasury juggling save the month?"

---

## Phase 3: Make It Elite

### 3.1 Causal Action Simulation

Not just: "delaying RTZN by 5 days adds cash"

But: cash improvement + vendor relationship risk + late-fee probability + impact on next month trough + chance of larger later crunch

### 3.2 Explain Every Forecasted Event

For each major driver:
- why it is expected
- what evidence supports it
- what could invalidate it
- confidence
- model-derived vs rule-derived

### 3.3 Honest Uncertainty

- Expected impact
- Plausible range
- Confidence band
- Assumptions

Example: "Delay RTZN by 5 days — 14d cash improvement: +$5.0k, likely range +$3.1k–$6.2k, confidence: low-medium, assumes vendor payment can slip without penalty"

### 3.4 Model Governance

Track:
- model version
- feature version
- calibration version
- tagging version
- policy version

When forecast changes, know why.

### 3.5 North Star: Decision Quality

Optimize for:
- Will I hit a cash crunch soon?
- Which 3 entities matter most?
- What can I do in the next 7 days?
- How much confidence should I place in this?
- What happens if I do nothing?

---

## LLM Integration Points

Use LLM where it benefits the system:

- **Narrative generation:** Explain forecast drivers, interventions, uncertainty in founder-friendly language
- **Entity disambiguation:** Resolve ambiguous counterparties when rules fail
- **Anomaly explanation:** "Why did this vendor payment spike?"
- **Intervention reasoning:** "What are the tradeoffs of delaying this payment?"
- **Segment labeling:** Infer customer/vendor archetype from sparse signals
- **Invoice memo parsing:** Extract due dates, amounts, terms from unstructured text

---

## Current Codebase Map

| Component | Location | Notes |
|-----------|----------|-------|
| Behavioral models | `forecast-engine.ts` | `buildBehavioralModels`, `CustomerModel`, `VendorModel` |
| Customer archetypes | `forecast-engine.ts` | `classifyCustomerArchetype` — clockwork, slow_reliable, bursty, episodic, volatile, low_data |
| Recurrence | `forecast-engine.ts` | `classifyRecurrence` — hard, soft, seasonal, episodic |
| Invoice forecasts | `forecast-engine.ts` | `buildInvoiceForecasts` — rule-based probabilities |
| Event generation | `forecast-engine.ts` | `generateEvents30d` |
| Monte Carlo | `forecast-engine.ts` | `runMonteCarlo`, 500 sims |
| Backtest | `forecast-engine.ts` | `runBacktest` |
| Forecast confidence | `forecast-engine.ts` | `computeForecastConfidence` — 8 components |
| Calibration | `types.ts` | `CalibrationResult`, `BacktestResult` |
| Movement decomposition | `forecast-engine.ts` | `categorize`, `decomposeMovements` |

---

## Implementation Order (Recommended)

1. **Phase 1.4–1.5:** Extend backtest (horizon, segment), ensure forecast confidence is honest
2. **Phase 2.12:** Separate operating / settlement / treasury / owner forecasts in output
3. **Phase 2.2:** Add event classification step before forecasting
4. **Phase 2.7:** Implement benchmark baselines, compare
5. **Phase 2.5:** Per-segment calibration
6. **Phase 2.1:** Split into inflow likelihood, inflow timing, outflow obligation models (incremental)
7. **Phase 2.3:** Survival/hazard for timing (when data supports)
8. **Phase 3.1–3.3:** Causal simulation, explainability, uncertainty bands

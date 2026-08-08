# Entities Endpoint Study: Complete Architecture

## Overview
The `/entities` endpoint is the core API for fetching and managing entity profiles (customers and vendors). It's a sophisticated system that aggregates transaction data, computes behavioral metrics, and generates AI-powered insights.

---

## Architecture Layers

### Layer 1: API Routes (Entry Points)

#### `GET /api/entities` - List All Entities
**File:** `app/api/entities/route.ts`

**Flow:**
1. Authenticate user via session cookie
2. Parse query parameters:
   - `type`: Filter by entity type (customer/vendor)
   - `sort`: Sort field (lifetime_value, transaction_count, last_transaction, name)
   - `min_transactions`: Minimum transaction threshold
   - `refresh`: Force rebuild profiles and narratives
3. Optionally rebuild profiles if `refresh=true`
4. Fetch all entity profiles using `getAllEntityProfiles()`
5. Join with entity details (canonical_name, display_name)
6. Calculate summary stats (totals, at-risk count)
7. Return: `{ entities, summary }`

**Response Structure:**
```typescript
{
  entities: [
    {
      id: string
      canonical_name: string
      display_name: string | null
      entity_type: "customer" | "vendor"
      archetype: EntityArchetype
      lifetime_value: number
      outstanding_amount: number
      overdue_amount: number
      reliability_score: number
      risk_score: number
      transaction_count: number
      last_transaction_date: string
      ai_summary: string
    }
  ],
  summary: {
    total_entities: number
    total_customers: number
    total_vendors: number
    total_ar_outstanding: number
    total_ap_outstanding: number
    total_lifetime_value: number
    at_risk_count: number
  }
}
```

#### `GET /api/entities/[id]` - Get Single Entity Details
**File:** `app/api/entities/[id]/route.ts`

**Flow:**
1. Validate entity ID (UUID format)
2. Fetch entity details from `entities` table
3. Get entity profile using `getEntityProfile()`
4. Optionally fetch transactions using `aggregateEntityTransactions()`
5. Generate/refresh AI narratives if requested
6. Build forecast features for forecasting engine
7. Return: `{ entity, profile, narratives, transactions, forecast_features }`

**Response Structure:**
```typescript
{
  entity: {
    id: string
    canonical_name: string
    display_name: string | null
    entity_type: string
    domain: string | null
  },
  profile: EntityPaymentProfile,
  narratives: {
    ai_summary: string
    ai_forecast_notes: string
    ai_risk_explanation: string
  },
  transactions: EntityTransaction[],
  forecast_features: ForecastFeatures | null
}
```

---

### Layer 2: Entity Profiles Library
**File:** `lib/entity-profiles.ts`

This is the computational engine that transforms raw transaction data into behavioral profiles.

#### 2.1 Transaction Aggregation

**Function:** `aggregateEntityTransactions(userId, entityId)`

**Data Sources:**
- `movement_attributions`: Links movements to AR/AP components
- `movements`: Raw transaction records
- `qbo_entities`: QuickBooks invoice/bill data (for due dates)
- `xero_entities`: Xero invoice/bill data (for due dates)

**Calculation:**
```
For each movement attributed to an entity:
1. Get the net amount from movement_attribution
2. Get the transaction date from movement
3. Look up the due date from QBO or Xero
4. Calculate days_to_pay = (transaction_date - due_date) / 86,400,000 ms
5. Determine was_on_time = (days_to_pay <= 0)
```

**Output:** Array of `EntityTransaction` objects with:
- amount
- transaction_date
- due_date
- days_to_pay (null if no due date)
- was_on_time (null if no due date)

#### 2.2 Behavioral Metrics Computation

**Function:** `computeBehavioralMetrics(transactions)`

**Metrics Calculated:**

1. **Amount Metrics:**
   - `avg_transaction_amount`: Mean of all transaction amounts
   - `std_transaction_amount`: Standard deviation
   - `largest_transaction`: Max amount
   - `smallest_transaction`: Min amount

2. **Payment Timing Metrics:**
   - `avg_days_to_pay`: Average days from due date to payment
   - `std_days_to_pay`: Standard deviation of payment delays
   - `on_time_payment_rate`: % of payments on or before due date
   - `early_payment_rate`: % of payments before due date
   - `avg_days_early_late`: Average days early (negative) or late (positive)

3. **Frequency Metrics:**
   - `transactions_per_month`: Total transactions / months of history
   - `avg_interval_days`: Average days between consecutive transactions
   - `interval_cv`: Coefficient of variation (std / mean) of intervals

4. **Trend Analysis:**
   - `amount_trend`: "increasing" | "decreasing" | "stable"
     - Compares average amount in first half vs second half of transactions
     - Threshold: ±15% change

**Algorithm for Amount Trend:**
```
1. Sort transactions by date
2. Split into older half and newer half
3. Calculate average amount for each half
4. If (newer_avg - older_avg) / older_avg > 0.15 → "increasing"
5. If (newer_avg - older_avg) / older_avg < -0.15 → "decreasing"
6. Otherwise → "stable"
```

#### 2.3 Seasonality Detection

**Function:** `detectSeasonality(transactions)`

**Process:**
1. Count transactions per month (0-11)
2. Calculate average count across all months
3. Compute month weights: count / average
4. Identify peak months: weight > 1.3
5. Identify low months: weight < 0.7 AND count > 0

**Output:**
```typescript
{
  peak_months: number[] (1-indexed)
  low_months: number[] (1-indexed)
  month_weights: number[] (12 values, 0-indexed)
}
```

#### 2.4 Risk Assessment

**Function:** `computeRiskSignals(metrics, transactions)`

**Risk Factors Evaluated:**

1. **Payment Slowing** (+0.15 risk)
   - Compare recent 3 transactions vs older 3 transactions
   - Flag if recent avg days_to_pay > older avg + 2 days

2. **Amount Declining** (+0.10 risk)
   - If `amount_trend === "decreasing"`

3. **Low On-Time Rate** (+0.15 risk)
   - If `on_time_payment_rate < 0.7`

4. **High Timing Variance** (+0.10 risk)
   - If `interval_cv > 1.0`

5. **Frequency Dropping** (+0.15 risk)
   - If recent 3-month transactions < 50% of expected

**Risk Score Calculation:**
```
base_risk = 0.2
total_risk = base_risk + sum(factor_scores)
final_risk = min(1.0, total_risk)
```

**Recent Trend:**
- "improving": No risk factors AND on_time_rate > 90%
- "deteriorating": 2+ risk factors
- "stable": Otherwise

#### 2.5 Archetype Classification

**Function:** `classifyArchetype(metrics)`

**Classification Logic:**

| Archetype | Conditions |
|-----------|-----------|
| **clockwork** | CV < 0.3 AND on_time_rate > 85% |
| **slow_reliable** | CV < 0.5 AND on_time_rate > 70% AND avg_days_to_pay > 20 |
| **bursty** | CV 0.7-1.2 AND on_time_rate > 50% |
| **volatile** | CV > 1.0 OR on_time_rate < 50% |
| **low_data** | transaction_count < 3 |

Where:
- CV = Coefficient of Variation (interval_cv)
- on_time_rate = on_time_payment_rate

---

### Layer 3: Profile Storage & Retrieval

**Function:** `buildEntityProfiles(userId)`

**Process:**
1. Get all entities with transactions
2. For each entity:
   - Aggregate transactions
   - Compute behavioral metrics
   - Detect seasonality
   - Compute risk signals
   - Classify archetype
3. Store in `entity_payment_profiles` table

**Function:** `getEntityProfile(userId, entityId)`

**Query:**
```sql
SELECT * FROM entity_payment_profiles
WHERE user_id = $1 AND entity_id = $2
```

**Function:** `getAllEntityProfiles(userId, filters)`

**Query:**
```sql
SELECT * FROM entity_payment_profiles
WHERE user_id = $1
  AND (type IS NULL OR entity_type = type)
  AND transaction_count >= min_transactions
ORDER BY [sort_field] DESC
```

---

### Layer 4: AI Narratives

**File:** `lib/entity-profile-ai.ts`

**Function:** `generateEntityNarratives(profileData)`

**Input:**
- Entity name, type, archetype
- All behavioral metrics
- Risk assessment
- Seasonality data
- Recent transactions

**Output:**
```typescript
{
  ai_summary: string // "Sarah Katz is an irregular but active customer..."
  ai_forecast_notes: string // "Predictable payment patterns"
  ai_risk_explanation: string // "Payment times increasing recently"
}
```

---

## Data Flow Diagram

```
Raw Transactions
    ↓
[movements + movement_attributions + qbo_entities/xero_entities]
    ↓
aggregateEntityTransactions()
    ↓
EntityTransaction[] (with days_to_pay, was_on_time)
    ↓
┌─────────────────────────────────────────────────┐
│ Parallel Computations:                          │
│ • computeBehavioralMetrics()                    │
│ • detectSeasonality()                           │
│ • computeRiskSignals()                          │
│ • classifyArchetype()                           │
└─────────────────────────────────────────────────┘
    ↓
EntityPaymentProfile (stored in DB)
    ↓
generateEntityNarratives() (AI)
    ↓
Final Profile with AI Insights
    ↓
API Response to Frontend
```

---

## Key Insights

### 1. **Data Quality Dependency**
The entire system depends on accurate due dates from QBO/Xero. Without due dates:
- `days_to_pay` metrics are NULL
- `on_time_payment_rate` cannot be calculated
- Risk assessment is incomplete

### 2. **Archetype as Predictor**
Archetypes are used by the forecasting engine to predict future payment behavior:
- **Clockwork**: Highly predictable, use for conservative forecasts
- **Bursty**: Irregular but reliable, add variance to forecasts
- **Volatile**: Unpredictable, use wide confidence intervals
- **Slow Reliable**: Predictable but delayed, adjust payment timing

### 3. **Risk Score Normalization**
Risk scores are normalized to 0-1 range, making them comparable across entities and suitable for:
- Sorting "at-risk" entities
- Threshold-based alerts
- Weighting in portfolio analysis

### 4. **Seasonality for Forecasting**
Month weights enable seasonal adjustment:
- Peak months get higher forecast weights
- Low months get lower forecast weights
- Enables accurate cash flow predictions

---

## Integration Points

### Frontend (Customers/Vendors/Contacts Pages)
- Calls `GET /api/dashboard/entity-profiles` (different endpoint, similar data)
- Displays archetype, reliability, risk, payment behavior
- Shows AI insights in drawer

### Forecasting Engine
- Consumes `EntityPaymentProfile` data
- Uses archetype for model selection
- Uses metrics for parameter tuning
- Uses seasonality for seasonal adjustment

### Risk Management
- Monitors risk_score and risk_factors
- Alerts on deteriorating trends
- Tracks frequency dropping

---

## Performance Considerations

1. **Transaction Aggregation**: O(n) where n = number of movements
2. **Metric Computation**: O(n log n) due to sorting
3. **Caching**: Profiles stored in DB, rebuilt on demand
4. **Batch Processing**: Pipeline runs for all users in background

---

## Summary

The entities endpoint is a sophisticated data pipeline that:
1. **Aggregates** raw transaction data from multiple sources
2. **Computes** behavioral metrics using statistical analysis
3. **Classifies** entities into archetypes for forecasting
4. **Assesses** risk based on payment patterns
5. **Generates** AI narratives for human interpretation
6. **Stores** profiles for fast retrieval
7. **Serves** data to frontend and forecasting engine

This architecture enables the "Cash Flow CRM" to provide intelligent, data-driven insights about customer and vendor behavior.

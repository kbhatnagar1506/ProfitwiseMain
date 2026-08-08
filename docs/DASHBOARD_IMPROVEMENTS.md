# Customers & Vendors Pages: Improvement Strategy

Based on the entities endpoint architecture study, here's how to make the dashboard pages more robust and feature-rich.

---

## 1. **Leverage the Full Archetype System**

### Current State
- Archetypes are displayed but underutilized
- Only used for visual badges

### Improvements

#### A. Archetype-Based Insights in Drawer
Add archetype-specific guidance in the detail drawer:

```typescript
const archetypeInsights = {
  clockwork: {
    icon: "⏰",
    description: "Highly predictable payment behavior",
    recommendations: [
      "Optimize payment terms - they'll likely pay on time",
      "Consider early payment discounts",
      "Reliable for cash flow forecasting"
    ],
    riskLevel: "low"
  },
  slow_reliable: {
    icon: "🐢",
    description: "Consistent but takes longer to pay",
    recommendations: [
      "Plan for extended payment cycles",
      "Consider supply chain financing",
      "Reliable despite longer terms"
    ],
    riskLevel: "low"
  },
  bursty: {
    icon: "📊",
    description: "Irregular timing but eventually pays",
    recommendations: [
      "Monitor payment frequency",
      "Use wider confidence intervals for forecasts",
      "Watch for frequency drops"
    ],
    riskLevel: "medium"
  },
  volatile: {
    icon: "⚡",
    description: "Unpredictable payment patterns",
    recommendations: [
      "Require upfront deposits or shorter terms",
      "Monitor closely for deterioration",
      "Consider credit limits"
    ],
    riskLevel: "high"
  }
}
```

#### B. Archetype Filter with Insights
Enhance the archetype filter to show:
- Count of entities in each archetype
- Average reliability score per archetype
- Risk distribution

---

## 2. **Risk Score Visualization & Actionability**

### Current State
- Risk factors listed but not actionable
- No visual hierarchy of risk

### Improvements

#### A. Risk Score Gauge
Replace simple risk badge with a gauge showing:
- Current risk score (0-1)
- Risk trend (improving/stable/deteriorating)
- Primary risk factors highlighted

```typescript
<RiskGauge 
  score={entity.risk_score}
  trend={entity.recent_trend}
  factors={entity.risk_factors}
  onFactorClick={(factor) => showFactorExplanation(factor)}
/>
```

#### B. Risk Factor Explanations
Each risk factor should have a tooltip explaining:
- What it means
- Why it matters
- What to do about it

```typescript
const riskFactorExplanations = {
  payment_slowing: {
    meaning: "Recent payments are taking longer than historical average",
    impact: "May indicate cash flow issues or operational changes",
    action: "Follow up to understand the cause"
  },
  amount_declining: {
    meaning: "Transaction amounts are trending downward",
    impact: "Could indicate reduced business volume or consolidation",
    action: "Investigate business relationship health"
  },
  low_on_time_rate: {
    meaning: "Less than 70% of payments are on time",
    impact: "Unreliable payment behavior affects forecasting",
    action: "Consider stricter payment terms or deposits"
  },
  high_timing_variance: {
    meaning: "Payment timing is highly unpredictable",
    impact: "Makes cash flow forecasting difficult",
    action: "Monitor closely and adjust credit terms"
  },
  frequency_dropping: {
    meaning: "Transaction frequency has declined significantly",
    impact: "May indicate relationship deterioration",
    action: "Reach out to understand business changes"
  }
}
```

---

## 3. **Seasonality Visualization**

### Current State
- Seasonality data exists but not displayed
- No visual representation of peak/low months

### Improvements

#### A. Month Weight Heatmap
Show 12-month heatmap in drawer:
- Peak months highlighted in green
- Low months in red
- Neutral months in gray
- Hover to see exact weight

```typescript
<SeasonalityHeatmap 
  monthWeights={entity.peak_months}
  lowMonths={entity.low_months}
  monthWeights={entity.month_weights}
/>
```

#### B. Seasonal Forecast Adjustment
In the drawer, show:
- "This entity typically has 40% higher volume in Q4"
- "Expect lower activity in August"
- "Plan for seasonal peaks in March and September"

---

## 4. **Payment Behavior Deep Dive**

### Current State
- Payment metrics shown but not contextualized
- No comparison to peer group

### Improvements

#### A. Payment Metrics with Peer Comparison
Show each metric with:
- Entity's value
- Peer average (same archetype)
- Industry benchmark
- Visual comparison

```typescript
<PaymentMetricComparison
  metric="avg_days_to_pay"
  entityValue={entity.avg_days_to_pay}
  peerAverage={peerStats.avg_days_to_pay}
  benchmark={industryBenchmark.avg_days_to_pay}
/>
```

#### B. Payment Behavior Timeline
Show last 12 months of:
- Days to pay trend
- On-time rate trend
- Amount trend
- Frequency trend

---

## 5. **Trend Analysis Enhancement**

### Current State
- Trends shown as simple indicators
- No historical context

### Improvements

#### A. Trend Sparklines
For each metric, show:
- Last 12 months sparkline
- Current value
- Trend direction
- Velocity (accelerating/decelerating)

```typescript
<TrendSparkline
  data={last12MonthsTrend}
  currentValue={entity.transactions_per_month}
  trend={entity.amount_trend}
  velocity="accelerating" // or "stable" or "decelerating"
/>
```

#### B. Trend Alerts
Highlight when:
- Trend is reversing (was improving, now deteriorating)
- Velocity is increasing (getting worse faster)
- Threshold crossed (e.g., on-time rate dropped below 70%)

---

## 6. **Forecast Confidence Indicators**

### Current State
- Forecast uncertainty shown but not explained
- No indication of data quality

### Improvements

#### A. Data Quality Score
Show:
- Transaction count (more = more reliable)
- Data span (longer = more reliable)
- Due date coverage (% of transactions with due dates)
- Consistency score (based on interval_cv)

```typescript
<DataQualityScore
  transactionCount={entity.transaction_count}
  dataSpanMonths={monthsSinceFirstTransaction}
  dueDateCoverage={percentWithDueDate}
  consistencyScore={1 - entity.interval_cv}
/>
```

#### B. Forecast Confidence Explanation
Show why forecast is "low/medium/high" confidence:
- "High confidence: 50+ transactions, 2+ years of data, 95% have due dates"
- "Medium confidence: 15 transactions, 6 months of data, 60% have due dates"
- "Low confidence: 3 transactions, 2 months of data, 30% have due dates"

---

## 7. **Comparative Analysis**

### Current State
- Each entity viewed in isolation
- No peer comparison

### Improvements

#### A. Peer Comparison View
In drawer, show how entity compares to:
- Same archetype peers
- Same industry/category
- All entities

```typescript
<PeerComparison
  entity={selectedEntity}
  peers={entitiesWithSameArchetype}
  metrics={['reliability_score', 'risk_score', 'avg_days_to_pay']}
/>
```

#### B. Percentile Ranking
Show entity's percentile for:
- Reliability score
- Risk score
- Payment speed
- Consistency

---

## 8. **Actionable Recommendations**

### Current State
- AI recommendations exist but generic
- No prioritization

### Improvements

#### A. Priority-Based Recommendations
Show recommendations in order of:
1. **Critical** (immediate action needed)
2. **High** (address this month)
3. **Medium** (address this quarter)
4. **Low** (nice to have)

```typescript
const recommendations = [
  {
    priority: "critical",
    title: "Payment Slowing Alert",
    description: "Recent payments 5 days slower than average",
    action: "Follow up with customer",
    impact: "Could affect cash flow by $50K"
  },
  {
    priority: "high",
    title: "Seasonal Peak Approaching",
    description: "Q4 typically sees 40% higher volume",
    action: "Prepare inventory and credit lines",
    impact: "Opportunity for $200K additional revenue"
  }
]
```

#### B. Recommendation Tracking
Add ability to:
- Mark recommendation as "acknowledged"
- Set follow-up date
- Track completion
- See historical recommendations

---

## 9. **Enhanced Table Columns (Optional Expansion)**

### Current State
- Simplified table with essential columns
- Details only in drawer

### Improvements

#### A. Configurable Columns
Allow users to show/hide:
- Archetype
- Risk Score
- Reliability Score
- Payment Behavior
- Trend
- Last Transaction
- Forecast Uncertainty

#### B. Column Sorting
Enable sorting by:
- Risk score (descending)
- Reliability score (descending)
- Payment speed (ascending)
- Frequency (descending)

---

## 10. **Bulk Actions & Workflows**

### Current State
- Individual entity view only
- No bulk operations

### Improvements

#### A. Multi-Select Actions
Allow selecting multiple entities to:
- Export to CSV with custom columns
- Apply bulk tags/categories
- Schedule follow-ups
- Generate reports

#### B. Workflow Triggers
Create workflows for:
- "All volatile entities: send payment reminder"
- "All improving entities: offer early payment discount"
- "All deteriorating entities: schedule review call"

---

## 11. **Historical Tracking**

### Current State
- Current state only
- No historical snapshots

### Improvements

#### A. Profile History
Show how entity metrics have changed:
- Archetype changes (e.g., "Volatile → Bursty")
- Risk score history (chart)
- Reliability score history (chart)
- Payment behavior changes

#### B. Milestone Tracking
Track when entity:
- First transaction
- Reached 10/50/100 transactions
- Changed archetype
- Risk score crossed thresholds

---

## 12. **Integration with Forecasting**

### Current State
- Forecast features exist but not displayed
- No link to actual forecasts

### Improvements

#### A. Forecast Preview
In drawer, show:
- Next 3 months forecast
- Confidence interval
- Seasonal adjustment applied
- Key assumptions

#### B. Forecast Comparison
Show:
- Forecast vs actual (last 3 months)
- Forecast accuracy
- Model performance

---

## Implementation Priority

### Phase 1 (High Impact, Low Effort)
1. Risk factor explanations (tooltips)
2. Archetype-based insights
3. Peer comparison percentiles
4. Data quality score

### Phase 2 (Medium Impact, Medium Effort)
1. Seasonality heatmap
2. Trend sparklines
3. Priority-based recommendations
4. Payment metrics with peer comparison

### Phase 3 (High Impact, High Effort)
1. Forecast preview integration
2. Historical tracking
3. Bulk actions & workflows
4. Configurable columns

---

## Technical Implementation Notes

### Data Already Available
- All archetype data
- All risk factors and scores
- All seasonality data
- All trend data
- All payment metrics

### Data to Compute
- Peer statistics (group by archetype)
- Percentile rankings
- Data quality scores
- Forecast previews (call forecast engine)

### New Components Needed
- `ArchetypeInsights`
- `RiskGauge`
- `SeasonalityHeatmap`
- `TrendSparkline`
- `DataQualityScore`
- `PeerComparison`
- `PriorityRecommendations`
- `PaymentMetricComparison`

---

## Summary

The current dashboard is solid but underutilizes the rich data available from the entities endpoint. By implementing these improvements, you'll transform it from a "data display" tool into an "actionable intelligence" tool that helps users:

1. **Understand** entity behavior through archetypes and metrics
2. **Identify** risks and opportunities through alerts and comparisons
3. **Act** through prioritized recommendations and workflows
4. **Track** progress through historical data and milestone tracking

The key is to move from "showing data" to "telling stories" about each entity's behavior and what it means for the business.

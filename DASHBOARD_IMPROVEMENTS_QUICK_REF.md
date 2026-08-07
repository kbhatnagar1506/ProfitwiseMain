# Dashboard Improvements: Quick Reference

## Current vs Improved Experience

### Current State
```
┌─────────────────────────────────────────┐
│ Customers Page                          │
├─────────────────────────────────────────┤
│ [Refresh] [Export]                      │
├─────────────────────────────────────────┤
│ KPI Row: Total | Volume | AR | Overdue │
├─────────────────────────────────────────┤
│ Filters: Search | Sort | Archetype     │
├─────────────────────────────────────────┤
│ Table:                                  │
│ Name | Archetype | Reliability | Value │
│ AR   | Overdue                         │
├─────────────────────────────────────────┤
│ Click → Drawer with details             │
└─────────────────────────────────────────┘
```

### Improved State
```
┌─────────────────────────────────────────┐
│ Customers Page                          │
├─────────────────────────────────────────┤
│ [Refresh] [Export] [Advanced Filters]   │
├─────────────────────────────────────────┤
│ KPI Row: Total | Volume | AR | Overdue │
│ + At-Risk Count | Avg Reliability      │
├─────────────────────────────────────────┤
│ Filters: Search | Sort | Archetype     │
│ + Peer Comparison | Risk Level         │
├─────────────────────────────────────────┤
│ Table (with optional columns):          │
│ Name | Archetype | Risk | Reliability  │
│ Trend | Last Txn | Forecast Conf       │
├─────────────────────────────────────────┤
│ Click → Enhanced Drawer with:           │
│ • Archetype insights & recommendations │
│ • Risk gauge with factors & actions    │
│ • Seasonality heatmap                  │
│ • Payment behavior timeline            │
│ • Peer comparison percentiles          │
│ • Data quality score                   │
│ • Forecast preview                     │
│ • Historical tracking                  │
└─────────────────────────────────────────┘
```

---

## Key Improvements by Category

### 1. Risk Management
**Before:** Risk badge with factors list
**After:** 
- Risk gauge (0-1 scale)
- Trend indicator (improving/stable/deteriorating)
- Actionable factor explanations
- Risk factor history

### 2. Archetype Utilization
**Before:** Visual badge only
**After:**
- Archetype-specific insights
- Peer comparison within archetype
- Archetype-based recommendations
- Archetype change tracking

### 3. Payment Behavior
**Before:** Static metrics in drawer
**After:**
- 12-month trend sparklines
- Peer comparison (same archetype)
- Industry benchmarks
- Payment behavior timeline

### 4. Seasonality
**Before:** Data exists but not shown
**After:**
- 12-month heatmap visualization
- Peak/low month highlighting
- Seasonal adjustment explanations
- Forecast impact

### 5. Forecast Integration
**Before:** Forecast uncertainty label
**After:**
- Data quality score (transaction count, span, due date coverage)
- Forecast confidence explanation
- 3-month forecast preview
- Forecast accuracy tracking

### 6. Actionability
**Before:** Generic AI recommendations
**After:**
- Priority-based recommendations (critical/high/medium/low)
- Impact quantification ($50K cash flow risk)
- Action tracking (acknowledged/completed)
- Historical recommendations

---

## Component Hierarchy

```
CustomersPage
├── Header
│   ├── Title
│   ├── RefreshButton (existing)
│   └── ExportButton (existing)
├── KPIRow
│   ├── TotalCustomers
│   ├── LifetimeVolume
│   ├── OutstandingAR
│   ├── OverdueAR
│   ├── AtRiskCount (NEW)
│   └── AvgReliability (NEW)
├── FilterBar
│   ├── SearchInput (existing)
│   ├── SortSelect (existing)
│   ├── ArchetypeSelect (existing)
│   ├── AtRiskToggle (existing)
│   ├── PeerComparisonFilter (NEW)
│   └── RiskLevelFilter (NEW)
├── Table
│   ├── NameColumn (existing)
│   ├── ArchetypeColumn (existing)
│   ├── ReliabilityColumn (existing)
│   ├── LifetimeValueColumn (existing)
│   ├── ARColumn (existing)
│   ├── OverdueColumn (existing)
│   ├── RiskScoreColumn (NEW)
│   ├── TrendColumn (NEW)
│   ├── LastTxnColumn (NEW)
│   └── ForecastConfColumn (NEW)
└── DetailDrawer
    ├── EntityHeader
    ├── ArchetypeInsights (NEW)
    ├── RiskGauge (NEW)
    ├── RiskFactorExplanations (NEW)
    ├── SeasonalityHeatmap (NEW)
    ├── PaymentBehaviorTimeline (NEW)
    ├── PeerComparison (NEW)
    ├── DataQualityScore (NEW)
    ├── ForecastPreview (NEW)
    ├── HistoricalTracking (NEW)
    └── PriorityRecommendations (NEW)
```

---

## Data Flow for New Features

### Risk Gauge
```
entity.risk_score (0-1)
entity.recent_trend (improving/stable/deteriorating)
entity.risk_factors (array)
    ↓
RiskGauge Component
    ↓
Visual gauge + trend indicator + factor list
```

### Seasonality Heatmap
```
entity.peak_months (array)
entity.low_months (array)
entity.month_weights (array[12])
    ↓
SeasonalityHeatmap Component
    ↓
12-month heatmap with color coding
```

### Peer Comparison
```
selectedEntity
allEntitiesWithSameArchetype
    ↓
Calculate percentiles for:
  - reliability_score
  - risk_score
  - avg_days_to_pay
  - transactions_per_month
    ↓
PeerComparison Component
    ↓
Show entity vs peer distribution
```

### Data Quality Score
```
entity.transaction_count
entity.last_transaction_date - entity.first_transaction_date
entity.payment_metrics_available
entity.interval_cv
    ↓
Calculate:
  - Data span (months)
  - Due date coverage (%)
  - Consistency score (1 - interval_cv)
    ↓
DataQualityScore Component
    ↓
Show quality indicators
```

---

## Quick Implementation Checklist

### Phase 1 (Week 1-2)
- [ ] Add risk factor tooltips/explanations
- [ ] Create ArchetypeInsights component
- [ ] Add percentile calculations to API
- [ ] Create DataQualityScore component
- [ ] Update drawer to show new components

### Phase 2 (Week 3-4)
- [ ] Create SeasonalityHeatmap component
- [ ] Create TrendSparkline component
- [ ] Add peer comparison to drawer
- [ ] Create PriorityRecommendations component
- [ ] Add payment metrics comparison

### Phase 3 (Week 5-6)
- [ ] Integrate forecast preview
- [ ] Add historical tracking
- [ ] Create bulk actions UI
- [ ] Add configurable columns
- [ ] Performance optimization

---

## Expected Impact

### User Experience
- **Clarity**: Users understand WHY an entity is risky, not just THAT it's risky
- **Actionability**: Clear next steps for each entity
- **Confidence**: Data quality indicators show forecast reliability
- **Context**: Peer comparisons show if behavior is normal or anomalous

### Business Value
- **Risk Reduction**: Early identification of deteriorating relationships
- **Opportunity**: Identification of reliable entities for better terms
- **Efficiency**: Prioritized recommendations reduce decision time
- **Accuracy**: Better forecasts through confidence indicators

### Metrics to Track
- Time spent per entity (should decrease with better UX)
- Actions taken per entity (should increase with recommendations)
- Forecast accuracy (should improve with better data quality indicators)
- User satisfaction (should increase with actionability)

---

## Notes

1. **All data already exists** in the entities endpoint - these are visualization/UX improvements
2. **Minimal API changes** needed - mostly frontend enhancements
3. **Reusable components** can be used across Customers, Vendors, and Contacts pages
4. **Performance** should be good since data is already computed and cached
5. **Mobile-friendly** considerations for drawer components

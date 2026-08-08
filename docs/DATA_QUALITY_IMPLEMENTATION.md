# Data Quality Cleanup - Implementation Guide

**Date:** April 5, 2026  
**Timeline:** 3 phases over 2-3 weeks  
**Total Effort:** 20-30 hours

---

## Phase 1: Immediate Fixes (TODAY - 4 hours)

### Objective
Stop the bleeding. Fix the three critical issues that make reconciliation data unreliable.

### Tasks

#### Task 1.1: Identify and Document Duplicates (1 hour)
```bash
# Run this query to find all duplicates
psql -U $DB_USER -d $DB_NAME -c "
SELECT 
  ce1.id as id1,
  ce2.id as id2,
  ce1.amount::float,
  ce1.expected_date,
  ce1.metadata->>'customer_name' as customer
FROM cash_events ce1
JOIN cash_events ce2 ON 
  ce1.user_id = ce2.user_id
  AND ce1.event_type = ce2.event_type
  AND ce1.id < ce2.id
  AND ABS(ce1.amount::float - ce2.amount::float) < 0.01
  AND ce1.expected_date = ce2.expected_date
WHERE ce1.user_id = '$USER_ID'
  AND ce1.duplicate_of IS NULL
  AND ce2.duplicate_of IS NULL
ORDER BY ce1.expected_date DESC;
" > duplicates.csv
```

**Deliverable:** `duplicates.csv` with all duplicate pairs

#### Task 1.2: Mark Duplicates in Database (1 hour)
```sql
-- Execute this in your database
UPDATE cash_events ce_new
SET duplicate_of = ce_old.id
FROM cash_events ce_old
WHERE ce_new.user_id = 'USER_ID'
  AND ce_new.duplicate_of IS NULL
  AND ce_old.user_id = ce_new.user_id
  AND ce_old.event_type = ce_new.event_type
  AND ce_old.id < ce_new.id
  AND ABS(ce_old.amount::float - ce_new.amount::float) < 0.01
  AND ce_old.expected_date = ce_new.expected_date
  AND ce_old.metadata->>'customer_name' = ce_new.metadata->>'customer_name';
```

**Verification:**
```sql
-- Verify duplicates were marked
SELECT COUNT(*) as duplicates_marked
FROM cash_events
WHERE user_id = 'USER_ID' AND duplicate_of IS NOT NULL;
```

#### Task 1.3: Recalculate Status Field (1 hour)
```sql
-- Execute this in your database
UPDATE cash_events
SET status = CASE 
  WHEN outstanding_amount <= 0 THEN 'paid'
  WHEN expected_date < NOW()::date THEN 'overdue'
  ELSE 'open'
END
WHERE user_id = 'USER_ID'
  AND event_type = 'ar';
```

**Verification:**
```sql
-- Verify status was recalculated
SELECT 
  status,
  COUNT(*) as count,
  SUM(outstanding_amount::float) as total_outstanding
FROM cash_events
WHERE user_id = 'USER_ID' AND event_type = 'ar'
GROUP BY status;
```

#### Task 1.4: Validate Data Integrity (1 hour)
```sql
-- Run validation queries
SELECT 
  'Duplicates Marked' as check_name,
  COUNT(*) as count
FROM cash_events
WHERE user_id = 'USER_ID' AND duplicate_of IS NOT NULL
UNION ALL
SELECT 
  'Status Anomalies Remaining',
  COUNT(*)
FROM cash_events
WHERE user_id = 'USER_ID' AND event_type = 'ar'
  AND ((status = 'paid' AND outstanding_amount > 0) 
       OR (status = 'open' AND outstanding_amount <= 0))
UNION ALL
SELECT 
  'Partial Matches Exceeding Bill',
  COUNT(*)
FROM (
  SELECT ce.id
  FROM cash_events ce
  LEFT JOIN movement_attributions ma ON ma.entity_id = ce.entity_id AND ma.component_type = 'ar'
  WHERE ce.user_id = 'USER_ID' AND ce.event_type = 'ar'
  GROUP BY ce.id, ce.amount
  HAVING SUM(ABS(ma.net_amount::float)) > ce.amount::float * 1.02
) t;
```

### Deliverables
- ✅ Duplicates marked in database
- ✅ Status field recalculated
- ✅ Data integrity validated
- ✅ Validation report generated

### Success Criteria
- All duplicate cash events marked with `duplicate_of`
- All status anomalies resolved
- No invoices with status='paid' and outstanding_amount > 0
- Match rate improved to 55-60%

---

## Phase 2: High Priority Fixes (THIS WEEK - 12-16 hours)

### Objective
Fix the remaining issues that prevent proper reconciliation.

### Tasks

#### Task 2.1: Audit Partial Matches (3 hours)

**Step 1: Identify Problem Cases**
```sql
SELECT 
  ce.id,
  ce.metadata->>'customer_name' as customer,
  ce.amount::float as bill_amount,
  SUM(ABS(ma.net_amount::float)) as matched_amount,
  COUNT(ma.id) as match_count,
  STRING_AGG(DISTINCT ma.movement_id::text, ', ') as movement_ids
FROM cash_events ce
LEFT JOIN movement_attributions ma ON ma.entity_id = ce.entity_id AND ma.component_type = 'ar'
WHERE ce.user_id = 'USER_ID' AND ce.event_type = 'ar'
GROUP BY ce.id, ce.amount
HAVING SUM(ABS(ma.net_amount::float)) > ce.amount::float * 1.02
ORDER BY (SUM(ABS(ma.net_amount::float)) - ce.amount::float) DESC;
```

**Step 2: Manual Review**
For each case:
1. Check if multiple invoices are matched to single payment
2. Verify matched amounts are correct
3. Correct any over-matches

**Step 3: Document Findings**
Create a spreadsheet with:
- Invoice ID
- Customer
- Bill Amount
- Matched Amount
- Root Cause
- Action Taken

#### Task 2.2: Standardize Entity Names (4-6 hours)

**Step 1: Identify Variations**
```sql
SELECT 
  LOWER(REGEXP_REPLACE(metadata->>'customer_name', '[^a-z0-9]', '', 'g')) as normalized_name,
  ARRAY_AGG(DISTINCT metadata->>'customer_name' ORDER BY metadata->>'customer_name') as variations,
  COUNT(*) as total_invoices
FROM cash_events
WHERE user_id = 'USER_ID' AND event_type = 'ar'
GROUP BY normalized_name
HAVING COUNT(DISTINCT metadata->>'customer_name') > 1
ORDER BY total_invoices DESC;
```

**Step 2: Create Canonical Names**
Create a mapping table:
```sql
CREATE TABLE entity_name_mapping (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  normalized_name VARCHAR(255) NOT NULL,
  canonical_name VARCHAR(255) NOT NULL,
  variations TEXT[] NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, normalized_name)
);
```

**Step 3: Update Cash Events**
```sql
UPDATE cash_events ce
SET metadata = jsonb_set(
  ce.metadata,
  '{canonical_name}',
  to_jsonb(enm.canonical_name)
)
FROM entity_name_mapping enm
WHERE ce.user_id = 'USER_ID'
  AND LOWER(REGEXP_REPLACE(ce.metadata->>'customer_name', '[^a-z0-9]', '', 'g')) = enm.normalized_name;
```

#### Task 2.3: Classify Unclassified Transactions (4-8 hours)

**Step 1: Identify Unclassified**
```sql
SELECT 
  m.id,
  m.amount::float,
  m.date,
  m.counterparty,
  m.raw_description,
  m.direction
FROM movements m
WHERE m.user_id = 'USER_ID'
  AND m.duplicate_of IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM movement_attributions ma
    WHERE ma.movement_id = m.id
  )
ORDER BY m.date DESC;
```

**Step 2: Create Classification Rules**
```sql
-- Rule 1: Identify fees
SELECT 
  m.id,
  'fee' as classification
FROM movements m
WHERE m.user_id = 'USER_ID'
  AND (
    m.raw_description ILIKE '%fee%'
    OR m.raw_description ILIKE '%charge%'
    OR m.raw_description ILIKE '%interest%'
    OR m.amount::float < 50
  );

-- Rule 2: Identify transfers
SELECT 
  m.id,
  'internal_transfer' as classification
FROM movements m
WHERE m.user_id = 'USER_ID'
  AND (
    m.raw_description ILIKE '%transfer%'
    OR m.raw_description ILIKE '%sweep%'
    OR m.counterparty ILIKE '%bank%'
  );

-- Rule 3: Identify operational expenses
SELECT 
  m.id,
  'operational_expense' as classification
FROM movements m
WHERE m.user_id = 'USER_ID'
  AND (
    m.raw_description ILIKE '%subscription%'
    OR m.raw_description ILIKE '%software%'
    OR m.raw_description ILIKE '%service%'
  );
```

**Step 3: Manual Review**
Review remaining unclassified transactions and classify manually.

#### Task 2.4: Add Missing Descriptions (2-3 hours)

**Step 1: Identify Missing**
```sql
SELECT 
  m.id,
  m.amount::float,
  m.date,
  m.counterparty,
  m.raw_description
FROM movements m
WHERE m.user_id = 'USER_ID'
  AND (m.counterparty IS NULL OR m.raw_description IS NULL OR m.raw_description = 'Bank Transaction')
ORDER BY m.date DESC;
```

**Step 2: Populate from Plaid**
If available, update from Plaid merchant data:
```sql
UPDATE movements m
SET raw_description = COALESCE(m.raw_description, m.counterparty, 'Bank Transaction')
WHERE m.user_id = 'USER_ID'
  AND (m.raw_description IS NULL OR m.raw_description = 'Bank Transaction');
```

**Step 3: Manual Review**
For any still missing, add manually or flag for follow-up.

#### Task 2.5: Re-run Reconciliation (1 hour)
```bash
# Trigger reconciliation after cleanup
curl -X POST https://your-api.com/api/ar-ap-step?run=true \
  -H "Authorization: Bearer $TOKEN"

# Wait for completion (up to 3 minutes)
sleep 30
curl https://your-api.com/api/dashboard/reconciliation \
  -H "Authorization: Bearer $TOKEN" | jq '.summary'
```

### Deliverables
- ✅ Partial matches audited and corrected
- ✅ Entity names standardized
- ✅ Transactions classified
- ✅ Missing descriptions added
- ✅ Reconciliation re-run
- ✅ Match rate improved to 70-75%

### Success Criteria
- All partial matches reviewed and corrected
- Entity name variations consolidated
- 355 unclassified transactions classified
- Missing descriptions populated
- Match rate improved to 70-75%

---

## Phase 3: Process Improvements (NEXT SPRINT - 6-8 hours)

### Objective
Prevent future data quality issues.

### Tasks

#### Task 3.1: Implement Data Validation Framework (2-3 hours)

**Create validation schema:**
```typescript
// lib/validation/schemas.ts
import { z } from 'zod';

export const movementSchema = z.object({
  amount: z.number().min(0.01).max(10_000_000),
  date: z.string().date(),
  counterparty: z.string().optional(),
  raw_description: z.string().min(1),
  direction: z.enum(['inflow', 'outflow']),
});

export const cashEventSchema = z.object({
  amount: z.number().min(0.01),
  outstanding_amount: z.number().min(0),
  expected_date: z.string().date(),
  entity_id: z.string().uuid(),
  event_type: z.enum(['ar', 'ap']),
  metadata: z.object({
    customer_name: z.string().min(1),
    canonical_name: z.string().optional(),
  }),
});
```

**Add validation to API endpoints:**
```typescript
// app/api/movements/create/route.ts
import { movementSchema } from '@/lib/validation/schemas';

export async function POST(req: Request) {
  const body = await req.json();
  
  try {
    const validated = movementSchema.parse(body);
    // Process validated data
  } catch (error) {
    return Response.json({ error: 'Validation failed', details: error }, { status: 400 });
  }
}
```

#### Task 3.2: Add Data Quality Flags (2-3 hours)

**Create flags table:**
```sql
CREATE TABLE data_quality_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  flag_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  affected_record_id UUID,
  affected_record_type VARCHAR(50),
  message TEXT,
  suggested_action TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_data_quality_flags_user_id ON data_quality_flags(user_id);
CREATE INDEX idx_data_quality_flags_severity ON data_quality_flags(severity);
```

**Add flag detection to reconciliation:**
```typescript
// lib/reconciliation/quality-checks.ts
export async function validateReconciliationData(userId: string) {
  const flags: DataQualityFlag[] = [];
  
  // Check 1: Duplicates
  const duplicates = await checkDuplicates(userId);
  if (duplicates > 0) {
    flags.push({
      severity: 'error',
      code: 'DUPLICATES_DETECTED',
      message: `${duplicates} duplicate transactions detected`,
    });
  }
  
  // Check 2: Status anomalies
  const anomalies = await checkStatusAnomalies(userId);
  if (anomalies > 0) {
    flags.push({
      severity: 'error',
      code: 'STATUS_ANOMALIES',
      message: `${anomalies} status anomalies detected`,
    });
  }
  
  // Check 3: Partial match exceeds bill
  const exceeds = await checkPartialMatchExceeds(userId);
  if (exceeds > 0) {
    flags.push({
      severity: 'error',
      code: 'PARTIAL_MATCH_EXCEEDS',
      message: `${exceeds} partial matches exceed bill amount`,
    });
  }
  
  return flags;
}
```

#### Task 3.3: Create Monitoring Dashboard (2-3 hours)

**Create dashboard page:**
```typescript
// app/dashboard/data-quality/page.tsx
export default function DataQualityPage() {
  const [metrics, setMetrics] = useState<DataQualityMetrics | null>(null);
  
  useEffect(() => {
    const fetchMetrics = async () => {
      const response = await fetch('/api/data-quality/metrics');
      const data = await response.json();
      setMetrics(data);
    };
    
    fetchMetrics();
  }, []);
  
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Data Quality Monitoring</h1>
      
      {/* Quality Score */}
      <div className="grid grid-cols-4 gap-4">
        <MetricCard
          title="Quality Score"
          value={metrics?.quality_score}
          target={9}
          unit="/10"
        />
        <MetricCard
          title="Duplicates"
          value={metrics?.duplicate_count}
          target={0}
        />
        <MetricCard
          title="Status Anomalies"
          value={metrics?.status_anomalies}
          target={0}
        />
        <MetricCard
          title="Missing Data"
          value={metrics?.missing_data_count}
          target={0}
        />
      </div>
      
      {/* Trends */}
      <TrendChart data={metrics?.trends} />
      
      {/* Issues */}
      <IssuesList issues={metrics?.issues} />
    </div>
  );
}
```

### Deliverables
- ✅ Data validation framework implemented
- ✅ Data quality flags added
- ✅ Monitoring dashboard created
- ✅ Automated quality checks running
- ✅ Alerts configured

### Success Criteria
- All incoming data validated
- Quality flags tracked and monitored
- Dashboard shows real-time metrics
- Alerts trigger on new issues
- Team trained on best practices

---

## Rollback Plan

If issues occur during cleanup:

### Rollback Phase 1
```sql
-- Restore duplicates (if needed)
UPDATE cash_events
SET duplicate_of = NULL
WHERE user_id = 'USER_ID'
  AND duplicate_of IS NOT NULL;

-- Restore original status (if backup exists)
-- Requires backup table: cash_events_backup
UPDATE cash_events ce
SET status = ceb.status
FROM cash_events_backup ceb
WHERE ce.id = ceb.id;
```

### Rollback Phase 2
```sql
-- Restore original entity names
UPDATE cash_events
SET metadata = jsonb_set(
  metadata,
  '{canonical_name}',
  'null'::jsonb
)
WHERE user_id = 'USER_ID';
```

---

## Monitoring & Verification

### Daily Checks
```bash
# Check data quality score
curl https://your-api.com/api/data-quality/metrics \
  -H "Authorization: Bearer $TOKEN" | jq '.quality_score'

# Check for new issues
curl https://your-api.com/api/data-quality/flags \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | select(.severity == "error")'
```

### Weekly Report
```sql
-- Generate weekly data quality report
SELECT 
  DATE_TRUNC('week', created_at) as week,
  flag_type,
  severity,
  COUNT(*) as count
FROM data_quality_flags
WHERE user_id = 'USER_ID'
GROUP BY week, flag_type, severity
ORDER BY week DESC;
```

---

## Timeline Summary

| Phase | Duration | Effort | Start | End |
|-------|----------|--------|-------|-----|
| Phase 1: Immediate | 4 hours | 1 person | Today | Today |
| Phase 2: High Priority | 12-16 hours | 1-2 people | Tomorrow | End of week |
| Phase 3: Process Improvements | 6-8 hours | 1 person | Next sprint | +1 week |
| **TOTAL** | **22-28 hours** | **1-2 people** | **Today** | **+2 weeks** |

---

## Success Metrics

### Before Cleanup
- Match Rate: 51%
- Data Quality: 4/10
- Duplicates: 10-20
- Status Anomalies: 242

### After Phase 1
- Match Rate: 55-60%
- Data Quality: 5/10
- Duplicates: 0
- Status Anomalies: 0

### After Phase 2
- Match Rate: 70-75%
- Data Quality: 7/10
- Unclassified: 0
- Missing Data: <5%

### After Phase 3
- Match Rate: 85-90%
- Data Quality: 9/10
- Automated Validation: 100%
- Monitoring: Real-time

---

## Questions & Support

For questions or issues during implementation:
1. Review the detailed analysis: `DATA_QUALITY_ANALYSIS_DETAILED.md`
2. Check the query reference: `DATA_QUALITY_QUERIES.md`
3. Consult the summary: `DATA_QUALITY_ISSUES_SUMMARY.md`

# Data Quality Validation & Cleanup Queries

**Date:** April 5, 2026  
**Purpose:** SQL queries to identify, validate, and fix data quality issues

---

## Section 1: Duplicate Detection Queries

### Query 1.1: Find Duplicate Cash Events (Exact Match)
```sql
-- Find cash events with identical customer, amount, and date
SELECT 
  ce1.id as id1,
  ce2.id as id2,
  ce1.amount::float,
  ce1.expected_date,
  ce1.metadata->>'customer_name' as customer,
  ce1.created_at as created_1,
  ce2.created_at as created_2,
  CASE 
    WHEN ce1.created_at < ce2.created_at THEN 'Keep ' || ce1.id || ', Mark ' || ce2.id || ' as duplicate'
    ELSE 'Keep ' || ce2.id || ', Mark ' || ce1.id || ' as duplicate'
  END as recommendation
FROM cash_events ce1
JOIN cash_events ce2 ON 
  ce1.user_id = ce2.user_id
  AND ce1.event_type = ce2.event_type
  AND ce1.id < ce2.id
  AND ABS(ce1.amount::float - ce2.amount::float) < 0.01
  AND ce1.expected_date = ce2.expected_date
WHERE ce1.user_id = $1
  AND ce1.duplicate_of IS NULL
  AND ce2.duplicate_of IS NULL
ORDER BY ce1.expected_date DESC, ce1.amount DESC;
```

### Query 1.2: Find Duplicate Bank Transactions
```sql
-- Find movements with identical amount and date
SELECT 
  m1.id as id1,
  m2.id as id2,
  m1.amount::float,
  m1.date,
  m1.counterparty,
  m1.raw_description,
  m1.created_at as created_1,
  m2.created_at as created_2
FROM movements m1
JOIN movements m2 ON 
  m1.user_id = m2.user_id
  AND m1.id < m2.id
  AND ABS(m1.amount::float - m2.amount::float) < 0.01
  AND m1.date = m2.date
WHERE m1.user_id = $1
  AND m1.duplicate_of IS NULL
  AND m2.duplicate_of IS NULL
ORDER BY m1.date DESC, m1.amount DESC;
```

### Query 1.3: Count Duplicates by Customer
```sql
-- Summary of duplicates by customer
SELECT 
  ce.metadata->>'customer_name' as customer,
  ce.amount::float,
  ce.expected_date,
  COUNT(*) as duplicate_count,
  COUNT(*) - 1 as duplicates_to_remove,
  (COUNT(*) - 1) * ce.amount::float as total_duplicate_amount
FROM cash_events ce
WHERE ce.user_id = $1
  AND ce.event_type = 'ar'
  AND ce.duplicate_of IS NULL
GROUP BY ce.metadata->>'customer_name', ce.amount, ce.expected_date
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, total_duplicate_amount DESC;
```

---

## Section 2: Status Anomaly Detection

### Query 2.1: Find Status Anomalies
```sql
-- Find invoices where status doesn't match outstanding amount
SELECT 
  id,
  metadata->>'customer_name' as customer,
  status,
  amount::float as total_amount,
  outstanding_amount::float as outstanding,
  expected_date,
  CASE 
    WHEN status = 'paid' AND outstanding_amount > 0 THEN 'ANOMALY: Marked paid but has outstanding'
    WHEN status = 'open' AND outstanding_amount <= 0 THEN 'ANOMALY: Marked open but fully paid'
    WHEN status = 'overdue' AND expected_date >= NOW()::date THEN 'ANOMALY: Marked overdue but not past due'
    WHEN status = 'open' AND expected_date < NOW()::date THEN 'SHOULD BE: Overdue'
  END as anomaly_type,
  CASE 
    WHEN outstanding_amount <= 0 THEN 'paid'
    WHEN expected_date < NOW()::date THEN 'overdue'
    ELSE 'open'
  END as correct_status
FROM cash_events
WHERE user_id = $1
  AND event_type = 'ar'
  AND (
    (status = 'paid' AND outstanding_amount > 0)
    OR (status = 'open' AND outstanding_amount <= 0)
    OR (status = 'overdue' AND expected_date >= NOW()::date)
    OR (status = 'open' AND expected_date < NOW()::date)
  )
ORDER BY outstanding_amount DESC;
```

### Query 2.2: Count Status Anomalies
```sql
-- Summary of status anomalies
SELECT 
  status,
  CASE 
    WHEN status = 'paid' AND outstanding_amount > 0 THEN 'Marked paid but outstanding'
    WHEN status = 'open' AND outstanding_amount <= 0 THEN 'Marked open but paid'
    WHEN status = 'overdue' AND expected_date >= NOW()::date THEN 'Marked overdue but not past due'
  END as anomaly_type,
  COUNT(*) as count,
  SUM(outstanding_amount::float) as total_outstanding
FROM cash_events
WHERE user_id = $1
  AND event_type = 'ar'
  AND (
    (status = 'paid' AND outstanding_amount > 0)
    OR (status = 'open' AND outstanding_amount <= 0)
    OR (status = 'overdue' AND expected_date >= NOW()::date)
  )
GROUP BY status, anomaly_type
ORDER BY count DESC;
```

---

## Section 3: Partial Match Validation

### Query 3.1: Find Partial Matches Exceeding Bill Amount
```sql
-- Find cases where matched amount > bill amount
SELECT 
  ce.id,
  ce.metadata->>'customer_name' as customer,
  ce.amount::float as bill_amount,
  SUM(ABS(ma.net_amount::float)) as total_matched,
  COUNT(ma.id) as match_count,
  SUM(ABS(ma.net_amount::float)) - ce.amount::float as excess_amount,
  ROUND(((SUM(ABS(ma.net_amount::float)) - ce.amount::float) / ce.amount::float * 100)::numeric, 2) as excess_percent,
  STRING_AGG(DISTINCT ma.movement_id::text, ', ') as matched_movement_ids
FROM cash_events ce
LEFT JOIN movement_attributions ma ON 
  ma.entity_id = ce.entity_id 
  AND ma.component_type = 'ar'
  AND ma.duplicate_of IS NULL
WHERE ce.user_id = $1 
  AND ce.event_type = 'ar'
GROUP BY ce.id, ce.amount
HAVING SUM(ABS(ma.net_amount::float)) > ce.amount::float * 1.02
ORDER BY excess_amount DESC;
```

### Query 3.2: Validate Matched + Outstanding = Total
```sql
-- Verify that matched + outstanding = total for each invoice
SELECT 
  ce.id,
  ce.metadata->>'customer_name' as customer,
  ce.amount::float as total_invoiced,
  ce.outstanding_amount::float as outstanding,
  COALESCE(SUM(ABS(ma.net_amount::float)), 0) as total_matched,
  ce.amount::float - (ce.outstanding_amount::float + COALESCE(SUM(ABS(ma.net_amount::float)), 0)) as discrepancy,
  CASE 
    WHEN ABS(ce.amount::float - (ce.outstanding_amount::float + COALESCE(SUM(ABS(ma.net_amount::float)), 0))) > 0.01 THEN 'ERROR'
    ELSE 'OK'
  END as validation_status
FROM cash_events ce
LEFT JOIN movement_attributions ma ON 
  ma.entity_id = ce.entity_id 
  AND ma.component_type = 'ar'
  AND ma.duplicate_of IS NULL
WHERE ce.user_id = $1 
  AND ce.event_type = 'ar'
GROUP BY ce.id, ce.amount, ce.outstanding_amount
HAVING ABS(ce.amount::float - (ce.outstanding_amount::float + COALESCE(SUM(ABS(ma.net_amount::float)), 0))) > 0.01
ORDER BY ABS(discrepancy) DESC;
```

---

## Section 4: Entity Name Inconsistencies

### Query 4.1: Find Entity Name Variations
```sql
-- Find customers with multiple name variations
SELECT 
  LOWER(REGEXP_REPLACE(metadata->>'customer_name', '[^a-z0-9]', '', 'g')) as normalized_name,
  COUNT(DISTINCT metadata->>'customer_name') as name_variations,
  ARRAY_AGG(DISTINCT metadata->>'customer_name' ORDER BY metadata->>'customer_name') as variations,
  COUNT(*) as total_invoices,
  SUM(amount::float) as total_amount
FROM cash_events
WHERE user_id = $1 
  AND event_type = 'ar'
  AND metadata->>'customer_name' IS NOT NULL
GROUP BY normalized_name
HAVING COUNT(DISTINCT metadata->>'customer_name') > 1
ORDER BY total_invoices DESC;
```

### Query 4.2: Find Unmatched Invoices by Entity
```sql
-- Find unmatched invoices grouped by customer
SELECT 
  metadata->>'customer_name' as customer,
  COUNT(*) as unmatched_count,
  SUM(outstanding_amount::float) as total_outstanding,
  MIN(expected_date) as oldest_date,
  MAX(expected_date) as newest_date
FROM cash_events
WHERE user_id = $1 
  AND event_type = 'ar'
  AND outstanding_amount > 0
  AND duplicate_of IS NULL
GROUP BY metadata->>'customer_name'
ORDER BY total_outstanding DESC;
```

---

## Section 5: Missing Data Detection

### Query 5.1: Find Missing Descriptions
```sql
-- Find bank transactions with missing descriptions
SELECT 
  m.id,
  m.amount::float,
  m.date,
  m.counterparty,
  m.raw_description,
  CASE 
    WHEN m.counterparty IS NULL AND m.raw_description IS NULL THEN 'MISSING: Both NULL'
    WHEN m.counterparty IS NULL THEN 'MISSING: Counterparty NULL'
    WHEN m.raw_description IS NULL THEN 'MISSING: Description NULL'
    WHEN m.raw_description = 'Bank Transaction' THEN 'GENERIC: Default description'
    WHEN LENGTH(COALESCE(m.raw_description, '')) < 3 THEN 'TOO SHORT: Description too short'
  END as issue_type
FROM movements m
WHERE m.user_id = $1
  AND m.duplicate_of IS NULL
  AND (
    (m.counterparty IS NULL AND m.raw_description IS NULL)
    OR m.raw_description = 'Bank Transaction'
    OR LENGTH(COALESCE(m.raw_description, '')) < 3
  )
ORDER BY m.date DESC;
```

### Query 5.2: Find Missing Entity Names
```sql
-- Find invoices with missing customer names
SELECT 
  id,
  amount::float,
  expected_date,
  metadata->>'customer_name' as customer_name,
  metadata->>'canonical_name' as canonical_name,
  CASE 
    WHEN metadata->>'customer_name' IS NULL THEN 'MISSING: customer_name'
    WHEN metadata->>'customer_name' = 'Unknown Customer' THEN 'UNKNOWN: Default value'
    WHEN metadata->>'customer_name' = '' THEN 'EMPTY: Empty string'
  END as issue_type
FROM cash_events
WHERE user_id = $1 
  AND event_type = 'ar'
  AND (
    metadata->>'customer_name' IS NULL
    OR metadata->>'customer_name' = 'Unknown Customer'
    OR metadata->>'customer_name' = ''
  )
ORDER BY amount DESC;
```

---

## Section 6: Cleanup Operations

### Query 6.1: Mark Duplicate Cash Events
```sql
-- Mark duplicate cash events (keep oldest, mark newer as duplicate)
UPDATE cash_events ce_new
SET duplicate_of = ce_old.id
FROM cash_events ce_old
WHERE ce_new.user_id = $1
  AND ce_new.duplicate_of IS NULL
  AND ce_old.user_id = ce_new.user_id
  AND ce_old.event_type = ce_new.event_type
  AND ce_old.id < ce_new.id
  AND ABS(ce_old.amount::float - ce_new.amount::float) < 0.01
  AND ce_old.expected_date = ce_new.expected_date
  AND ce_old.metadata->>'customer_name' = ce_new.metadata->>'customer_name';
```

### Query 6.2: Recalculate Status Field
```sql
-- Recalculate status based on outstanding amount and due date
UPDATE cash_events
SET status = CASE 
  WHEN outstanding_amount <= 0 THEN 'paid'
  WHEN expected_date < NOW()::date THEN 'overdue'
  ELSE 'open'
END
WHERE user_id = $1
  AND event_type = 'ar';
```

### Query 6.3: Mark Duplicate Bank Transactions
```sql
-- Mark duplicate bank transactions
UPDATE movements m_new
SET duplicate_of = m_old.id
FROM movements m_old
WHERE m_new.user_id = $1
  AND m_new.duplicate_of IS NULL
  AND m_old.user_id = m_new.user_id
  AND m_old.id < m_new.id
  AND ABS(m_old.amount::float - m_new.amount::float) < 0.01
  AND m_old.date = m_new.date;
```

---

## Section 7: Data Quality Summary Report

### Query 7.1: Overall Data Quality Score
```sql
-- Calculate overall data quality metrics
WITH metrics AS (
  SELECT
    -- Duplicate metrics
    (SELECT COUNT(*) FROM cash_events WHERE user_id = $1 AND duplicate_of IS NOT NULL) as duplicate_cash_events,
    (SELECT COUNT(*) FROM movements WHERE user_id = $1 AND duplicate_of IS NOT NULL) as duplicate_movements,
    
    -- Status anomaly metrics
    (SELECT COUNT(*) FROM cash_events 
     WHERE user_id = $1 AND event_type = 'ar' 
     AND ((status = 'paid' AND outstanding_amount > 0) 
          OR (status = 'open' AND outstanding_amount <= 0))) as status_anomalies,
    
    -- Partial match metrics
    (SELECT COUNT(*) FROM (
      SELECT ce.id
      FROM cash_events ce
      LEFT JOIN movement_attributions ma ON ma.entity_id = ce.entity_id AND ma.component_type = 'ar'
      WHERE ce.user_id = $1 AND ce.event_type = 'ar'
      GROUP BY ce.id, ce.amount
      HAVING SUM(ABS(ma.net_amount::float)) > ce.amount::float * 1.02
    ) t) as partial_match_exceeds,
    
    -- Missing data metrics
    (SELECT COUNT(*) FROM movements 
     WHERE user_id = $1 AND (counterparty IS NULL OR raw_description IS NULL)) as missing_descriptions,
    
    -- Total records
    (SELECT COUNT(*) FROM cash_events WHERE user_id = $1 AND event_type = 'ar') as total_ar,
    (SELECT COUNT(*) FROM movements WHERE user_id = $1) as total_movements
)
SELECT
  duplicate_cash_events,
  duplicate_movements,
  status_anomalies,
  partial_match_exceeds,
  missing_descriptions,
  total_ar,
  total_movements,
  ROUND((1 - (
    (duplicate_cash_events + duplicate_movements + status_anomalies + partial_match_exceeds + missing_descriptions)::float 
    / (total_ar + total_movements)::float
  )) * 10, 1) as data_quality_score
FROM metrics;
```

### Query 7.2: Data Quality Issues by Severity
```sql
-- Categorize all data quality issues by severity
SELECT 
  'CRITICAL' as severity,
  'Duplicate Cash Events' as issue_type,
  COUNT(*) as count,
  SUM(amount::float) as total_amount
FROM cash_events
WHERE user_id = $1 AND duplicate_of IS NOT NULL
UNION ALL
SELECT 
  'CRITICAL',
  'Status Anomalies',
  COUNT(*),
  SUM(outstanding_amount::float)
FROM cash_events
WHERE user_id = $1 AND event_type = 'ar'
  AND ((status = 'paid' AND outstanding_amount > 0) 
       OR (status = 'open' AND outstanding_amount <= 0))
UNION ALL
SELECT 
  'CRITICAL',
  'Partial Match Exceeds Bill',
  COUNT(*),
  SUM(excess_amount)
FROM (
  SELECT 
    ce.id,
    SUM(ABS(ma.net_amount::float)) - ce.amount::float as excess_amount
  FROM cash_events ce
  LEFT JOIN movement_attributions ma ON ma.entity_id = ce.entity_id AND ma.component_type = 'ar'
  WHERE ce.user_id = $1 AND ce.event_type = 'ar'
  GROUP BY ce.id, ce.amount
  HAVING SUM(ABS(ma.net_amount::float)) > ce.amount::float * 1.02
) t
UNION ALL
SELECT 
  'HIGH',
  'Missing Descriptions',
  COUNT(*),
  SUM(amount::float)
FROM movements
WHERE user_id = $1 AND (counterparty IS NULL OR raw_description IS NULL)
UNION ALL
SELECT 
  'HIGH',
  'Entity Name Mismatches',
  COUNT(DISTINCT normalized_name),
  0
FROM (
  SELECT 
    LOWER(REGEXP_REPLACE(metadata->>'customer_name', '[^a-z0-9]', '', 'g')) as normalized_name
  FROM cash_events
  WHERE user_id = $1 AND event_type = 'ar'
  GROUP BY normalized_name
  HAVING COUNT(DISTINCT metadata->>'customer_name') > 1
) t
ORDER BY severity, count DESC;
```

---

## Usage Instructions

### Step 1: Run Detection Queries
1. Run Query 1.1 to find duplicate cash events
2. Run Query 2.1 to find status anomalies
3. Run Query 3.1 to find partial match issues
4. Run Query 4.1 to find entity name mismatches
5. Run Query 5.1 to find missing descriptions

### Step 2: Review Findings
- Export results to CSV
- Review with team
- Identify root causes

### Step 3: Execute Cleanup
1. Run Query 6.1 to mark duplicate cash events
2. Run Query 6.2 to recalculate status
3. Run Query 6.3 to mark duplicate movements
4. Verify with Query 7.1

### Step 4: Monitor
- Run Query 7.2 regularly to track improvements
- Set up alerts for new issues
- Document any manual corrections

---

## Notes

- Replace `$1` with actual user_id
- All queries use `duplicate_of IS NULL` to exclude already-marked duplicates
- Amounts are cast to float for comparison (tolerance: 0.01)
- Dates are compared as exact matches
- All queries are read-only except Section 6 (cleanup operations)

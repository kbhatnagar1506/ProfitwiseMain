# AR/AP Status Architecture

> Living reference document. Update this file whenever a new writer to `cash_events.status` is added.

---

## 1. Single Source of Truth (SSOT)

`cash_events.status` is the canonical AR/AP payment state. There is exactly one definition of what each status value means:

| Status | Meaning | Who computes it |
|---|---|---|
| `open` | Outstanding balance = full invoice amount | Server (DB write) |
| `partially_paid` | Outstanding > 0 but < invoice amount | Server (DB write) |
| `paid` | Outstanding ≤ $0.01 | Server (DB write) |
| `overdue` | `open` AND `expected_date < CURRENT_DATE` | **Query time only** — never stored |
| `void` | `voided_at IS NOT NULL` | Server (DB write) |

**`display_status` (STORED generated column):** Pre-computes the static states to avoid repeat CASE logic in every query:

```sql
GENERATED ALWAYS AS (
  CASE
    WHEN status = 'paid'                                        THEN 'paid'
    WHEN voided_at IS NOT NULL                                  THEN 'void'
    WHEN outstanding_amount < amount AND outstanding_amount > 0 THEN 'partially_paid'
    ELSE 'open'
  END
) STORED
```

To add `overdue` at query time:
```sql
CASE WHEN ce.display_status = 'open' AND ce.expected_date < CURRENT_DATE
     THEN 'overdue' ELSE ce.display_status END AS effective_status
```

---

## 2. The 6 Write Paths

All 6 writers **must** import from `lib/ar-ap-status.ts`. No other file may update `cash_events.status`.

| # | File | Trigger | `triggered_by` value |
|---|---|---|---|
| 1 | `lib/cash-events-build.ts` | QBO/Xero sync | `qbo_sync` |
| 2 | `lib/reconciliation-waterfall.ts` | Automated waterfall | `waterfall` |
| 3 | `app/api/dashboard/reconciliation/mark-paid/route.ts` | Manual mark paid | `mark_paid` / `mark_unpaid` |
| 4 | `app/api/dashboard/reconciliation/apply-match/route.ts` | Manual 1-to-1 match | `apply_match` |
| 5 | `app/api/dashboard/reconciliation/split-match/route.ts` | Manual split match | `split_match` |
| 6 | `app/api/dashboard/reconciliation/unmatch/route.ts` | Unmatch / reverse | `unmatch` |

### Canonical helper: `lib/ar-ap-status.ts`

```typescript
// statusFromOutstanding(outstanding, originalAmount) -> "open" | "partially_paid" | "paid"
// writeStatusChange(client, opts) — atomic UPDATE cash_events + INSERT ar_ap_status_log
// lockCashEvent(client, id, userId) — FOR UPDATE by PK
// lockCashEventByEntity(client, userId, entityId, eventType) — FOR UPDATE by entity
```

---

## 3. `movement_attributions` Bridge

`movement_attributions` is the source of truth for **how much** of each bank movement maps to each AR/AP event.

```
movements (bank data)  ──→  movement_attributions  ──→  cash_events (AR/AP)
           gross_amount                  net_amount            outstanding_amount
```

When a match is applied:
1. Insert row into `movement_attributions`
2. Read current `cash_events.outstanding_amount` (with `FOR UPDATE` lock)
3. `newOutstanding = MAX(0, prevOutstanding - attribution.net_amount)`
4. `newStatus = statusFromOutstanding(newOutstanding, original_amount)`
5. Call `writeStatusChange()` → updates `cash_events` + appends `ar_ap_status_log`

When unmatched:
1. Delete row from `movement_attributions`
2. Re-aggregate: `outstanding = original_amount - SUM(remaining attributions)`
3. Call `writeStatusChange()` with `triggered_by = "unmatch"`

---

## 4. Pipeline Steps

```
QBO/Xero sync
  ↓
lib/cash-events-build.ts  (upsert invoices/bills → cash_events)
  F3: never overwrite manual_paid or bank-reconciled status
  ↓
Automated waterfall (lib/reconciliation-waterfall.ts)
  ↓
User manual actions (mark-paid / apply-match / split-match / unmatch)
  F2: SELECT FOR UPDATE on cash_events row before any UPDATE
  ↓
ar_ap_status_log  ← all transitions recorded here
```

---

## 5. Metrics Map

| Metric | Source | Fixed by |
|---|---|---|
| `overdue_balance` | `entity-profiles/route.ts` | F6 — SUM where `expected_date < CURRENT_DATE` |
| `avg_days_to_pay` | `lib/entity-profiles.ts` | F7 — COALESCE qbo/xero due date + `cash_events.expected_date` |
| `at_risk_count` | `entity-profiles/route.ts` summary | counts entities where `overdue_balance > 0` |
| `reliability_score` | `entity-profiles.ts` → `entity_payment_profiles` | depends on `avg_days_to_pay` accuracy |
| `ar_balance` | `entity-profiles/route.ts` | SUM of outstanding where event_type = 'ar' |

---

## 6. State Machine

```
[invoice upserted] → open
    open ──(attribution applied, partial)──→ partially_paid
    open ──(attribution applied, full OR mark-paid)──→ paid
    partially_paid ──(remaining attributed OR mark-paid)──→ paid
    partially_paid ──(unmatch, re-aggregate)──→ open
    paid ──(unmatch OR mark-unpaid)──→ open
    any ──(voided_at set)──→ void  [display_status only]

overdue is NOT a state machine node — it is computed from:
  display_status = 'open' AND expected_date < CURRENT_DATE
```

---

## 7. Schema Additions (F5)

### `ar_ap_status_log`

```sql
CREATE TABLE ar_ap_status_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_event_id    UUID NOT NULL REFERENCES cash_events(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_status      TEXT NOT NULL,
  to_status        TEXT NOT NULL,
  from_outstanding NUMERIC,
  to_outstanding   NUMERIC,
  triggered_by     TEXT NOT NULL,  -- 'user'|'waterfall'|'llm'|'qbo_sync'|'waterfall_unmatch'|...
  attribution_id   UUID REFERENCES movement_attributions(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
```

### New `cash_events` columns

| Column | Type | Purpose |
|---|---|---|
| `overdue_notified_at` | TIMESTAMPTZ | When the user was last notified this is overdue |
| `chase_count` | INT | # of times a chase email was sent |
| `last_chased_at` | TIMESTAMPTZ | Last chase timestamp |
| `void_reason` | TEXT | Free text reason for voiding |
| `voided_at` | TIMESTAMPTZ | When voided (drives `display_status = 'void'`) |
| `confidence_score` | REAL | 1.0 = QBO verified, 0.5 = Stripe inferred, 0.3 = gmail |
| `display_status` | TEXT GENERATED STORED | Pre-computed immutable status (no `overdue`) |

---

## 8. Consistency Rules

1. **Never write `status` directly** — always use `writeStatusChange()`.
2. **Always lock before update** — use `lockCashEvent()` or `lockCashEventByEntity()` inside a transaction.
3. **Never overwrite `manual_paid` or `last_reconciled_at`-verified status** — the F3 guard in `cash-events-build.ts` handles this.
4. **`overdue` is computed at query time** — never stored, never sent as `status` to the database.
5. **Frontend never computes status** — it receives `status` from the server and renders via `<StatusBadge>`.
6. **`display_status` is read-only** — PostgreSQL GENERATED ALWAYS. Do not attempt to UPDATE it.

---

## 9. API Ownership Matrix

| Endpoint | Reads | Writes | Notes |
|---|---|---|---|
| `GET /api/dashboard/reconciliation` | `cash_events`, `movement_attributions` | — | Returns `status` + `days_overdue` |
| `POST /api/dashboard/reconciliation/apply-match` | `movements`, `cash_events` | `movement_attributions`, `cash_events`, `ar_ap_status_log` | F2 SELECT FOR UPDATE |
| `POST /api/dashboard/reconciliation/split-match` | `movements`, `cash_events` | `movement_attributions`, `cash_events`, `ar_ap_status_log` | |
| `POST /api/dashboard/reconciliation/mark-paid` | `cash_events` | `cash_events`, `ar_ap_status_log` | |
| `DELETE /api/dashboard/reconciliation/unmatch` | `movement_attributions`, `cash_events` | `movement_attributions`, `cash_events`, `ar_ap_status_log` | F4 fallback path fixed |
| `GET /api/dashboard/entity-profiles` | `entities`, `movements`, `cash_events` | — | F6 overdue_balance fixed |
| `POST /api/ar-ap-step` | all | triggers waterfall + LLM stage | calls cash-events-build + waterfall |
| `lib/cash-events-build.ts` | `qbo_entities`, `xero_entities` | `cash_events` | F3 bank-verified guard |
| `lib/reconciliation-waterfall.ts` | `movements`, `cash_events` | `cash_events`, `ar_ap_status_log` (via helper) | Batch updates |

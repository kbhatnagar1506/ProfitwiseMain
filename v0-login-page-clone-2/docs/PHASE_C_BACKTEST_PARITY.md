# Phase C: Backtest vs Production Parity

## Overview

This document captures known gaps between the backtest replay path and the production forecast path, along with recommendations for future alignment.

## Current State

### Production Forecast Path (`computeCashflowForecast`)
- Uses **entity profiles** from `entity_payment_profiles` table
- Merges **cash_events bridge** (AR/AP from invoices/bills)
- Creates **synthetic components** when movement buckets are empty
- Uses **PRNG seeding** for reproducible Monte Carlo
- Applies **calibration parameters** from `forecast_calibration_overrides`

### Backtest Replay Path (`runSingleBacktest`)
- Uses `buildBehavioralModels(training, invoices, bills)` directly
- Uses `decomposeMovements(training)` for components
- Calls `generateEvents30d` only (no bridge merge, no synthetic AR/AP path)
- Does **not** use entity profiles
- Does **not** apply the same calibration threading as production

## Known Gaps

### 1. Entity Profiles Not Used in Backtest
**Impact**: Backtest doesn't benefit from pre-computed behavioral data (reliability scores, payment patterns, archetypes) that production uses.

**Recommendation**: Thread `entityProfiles` into `runSingleBacktest` and call `enhanceModelsWithProfiles` on the training-derived models.

### 2. Cash Events Bridge Not Merged
**Impact**: Backtest uses only movement-derived events, while production merges invoice/bill-based events from `cash_events` table.

**Recommendation**: Add optional `bridgeEvents` parameter to backtest, or compute bridge events from the training-period invoices/bills.

### 3. Historical AR/AP at Cutoff
**Impact**: `runSingleBacktest` uses **current** `invoices`/`bills` arrays while training on past movements. This creates a temporal mismatch—the backtest sees future invoice state.

**Recommendation**: 
- Short-term: Accept this limitation and document that tuned knobs are "movement-replay optimal" only.
- Long-term: Snapshot or approximate historical open AR/AP at `cutoffDate` if data exists (e.g., from `cash_events` history or invoice status changes).

### 4. Synthetic Components Path
**Impact**: Production creates synthetic AR/AP components when no movement-based components exist. Backtest doesn't replicate this.

**Recommendation**: Add the same synthetic component logic to backtest when `components.length === 0`.

## Acceptance Criteria for Phase C

1. [x] Entity profiles are threaded into backtest
2. [x] Backtest thresholds lowered for sparse data
3. [ ] Backtest uses the same event pipeline as production (bridge optional flag)
4. [ ] Historical AR/AP approximation is implemented or explicitly documented as out-of-scope
5. [ ] Golden tests verify backtest/production parity on a fixed dataset

## Priority

**Medium** - The current implementation is acceptable for initial calibration tuning. These gaps primarily affect the precision of tuned parameters, not the correctness of the forecast itself.

## Related Files

- `lib/state/forecast-engine.ts` - Both paths live here
- `lib/forecast-calibration-tune.ts` - Tuner uses backtest
- `lib/cash-events-build.ts` - Bridge event generation
- `lib/entity-profiles.ts` - Entity profile loading

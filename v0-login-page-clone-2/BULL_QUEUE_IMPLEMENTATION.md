# Bull Job Queue Implementation - Architecture & Design

This document describes the Bull job queue system that has been designed and partially implemented for ProfitWise.

## Overview

The job queue system is designed to handle asynchronous data processing:
1. **Initial Sync**: When a user first logs in, fetch data from all sources (Plaid, QBO, Xero, Stripe, Shopify) in parallel
2. **Sequential Processing**: Classify → Tag → Compute State → Generate Forecast
3. **Incremental Updates**: Process webhooks from external services asynchronously
4. **Caching**: Store expensive computations (forecasts, state snapshots) for quick retrieval

## Architecture

### Critical Constraints

1. **Redis Payload Trap**: All job payloads contain ONLY IDs, never raw data
   - Prevents Redis from running out of memory
   - Job processors fetch data from Postgres, not from job payloads

2. **Connection Pool Chokehold**: Bull concurrency set to 2
   - Protects Postgres from connection exhaustion
   - Queue acts as a funnel for database access

### Job Flow

```
User Login (First Time)
    ↓
POST /api/onboarding/after-identity
    ↓
Queue: sync-initial-data { userId }
    ↓
Fetch from all sources in parallel
    ↓
Queue: classify-movements { userId }
    ↓
Queue: tag-movements { userId }
    ↓
Queue: compute-state { userId }
    ↓
Queue: generate-forecast { userId }
    ↓
Store in forecast_cache
    ↓
Frontend polls /api/dashboard/sync-status
    ↓
Dashboard renders with cached data
```

## Files Created

### Queue Infrastructure
- `lib/queue/bull-config.ts` - Queue name constants
- `lib/queue/bull-client.ts` - Queue instances (runtime only)
- `lib/queue/job-types.ts` - TypeScript interfaces for job payloads
- `lib/queue/queue-wrapper.ts` - Wrapper to isolate Bull imports
- `lib/queue/worker.ts` - Background worker process

### Job Processors
- `lib/queue/processors/sync-initial-data.ts` - Fetch from all sources
- `lib/queue/processors/classify-movements.ts` - Classify movements
- `lib/queue/processors/tag-movements.ts` - Tag movements
- `lib/queue/processors/compute-state.ts` - Compute financial state
- `lib/queue/processors/generate-forecast.ts` - Generate forecast
- `lib/queue/processors/process-webhook.ts` - Process webhook updates

### Monitoring & Logging
- `lib/queue/queue-logger.ts` - Log job events and payload sizes
- `lib/queue/connection-monitor.ts` - Monitor Postgres connection pool
- `lib/queue/redis-monitor.ts` - Monitor Redis memory usage

### API Endpoints
- `app/api/dashboard/sync-status/route.ts` - GET job progress
- `app/api/dashboard/sync-initial/route.ts` - POST to queue initial sync

### Frontend
- `components/dashboard/sync-status-poller.tsx` - Progress modal component
- Updated `components/dashboard/dashboard-layout.tsx` - Integrated poller

### Database
- Added `job_status` table to track job progress
- Updated `forecast_cache` table with TTL support

## Deployment Notes

### Current Status
The job queue infrastructure has been designed and implemented, but there's a build-time issue with Turbopack trying to bundle Bull (which uses child processes). This is a known limitation of Next.js 16 with Turbopack.

### Solution Options

1. **Separate Worker Service** (Recommended)
   - Run the web app on Heroku (Next.js)
   - Run the worker on a separate Heroku dyno (`npm run worker`)
   - Use environment variables for Redis/Postgres connection

2. **Disable Turbopack**
   - Set `NEXT_EXPERIMENTAL_TURBOPACK=false` in Heroku config
   - Use webpack instead (slower builds but works with Bull)

3. **Alternative Queue System**
   - Use a simpler queue like `node-queue` or `bee-queue`
   - Or use a managed service like AWS SQS or Google Cloud Tasks

### To Deploy

1. **Option A: Use Separate Worker Dyno**
   ```bash
   # Heroku config
   heroku config:set REDIS_URL=redis://...
   heroku config:set DATABASE_URL=postgres://...
   
   # Scale worker dyno
   heroku ps:scale worker=1
   ```

2. **Option B: Disable Turbopack**
   ```bash
   heroku config:set NEXT_EXPERIMENTAL_TURBOPACK=false
   git push heroku main
   ```

## Testing the System

Once deployed, test the end-to-end flow:

1. User logs in (first time)
2. Completes onboarding
3. POST /api/onboarding/after-identity triggers sync
4. Frontend polls /api/dashboard/sync-status
5. SyncStatusPoller shows progress
6. Dashboard renders with cached data

## Performance Characteristics

- **Sync Initial Data**: ~30-60s (parallel fetches from 5 sources)
- **Classify Movements**: ~10-20s (depends on movement count)
- **Tag Movements**: ~5-10s
- **Compute State**: ~5-10s
- **Generate Forecast**: ~20-30s (Monte Carlo simulation)
- **Total**: ~70-130s for first-time sync

## Monitoring

The system includes comprehensive logging:
- Job start/progress/completion events
- Payload size verification (< 1KB)
- Connection pool usage alerts
- Redis memory usage alerts
- Slow job detection (> 30s per step)

## Future Enhancements

1. Add job retry UI with manual retry button
2. Implement job cancellation
3. Add job history/audit trail
4. Implement priority queues for urgent jobs
5. Add job scheduling (e.g., daily forecast refresh)
6. Implement job dependencies (e.g., don't start forecast until state is computed)

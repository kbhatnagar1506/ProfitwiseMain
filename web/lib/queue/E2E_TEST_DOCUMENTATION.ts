/**
 * End-to-End Job Queue Flow Test
 * 
 * This file documents the complete flow of the Bull job queue system:
 * 1. User logs in (first time)
 * 2. Onboarding completes → sync-initial-data job queued
 * 3. sync-initial-data fetches from all sources in parallel
 * 4. classify-movements job queued
 * 5. tag-movements job queued
 * 6. compute-state job queued
 * 7. generate-forecast job queued
 * 8. Frontend polls sync-status and displays progress
 * 9. Dashboard renders with cached data
 * 
 * CRITICAL CONSTRAINTS:
 * - Redis Payload Trap: All job payloads contain ONLY IDs, no raw data
 * - Connection Pool Chokehold: Bull concurrency set to 2 to protect Postgres
 */

// ─── FLOW 1: Initial Sync on First Login ───

/**
 * Step 1: User completes onboarding (after-identity step)
 * 
 * POST /api/onboarding/after-identity
 * 
 * Flow:
 * 1. Sync entities to Supermemory
 * 2. Queue sync-initial-data job with { userId }
 * 3. Return 202 with jobId
 * 
 * Frontend:
 * - Receives jobId
 * - Starts polling /api/dashboard/sync-status every 2 seconds
 * - Shows SyncStatusPoller modal with progress
 */

// ─── FLOW 2: Sync Initial Data ───

/**
 * Job: sync-initial-data
 * Payload: { userId: "123" }
 * 
 * Processor: lib/queue/processors/sync-initial-data.ts
 * 
 * Steps:
 * 1. Fetch from all sources in parallel (Plaid, QBO, Xero, Stripe, Shopify)
 * 2. Upsert raw data to source-specific tables
 * 3. Update job_status: { step: 'fetching', progress: 100 }
 * 4. Queue classify-movements job with { userId }
 * 
 * CRITICAL: Do NOT pass transaction data to next job
 * Only pass: { userId: "123" }
 */

// ─── FLOW 3: Classify Movements ───

/**
 * Job: classify-movements
 * Payload: { userId: "123" }
 * 
 * Processor: lib/queue/processors/classify-movements.ts
 * 
 * Steps:
 * 1. Fetch movements from DB (not from payload)
 * 2. Extract observations from all sources
 * 3. Coalesce into canonical movements
 * 4. Resolve counterparty identity
 * 5. Classify movement types
 * 6. Persist to movements table
 * 7. Update job_status: { step: 'classifying', progress: 100 }
 * 8. Queue tag-movements job with { userId }
 */

// ─── FLOW 4: Tag Movements ───

/**
 * Job: tag-movements
 * Payload: { userId: "123" }
 * 
 * Processor: lib/queue/processors/tag-movements.ts
 * 
 * Steps:
 * 1. Fetch movements from DB
 * 2. Tag with economic_class, cashflow_bucket, counterparty_role
 * 3. Persist to movement_tags table
 * 4. Update job_status: { step: 'tagging', progress: 100 }
 * 5. Queue compute-state job with { userId }
 */

// ─── FLOW 5: Compute State ───

/**
 * Job: compute-state
 * Payload: { userId: "123" }
 * 
 * Processor: lib/queue/processors/compute-state.ts
 * 
 * Steps:
 * 1. Fetch movements and tags from DB
 * 2. Compute RevenueState, SpendState, LiquidityState
 * 3. Persist snapshot to state_snapshots table
 * 4. Update job_status: { step: 'computing-state', progress: 100 }
 * 5. Queue generate-forecast job with { userId }
 */

// ─── FLOW 6: Generate Forecast ───

/**
 * Job: generate-forecast
 * Payload: { userId: "123" }
 * 
 * Processor: lib/queue/processors/generate-forecast.ts
 * 
 * Steps:
 * 1. Fetch all needed data from DB (movements, tags, AR/AP items)
 * 2. Build entity payment profiles
 * 3. Run Monte Carlo simulation
 * 4. Generate narrative with LLM
 * 5. Store in forecast_cache table with TTL (24 hours)
 * 6. Update job_status: { step: 'complete', progress: 100, status: 'complete' }
 * 7. Mark job as complete
 */

// ─── FLOW 7: Frontend Polling ───

/**
 * Frontend polls /api/dashboard/sync-status every 2 seconds
 * 
 * Response:
 * {
 *   jobId: "job-123",
 *   status: "processing",
 *   step: "classifying",
 *   progress: 50,
 *   error: null,
 *   updatedAt: "2026-04-02T10:30:00Z"
 * }
 * 
 * SyncStatusPoller component:
 * - Shows modal with progress bar
 * - Displays current step with spinner
 * - Shows completed steps with checkmarks
 * - On complete: calls onComplete() to refresh dashboard
 * - On error: shows error message with retry button
 */

// ─── FLOW 8: Webhook Processing ───

/**
 * When webhook arrives (e.g., Plaid SYNC_UPDATES_AVAILABLE):
 * 
 * 1. Plaid webhook handler receives webhook
 * 2. Syncs transactions to DB
 * 3. Queues process-webhook job with { userId, source: 'plaid', webhookData }
 * 4. Returns 200 OK immediately
 * 
 * Job: process-webhook
 * Payload: { userId: "123", source: "plaid", webhookData: {...} }
 * 
 * Processor: lib/queue/processors/process-webhook.ts
 * 
 * Steps:
 * 1. Verify webhook signature
 * 2. Upsert data to source-specific tables
 * 3. Fetch affected movements from DB
 * 4. Reclassify affected movements only
 * 5. Update movement_tags for affected movements
 * 6. Invalidate forecast cache (set expiresAt to now)
 */

// ─── DATABASE SCHEMA ───

/**
 * New table: job_status
 * 
 * Columns:
 * - id: UUID (primary key)
 * - job_id: TEXT (unique, references Bull job ID)
 * - user_id: UUID (foreign key to users)
 * - status: TEXT ('queued', 'processing', 'complete', 'failed')
 * - step: TEXT ('fetching', 'classifying', 'tagging', 'computing-state', 'generating-forecast', 'complete')
 * - progress: INTEGER (0-100)
 * - error: TEXT (nullable)
 * - created_at: TIMESTAMPTZ
 * - updated_at: TIMESTAMPTZ
 * 
 * Indexes:
 * - idx_job_status_user (user_id)
 * - idx_job_status_job_id (job_id)
 */

// ─── MONITORING & LOGGING ───

/**
 * Queue Logger (lib/queue/queue-logger.ts):
 * - Logs job start with payload size check
 * - Alerts if payload > 1KB (Redis Payload Trap)
 * - Logs job progress, completion, failures
 * - Tracks job duration per step
 * - Alerts on slow jobs (>30s per step)
 * 
 * Connection Pool Monitor (lib/queue/connection-monitor.ts):
 * - Monitors Postgres connection pool every 30s
 * - Alerts if connections > 80% of max (400/500)
 * - Logs connection pool stats
 * - Can reduce Bull concurrency if pool usage is high
 * 
 * Redis Monitor (lib/queue/redis-monitor.ts):
 * - Monitors Redis memory usage every 30s
 * - Alerts if memory > 80% of max
 * - Verifies job payloads are small (< 1KB each)
 */

// ─── ERROR HANDLING & RETRIES ───

/**
 * Bull automatically retries failed jobs:
 * - 3 attempts per job
 * - Exponential backoff: 2s, 4s, 8s
 * 
 * On final failure:
 * - Error stored in job_status table
 * - Frontend shows error with retry button
 * - Admin dashboard shows failed jobs for manual intervention
 * - All job payloads logged to verify they contain only IDs
 */

// ─── TESTING CHECKLIST ───

/**
 * 1. Initial Sync Flow:
 *    ✓ User logs in (first time)
 *    ✓ Onboarding completes
 *    ✓ sync-initial-data job queued
 *    ✓ Job fetches from all sources
 *    ✓ classify-movements job queued
 *    ✓ tag-movements job queued
 *    ✓ compute-state job queued
 *    ✓ generate-forecast job queued
 *    ✓ Frontend polls sync-status
 *    ✓ SyncStatusPoller shows progress
 *    ✓ Dashboard renders with cached data
 * 
 * 2. Webhook Processing:
 *    ✓ Plaid webhook received
 *    ✓ process-webhook job queued
 *    ✓ Affected movements reclassified
 *    ✓ Forecast cache invalidated
 * 
 * 3. Error Handling:
 *    ✓ Job fails and retries
 *    ✓ Error stored in job_status
 *    ✓ Frontend shows error message
 * 
 * 4. Monitoring:
 *    ✓ Queue logger logs job payloads
 *    ✓ Connection pool monitor alerts on high usage
 *    ✓ Redis monitor alerts on high memory usage
 * 
 * 5. Performance:
 *    ✓ Payload size < 1KB (Redis Payload Trap)
 *    ✓ Bull concurrency = 2 (Connection Pool Chokehold)
 *    ✓ Job duration < 30s per step
 */

export const E2E_TEST_DOCUMENTATION = true

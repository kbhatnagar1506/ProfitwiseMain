# Background Refresh Job System - Quick Start Guide

## Overview

The background refresh job system prevents timeouts by running refresh operations asynchronously. Instead of waiting for the entire refresh to complete (which can take 30+ seconds), the system:

1. Starts a background job immediately
2. Returns a job ID to the frontend
3. Frontend polls for completion
4. Fetches fresh data once done

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                         │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ useEntityRefresh Hook                                    │   │
│  │ - Manages refresh workflow                              │   │
│  │ - Polls for job completion                              │   │
│  │ - Updates progress bar                                  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                    HTTP Requests (REST API)
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Backend (Next.js)                           │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ POST /api/dashboard/refresh-job                          │   │
│  │ - Create job record                                      │   │
│  │ - Start background process                              │   │
│  │ - Return job_id immediately                             │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↓                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Background Job Process                                   │   │
│  │ - buildEntityProfiles()                                  │   │
│  │ - refreshEntityNarratives()                              │   │
│  │ - Update job status to "completed"                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↑                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ GET /api/dashboard/refresh-job?job_id=xxx               │   │
│  │ - Check job status                                       │   │
│  │ - Return status (pending/running/completed/failed)       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Database (PostgreSQL)                         │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ refresh_jobs Table                                       │   │
│  │ - id (UUID)                                              │   │
│  │ - user_id (UUID)                                         │   │
│  │ - status (pending/running/completed/failed)              │   │
│  │ - error_message (TEXT)                                   │   │
│  │ - created_at, updated_at (TIMESTAMP)                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Request/Response Flow

### 1. Start Refresh Job

**Request:**
```
POST /api/dashboard/refresh-job
Authorization: Bearer <session_token>
```

**Response (immediate):**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "message": "Refresh job started"
}
```

**Time to response:** ~50ms

### 2. Poll for Completion

**Request (repeated every 1 second):**
```
GET /api/dashboard/refresh-job?job_id=550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer <session_token>
```

**Response (while running):**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "running",
  "error_message": null,
  "created_at": "2026-04-06T04:36:00Z",
  "updated_at": "2026-04-06T04:36:05Z"
}
```

**Response (when completed):**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "error_message": null,
  "created_at": "2026-04-06T04:36:00Z",
  "updated_at": "2026-04-06T04:36:45Z"
}
```

**Time per poll:** ~20ms

### 3. Fetch Updated Data

**Request (after job completes):**
```
GET /api/dashboard/entity-profiles?entity_type=customer&page=1&limit=50
Authorization: Bearer <session_token>
```

**Response:**
```json
{
  "summary": { ... },
  "customers": [ ... ],
  "pagination": { ... },
  "refresh_status": "none"
}
```

## Frontend Usage

### Using the Hook

```typescript
import { useEntityRefresh } from "@/hooks/useEntityRefresh"

export function CustomersPage() {
  const refreshState = useEntityRefresh()
  const [customers, setCustomers] = useState([])

  const fetchCustomers = async (refresh: boolean) => {
    const response = await fetch(
      `/api/dashboard/entity-profiles?entity_type=customer&refresh=${refresh}`
    )
    return await response.json()
  }

  const handleRefresh = async () => {
    await refreshState.refresh(fetchCustomers, {
      onSuccess: () => {
        console.log("Refresh complete!")
        // Fetch fresh data
        fetchCustomers(false).then(data => setCustomers(data.customers))
      },
      onError: (error) => {
        console.error("Refresh failed:", error)
      },
      maxAttempts: 120,      // 2 minutes
      pollInterval: 1000,    // 1 second
    })
  }

  return (
    <div>
      <button 
        onClick={handleRefresh} 
        disabled={refreshState.isRefreshing}
      >
        {refreshState.isRefreshing ? "Refreshing..." : "Refresh Data"}
      </button>
      
      {refreshState.isRefreshing && (
        <div>
          <progress value={refreshState.progress} max={100} />
          <p>{refreshState.message}</p>
        </div>
      )}
      
      {/* Display customers */}
    </div>
  )
}
```

## Job Lifecycle

```
┌─────────┐
│ pending │  Job created, waiting to start
└────┬────┘
     │
     ↓
┌─────────┐
│ running │  Background job is executing
└────┬────┘
     │
     ├─→ ┌───────────┐
     │   │ completed │  Job finished successfully
     │   └───────────┘
     │
     └─→ ┌────────┐
         │ failed │  Job encountered an error
         └────────┘
```

## Monitoring

### Check Recent Jobs

```sql
SELECT 
  id, 
  user_id, 
  status, 
  created_at, 
  updated_at,
  EXTRACT(EPOCH FROM (updated_at - created_at)) as duration_seconds
FROM refresh_jobs 
ORDER BY created_at DESC 
LIMIT 20;
```

### Check Failed Jobs

```sql
SELECT 
  id, 
  user_id, 
  error_message, 
  created_at
FROM refresh_jobs 
WHERE status = 'failed'
ORDER BY created_at DESC;
```

### Job Duration Statistics

```sql
SELECT 
  status,
  COUNT(*) as count,
  AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_duration_seconds,
  MAX(EXTRACT(EPOCH FROM (updated_at - created_at))) as max_duration_seconds
FROM refresh_jobs 
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status;
```

## Performance Comparison

### Before (Synchronous Refresh)
- Request timeout: 30 seconds (Heroku limit)
- User experience: Blocked waiting
- Result: H12 timeout errors on large datasets

### After (Background Job)
- Initial response: ~50ms
- Polling overhead: ~20ms per request
- Total time: Same as before, but no timeout
- User experience: Progress updates, responsive UI

## Troubleshooting

### Job Stuck in "running" Status

Check if the background process is actually running:

```sql
SELECT * FROM refresh_jobs 
WHERE status = 'running' 
AND updated_at < NOW() - INTERVAL '5 minutes';
```

If found, manually update to failed:

```sql
UPDATE refresh_jobs 
SET status = 'failed', 
    error_message = 'Job timeout - manually marked'
WHERE id = 'job-id-here';
```

### High Job Failure Rate

Check error messages:

```sql
SELECT error_message, COUNT(*) as count
FROM refresh_jobs 
WHERE status = 'failed'
GROUP BY error_message
ORDER BY count DESC;
```

### Database Table Not Created

The table is created automatically on first use. If it fails:

```bash
psql $DATABASE_URL -f web/migrations/001_create_refresh_jobs.sql
```

## Next Steps

1. **Monitor** job performance in production
2. **Optimize** refresh operations if needed
3. **Implement** job cleanup (delete old jobs)
4. **Add** WebSocket notifications for real-time updates
5. **Consider** rate limiting per user

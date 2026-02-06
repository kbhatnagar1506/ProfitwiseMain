# Background Refresh Job System

## Overview

The background refresh job system prevents request timeouts when refreshing large datasets. Instead of performing synchronous refresh operations that can exceed Heroku's 30-second timeout limit, the system:

1. **Starts a background job** via `/api/dashboard/refresh-job` (POST)
2. **Returns immediately** with a job ID
3. **Polls for completion** via `/api/dashboard/refresh-job` (GET)
4. **Fetches updated data** once the job completes

## Architecture

### Database Schema

The `refresh_jobs` table tracks job status:

```sql
CREATE TABLE refresh_jobs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, running, completed, failed
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### API Endpoints

#### Start a Refresh Job
```
POST /api/dashboard/refresh-job
```

**Response:**
```json
{
  "job_id": "uuid-string",
  "status": "pending",
  "message": "Refresh job started"
}
```

#### Check Job Status
```
GET /api/dashboard/refresh-job?job_id=uuid-string
```

**Response:**
```json
{
  "job_id": "uuid-string",
  "status": "completed|running|pending|failed",
  "error_message": null,
  "created_at": "2026-04-02T10:00:00Z",
  "updated_at": "2026-04-02T10:05:00Z"
}
```

### Frontend Hook

The `useEntityRefresh` hook manages the entire refresh workflow:

```typescript
import { useEntityRefresh } from "@/hooks/useEntityRefresh"

export function MyComponent() {
  const refreshState = useEntityRefresh()

  const handleRefresh = async () => {
    await refreshState.refresh(fetchCustomers, {
      onSuccess: () => console.log("Refresh complete!"),
      onError: (err) => console.error("Refresh failed:", err),
      maxAttempts: 120, // 2 minutes
      pollInterval: 1000, // 1 second
    })
  }

  return (
    <div>
      <button onClick={handleRefresh} disabled={refreshState.isRefreshing}>
        {refreshState.isRefreshing ? "Refreshing..." : "Refresh Data"}
      </button>
      <p>{refreshState.message}</p>
      <progress value={refreshState.progress} max={100} />
    </div>
  )
}
```

## Workflow

1. **User clicks "Refresh Data"** button
2. **Frontend calls POST /api/dashboard/refresh-job**
   - Backend creates a job record with status "pending"
   - Backend starts background job (fire-and-forget)
   - Backend returns job_id immediately
3. **Frontend polls GET /api/dashboard/refresh-job?job_id=xxx**
   - Polls every 1 second (configurable)
   - Updates progress bar
   - Continues until status is "completed" or "failed"
4. **Once job completes**
   - Frontend fetches updated data via `/api/dashboard/entity-profiles`
   - UI updates with fresh data
   - Success callback fires

## Job Lifecycle

```
pending → running → completed
                 ↘ failed
```

- **pending**: Job created, waiting to start
- **running**: Background job is executing
- **completed**: Job finished successfully
- **failed**: Job encountered an error (error_message populated)

## Deployment

### Database Initialization

The `refresh_jobs` table is created automatically on first use via `initializeRefreshJobsTable()` in `lib/db-init.ts`. This is called by the POST endpoint.

Alternatively, run the migration manually:

```bash
psql $DATABASE_URL -f v0-login-page-clone-2/migrations/001_create_refresh_jobs.sql
```

### Environment Variables

No additional environment variables required. Uses existing `DATABASE_URL`.

## Benefits

1. **No Timeouts**: Background jobs run independently of HTTP request timeout limits
2. **Better UX**: Users see progress updates while refresh happens
3. **Scalability**: Multiple refresh jobs can run concurrently
4. **Error Handling**: Failed jobs are tracked with error messages
5. **Audit Trail**: Job history available for debugging

## Monitoring

Check job status in the database:

```sql
-- Recent jobs
SELECT id, user_id, status, created_at, updated_at 
FROM refresh_jobs 
ORDER BY created_at DESC 
LIMIT 10;

-- Failed jobs
SELECT id, user_id, error_message, created_at 
FROM refresh_jobs 
WHERE status = 'failed' 
ORDER BY created_at DESC;

-- Job duration
SELECT 
  id, 
  user_id, 
  status,
  EXTRACT(EPOCH FROM (updated_at - created_at)) as duration_seconds
FROM refresh_jobs 
WHERE status = 'completed'
ORDER BY created_at DESC;
```

## Future Enhancements

1. **Job Cleanup**: Implement a cron job to delete old completed/failed jobs
2. **Retry Logic**: Automatically retry failed jobs
3. **Webhooks**: Notify frontend when job completes via WebSocket
4. **Rate Limiting**: Prevent users from starting too many concurrent jobs
5. **Job Prioritization**: Queue jobs by priority

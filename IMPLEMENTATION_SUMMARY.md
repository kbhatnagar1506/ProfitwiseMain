# Background Refresh Job System - Implementation Summary

## What Was Implemented

A complete background job system for handling long-running refresh operations without HTTP request timeouts.

### Problem Solved
Previously, the refresh operation was synchronous and would timeout on Heroku's 30-second limit when processing large datasets. This resulted in `H12 Request timeout` errors.

### Solution Architecture

#### 1. **Database Layer** (`refresh_jobs` table)
- Tracks job status: `pending` → `running` → `completed` or `failed`
- Stores error messages for failed jobs
- Indexed for fast lookups by user_id and status

#### 2. **Backend API** (`/api/dashboard/refresh-job`)
- **POST**: Start a new refresh job
  - Creates job record with status "pending"
  - Starts background job (fire-and-forget)
  - Returns immediately with job_id
  - Automatically initializes database table on first use

- **GET**: Check job status
  - Polls for job completion
  - Returns current status and error messages
  - Supports long polling from frontend

#### 3. **Frontend Hook** (`useEntityRefresh`)
- Manages entire refresh workflow
- Starts background job via POST
- Polls for completion via GET (configurable intervals)
- Updates progress bar during polling
- Fetches fresh data once job completes
- Handles errors gracefully

### Files Created/Modified

**New Files:**
- `app/api/dashboard/refresh-job/route.ts` - Job API endpoint
- `lib/db-init.ts` - Database initialization utility
- `migrations/001_create_refresh_jobs.sql` - Database schema
- `run-migrations.sh` - Migration runner script
- `BACKGROUND_REFRESH_JOBS.md` - Complete documentation

**Modified Files:**
- `hooks/useEntityRefresh.ts` - Updated to use background job API
- `app/api/dashboard/entity-profiles/route.ts` - Removed synchronous refresh

## How It Works

```
User clicks "Refresh Data"
    ↓
Frontend calls POST /api/dashboard/refresh-job
    ↓
Backend creates job record, starts background process, returns job_id
    ↓
Frontend polls GET /api/dashboard/refresh-job?job_id=xxx every 1 second
    ↓
Backend processes refresh in background (buildEntityProfiles + refreshEntityNarratives)
    ↓
Job completes, status changes to "completed"
    ↓
Frontend fetches updated data via /api/dashboard/entity-profiles
    ↓
UI updates with fresh data
```

## Key Features

1. **No Timeouts**: Background jobs run independently of HTTP request limits
2. **Progress Tracking**: Frontend shows progress bar and status messages
3. **Error Handling**: Failed jobs tracked with error messages
4. **Automatic Initialization**: Database table created on first use
5. **Configurable Polling**: Adjustable poll interval and max attempts
6. **Audit Trail**: Job history available in database for debugging

## Deployment

✅ Successfully deployed to Heroku (v734)
- Build completed successfully
- App is running and healthy
- No errors in application logs

## Testing the System

### Start a refresh job:
```bash
curl -X POST https://dashboard.profitwise.app/api/dashboard/refresh-job
# Returns: { "job_id": "uuid", "status": "pending" }
```

### Check job status:
```bash
curl https://dashboard.profitwise.app/api/dashboard/refresh-job?job_id=uuid
# Returns: { "job_id": "uuid", "status": "running|completed|failed", ... }
```

### Monitor in database:
```sql
SELECT id, user_id, status, created_at, updated_at 
FROM refresh_jobs 
ORDER BY created_at DESC 
LIMIT 10;
```

## Performance Impact

- **Request latency**: Reduced from 30+ seconds (timeout) to <100ms (job creation)
- **User experience**: Immediate feedback with progress updates
- **Scalability**: Multiple jobs can run concurrently
- **Resource usage**: Background jobs don't block HTTP workers

## Future Enhancements

1. Job cleanup (delete old completed/failed jobs)
2. Automatic retry logic for failed jobs
3. WebSocket notifications for real-time updates
4. Rate limiting per user
5. Job prioritization queue
6. Webhook notifications

## Documentation

See `BACKGROUND_REFRESH_JOBS.md` for:
- Complete API documentation
- Database schema details
- Frontend hook usage examples
- Monitoring and debugging guides
- Future enhancement roadmap

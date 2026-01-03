/**
 * Bull Queue Client
 * 
 * This file creates Queue instances for adding jobs.
 * It should only be imported at runtime (not during Next.js build).
 * Use dynamic imports in API routes to avoid bundling issues.
 */

import Queue from 'bull'
import Redis from 'redis'
import { QUEUE_NAMES } from './bull-config'

// Redis connection configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
}

// Create queues with low concurrency to protect Postgres connection pool
// NOTE: These are client-only instances for adding jobs
// Actual processing happens in the background worker (worker.ts)
export const queues = {
  syncInitialData: new Queue(QUEUE_NAMES.SYNC_INITIAL_DATA, redisConfig),
  classifyMovements: new Queue(QUEUE_NAMES.CLASSIFY_MOVEMENTS, redisConfig),
  tagMovements: new Queue(QUEUE_NAMES.TAG_MOVEMENTS, redisConfig),
  computeState: new Queue(QUEUE_NAMES.COMPUTE_STATE, redisConfig),
  generateForecast: new Queue(QUEUE_NAMES.GENERATE_FORECAST, redisConfig),
  processWebhook: new Queue(QUEUE_NAMES.PROCESS_WEBHOOK, redisConfig),
}

export default queues

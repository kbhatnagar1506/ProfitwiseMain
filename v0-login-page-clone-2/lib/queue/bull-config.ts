import Queue from 'bull'
import Redis from 'redis'

// Redis connection configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
}

// Job queue names
export const QUEUE_NAMES = {
  SYNC_INITIAL_DATA: 'sync-initial-data',
  CLASSIFY_MOVEMENTS: 'classify-movements',
  TAG_MOVEMENTS: 'tag-movements',
  COMPUTE_STATE: 'compute-state',
  GENERATE_FORECAST: 'generate-forecast',
  PROCESS_WEBHOOK: 'process-webhook',
} as const

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


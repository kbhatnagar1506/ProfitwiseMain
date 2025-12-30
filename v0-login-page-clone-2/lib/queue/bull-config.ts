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
export const queues = {
  syncInitialData: new Queue(QUEUE_NAMES.SYNC_INITIAL_DATA, redisConfig),
  classifyMovements: new Queue(QUEUE_NAMES.CLASSIFY_MOVEMENTS, redisConfig),
  tagMovements: new Queue(QUEUE_NAMES.TAG_MOVEMENTS, redisConfig),
  computeState: new Queue(QUEUE_NAMES.COMPUTE_STATE, redisConfig),
  generateForecast: new Queue(QUEUE_NAMES.GENERATE_FORECAST, redisConfig),
  processWebhook: new Queue(QUEUE_NAMES.PROCESS_WEBHOOK, redisConfig),
}

// Configure concurrency for all queues
// CRITICAL: Keep concurrency LOW (2) to protect Postgres connection pool
Object.values(queues).forEach((queue) => {
  queue.process(2, async (job) => {
    // Processors will be registered separately
    throw new Error('Processor not registered for this queue')
  })

  // Global error handler
  queue.on('error', (err) => {
    console.error(`Queue error in ${queue.name}:`, err)
  })

  queue.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed in ${queue.name}:`, err.message)
  })

  queue.on('completed', (job) => {
    console.log(`Job ${job.id} completed in ${queue.name}`)
  })
})

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing queues...')
  await Promise.all(Object.values(queues).map((q) => q.close()))
  process.exit(0)
})

export default queues

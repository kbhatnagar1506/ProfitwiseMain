/**
 * Background Worker Process
 * 
 * This file runs as a separate Node.js process (not part of Next.js)
 * It processes jobs from the Bull queues
 * 
 * Run with: node lib/queue/worker.ts (or tsx lib/queue/worker.ts in development)
 */

import { log } from '../logger'
import { processSyncInitialData } from './processors/sync-initial-data'
import { processClassifyMovements } from './processors/classify-movements'
import { processTagMovements } from './processors/tag-movements'
import { processComputeState } from './processors/compute-state'
import { processGenerateForecast } from './processors/generate-forecast'
import { processMatchCustomers } from './processors/match-customers'
import { processProcessWebhook } from './processors/process-webhook'
import { QUEUE_NAMES } from './bull-config'
import { queues } from './bull-client'

// Register processors with CRITICAL: concurrency = 2 to protect Postgres
async function startWorker() {
  console.log('Starting Bull queue worker...')

  // sync-initial-data processor
  queues.syncInitialData.process(2, processSyncInitialData)
  queues.syncInitialData.on('error', (err) => {
    console.error(`Queue error in ${QUEUE_NAMES.SYNC_INITIAL_DATA}:`, err)
    log('queue.error', { queue: QUEUE_NAMES.SYNC_INITIAL_DATA, error: err.message }, 'queue')
  })
  queues.syncInitialData.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed in ${QUEUE_NAMES.SYNC_INITIAL_DATA}:`, err.message)
  })
  queues.syncInitialData.on('completed', (job) => {
    console.log(`Job ${job.id} completed in ${QUEUE_NAMES.SYNC_INITIAL_DATA}`)
  })

  // classify-movements processor
  queues.classifyMovements.process(2, processClassifyMovements)
  queues.classifyMovements.on('error', (err) => {
    console.error(`Queue error in ${QUEUE_NAMES.CLASSIFY_MOVEMENTS}:`, err)
    log('queue.error', { queue: QUEUE_NAMES.CLASSIFY_MOVEMENTS, error: err.message }, 'queue')
  })

  // tag-movements processor
  queues.tagMovements.process(2, processTagMovements)
  queues.tagMovements.on('error', (err) => {
    console.error(`Queue error in ${QUEUE_NAMES.TAG_MOVEMENTS}:`, err)
    log('queue.error', { queue: QUEUE_NAMES.TAG_MOVEMENTS, error: err.message }, 'queue')
  })

  // compute-state processor
  queues.computeState.process(2, processComputeState)
  queues.computeState.on('error', (err) => {
    console.error(`Queue error in ${QUEUE_NAMES.COMPUTE_STATE}:`, err)
    log('queue.error', { queue: QUEUE_NAMES.COMPUTE_STATE, error: err.message }, 'queue')
  })

  // generate-forecast processor
  queues.generateForecast.process(2, processGenerateForecast)
  queues.generateForecast.on('error', (err) => {
    console.error(`Queue error in ${QUEUE_NAMES.GENERATE_FORECAST}:`, err)
    log('queue.error', { queue: QUEUE_NAMES.GENERATE_FORECAST, error: err.message }, 'queue')
  })

  // match-customers processor
  queues.matchCustomers.process(2, processMatchCustomers)
  queues.matchCustomers.on('error', (err) => {
    console.error(`Queue error in ${QUEUE_NAMES.MATCH_CUSTOMERS}:`, err)
    log('queue.error', { queue: QUEUE_NAMES.MATCH_CUSTOMERS, error: err.message }, 'queue')
  })

  // process-webhook processor
  queues.processWebhook.process(2, processProcessWebhook)
  queues.processWebhook.on('error', (err) => {
    console.error(`Queue error in ${QUEUE_NAMES.PROCESS_WEBHOOK}:`, err)
    log('queue.error', { queue: QUEUE_NAMES.PROCESS_WEBHOOK, error: err.message }, 'queue')
  })

  console.log('Bull queue worker started successfully')
  console.log(`Listening on queues: ${Object.values(QUEUE_NAMES).join(', ')}`)
  console.log('Concurrency: 2 per queue (protecting Postgres connection pool)')
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down worker...')
  await Promise.all(Object.values(queues).map((q) => q.close()))
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down worker...')
  await Promise.all(Object.values(queues).map((q) => q.close()))
  process.exit(0)
})

// Start worker
startWorker().catch((err) => {
  console.error('Failed to start worker:', err)
  process.exit(1)
})

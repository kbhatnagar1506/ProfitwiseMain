// Type definitions for job queues
// This file contains only types and is safe to import in Next.js

export const QUEUE_NAMES = {
  SYNC_INITIAL_DATA: 'sync-initial-data',
  CLASSIFY_MOVEMENTS: 'classify-movements',
  TAG_MOVEMENTS: 'tag-movements',
  COMPUTE_STATE: 'compute-state',
  GENERATE_FORECAST: 'generate-forecast',
  MATCH_CUSTOMERS: 'match-customers',
  PROCESS_WEBHOOK: 'process-webhook',
} as const

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES]



// CRITICAL: All job payloads must contain ONLY IDs, no raw data
// This prevents Redis from running out of memory

export interface SyncInitialDataJob {
  userId: string
}

export interface ClassifyMovementsJob {
  userId: string
}

export interface TagMovementsJob {
  userId: string
}

export interface ComputeStateJob {
  userId: string
}

export interface GenerateForecastJob {
  userId: string
}

export interface MatchCustomersJob {
  userId: string
}

export interface ProcessWebhookJob {
  userId: string
  source: 'plaid' | 'qbo' | 'xero' | 'stripe' | 'shopify'
  webhookData: Record<string, any>
}

// Job status tracking
export interface JobStatus {
  jobId: string
  userId: string
  status: 'queued' | 'processing' | 'complete' | 'failed'
  step: 'fetching' | 'classifying' | 'tagging' | 'computing-state' | 'generating-forecast' | 'matching-customers' | 'complete'
  progress: number // 0-100
  error?: string
  createdAt: Date
  updatedAt: Date
}

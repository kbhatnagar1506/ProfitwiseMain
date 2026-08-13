'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'

interface SyncStatus {
  jobId: string | null
  status: 'idle' | 'queued' | 'processing' | 'complete' | 'failed' | 'skipped'
  step: 'fetching' | 'classifying' | 'tagging' | 'computing-state' | 'generating-forecast' | 'complete'
  progress: number
  error: string | null
  updatedAt?: string
}

const STEP_LABELS: Record<string, string> = {
  fetching: 'Fetching data from sources...',
  classifying: 'Classifying movements...',
  tagging: 'Tagging movements...',
  'computing-state': 'Computing financial state...',
  'generating-forecast': 'Generating forecast...',
  complete: 'Sync complete!',
}

const STEP_ORDER = ['fetching', 'classifying', 'tagging', 'computing-state', 'generating-forecast', 'complete']

export function SyncStatusPoller({ onComplete }: { onComplete?: () => void }) {
  const [status, setStatus] = useState<SyncStatus>({
    jobId: null,
    status: 'idle',
    step: 'fetching',
    progress: 0,
    error: null,
  })
  const [isPolling, setIsPolling] = useState(false)

  useEffect(() => {
    const pollSyncStatus = async () => {
      try {
        const response = await fetch('/api/dashboard/sync-status')
        if (!response.ok) throw new Error('Failed to fetch sync status')

        const data: SyncStatus = await response.json()
        setStatus(data)

        // Stop polling if complete or failed
        if (data.status === 'complete' || data.status === 'failed' || data.status === 'skipped') {
          setIsPolling(false)
          if (data.status === 'complete' && onComplete) {
            onComplete()
          }
        }
      } catch (error) {
        console.error('Error polling sync status:', error)
      }
    }

    // Start polling if we have an active job
    if (isPolling || (status.jobId && status.status !== 'idle')) {
      setIsPolling(true)
      const interval = setInterval(pollSyncStatus, 2000) // Poll every 2 seconds

      return () => clearInterval(interval)
    }
  }, [isPolling, status.jobId, status.status, onComplete])

  // Don't show anything if idle or skipped
  if (status.status === 'idle' || status.status === 'skipped') {
    return null
  }

  const stepIndex = STEP_ORDER.indexOf(status.step)
  const completedSteps = stepIndex + (status.status === 'complete' ? 1 : 0)
  const totalSteps = STEP_ORDER.length

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#0c0c0c] border border-white/[0.06] rounded-lg p-8 max-w-md w-full mx-4">
        <div className="space-y-6">
          {/* Header */}
          <div>
            <h2 className="text-lg font-semibold text-white mb-2">Syncing Your Data</h2>
            <p className="text-sm text-neutral-400">
              {status.status === 'failed' ? 'Sync failed' : STEP_LABELS[status.step] || 'Processing...'}
            </p>
          </div>

          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-neutral-500">
              <span>Progress</span>
              <span>{status.progress}%</span>
            </div>
            <div className="w-full bg-white/[0.05] rounded-full h-2 overflow-hidden">
              <div
                className="bg-gradient-to-r from-blue-500 to-blue-600 h-full transition-all duration-300"
                style={{ width: `${status.progress}%` }}
              />
            </div>
          </div>

          {/* Step Progress */}
          <div className="space-y-2">
            {STEP_ORDER.map((step, index) => {
              const isCompleted = index < completedSteps
              const isCurrent = index === stepIndex && status.status !== 'complete'

              return (
                <div key={step} className="flex items-center gap-3">
                  <div className="flex-shrink-0">
                    {isCompleted ? (
                      <CheckCircle2 className="w-5 h-5 text-green-500" />
                    ) : isCurrent ? (
                      <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                    ) : (
                      <div className="w-5 h-5 rounded-full border border-white/[0.2]" />
                    )}
                  </div>
                  <span
                    className={`text-sm ${
                      isCompleted || isCurrent ? 'text-white' : 'text-neutral-500'
                    }`}
                  >
                    {STEP_LABELS[step]}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Error Message */}
          {status.error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 flex gap-3">
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-red-400">Sync Error</p>
                <p className="text-xs text-red-300 mt-1">{status.error}</p>
              </div>
            </div>
          )}

          {/* Status Message */}
          {status.status === 'complete' && (
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 flex gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-green-400">Your data has been synced successfully!</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

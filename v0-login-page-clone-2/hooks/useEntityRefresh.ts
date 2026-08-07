import { useState, useCallback } from "react"

interface RefreshOptions {
  onSuccess?: () => void
  onError?: (error: string) => void
  maxAttempts?: number
  pollInterval?: number
}

interface RefreshState {
  isRefreshing: boolean
  progress: number // 0-100
  status: "idle" | "refreshing" | "polling" | "completed" | "error"
  message: string
  jobId?: string
}

/**
 * Hook for refreshing entity profiles with background job polling
 * Starts a background job and polls until completion
 */
export function useEntityRefresh() {
  const [refreshState, setRefreshState] = useState<RefreshState>({
    isRefreshing: false,
    progress: 0,
    status: "idle",
    message: "",
  })

  const refresh = useCallback(
    async (
      fetchFn: (refresh: boolean) => Promise<any>,
      options: RefreshOptions = {}
    ) => {
      const {
        onSuccess,
        onError,
        maxAttempts = 120, // 2 minutes with 1s polling
        pollInterval = 1000,
      } = options

      try {
        setRefreshState({
          isRefreshing: true,
          progress: 10,
          status: "refreshing",
          message: "Starting background refresh job...",
        })

        // Start background refresh job
        const jobResponse = await fetch("/api/dashboard/refresh-job", {
          method: "POST",
        })

        if (!jobResponse.ok) {
          throw new Error("Failed to start refresh job")
        }

        const { job_id } = await jobResponse.json()

        setRefreshState({
          isRefreshing: true,
          progress: 20,
          status: "polling",
          message: "Refresh job started, polling for completion...",
          jobId: job_id,
        })

        // Poll for job completion
        let attempts = 0
        let jobCompleted = false

        while (attempts < maxAttempts && !jobCompleted) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval))
          attempts++

          try {
            const statusResponse = await fetch(
              `/api/dashboard/refresh-job?job_id=${job_id}`
            )

            if (!statusResponse.ok) {
              throw new Error("Failed to check job status")
            }

            const jobStatus = await statusResponse.json()

            if (jobStatus.status === "completed") {
              jobCompleted = true

              // Fetch updated data
              await fetchFn(false)

              setRefreshState({
                isRefreshing: false,
                progress: 100,
                status: "completed",
                message: "Data refreshed successfully!",
                jobId: job_id,
              })
              onSuccess?.()
              return
            } else if (jobStatus.status === "failed") {
              throw new Error(
                jobStatus.error_message || "Refresh job failed"
              )
            }

            // Update progress
            const progressPercent = 20 + (attempts / maxAttempts) * 80
            setRefreshState({
              isRefreshing: true,
              progress: Math.min(99, progressPercent),
              status: "polling",
              message: `Refresh in progress... (${attempts}/${maxAttempts})`,
              jobId: job_id,
            })
          } catch (err) {
            console.error("[useEntityRefresh] Poll attempt failed:", err)
            // Continue polling on error
          }
        }

        // Timeout reached
        setRefreshState({
          isRefreshing: false,
          progress: 100,
          status: "completed",
          message: "Refresh job submitted (processing in background)",
          jobId: job_id,
        })
        onSuccess?.()
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error"
        setRefreshState({
          isRefreshing: false,
          progress: 0,
          status: "error",
          message: `Refresh failed: ${errorMsg}`,
        })
        onError?.(errorMsg)
      }
    },
    []
  )

  const reset = useCallback(() => {
    setRefreshState({
      isRefreshing: false,
      progress: 0,
      status: "idle",
      message: "",
    })
  }, [])

  return {
    ...refreshState,
    refresh,
    reset,
  }
}

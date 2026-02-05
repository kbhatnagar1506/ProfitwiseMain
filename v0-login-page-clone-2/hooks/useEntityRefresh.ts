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
}

/**
 * Hook for refreshing entity profiles with polling
 * Triggers a refresh and polls until data is updated
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
        maxAttempts = 30,
        pollInterval = 1000,
      } = options

      try {
        setRefreshState({
          isRefreshing: true,
          progress: 10,
          status: "refreshing",
          message: "Triggering data refresh...",
        })

        // Trigger refresh
        await fetchFn(true)

        setRefreshState({
          isRefreshing: true,
          progress: 30,
          status: "polling",
          message: "Waiting for data to update...",
        })

        // Poll for updates
        let attempts = 0
        let lastDataHash = ""

        while (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval))
          attempts++

          try {
            const response = await fetchFn(false)
            const currentDataHash = JSON.stringify(response)

            // Check if data has changed
            if (lastDataHash && currentDataHash !== lastDataHash) {
              setRefreshState({
                isRefreshing: false,
                progress: 100,
                status: "completed",
                message: "Data refreshed successfully!",
              })
              onSuccess?.()
              return
            }

            lastDataHash = currentDataHash

            // Update progress
            const progressPercent = 30 + (attempts / maxAttempts) * 70
            setRefreshState({
              isRefreshing: true,
              progress: Math.min(99, progressPercent),
              status: "polling",
              message: `Polling for updates... (${attempts}/${maxAttempts})`,
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
          message: "Refresh completed (data may be updating)",
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

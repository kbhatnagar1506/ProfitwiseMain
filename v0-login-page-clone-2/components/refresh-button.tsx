import { Button } from "@/components/ui/button"
import { RefreshCw, CheckCircle, AlertCircle } from "lucide-react"

interface RefreshButtonProps {
  isRefreshing: boolean
  status: "idle" | "refreshing" | "polling" | "completed" | "error"
  progress: number
  message: string
  onClick: () => void
}

export function RefreshButton({
  isRefreshing,
  status,
  progress,
  message,
  onClick,
}: RefreshButtonProps) {
  return (
    <div className="flex flex-col gap-2">
      <Button
        onClick={onClick}
        disabled={isRefreshing}
        variant="outline"
        size="sm"
        className="gap-2"
      >
        <RefreshCw
          className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`}
        />
        {isRefreshing ? "Refreshing..." : "Refresh Data"}
      </Button>

      {isRefreshing && (
        <div className="space-y-2">
          <div className="w-full bg-zinc-700 rounded-full h-1.5 overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-zinc-400">{message}</p>
        </div>
      )}

      {status === "completed" && !isRefreshing && (
        <div className="flex items-center gap-2 text-xs text-emerald-400">
          <CheckCircle className="w-4 h-4" />
          <span>{message}</span>
        </div>
      )}

      {status === "error" && !isRefreshing && (
        <div className="flex items-center gap-2 text-xs text-red-400">
          <AlertCircle className="w-4 h-4" />
          <span>{message}</span>
        </div>
      )}
    </div>
  )
}

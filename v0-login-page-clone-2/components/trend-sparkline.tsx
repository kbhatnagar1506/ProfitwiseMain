import { TrendingUp, TrendingDown, Minus } from "lucide-react"

interface TrendSparklineProps {
  label: string
  currentValue: number
  trend: "increasing" | "decreasing" | "stable"
  unit?: string
  format?: (value: number) => string
}

export function TrendSparkline({
  label,
  currentValue,
  trend,
  unit = "",
  format = (v) => v.toFixed(1),
}: TrendSparklineProps) {
  const trendIcon =
    trend === "increasing" ? (
      <TrendingUp className="w-4 h-4 text-emerald-400" />
    ) : trend === "decreasing" ? (
      <TrendingDown className="w-4 h-4 text-red-400" />
    ) : (
      <Minus className="w-4 h-4 text-zinc-400" />
    )

  const trendColor =
    trend === "increasing"
      ? "text-emerald-400"
      : trend === "decreasing"
        ? "text-red-400"
        : "text-zinc-400"

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-neutral-500">{label}</span>
        <div className="flex items-center gap-1">
          {trendIcon}
          <span className={`text-xs font-medium capitalize ${trendColor}`}>{trend}</span>
        </div>
      </div>

      <div className="flex items-baseline gap-1 bg-white/[0.02] p-2.5 rounded">
        <span className="text-sm font-semibold text-neutral-300">{format(currentValue)}</span>
        {unit && <span className="text-xs text-neutral-600">{unit}</span>}
      </div>

      {/* Simple trend indicator bar */}
      <div className="h-1 bg-zinc-700 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all ${
            trend === "increasing"
              ? "bg-emerald-500/60"
              : trend === "decreasing"
                ? "bg-red-500/60"
                : "bg-zinc-500/60"
          }`}
          style={{
            width:
              trend === "increasing"
                ? "75%"
                : trend === "decreasing"
                  ? "25%"
                  : "50%",
          }}
        />
      </div>
    </div>
  )
}

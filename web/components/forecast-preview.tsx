import { TrendingUp, AlertCircle } from "lucide-react"

interface ForecastPreviewProps {
  nextMonthForecast: number
  nextMonthConfidence: number
  seasonalAdjustment: number
  assumptions: string[]
}

export function ForecastPreview({
  nextMonthForecast,
  nextMonthConfidence,
  seasonalAdjustment,
  assumptions,
}: ForecastPreviewProps) {
  const confidenceColor =
    nextMonthConfidence >= 80
      ? "text-emerald-400"
      : nextMonthConfidence >= 60
        ? "text-amber-400"
        : "text-red-400"

  const confidenceBg =
    nextMonthConfidence >= 80
      ? "bg-emerald-500/10"
      : nextMonthConfidence >= 60
        ? "bg-amber-500/10"
        : "bg-red-500/10"

  return (
    <div className="space-y-3">
      {/* Forecast Value */}
      <div className={`${confidenceBg} border border-white/[0.06] rounded-lg p-4`}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium text-neutral-500">Next Month Forecast</span>
          <div className="flex items-center gap-1">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <span className={`text-xs font-medium ${confidenceColor}`}>{Math.round(nextMonthConfidence)}% confidence</span>
          </div>
        </div>
        <p className="text-2xl font-bold text-white tabular-nums">
          ${Math.round(nextMonthForecast).toLocaleString()}
        </p>
        {seasonalAdjustment !== 0 && (
          <p className="text-xs text-neutral-500 mt-2">
            {seasonalAdjustment > 0 ? "↑" : "↓"} {Math.abs(Math.round(seasonalAdjustment))}% seasonal adjustment
          </p>
        )}
      </div>

      {/* Confidence Interval */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
        <p className="text-xs font-medium text-neutral-500 mb-2">Confidence Interval</p>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-600">Conservative</span>
            <span className="text-neutral-300">${Math.round(nextMonthForecast * 0.8).toLocaleString()}</span>
          </div>
          <div className="w-full h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500/60" style={{ width: "100%" }} />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-600">Optimistic</span>
            <span className="text-neutral-300">${Math.round(nextMonthForecast * 1.2).toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Assumptions */}
      {assumptions.length > 0 && (
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
          <p className="text-xs font-medium text-neutral-500 mb-2">Key Assumptions</p>
          <ul className="space-y-1">
            {assumptions.map((assumption, idx) => (
              <li key={idx} className="flex items-start gap-2 text-xs text-neutral-400">
                <span className="text-neutral-600 mt-0.5">•</span>
                <span>{assumption}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Disclaimer */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2">
        <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-400/80">
          Forecasts are based on historical patterns and may not account for external factors or market changes.
        </p>
      </div>
    </div>
  )
}

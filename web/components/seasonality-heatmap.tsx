interface SeasonalityHeatmapProps {
  peakMonths: number[]
  lowMonths: number[]
  monthWeights?: number[]
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function SeasonalityHeatmap({ peakMonths, lowMonths, monthWeights = [] }: SeasonalityHeatmapProps) {
  const getMonthColor = (month: number): string => {
    if (peakMonths.includes(month)) {
      return "bg-emerald-500/40 border-emerald-500/60 text-emerald-300"
    }
    if (lowMonths.includes(month)) {
      return "bg-red-500/20 border-red-500/40 text-red-300"
    }
    return "bg-zinc-700/30 border-zinc-600/40 text-zinc-400"
  }

  const getMonthWeight = (month: number): string => {
    const weight = monthWeights[month - 1] || 1
    if (weight > 1.3) return "Very High"
    if (weight > 1) return "High"
    if (weight < 0.7) return "Low"
    return "Normal"
  }

  return (
    <div className="space-y-3">
      {/* Legend */}
      <div className="flex items-center gap-4 text-xs">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-emerald-500/40 border border-emerald-500/60" />
          <span className="text-neutral-400">Peak</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-zinc-700/30 border border-zinc-600/40" />
          <span className="text-neutral-400">Normal</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-red-500/20 border border-red-500/40" />
          <span className="text-neutral-400">Low</span>
        </div>
      </div>

      {/* Heatmap Grid */}
      <div className="grid grid-cols-6 gap-2">
        {MONTH_NAMES.map((month, idx) => {
          const monthNum = idx + 1
          const colorClass = getMonthColor(monthNum)
          const weight = getMonthWeight(monthNum)

          return (
            <div
              key={month}
              className={`p-2 rounded border text-center cursor-help transition-all hover:scale-105 ${colorClass}`}
              title={`${month}: ${weight} activity`}
            >
              <div className="text-xs font-semibold">{month}</div>
              <div className="text-[10px] opacity-75 mt-1">{weight}</div>
            </div>
          )
        })}
      </div>

      {/* Summary */}
      <div className="text-xs text-neutral-500 pt-2 border-t border-white/[0.06]">
        {peakMonths.length > 0 && (
          <p>
            Peak months: <span className="text-emerald-400">{peakMonths.map((m) => MONTH_NAMES[m - 1]).join(", ")}</span>
          </p>
        )}
        {lowMonths.length > 0 && (
          <p>
            Low months: <span className="text-red-400">{lowMonths.map((m) => MONTH_NAMES[m - 1]).join(", ")}</span>
          </p>
        )}
        {peakMonths.length === 0 && lowMonths.length === 0 && (
          <p>No significant seasonal patterns detected</p>
        )}
      </div>
    </div>
  )
}

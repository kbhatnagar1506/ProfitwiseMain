import { AlertCircle, TrendingDown, TrendingUp, Minus } from "lucide-react"

interface RiskGaugeProps {
  score: number
  factors: string[]
  recentTrend?: "improving" | "stable" | "deteriorating"
}

export function RiskGauge({ score, factors, recentTrend = "stable" }: RiskGaugeProps) {
  const normalizedScore = Math.min(100, Math.max(0, score))
  const riskLevel = normalizedScore < 35 ? "Low" : normalizedScore < 60 ? "Medium" : "High"
  const riskColor =
    normalizedScore < 35
      ? "text-emerald-400"
      : normalizedScore < 60
        ? "text-amber-400"
        : "text-red-400"
  const bgColor =
    normalizedScore < 35
      ? "bg-emerald-500/10"
      : normalizedScore < 60
        ? "bg-amber-500/10"
        : "bg-red-500/10"
  const borderColor =
    normalizedScore < 35
      ? "border-emerald-500/20"
      : normalizedScore < 60
        ? "border-amber-500/20"
        : "border-red-500/20"

  const trendIcon =
    recentTrend === "improving" ? (
      <TrendingUp className="w-4 h-4 text-emerald-400" />
    ) : recentTrend === "deteriorating" ? (
      <TrendingDown className="w-4 h-4 text-red-400" />
    ) : (
      <Minus className="w-4 h-4 text-zinc-400" />
    )

  return (
    <div className={`${bgColor} border ${borderColor} rounded-lg p-4 space-y-3`}>
      {/* Risk Score Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertCircle className={`w-5 h-5 ${riskColor}`} />
          <span className="text-sm font-medium text-neutral-400">Risk Score</span>
        </div>
        <div className="flex items-center gap-2">
          {trendIcon}
          <span className="text-xs text-neutral-500 capitalize">{recentTrend}</span>
        </div>
      </div>

      {/* Risk Gauge Bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className={`text-2xl font-bold ${riskColor}`}>{normalizedScore}</span>
          <span className={`text-xs font-medium ${riskColor}`}>{riskLevel} Risk</span>
        </div>
        <div className="w-full bg-zinc-700 rounded-full h-2 overflow-hidden">
          <div
            className={`h-full transition-all ${
              normalizedScore < 35
                ? "bg-emerald-500"
                : normalizedScore < 60
                  ? "bg-amber-500"
                  : "bg-red-500"
            }`}
            style={{ width: `${normalizedScore}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-neutral-600">
          <span>Low</span>
          <span>Medium</span>
          <span>High</span>
        </div>
      </div>

      {/* Risk Factors */}
      {factors.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-white/[0.06]">
          <p className="text-xs font-medium text-neutral-500">Risk Factors</p>
          <ul className="space-y-1">
            {factors.map((factor, idx) => (
              <li key={idx} className="flex items-start gap-2 text-xs text-neutral-400">
                <span className="text-neutral-600 mt-0.5">•</span>
                <span>{factor}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

import { CheckCircle, AlertCircle, Info } from "lucide-react"

interface DataQualityScoreProps {
  transactionCount: number
  dataSpanMonths: number
  dueDateCoverage: number
  consistencyScore: number
}

export function DataQualityScore({
  transactionCount,
  dataSpanMonths,
  dueDateCoverage,
  consistencyScore,
}: DataQualityScoreProps) {
  // Calculate overall quality rating
  const qualityScore =
    (Math.min(transactionCount / 50, 1) * 0.3 +
      Math.min(dataSpanMonths / 12, 1) * 0.3 +
      dueDateCoverage * 0.2 +
      consistencyScore * 0.2) *
    100

  const qualityLevel =
    qualityScore >= 70 ? "High" : qualityScore >= 40 ? "Medium" : "Low"
  const qualityColor =
    qualityScore >= 70
      ? "text-emerald-400"
      : qualityScore >= 40
        ? "text-amber-400"
        : "text-red-400"
  const bgColor =
    qualityScore >= 70
      ? "bg-emerald-500/10"
      : qualityScore >= 40
        ? "bg-amber-500/10"
        : "bg-red-500/10"
  const borderColor =
    qualityScore >= 70
      ? "border-emerald-500/20"
      : qualityScore >= 40
        ? "border-amber-500/20"
        : "border-red-500/20"

  const metrics = [
    {
      label: "Transactions",
      value: transactionCount,
      target: 50,
      icon: transactionCount >= 50 ? CheckCircle : AlertCircle,
    },
    {
      label: "Data Span",
      value: `${dataSpanMonths}mo`,
      target: "12mo",
      icon: dataSpanMonths >= 12 ? CheckCircle : AlertCircle,
    },
    {
      label: "Due Date Coverage",
      value: `${Math.round(dueDateCoverage * 100)}%`,
      target: "100%",
      icon: dueDateCoverage >= 0.8 ? CheckCircle : AlertCircle,
    },
    {
      label: "Consistency",
      value: `${Math.round(consistencyScore * 100)}%`,
      target: "100%",
      icon: consistencyScore >= 0.7 ? CheckCircle : AlertCircle,
    },
  ]

  return (
    <div className={`${bgColor} border ${borderColor} rounded-lg p-4 space-y-3`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Info className={`w-5 h-5 ${qualityColor}`} />
          <span className="text-sm font-medium text-neutral-400">Data Quality</span>
        </div>
        <span className={`text-xs font-medium px-2 py-1 rounded ${qualityColor} bg-white/5`}>
          {qualityLevel}
        </span>
      </div>

      {/* Quality Score Bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className={`text-lg font-bold ${qualityColor}`}>{Math.round(qualityScore)}</span>
          <span className="text-xs text-neutral-500">/ 100</span>
        </div>
        <div className="w-full bg-zinc-700 rounded-full h-1.5 overflow-hidden">
          <div
            className={`h-full transition-all ${
              qualityScore >= 70
                ? "bg-emerald-500"
                : qualityScore >= 40
                  ? "bg-amber-500"
                  : "bg-red-500"
            }`}
            style={{ width: `${qualityScore}%` }}
          />
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-white/[0.06]">
        {metrics.map((metric) => {
          const Icon = metric.icon
          return (
            <div key={metric.label} className="space-y-1">
              <div className="flex items-center gap-1">
                <Icon className="w-3.5 h-3.5 text-neutral-600" />
                <span className="text-xs text-neutral-500">{metric.label}</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-sm font-semibold text-neutral-300">{metric.value}</span>
                <span className="text-[10px] text-neutral-600">/ {metric.target}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Interpretation */}
      <div className="text-xs text-neutral-500 pt-2 border-t border-white/[0.06]">
        {qualityScore >= 70 && (
          <p>
            ✓ Excellent data quality. Forecasts and metrics are highly reliable.
          </p>
        )}
        {qualityScore >= 40 && qualityScore < 70 && (
          <p>
            ⚠ Moderate data quality. Use forecasts with caution. More data needed for accuracy.
          </p>
        )}
        {qualityScore < 40 && (
          <p>
            ✗ Limited data quality. Forecasts are conservative estimates. Gather more history.
          </p>
        )}
      </div>
    </div>
  )
}

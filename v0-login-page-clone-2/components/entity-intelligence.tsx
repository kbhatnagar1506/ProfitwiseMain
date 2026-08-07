import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown, Minus, AlertCircle } from "lucide-react"

export function PaymentBehaviorCell({
  avgDays,
  stdDays,
}: {
  avgDays: number
  stdDays: number
}) {
  if (avgDays === 0 && stdDays === 0) {
    return (
      <div className="text-[12px] font-medium text-neutral-500">
        Not available
      </div>
    )
  }
  const displayDays = Math.round(avgDays)
  const displayStd = Math.round(stdDays)
  return (
    <div className="text-[12px] font-medium text-neutral-300 tabular-nums">
      <span className="text-zinc-100">Pays in {displayDays}d</span>
      <span className="text-zinc-500"> ±{displayStd}d</span>
    </div>
  )
}

export function OnTimeRateCell({ rate }: { rate: number }) {
  if (rate === 0) {
    return (
      <div className="text-[12px] font-medium text-neutral-500">
        Not available
      </div>
    )
  }
  const displayRate = Math.round(rate)
  let colorClass = "text-emerald-400/90"

  if (displayRate < 70) {
    colorClass = "text-red-400/90"
  } else if (displayRate < 85) {
    colorClass = "text-amber-400/90"
  }

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-12 bg-zinc-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-emerald-400 transition-all"
          style={{ width: `${Math.min(displayRate, 100)}%` }}
        />
      </div>
      <span className={`text-[12px] font-medium ${colorClass} w-10 text-right`}>
        {displayRate}%
      </span>
    </div>
  )
}

export function TrendIndicator({
  trend,
}: {
  trend: "increasing" | "decreasing" | "stable"
}) {
  if (trend === "increasing") {
    return (
      <div className="flex items-center gap-1.5 text-emerald-400/90">
        <TrendingUp className="h-3.5 w-3.5" />
        <span className="text-[11px] font-medium">Increasing</span>
      </div>
    )
  } else if (trend === "decreasing") {
    return (
      <div className="flex items-center gap-1.5 text-red-400/90">
        <TrendingDown className="h-3.5 w-3.5" />
        <span className="text-[11px] font-medium">Decreasing</span>
      </div>
    )
  } else {
    return (
      <div className="flex items-center gap-1.5 text-zinc-500">
        <Minus className="h-3.5 w-3.5" />
        <span className="text-[11px] font-medium">Stable</span>
      </div>
    )
  }
}

export function RiskBadge({ score }: { score: number }) {
  let bgClass = "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
  let label = "Low"

  if (score >= 60) {
    bgClass = "bg-red-500/10 text-red-400 border-red-500/20"
    label = "High"
  } else if (score >= 35) {
    bgClass = "bg-amber-500/10 text-amber-400 border-amber-500/20"
    label = "Med"
  }

  return (
    <Badge variant="secondary" className={`text-[10px] h-5 ${bgClass}`}>
      {label}
    </Badge>
  )
}

export function RiskFactorsList({ factors }: { factors: string[] }) {
  if (factors.length === 0) {
    return (
      <p className="text-[12px] text-emerald-400/90">
        ✓ No significant risk factors
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {factors.map((factor, idx) => (
        <div key={idx} className="flex items-start gap-2">
          <AlertCircle className="h-3.5 w-3.5 text-amber-400/90 mt-0.5 flex-shrink-0" />
          <span className="text-[12px] text-neutral-300">{factor}</span>
        </div>
      ))}
    </div>
  )
}

export function MonthChart({ peakMonths, lowMonths }: { peakMonths: number[]; lowMonths: number[] }) {
  const monthLabels = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"]

  return (
    <div className="flex items-end gap-1">
      {monthLabels.map((label, idx) => {
        const month = idx + 1
        const isPeak = peakMonths.includes(month)
        const isLow = lowMonths.includes(month)

        return (
          <div key={idx} className="flex flex-col items-center gap-1">
            <div
              className={`w-5 h-8 rounded-sm transition-colors ${
                isPeak
                  ? "bg-emerald-500/60"
                  : isLow
                    ? "bg-zinc-700/40"
                    : "bg-zinc-700/20"
              }`}
            />
            <span className="text-[10px] text-zinc-500 font-medium">{label}</span>
          </div>
        )
      })}
    </div>
  )
}

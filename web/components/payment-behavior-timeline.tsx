interface PaymentBehaviorTimelineProps {
  avgDaysToPay: number
  stdDaysToPay: number
  onTimeRate: number
  earlyRate: number
  transactionsPerMonth: number
  amountTrend: "increasing" | "decreasing" | "stable"
}

export function PaymentBehaviorTimeline({
  avgDaysToPay,
  stdDaysToPay,
  onTimeRate,
  earlyRate,
  transactionsPerMonth,
  amountTrend,
}: PaymentBehaviorTimelineProps) {
  const metrics = [
    {
      label: "Days to Pay",
      value: avgDaysToPay === 0 ? "N/A" : `${Math.round(avgDaysToPay)}d`,
      variance: stdDaysToPay === 0 ? "" : `±${Math.round(stdDaysToPay)}d`,
      color: avgDaysToPay < 0 ? "emerald" : avgDaysToPay < 30 ? "blue" : "amber",
      icon: "📅",
    },
    {
      label: "On-Time Rate",
      value: onTimeRate === 0 ? "N/A" : `${Math.round(onTimeRate)}%`,
      variance: "",
      color: onTimeRate >= 85 ? "emerald" : onTimeRate >= 70 ? "blue" : "red",
      icon: "✓",
    },
    {
      label: "Frequency",
      value: `${transactionsPerMonth.toFixed(1)}/mo`,
      variance: "",
      color: transactionsPerMonth >= 5 ? "emerald" : transactionsPerMonth >= 1 ? "blue" : "amber",
      icon: "📊",
    },
    {
      label: "Amount Trend",
      value: amountTrend === "increasing" ? "↑ Growing" : amountTrend === "decreasing" ? "↓ Declining" : "→ Stable",
      variance: "",
      color: amountTrend === "increasing" ? "emerald" : amountTrend === "decreasing" ? "red" : "zinc",
      icon: "📈",
    },
  ]

  const getColorClasses = (color: string) => {
    switch (color) {
      case "emerald":
        return "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
      case "blue":
        return "bg-blue-500/10 border-blue-500/20 text-blue-400"
      case "amber":
        return "bg-amber-500/10 border-amber-500/20 text-amber-400"
      case "red":
        return "bg-red-500/10 border-red-500/20 text-red-400"
      default:
        return "bg-zinc-500/10 border-zinc-500/20 text-zinc-400"
    }
  }

  return (
    <div className="space-y-2">
      {metrics.map((metric) => (
        <div
          key={metric.label}
          className={`border rounded-lg p-3 ${getColorClasses(metric.color)}`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg">{metric.icon}</span>
              <div>
                <p className="text-xs font-medium text-neutral-400">{metric.label}</p>
                <p className="text-sm font-semibold mt-0.5">
                  {metric.value}
                  {metric.variance && <span className="text-xs font-normal ml-1">{metric.variance}</span>}
                </p>
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* Early Payment Indicator */}
      {earlyRate > 0 && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3 text-emerald-400">
          <p className="text-xs font-medium">💰 Early Payer</p>
          <p className="text-sm font-semibold mt-1">{Math.round(earlyRate)}% pay early</p>
        </div>
      )}
    </div>
  )
}

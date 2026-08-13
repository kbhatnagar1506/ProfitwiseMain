import { Clock, Zap, TrendingUp, AlertTriangle } from "lucide-react"

interface ArchetypeInsightsProps {
  archetype: "Clockwork" | "Bursty" | "Volatile" | "New" | "Slow Reliable"
}

const archetypeData = {
  Clockwork: {
    icon: Clock,
    description: "Highly predictable payment behavior",
    riskLevel: "Low",
    recommendations: [
      "Optimize payment terms - they'll likely pay on time",
      "Consider early payment discounts",
      "Reliable for cash flow forecasting",
    ],
  },
  "Slow Reliable": {
    icon: TrendingUp,
    description: "Consistent but takes longer to pay",
    riskLevel: "Low",
    recommendations: [
      "Plan for extended payment cycles",
      "Consider supply chain financing",
      "Reliable despite longer terms",
    ],
  },
  Bursty: {
    icon: Zap,
    description: "Irregular timing but eventually pays",
    riskLevel: "Medium",
    recommendations: [
      "Monitor payment frequency",
      "Use wider confidence intervals for forecasts",
      "Watch for frequency drops",
    ],
  },
  Volatile: {
    icon: AlertTriangle,
    description: "Unpredictable payment patterns",
    riskLevel: "High",
    recommendations: [
      "Require upfront deposits or shorter terms",
      "Monitor closely for deterioration",
      "Consider credit limits",
    ],
  },
  New: {
    icon: TrendingUp,
    description: "Insufficient transaction history",
    riskLevel: "Medium",
    recommendations: [
      "Gather more transaction data",
      "Start with conservative terms",
      "Monitor closely as history builds",
    ],
  },
}

export function ArchetypeInsights({ archetype }: ArchetypeInsightsProps) {
  const data = archetypeData[archetype]
  const Icon = data.icon

  const riskColor =
    data.riskLevel === "Low"
      ? "text-emerald-400"
      : data.riskLevel === "Medium"
        ? "text-amber-400"
        : "text-red-400"

  const bgColor =
    data.riskLevel === "Low"
      ? "bg-emerald-500/10"
      : data.riskLevel === "Medium"
        ? "bg-amber-500/10"
        : "bg-red-500/10"

  const borderColor =
    data.riskLevel === "Low"
      ? "border-emerald-500/20"
      : data.riskLevel === "Medium"
        ? "border-amber-500/20"
        : "border-red-500/20"

  return (
    <div className={`${bgColor} border ${borderColor} rounded-lg p-4 space-y-3`}>
      {/* Header */}
      <div className="flex items-start gap-3">
        <Icon className={`w-5 h-5 ${riskColor} flex-shrink-0 mt-0.5`} />
        <div className="flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">{archetype}</h3>
            <span className={`text-xs font-medium px-2 py-1 rounded ${riskColor} bg-white/5`}>
              {data.riskLevel} Risk
            </span>
          </div>
          <p className="text-xs text-neutral-400 mt-1">{data.description}</p>
        </div>
      </div>

      {/* Recommendations */}
      <div className="space-y-2 pt-2 border-t border-white/[0.06]">
        <p className="text-xs font-medium text-neutral-500">Recommendations</p>
        <ul className="space-y-1.5">
          {data.recommendations.map((rec, idx) => (
            <li key={idx} className="flex items-start gap-2 text-xs text-neutral-400">
              <span className="text-neutral-600 mt-0.5 flex-shrink-0">→</span>
              <span>{rec}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

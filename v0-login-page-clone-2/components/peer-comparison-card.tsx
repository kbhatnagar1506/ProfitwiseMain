import { TrendingUp, TrendingDown } from "lucide-react"

interface PeerComparisonCardProps {
  entityName: string
  archetype: string
  metrics: {
    reliabilityScore: number
    riskScore: number
    avgDaysToPay: number
    transactionsPerMonth: number
  }
  peerPercentiles: {
    reliabilityScore: number
    riskScore: number
    avgDaysToPay: number
    transactionsPerMonth: number
  }
}

export function PeerComparisonCard({
  entityName,
  archetype,
  metrics,
  peerPercentiles,
}: PeerComparisonCardProps) {
  const comparisons = [
    {
      label: "Reliability",
      value: Math.round(metrics.reliabilityScore),
      percentile: peerPercentiles.reliabilityScore,
      higher: true,
    },
    {
      label: "Risk Score",
      value: Math.round(metrics.riskScore),
      percentile: peerPercentiles.riskScore,
      higher: false,
    },
    {
      label: "Payment Speed",
      value: Math.round(metrics.avgDaysToPay),
      percentile: peerPercentiles.avgDaysToPay,
      higher: false,
    },
    {
      label: "Activity",
      value: Math.round(metrics.transactionsPerMonth * 10) / 10,
      percentile: peerPercentiles.transactionsPerMonth,
      higher: true,
    },
  ]

  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-4 space-y-3">
      {/* Header */}
      <div className="space-y-1">
        <p className="text-xs font-medium text-neutral-500">Peer Comparison</p>
        <p className="text-sm text-neutral-400">
          vs. other {archetype} entities
        </p>
      </div>

      {/* Comparisons */}
      <div className="space-y-2">
        {comparisons.map((comp) => {
          const isAboveAverage =
            (comp.higher && comp.percentile > 50) ||
            (!comp.higher && comp.percentile < 50)
          const percentileText = `${Math.round(comp.percentile)}th percentile`

          return (
            <div key={comp.label} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-neutral-500">{comp.label}</span>
                <div className="flex items-center gap-1">
                  {isAboveAverage ? (
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <TrendingDown className="w-3.5 h-3.5 text-amber-400" />
                  )}
                  <span className="text-xs font-medium text-neutral-300">
                    {comp.value}
                  </span>
                </div>
              </div>

              {/* Percentile Bar */}
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${
                      isAboveAverage ? "bg-emerald-500/60" : "bg-amber-500/60"
                    }`}
                    style={{ width: `${comp.percentile}%` }}
                  />
                </div>
                <span className="text-[10px] text-neutral-600 w-12 text-right">
                  {percentileText}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Summary */}
      <div className="pt-2 border-t border-white/[0.06]">
        <p className="text-xs text-neutral-500">
          {entityName} is{" "}
          <span className="text-neutral-300 font-medium">
            better than{" "}
            {Math.round(
              (peerPercentiles.reliabilityScore +
                (100 - peerPercentiles.riskScore) +
                (100 - peerPercentiles.avgDaysToPay) +
                peerPercentiles.transactionsPerMonth) /
                4
            )}
            %
          </span>{" "}
          of {archetype} peers
        </p>
      </div>
    </div>
  )
}

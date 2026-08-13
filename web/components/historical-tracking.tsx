import { TrendingUp, TrendingDown, Milestone } from "lucide-react"

interface Milestone {
  date: string
  event: string
  value?: string
}

interface HistoricalTrackingProps {
  archetypeHistory: Array<{ date: string; archetype: string }>
  riskScoreHistory: Array<{ date: string; score: number }>
  reliabilityHistory: Array<{ date: string; score: number }>
  milestones: Milestone[]
}

export function HistoricalTracking({
  archetypeHistory,
  riskScoreHistory,
  reliabilityHistory,
  milestones,
}: HistoricalTrackingProps) {
  const currentArchetype = archetypeHistory[archetypeHistory.length - 1]?.archetype || "Unknown"
  const archetypeChanges = archetypeHistory.filter(
    (item, idx) => idx === 0 || item.archetype !== archetypeHistory[idx - 1].archetype
  )

  const avgRiskScore =
    riskScoreHistory.length > 0
      ? riskScoreHistory.reduce((sum, item) => sum + item.score, 0) / riskScoreHistory.length
      : 0

  const avgReliability =
    reliabilityHistory.length > 0
      ? reliabilityHistory.reduce((sum, item) => sum + item.score, 0) / reliabilityHistory.length
      : 0

  return (
    <div className="space-y-4">
      {/* Archetype Evolution */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
        <p className="text-xs font-medium text-neutral-500 mb-3">Archetype Evolution</p>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-neutral-300">Current: {currentArchetype}</span>
            <span className="text-xs text-neutral-600">{archetypeChanges.length} changes</span>
          </div>
          {archetypeChanges.length > 1 && (
            <div className="text-xs text-neutral-500 space-y-1">
              {archetypeChanges.slice(-3).map((item, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <span className="text-neutral-600">→</span>
                  <span>{item.archetype}</span>
                  <span className="text-neutral-700">({new Date(item.date).toLocaleDateString()})</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Risk Score Trend */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
        <p className="text-xs font-medium text-neutral-500 mb-3">Risk Score Trend</p>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-neutral-300">Average: {Math.round(avgRiskScore)}</span>
            {riskScoreHistory.length > 1 && (
              <div className="flex items-center gap-1">
                {riskScoreHistory[riskScoreHistory.length - 1].score >
                riskScoreHistory[0].score ? (
                  <TrendingUp className="w-4 h-4 text-red-400" />
                ) : (
                  <TrendingDown className="w-4 h-4 text-emerald-400" />
                )}
                <span className="text-xs text-neutral-600">
                  {Math.round(riskScoreHistory[riskScoreHistory.length - 1].score)} now
                </span>
              </div>
            )}
          </div>
          <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${
                avgRiskScore >= 60
                  ? "bg-red-500/60"
                  : avgRiskScore >= 35
                    ? "bg-amber-500/60"
                    : "bg-emerald-500/60"
              }`}
              style={{ width: `${Math.min(avgRiskScore, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Reliability Score Trend */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
        <p className="text-xs font-medium text-neutral-500 mb-3">Reliability Trend</p>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-neutral-300">Average: {Math.round(avgReliability)}%</span>
            {reliabilityHistory.length > 1 && (
              <div className="flex items-center gap-1">
                {reliabilityHistory[reliabilityHistory.length - 1].score >
                reliabilityHistory[0].score ? (
                  <TrendingUp className="w-4 h-4 text-emerald-400" />
                ) : (
                  <TrendingDown className="w-4 h-4 text-red-400" />
                )}
                <span className="text-xs text-neutral-600">
                  {Math.round(reliabilityHistory[reliabilityHistory.length - 1].score)}% now
                </span>
              </div>
            )}
          </div>
          <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500/60 transition-all"
              style={{ width: `${Math.min(avgReliability, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Milestones */}
      {milestones.length > 0 && (
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
          <p className="text-xs font-medium text-neutral-500 mb-3">Milestones</p>
          <div className="space-y-2">
            {milestones.slice(-5).map((milestone, idx) => (
              <div key={idx} className="flex items-start gap-2">
                <Milestone className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-xs font-medium text-neutral-300">{milestone.event}</p>
                  <p className="text-[10px] text-neutral-600">
                    {new Date(milestone.date).toLocaleDateString()}
                    {milestone.value && ` • ${milestone.value}`}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

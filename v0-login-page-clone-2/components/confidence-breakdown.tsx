"use client"

/**
 * ConfidenceBreakdown: shows the per-signal breakdown of an AI confidence score.
 *
 * Usage:
 *   <ConfidenceBreakdown breakdown={match.confidence_detail?.components?.breakdown} />
 *
 * The component is compact (designed to sit below the existing confidence bar)
 * and only renders when full breakdown data is available.
 */

interface BreakdownSignal {
  score: number
  weight: number
  reasoning: string
}

interface BreakdownData {
  summary: string
  components: {
    amount: BreakdownSignal
    entity_name: BreakdownSignal
    date_proximity: BreakdownSignal
    history: BreakdownSignal
    category: BreakdownSignal
    match_sequence: BreakdownSignal
  }
  waterfall_stage?: string
  match_method?: string
}

interface ConfidenceBreakdownProps {
  breakdown?: BreakdownData | null
  /** Show full expanded breakdown (default: compact) */
  expanded?: boolean
  className?: string
}

const SIGNAL_LABELS: Record<string, string> = {
  amount: "Amount",
  entity_name: "Name",
  date_proximity: "Date",
  history: "History",
  category: "Category",
  match_sequence: "Sequence",
}

const SIGNAL_ORDER = ["amount", "entity_name", "date_proximity", "history", "category", "match_sequence"] as const

function ScoreBar({ score, tier }: { score: number; tier: "high" | "med" | "low" }) {
  const color =
    tier === "high" ? "bg-emerald-500"
    : tier === "med" ? "bg-amber-500"
    : "bg-zinc-600"
  return (
    <div className="w-full h-1 bg-white/[0.06] rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-none ${color}`}
        style={{ width: `${Math.round(score * 100)}%` }}
      />
    </div>
  )
}

function signalTier(score: number): "high" | "med" | "low" {
  if (score >= 0.80) return "high"
  if (score >= 0.60) return "med"
  return "low"
}

/** Compact view: 6 signal mini-bars in a grid */
function CompactBreakdown({ breakdown }: { breakdown: BreakdownData }) {
  return (
    <div className="mt-3 space-y-1.5">
      <p className="text-[9px] text-zinc-600 uppercase tracking-widest font-medium mb-2">Signal Breakdown</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {SIGNAL_ORDER.map((key) => {
          const signal = breakdown.components[key]
          if (!signal) return null
          const tier = signalTier(signal.score)
          const pct = Math.round(signal.score * 100)
          return (
            <div key={key}>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[9px] text-zinc-500">{SIGNAL_LABELS[key]}</span>
                <span className={`text-[9px] font-mono tabular-nums ${
                  tier === "high" ? "text-emerald-400"
                  : tier === "med" ? "text-amber-400"
                  : "text-zinc-500"
                }`}>
                  {pct}%
                </span>
              </div>
              <ScoreBar score={signal.score} tier={tier} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Expanded view: reasoning text per signal */
function ExpandedBreakdown({ breakdown }: { breakdown: BreakdownData }) {
  return (
    <div className="space-y-2">
      <p className="text-[9px] text-zinc-600 uppercase tracking-widest font-medium">Confidence Breakdown</p>
      {SIGNAL_ORDER.map((key) => {
        const signal = breakdown.components[key]
        if (!signal) return null
        const tier = signalTier(signal.score)
        const pct = Math.round(signal.score * 100)
        return (
          <div key={key} className="bg-white/[0.03] rounded-lg px-3 py-2 border border-white/[0.05]">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-zinc-300 font-medium">{SIGNAL_LABELS[key]}</span>
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-zinc-500">weight {Math.round(signal.weight * 100)}%</span>
                <span className={`text-[11px] font-mono font-bold tabular-nums ${
                  tier === "high" ? "text-emerald-400"
                  : tier === "med" ? "text-amber-400"
                  : "text-zinc-500"
                }`}>
                  {pct}%
                </span>
              </div>
            </div>
            <ScoreBar score={signal.score} tier={tier} />
            <p className="text-[9px] text-zinc-500 mt-1 leading-relaxed">{signal.reasoning}</p>
          </div>
        )
      })}
      {breakdown.waterfall_stage && (
        <p className="text-[9px] text-zinc-600 mt-1">
          Stage: <span className="text-zinc-400 font-mono">{breakdown.waterfall_stage}</span>
        </p>
      )}
    </div>
  )
}

export function ConfidenceBreakdown({ breakdown, expanded = false, className = "" }: ConfidenceBreakdownProps) {
  if (!breakdown?.components) return null

  return (
    <div className={className}>
      {expanded
        ? <ExpandedBreakdown breakdown={breakdown} />
        : <CompactBreakdown breakdown={breakdown} />
      }
    </div>
  )
}

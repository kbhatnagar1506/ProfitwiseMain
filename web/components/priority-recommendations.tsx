import { AlertCircle, CheckCircle, AlertTriangle, Info } from "lucide-react"

interface Recommendation {
  priority: "critical" | "high" | "medium" | "low"
  title: string
  description: string
  action?: string
  impact?: string
}

interface PriorityRecommendationsProps {
  recommendations: Recommendation[]
}

export function PriorityRecommendations({ recommendations }: PriorityRecommendationsProps) {
  const grouped = {
    critical: recommendations.filter((r) => r.priority === "critical"),
    high: recommendations.filter((r) => r.priority === "high"),
    medium: recommendations.filter((r) => r.priority === "medium"),
    low: recommendations.filter((r) => r.priority === "low"),
  }

  const getPriorityIcon = (priority: string) => {
    switch (priority) {
      case "critical":
        return <AlertCircle className="w-4 h-4 text-red-400" />
      case "high":
        return <AlertTriangle className="w-4 h-4 text-amber-400" />
      case "medium":
        return <Info className="w-4 h-4 text-blue-400" />
      default:
        return <CheckCircle className="w-4 h-4 text-zinc-400" />
    }
  }

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "critical":
        return "bg-red-500/10 border-red-500/20"
      case "high":
        return "bg-amber-500/10 border-amber-500/20"
      case "medium":
        return "bg-blue-500/10 border-blue-500/20"
      default:
        return "bg-zinc-500/10 border-zinc-500/20"
    }
  }

  const getPriorityLabel = (priority: string) => {
    switch (priority) {
      case "critical":
        return "CRITICAL"
      case "high":
        return "HIGH"
      case "medium":
        return "MEDIUM"
      default:
        return "LOW"
    }
  }

  const renderGroup = (priority: string, items: Recommendation[]) => {
    if (items.length === 0) return null

    return (
      <div key={priority} className="space-y-2">
        <p className="text-xs font-medium text-neutral-500 uppercase">{getPriorityLabel(priority)} Priority</p>
        <div className="space-y-2">
          {items.map((rec, idx) => (
            <div key={idx} className={`border rounded-lg p-3 ${getPriorityColor(rec.priority)}`}>
              <div className="flex items-start gap-2">
                {getPriorityIcon(rec.priority)}
                <div className="flex-1">
                  <p className="text-sm font-semibold text-neutral-300">{rec.title}</p>
                  <p className="text-xs text-neutral-400 mt-1">{rec.description}</p>
                  {rec.impact && (
                    <p className="text-xs text-neutral-500 mt-2">
                      <span className="font-medium">Impact:</span> {rec.impact}
                    </p>
                  )}
                  {rec.action && (
                    <p className="text-xs text-neutral-500 mt-2">
                      <span className="font-medium">Action:</span> {rec.action}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {renderGroup("critical", grouped.critical)}
      {renderGroup("high", grouped.high)}
      {renderGroup("medium", grouped.medium)}
      {renderGroup("low", grouped.low)}

      {recommendations.length === 0 && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
          <p className="text-xs text-emerald-400 font-medium">✓ No recommendations at this time</p>
          <p className="text-xs text-emerald-400/70 mt-1">This entity is performing well with no immediate actions needed.</p>
        </div>
      )}
    </div>
  )
}

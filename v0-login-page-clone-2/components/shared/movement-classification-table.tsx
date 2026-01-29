"use client"

import { useState } from "react"
import { CLASS_META, money } from "@/lib/dashboard-helpers"

interface Movement {
  id: string
  occurred_at: string
  direction: "in" | "out"
  amount: number
  raw_description: string | null
  movement_class: string
  confidence: number
  needs_review: boolean
}

interface MovementClassificationTableProps {
  movements: Movement[]
  loading?: boolean
  error?: string | null
}

export function MovementClassificationTable({
  movements,
  loading = false,
  error = null,
}: MovementClassificationTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-gray-400">
          <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          <span>Loading movements...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-4 py-3">
        <p className="text-red-300 text-sm">{error}</p>
      </div>
    )
  }

  if (movements.length === 0) {
    return (
      <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
        <p className="text-gray-400 text-sm">No movements to display.</p>
      </div>
    )
  }

  const needsReview = movements.filter((m) => m.needs_review)
  const classified = movements.filter((m) => !m.needs_review)

  return (
    <div className="space-y-6">
      {/* Review Queue */}
      {needsReview.length > 0 && (
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10 bg-white/[0.02]">
            <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider">Needs Review ({needsReview.length})</h3>
          </div>
          <div className="divide-y divide-white/10">
            {needsReview.map((m) => {
              const meta = CLASS_META[m.movement_class]
              const expanded = expandedId === m.id
              return (
                <div key={m.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : m.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-left"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {meta && <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-semibold text-white ${meta.color}`}>{meta.label}</span>}
                        <span className={`text-xs font-medium ${m.direction === "in" ? "text-emerald-400/90" : "text-zinc-400"}`}>
                          {m.direction === "in" ? "↑ In" : "↓ Out"}
                        </span>
                      </div>
                      <div className="text-sm text-gray-300 truncate">{m.raw_description || "No description"}</div>
                      <div className="text-xs text-gray-500 mt-1">
                        {new Date(m.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right">
                        <div className={`text-sm font-semibold tabular-nums ${m.direction === "in" ? "text-emerald-400/90" : "text-zinc-400"}`}>
                          {m.direction === "in" ? "+" : "-"}
                          {money(m.amount)}
                        </div>
                        <div className="text-xs text-gray-500 tabular-nums">{Math.round(m.confidence * 100)}% conf</div>
                      </div>
                      <svg
                        className={`w-4 h-4 text-gray-500 transition-transform ${expanded ? "rotate-180" : ""}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>
                  {expanded && (
                    <div className="px-4 pb-3 bg-white/[0.02] border-l-2 border-white/10 ml-4">
                      <div className="text-xs text-gray-400 space-y-1">
                        <div>
                          <span className="text-gray-500">Classification:</span> {meta?.label || "Unknown"}
                        </div>
                        <div>
                          <span className="text-gray-500">Confidence:</span> {Math.round(m.confidence * 100)}%
                        </div>
                        <div>
                          <span className="text-gray-500">Date:</span> {new Date(m.occurred_at).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Classified Movements */}
      {classified.length > 0 && (
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10 bg-white/[0.02]">
            <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider">Classified ({classified.length})</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 bg-white/[0.02]">
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Date</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Description</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Classification</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider tabular-nums">Amount</th>
                  <th className="px-4 py-2 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">Confidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {classified.slice(0, 20).map((m) => {
                  const meta = CLASS_META[m.movement_class]
                  return (
                    <tr key={m.id} className="hover:bg-white/[0.03] transition-colors">
                      <td className="px-4 py-2 text-gray-400 text-xs">
                        {new Date(m.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </td>
                      <td className="px-4 py-2 text-gray-300 truncate max-w-xs">{m.raw_description || "—"}</td>
                      <td className="px-4 py-2">
                        {meta && <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-semibold text-white ${meta.color}`}>{meta.label}</span>}
                      </td>
                      <td className={`px-4 py-2 text-right font-medium tabular-nums ${m.direction === "in" ? "text-emerald-400/90" : "text-zinc-400"}`}>
                        {m.direction === "in" ? "+" : "-"}
                        {money(m.amount)}
                      </td>
                      <td className="px-4 py-2 text-center text-xs text-gray-400">{Math.round(m.confidence * 100)}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

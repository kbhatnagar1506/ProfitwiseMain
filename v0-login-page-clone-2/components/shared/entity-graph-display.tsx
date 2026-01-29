"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { sourceColor, typeColor, typeLabel, confPct, confColor } from "@/lib/dashboard-helpers"

interface IdentityEntity {
  id: string
  entity_type: string
  canonical_name: string
  display_name: string | null
  domain: string | null
  confidence: number
  metadata: Record<string, unknown>
  created_at: string
  source_count: number
  evidence_count: number
  sources: string[]
}

interface IdentityAlias {
  id: string
  entity_id: string
  alias: string
  alias_type: string
  source: string
  source_id: string | null
  confidence: number
}

interface IdentityAssertionCount {
  entity_id: string
  assertion_type: string
  source: string
  count: number
  avg_score: number
}

interface EntityGraphDisplayProps {
  entities: IdentityEntity[]
  aliases: IdentityAlias[]
  assertionCounts: IdentityAssertionCount[]
  loading?: boolean
  error?: string | null
  onRescan?: () => void
  rescanning?: boolean
}

export function EntityGraphDisplay({
  entities,
  aliases,
  assertionCounts,
  loading = false,
  error = null,
  onRescan,
  rescanning = false,
}: EntityGraphDisplayProps) {
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null)

  const aliasesByEntity = new Map<string, IdentityAlias[]>()
  for (const a of aliases) {
    const list = aliasesByEntity.get(a.entity_id) ?? []
    list.push(a)
    aliasesByEntity.set(a.entity_id, list)
  }

  const assertionsByEntity = new Map<string, IdentityAssertionCount[]>()
  for (const a of assertionCounts) {
    const list = assertionsByEntity.get(a.entity_id) ?? []
    list.push(a)
    assertionsByEntity.set(a.entity_id, list)
  }

  const typeCounts: Record<string, number> = {}
  for (const e of entities) {
    typeCounts[e.entity_type] = (typeCounts[e.entity_type] ?? 0) + 1
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-gray-400">
          <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          <span>Loading entity graph...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-4 py-3">
        <p className="text-red-300 text-sm">Failed to load entity graph: {error}</p>
      </div>
    )
  }

  if (entities.length === 0) {
    return (
      <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
        <p className="text-gray-400 text-sm">No entities resolved yet. Connect integrations and sync data first.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
          <div className="text-2xl font-bold text-white tabular-nums">{entities.length}</div>
          <div className="text-xs text-gray-400">Total entities</div>
        </div>
        {Object.entries(typeCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => (
            <div key={type} className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
              <div className="text-2xl font-bold text-white tabular-nums">{count}</div>
              <div className="text-xs text-gray-400 capitalize">{typeLabel(type) + "s"}</div>
            </div>
          ))}
        <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
          <div className="text-2xl font-bold text-white tabular-nums">{aliases.length}</div>
          <div className="text-xs text-gray-400">Aliases</div>
        </div>
        {onRescan && (
          <button
            type="button"
            disabled={rescanning}
            onClick={onRescan}
            className="rounded-lg border border-white/20 bg-white/5 px-4 py-3 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="text-sm font-medium text-white">{rescanning ? "Scanning…" : "Re-scan sources"}</div>
            <div className="text-xs text-gray-400">Pick up new data</div>
          </button>
        )}
      </div>

      {/* Entity tables by category */}
      {Object.entries(typeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => {
          const categoryEntities = entities.filter((e) => e.entity_type === type)
          return (
            <div key={type} className="rounded-xl border border-white/20 bg-white/5 overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 border-b border-white/20">
                <span className={`inline-flex rounded-md border px-2.5 py-1 text-sm font-semibold text-white capitalize ${typeColor(type)}`}>
                  {typeLabel(type)}s
                </span>
                <span className="text-sm text-gray-400">
                  {count} entit{count !== 1 ? "ies" : "y"}
                </span>
              </div>
              <div className="max-h-[50vh] overflow-y-auto divide-y divide-white/10">
                {categoryEntities.map((ent) => {
                  const expanded = expandedEntity === ent.id
                  const entAliases = aliasesByEntity.get(ent.id) ?? []
                  const entAssertions = assertionsByEntity.get(ent.id) ?? []
                  const nameAliases = entAliases.filter((a) => a.alias_type === "name" || a.alias_type === "merchant_string")
                  const emailAliases = entAliases.filter((a) => a.alias_type === "email")
                  const domainAliases = entAliases.filter((a) => a.alias_type === "domain")

                  return (
                    <div key={ent.id}>
                      <button
                        type="button"
                        onClick={() => setExpandedEntity(expanded ? null : ent.id)}
                        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 transition-colors text-left"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-white font-semibold truncate">{ent.canonical_name}</span>
                            {(ent.sources ?? []).map((s: string) => (
                              <span
                                key={s}
                                className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium text-white uppercase ${sourceColor(s)}`}
                              >
                                {s}
                              </span>
                            ))}
                          </div>
                          <span className="text-[10px] text-gray-500">
                            {ent.evidence_count ?? entAliases.length} signals from {ent.source_count ?? new Set(entAliases.map((a) => a.source)).size} source
                            {(ent.source_count ?? 1) !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <div className="flex items-center gap-1.5">
                            <div className="w-14 h-1.5 rounded-full bg-white/10 overflow-hidden">
                              <div
                                className={`h-full rounded-full ${confColor(ent.confidence)}`}
                                style={{ width: `${confPct(ent.confidence)}%` }}
                              />
                            </div>
                            <span className="text-xs text-gray-400 w-8 text-right tabular-nums">{confPct(ent.confidence)}%</span>
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
                        <div className="px-4 pb-3 space-y-2 border-l-2 border-white/10 ml-4">
                          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider pt-1">Evidence trail</div>
                          {nameAliases.length > 0 && (
                            <div>
                              <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Names</div>
                              <div className="flex flex-wrap gap-1.5">
                                {nameAliases.map((a) => (
                                  <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-white/5 border border-white/10 px-2 py-1 text-xs text-white">
                                    {a.alias}
                                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceColor(a.source)}`} title={a.source} />
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {emailAliases.length > 0 && (
                            <div>
                              <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Emails</div>
                              <div className="flex flex-wrap gap-1.5">
                                {emailAliases.map((a) => (
                                  <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-white/5 border border-white/10 px-2 py-1 text-xs text-gray-300 font-mono">
                                    {a.alias}
                                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceColor(a.source)}`} title={a.source} />
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {domainAliases.length > 0 && (
                            <div>
                              <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Domains</div>
                              <div className="flex flex-wrap gap-1.5">
                                {domainAliases.map((a) => (
                                  <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-white/5 border border-white/10 px-2 py-1 text-xs text-gray-400 font-mono">
                                    {a.alias}
                                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceColor(a.source)}`} title={a.source} />
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {entAssertions.length > 0 && (
                            <div>
                              <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Assertions</div>
                              <div className="flex flex-wrap gap-1.5">
                                {entAssertions.map((a, i) => (
                                  <span key={i} className="inline-flex items-center gap-1 rounded-full bg-white/5 border border-white/10 px-2 py-0.5 text-[11px] text-gray-400">
                                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceColor(a.source)}`} />
                                    {a.assertion_type.replace(/_/g, " ")} via {a.source} ({a.count}x, avg {confPct(a.avg_score)}%)
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
    </div>
  )
}

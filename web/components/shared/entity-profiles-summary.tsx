"use client"

import { archetypeLabel, archetypeColor, money } from "@/lib/dashboard-helpers"

interface EntityProfile {
  id: string
  entity_type: "customer" | "vendor"
  canonical_name: string
  display_name: string | null
  archetype: string | null
  transaction_count: number
  lifetime_value: number
}

interface EntityProfilesSummary {
  total_customers: number
  total_vendors: number
  total_lifetime_value: number
  at_risk_count: number
}

interface EntityProfilesSummaryProps {
  summary: EntityProfilesSummary | null
  profiles: EntityProfile[]
  loading?: boolean
  error?: string | null
}

export function EntityProfilesSummary({
  summary,
  profiles,
  loading = false,
  error = null,
}: EntityProfilesSummaryProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-gray-400">
          <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          <span>Loading entity profiles...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-4 py-3">
        <p className="text-red-300 text-sm">Failed to load entity profiles: {error}</p>
      </div>
    )
  }

  if (!summary) {
    return (
      <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
        <p className="text-gray-400 text-sm">No entity profiles available yet.</p>
      </div>
    )
  }

  const customers = profiles.filter((e) => e.entity_type === "customer").slice(0, 5)
  const vendors = profiles.filter((e) => e.entity_type === "vendor").slice(0, 5)

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
          <div className="text-2xl font-bold text-emerald-400 tabular-nums">{summary.total_customers}</div>
          <div className="text-xs text-gray-400 mt-1">Customers</div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
          <div className="text-2xl font-bold text-blue-400 tabular-nums">{summary.total_vendors}</div>
          <div className="text-xs text-gray-400 mt-1">Vendors</div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
          <div className="text-2xl font-bold text-white tabular-nums">{money(summary.total_lifetime_value)}</div>
          <div className="text-xs text-gray-400 mt-1">Lifetime Value</div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
          <div className="text-2xl font-bold text-amber-400 tabular-nums">{summary.at_risk_count}</div>
          <div className="text-xs text-gray-400 mt-1">At Risk</div>
        </div>
      </div>

      {/* Top Customers */}
      {customers.length > 0 && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-4">
          <div className="text-xs uppercase tracking-wider text-gray-400 mb-3">Top Customers</div>
          <div className="space-y-2">
            {customers.map((e) => (
              <div key={e.id} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                <div className="flex items-center gap-3">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${archetypeColor(e.archetype)}`}>
                    {archetypeLabel(e.archetype)}
                  </span>
                  <span className="text-sm text-white truncate max-w-[200px]">{e.display_name || e.canonical_name}</span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-gray-400 tabular-nums">{e.transaction_count} txns</span>
                  <span className="text-emerald-400 font-medium tabular-nums">{money(e.lifetime_value)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Vendors */}
      {vendors.length > 0 && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-4">
          <div className="text-xs uppercase tracking-wider text-gray-400 mb-3">Top Vendors</div>
          <div className="space-y-2">
            {vendors.map((e) => (
              <div key={e.id} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                <div className="flex items-center gap-3">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${archetypeColor(e.archetype)}`}>
                    {archetypeLabel(e.archetype)}
                  </span>
                  <span className="text-sm text-white truncate max-w-[200px]">{e.display_name || e.canonical_name}</span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-gray-400 tabular-nums">{e.transaction_count} txns</span>
                  <span className="text-blue-400 font-medium tabular-nums">{money(e.lifetime_value)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* View All Link */}
      {profiles.length > 0 && (
        <div className="text-center">
          <a
            href="/dashboard/entity-profiles"
            className="inline-flex items-center gap-2 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            View all {profiles.length} entities →
          </a>
        </div>
      )}
    </div>
  )
}

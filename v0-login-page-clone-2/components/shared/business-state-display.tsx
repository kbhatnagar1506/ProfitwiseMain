"use client"

import { money, signedMoney, pct, riskColor, riskBg, riskBarColor, regimeColor, regimeBg } from "@/lib/dashboard-helpers"

interface RevenueState {
  period_start: string
  period_end: string
  gross_revenue: number
  contra_revenue: number
  net_revenue: number
  customer_count: number
  avg_receipt: number
  top_customer_pct: number
  repeat_revenue_ratio: number
  revenue_by_customer: { entity_id: string | null; name: string; total: number; count: number }[]
}

interface SpendState {
  period_start: string
  period_end: string
  total_opex: number
  total_cogs: number
  total_spend: number
  payroll: number
  recurring_obligations: number
  top_vendor_pct: number
  vendor_count: number
  spend_by_vendor: { entity_id: string | null; name: string; total: number; count: number; pct_of_spend: number }[]
}

interface LiquidityState {
  period_start: string
  period_end: string
  ending_cash: number
  period_net_cash_flow: number
  operating_inflows: number
  operating_outflows: number
  net_operating: number
  financing_inflows: number
  financing_outflows: number
  net_financing: number
  owner_inflows: number
  owner_outflows: number
  net_owner: number
  liquidity_regime: "strong" | "stable" | "tightening"
  runway_days: number | null
  burn_rate: number
  period_days: number
}

interface RiskDimension {
  level: "low" | "medium" | "high"
  score: number
  reason: string
}

interface RiskState {
  liquidity_risk: RiskDimension
  concentration_risk: RiskDimension
  dependency_risk: RiskDimension
  anomaly_risk: RiskDimension
  uncertainty_risk: RiskDimension
  overall: "low" | "medium" | "high"
  overall_score: number
}

interface StateConfidence {
  revenue_confidence: number
  spend_confidence: number
  liquidity_confidence: number
}

interface BusinessStateData {
  revenue: RevenueState
  spend: SpendState
  liquidity: LiquidityState
  risk: RiskState
  state_confidence: StateConfidence
  insight_block?: string
  computed_at?: string
}

interface BusinessStateDisplayProps {
  data: BusinessStateData | null
  loading?: boolean
  error?: string | null
}

function confColor(c: number): string {
  if (c >= 90) return "text-emerald-400"
  if (c >= 70) return "text-amber-400"
  return "text-red-400"
}

export function BusinessStateDisplay({
  data,
  loading = false,
  error = null,
}: BusinessStateDisplayProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-gray-400">
          <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          <span>Computing business state...</span>
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

  if (!data) {
    return (
      <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
        <p className="text-gray-400 text-sm">No business state data available.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Period Context */}
      <div className="flex items-center justify-center gap-4 text-xs text-gray-500 flex-wrap">
        {data.revenue.period_start && data.revenue.period_end && (
          <span>
            Period: {new Date(data.revenue.period_start).toLocaleDateString("en-US", { month: "short", day: "numeric" })} –{" "}
            {new Date(data.revenue.period_end).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            {data.liquidity.period_days > 0 && <span className="text-gray-600"> ({data.liquidity.period_days} days)</span>}
          </span>
        )}
        {data.computed_at && (
          <span className="text-gray-600">
            Updated: {new Date(data.computed_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        )}
      </div>

      {/* AI Summary Block */}
      {data.insight_block && (
        <div className="bg-gradient-to-br from-emerald-500/10 via-blue-500/5 to-purple-500/10 border border-white/10 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs uppercase tracking-wider text-emerald-400/80 font-medium">AI Summary</span>
          </div>
          <p className="text-sm text-gray-200 leading-relaxed">{data.insight_block}</p>
        </div>
      )}

      {/* Key Metrics Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center hover:bg-white/[0.07] transition-colors">
          <div className="text-2xl font-bold text-emerald-400 tabular-nums">{money(data.revenue.net_revenue)}</div>
          <div className="text-xs text-gray-400 mt-1">Net Revenue</div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center hover:bg-white/[0.07] transition-colors">
          <div className="text-2xl font-bold text-amber-400 tabular-nums">{money(data.spend.total_spend)}</div>
          <div className="text-xs text-gray-400 mt-1">Total Spend</div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center hover:bg-white/[0.07] transition-colors">
          <div className="text-2xl font-bold text-blue-400 tabular-nums">{money(data.liquidity.ending_cash)}</div>
          <div className="text-xs text-gray-400 mt-1">Cash Position</div>
        </div>
        <div className={`border rounded-xl p-4 text-center hover:opacity-90 transition-opacity ${riskBg(data.risk.overall)}`}>
          <div className={`text-2xl font-bold ${riskColor(data.risk.overall)}`}>{data.risk.overall.toUpperCase()}</div>
          <div className="text-xs text-gray-400 mt-1">Risk Level</div>
        </div>
      </div>

      {/* Confidence Indicators */}
      <div className="flex items-center justify-center gap-8 py-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              data.state_confidence.revenue_confidence >= 90
                ? "bg-emerald-400"
                : data.state_confidence.revenue_confidence >= 70
                  ? "bg-amber-400"
                  : "bg-red-400"
            }`}
          />
          <span className="text-xs text-gray-500">Revenue</span>
          <span className={`text-xs font-semibold ${confColor(data.state_confidence.revenue_confidence)}`}>
            {pct(data.state_confidence.revenue_confidence)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              data.state_confidence.spend_confidence >= 90
                ? "bg-emerald-400"
                : data.state_confidence.spend_confidence >= 70
                  ? "bg-amber-400"
                  : "bg-red-400"
            }`}
          />
          <span className="text-xs text-gray-500">Spend</span>
          <span className={`text-xs font-semibold ${confColor(data.state_confidence.spend_confidence)}`}>
            {pct(data.state_confidence.spend_confidence)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              data.state_confidence.liquidity_confidence >= 90
                ? "bg-emerald-400"
                : data.state_confidence.liquidity_confidence >= 70
                  ? "bg-amber-400"
                  : "bg-red-400"
            }`}
          />
          <span className="text-xs text-gray-500">Liquidity</span>
          <span className={`text-xs font-semibold ${confColor(data.state_confidence.liquidity_confidence)}`}>
            {pct(data.state_confidence.liquidity_confidence)}
          </span>
        </div>
      </div>

      {/* Risk Analysis */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Risk Analysis</h3>
          <div className={`text-xs font-bold px-3 py-1 rounded-full border ${riskBg(data.risk.overall)} ${riskColor(data.risk.overall)}`}>
            Score: {data.risk.overall_score}/100
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {(["liquidity_risk", "concentration_risk", "dependency_risk", "anomaly_risk", "uncertainty_risk"] as const).map((key) => {
            const dim = data.risk[key]
            const label = key
              .replace(/_risk$/, "")
              .split("_")
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" ")
            return (
              <div key={key} className="text-center">
                <div className="relative w-full h-1.5 bg-white/10 rounded-full overflow-hidden mb-2">
                  <div
                    className={`absolute left-0 top-0 h-full rounded-full transition-all ${riskBarColor(dim.level)}`}
                    style={{ width: `${Math.min(dim.score, 100)}%` }}
                  />
                </div>
                <div className={`text-xs font-semibold ${riskColor(dim.level)}`}>{dim.level.toUpperCase()}</div>
                <div className="text-[10px] text-gray-500 mt-0.5">{label}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Revenue & Spend Side by Side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Revenue Card */}
        <div className="bg-white/5 border border-white/10 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider">Revenue</h3>
            <span className="text-xs text-gray-500 tabular-nums">{data.revenue.customer_count} customers</span>
          </div>
          <div className="text-3xl font-bold text-white mb-3 tabular-nums">{money(data.revenue.net_revenue)}</div>
          <div className="text-xs text-gray-500 mb-4">
            Gross {money(data.revenue.gross_revenue)} − Contra {money(data.revenue.contra_revenue)}
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-white/5 rounded-lg p-2">
              <div className="text-sm font-semibold text-white tabular-nums">{money(data.revenue.avg_receipt)}</div>
              <div className="text-[10px] text-gray-500">Avg Receipt</div>
            </div>
            <div className="bg-white/5 rounded-lg p-2">
              <div className="text-sm font-semibold text-white tabular-nums">{pct(data.revenue.top_customer_pct)}</div>
              <div className="text-[10px] text-gray-500">Top Customer</div>
            </div>
            <div className="bg-white/5 rounded-lg p-2">
              <div className="text-sm font-semibold text-white tabular-nums">{pct(data.revenue.repeat_revenue_ratio * 100)}</div>
              <div className="text-[10px] text-gray-500">Repeat Rev</div>
            </div>
          </div>
          {data.revenue.revenue_by_customer.length > 0 && (
            <div className="mt-4 pt-3 border-t border-white/5">
              <div className="text-[10px] uppercase text-gray-500 mb-2">Top Customers</div>
              <div className="space-y-1">
                {data.revenue.revenue_by_customer.slice(0, 3).map((c, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-gray-300 truncate max-w-[60%]">{c.name}</span>
                    <span className="text-emerald-400 font-mono tabular-nums">{money(c.total)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Spend Card */}
        <div className="bg-white/5 border border-white/10 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider">Spend</h3>
            <span className="text-xs text-gray-500 tabular-nums">{data.spend.vendor_count} vendors</span>
          </div>
          <div className="text-3xl font-bold text-white mb-3 tabular-nums">{money(data.spend.total_spend)}</div>
          <div className="text-xs text-gray-500 mb-4">
            OpEx {money(data.spend.total_opex)} + COGS {money(data.spend.total_cogs)}
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-white/5 rounded-lg p-2">
              <div className="text-sm font-semibold text-white tabular-nums">{money(data.spend.payroll)}</div>
              <div className="text-[10px] text-gray-500">Payroll</div>
            </div>
            <div className="bg-white/5 rounded-lg p-2">
              <div className="text-sm font-semibold text-white tabular-nums">{money(data.spend.recurring_obligations)}</div>
              <div className="text-[10px] text-gray-500">Recurring</div>
            </div>
            <div className="bg-white/5 rounded-lg p-2">
              <div className="text-sm font-semibold text-white tabular-nums">{pct(data.spend.top_vendor_pct)}</div>
              <div className="text-[10px] text-gray-500">Top Vendor</div>
            </div>
          </div>
          {data.spend.spend_by_vendor.length > 0 && (
            <div className="mt-4 pt-3 border-t border-white/5">
              <div className="text-[10px] uppercase text-gray-500 mb-2">Top Vendors</div>
              <div className="space-y-1">
                {data.spend.spend_by_vendor.slice(0, 3).map((v, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-gray-300 truncate max-w-[60%]">{v.name}</span>
                    <span className="text-amber-400 font-mono tabular-nums">{money(v.total)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Liquidity State */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-blue-400 uppercase tracking-wider">Liquidity</h3>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${regimeBg(data.liquidity.liquidity_regime)} ${regimeColor(data.liquidity.liquidity_regime)}`}>
            {data.liquidity.liquidity_regime.charAt(0).toUpperCase() + data.liquidity.liquidity_regime.slice(1)} Regime
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-400 tabular-nums">{money(data.liquidity.ending_cash)}</div>
            <div className="text-xs text-gray-500 mt-1">Ending Cash</div>
          </div>
          <div className="text-center">
            <div className={`text-2xl font-bold tabular-nums ${data.liquidity.period_net_cash_flow >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {signedMoney(data.liquidity.period_net_cash_flow)}
            </div>
            <div className="text-xs text-gray-500 mt-1">Net Cash Flow</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-white tabular-nums">{data.liquidity.runway_days ?? "∞"}</div>
            <div className="text-xs text-gray-500 mt-1">Runway (days)</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-white tabular-nums">{money(data.liquidity.burn_rate)}</div>
            <div className="text-xs text-gray-500 mt-1">
              {data.liquidity.period_days >= 30 ? "Burn Rate/mo" : `Spend (${data.liquidity.period_days}d)`}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="bg-white/5 rounded-lg p-3">
            <div className="flex justify-between mb-1">
              <span className="text-gray-400">Operating</span>
              <span className={data.liquidity.net_operating >= 0 ? "text-emerald-400" : "text-red-400"} style={{ fontVariantNumeric: "tabular-nums" }}>
                {signedMoney(data.liquidity.net_operating)}
              </span>
            </div>
            <div className="text-[10px] text-gray-600">
              In {money(data.liquidity.operating_inflows)} / Out {money(data.liquidity.operating_outflows)}
            </div>
          </div>
          <div className="bg-white/5 rounded-lg p-3">
            <div className="flex justify-between mb-1">
              <span className="text-gray-400">Financing</span>
              <span className={data.liquidity.net_financing >= 0 ? "text-emerald-400" : "text-red-400"} style={{ fontVariantNumeric: "tabular-nums" }}>
                {signedMoney(data.liquidity.net_financing)}
              </span>
            </div>
            <div className="text-[10px] text-gray-600">
              In {money(data.liquidity.financing_inflows)} / Out {money(data.liquidity.financing_outflows)}
            </div>
          </div>
          <div className="bg-white/5 rounded-lg p-3">
            <div className="flex justify-between mb-1">
              <span className="text-gray-400">Owner</span>
              <span className={data.liquidity.net_owner >= 0 ? "text-emerald-400" : "text-red-400"} style={{ fontVariantNumeric: "tabular-nums" }}>
                {signedMoney(data.liquidity.net_owner)}
              </span>
            </div>
            <div className="text-[10px] text-gray-600">
              In {money(data.liquidity.owner_inflows)} / Out {money(data.liquidity.owner_outflows)}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

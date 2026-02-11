"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertCircle, Search, Loader2, ChevronDown } from "lucide-react"
import {
  RiskGauge,
  ArchetypeInsights,
  DataQualityScore,
  PeerComparisonCard,
  SeasonalityHeatmap,
  TrendSparkline,
  PaymentBehaviorTimeline,
  PriorityRecommendations,
} from "@/components/entity-intelligence"
import { CustomerSearchResults } from "./customer-search-results"
import { SupermemoryContextCard } from "./supermemory-context-card"

interface Customer {
  id: string
  canonical_name: string
  display_name: string | null
  entity_type: "customer" | "vendor"
  transaction_count: number
  lifetime_value: number
  ar_balance: number
  overdue_balance: number
  reliability_score: number
  archetype: string
  last_transaction_date: string | null
  metadata?: Record<string, any>
  avg_days_to_pay: number
  std_days_to_pay: number
  on_time_payment_rate: number
  early_payment_rate: number
  payment_count: number
  avg_payment_amount: number
  std_transaction_amount: number
  amount_trend: "increasing" | "decreasing" | "stable"
  transactions_per_month: number
  avg_interval_days: number
  interval_cv: number
  peak_months: number[]
  low_months: number[]
  risk_score: number
  risk_factors: string[]
  forecast_uncertainty: "low" | "medium" | "high"
  forecast_notes: string
  peer_percentiles?: {
    reliability_score: number
    risk_score: number
    avg_days_to_pay: number
    transactions_per_month: number
  }
}

interface AISummary {
  summary: string
  paymentBehavior: string
  riskAssessment: string
  seasonality: string
  trends: string
  recommendations: string[]
  contractContext: string
  generatedAt: string
}

interface SupermemoryContext {
  contractTerms: string | null
  relationshipNotes: string | null
  paymentTerms: string | null
  rawContext: string
}

interface CustomerDetailDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  customer: Customer | null
}

function formatCurrency(amount: number): string {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`
  return `$${amount.toFixed(0)}`
}

function formatDate(dateString: string | null): string {
  if (!dateString) return "—"
  try {
    return new Date(dateString).toLocaleDateString()
  } catch {
    return dateString
  }
}

function getArchetypeColor(archetype: string): string {
  const colors: Record<string, string> = {
    Clockwork: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    Bursty: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    Volatile: "bg-orange-500/20 text-orange-300 border-orange-500/30",
    New: "bg-neutral-500/20 text-neutral-300 border-neutral-500/30",
  }
  return colors[archetype] || colors.New
}

export function CustomerDetailDrawer({
  open,
  onOpenChange,
  customer,
}: CustomerDetailDrawerProps) {
  const [aiSummary, setAiSummary] = useState<AISummary | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchActive, setSearchActive] = useState(false)
  const [supermemoryContext, setSupermemoryContext] = useState<SupermemoryContext | null>(null)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    aiSummary: true,
    supermemory: false,
    existing: false,
  })
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Generate AI summary when drawer opens
  useEffect(() => {
    if (open && customer && !aiSummary) {
      generateAISummary()
    }
  }, [open, customer?.id])

  const generateAISummary = async () => {
    if (!customer) return

    setAiLoading(true)
    setAiError(null)

    try {
      const response = await fetch(
        `/api/dashboard/customer-detail/${customer.id}/ai-summary`,
        { method: "POST" }
      )

      if (!response.ok) {
        throw new Error("Failed to generate AI summary")
      }

      const data = await response.json()
      setAiSummary(data)
    } catch (err) {
      console.error("AI summary error:", err)
      setAiError("Unable to generate AI summary at this time")
    } finally {
      setAiLoading(false)
    }
  }

  // Fetch Supermemory context when drawer opens
  useEffect(() => {
    if (open && customer && !supermemoryContext) {
      fetchSupermemoryContext()
    }
  }, [open, customer?.id])

  const fetchSupermemoryContext = async () => {
    if (!customer) return

    try {
      const response = await fetch(
        `/api/dashboard/customer-detail/${customer.id}`
      )

      if (!response.ok) return

      const data = await response.json()
      setSupermemoryContext(data.supermemoryContext)
    } catch (err) {
      console.error("Supermemory context error:", err)
    }
  }

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }))
  }

  if (!customer) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="bg-black border-l border-white/10 w-full sm:w-[600px] overflow-y-auto shadow-[-20px_0_40px_rgba(0,0,0,0.5)]">
        <SheetHeader className="border-b border-white/[0.06] pb-4 mb-6">
          <SheetTitle className="text-white text-xl font-semibold">
            {customer.display_name || customer.canonical_name}
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-6">
          {/* AI Summary Section */}
          <div className="space-y-3">
            <button
              onClick={() => toggleSection("aiSummary")}
              className="flex items-center justify-between w-full text-left"
            >
              <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">
                AI Summary
              </p>
              <ChevronDown
                className={`w-4 h-4 text-neutral-600 transition-transform ${
                  expandedSections.aiSummary ? "rotate-180" : ""
                }`}
              />
            </button>

            {expandedSections.aiSummary && (
              <div className="space-y-3">
                {aiLoading ? (
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-4 space-y-2">
                    <Skeleton className="h-4 w-full bg-white/10" />
                    <Skeleton className="h-4 w-3/4 bg-white/10" />
                    <Skeleton className="h-4 w-5/6 bg-white/10" />
                  </div>
                ) : aiError ? (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                    <p className="text-[12px] text-red-400">{aiError}</p>
                  </div>
                ) : aiSummary ? (
                  <div className="space-y-3">
                    {aiSummary.summary && (
                      <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                        <p className="text-[12px] text-neutral-300 leading-relaxed">
                          {aiSummary.summary}
                        </p>
                      </div>
                    )}

                    {aiSummary.paymentBehavior && (
                      <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                        <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium mb-2">
                          Payment Behavior
                        </p>
                        <p className="text-[12px] text-neutral-300">
                          {aiSummary.paymentBehavior}
                        </p>
                      </div>
                    )}

                    {aiSummary.riskAssessment && (
                      <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                        <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium mb-2">
                          Risk Assessment
                        </p>
                        <p className="text-[12px] text-neutral-300">
                          {aiSummary.riskAssessment}
                        </p>
                      </div>
                    )}

                    {aiSummary.recommendations && aiSummary.recommendations.length > 0 && (
                      <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                        <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium mb-2">
                          Recommendations
                        </p>
                        <ul className="space-y-1">
                          {aiSummary.recommendations.map((rec, idx) => (
                            <li key={idx} className="text-[12px] text-neutral-300">
                              • {rec}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* Search Section */}
          <div className="space-y-3">
            <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">
              Search
            </p>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-neutral-600" />
              <Input
                ref={searchInputRef}
                type="text"
                placeholder="Search transactions, invoices, documents..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value)
                  setSearchActive(e.target.value.length > 0)
                }}
                className="pl-10 bg-white/[0.03] border border-white/[0.06] text-neutral-300 placeholder-neutral-600"
              />
            </div>

            {searchActive && searchQuery.length > 0 && (
              <CustomerSearchResults customerId={customer.id} query={searchQuery} />
            )}
          </div>

          {/* Supermemory Context Section */}
          {supermemoryContext && (
            <div className="space-y-3">
              <button
                onClick={() => toggleSection("supermemory")}
                className="flex items-center justify-between w-full text-left"
              >
                <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">
                  Contract & Relationship
                </p>
                <ChevronDown
                  className={`w-4 h-4 text-neutral-600 transition-transform ${
                    expandedSections.supermemory ? "rotate-180" : ""
                  }`}
                />
              </button>

              {expandedSections.supermemory && (
                <SupermemoryContextCard context={supermemoryContext} />
              )}
            </div>
          )}

          {/* Mini KPI Grid */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
              <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium">
                Total Invoiced
              </p>
              <p className="text-lg font-semibold text-emerald-400/90 mt-2 tabular-nums">
                {formatCurrency(customer.lifetime_value)}
              </p>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
              <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium">
                Open AR
              </p>
              <p
                className={`text-lg font-semibold mt-2 tabular-nums ${
                  customer.ar_balance > 0 ? "text-amber-400/90" : "text-zinc-500"
                }`}
              >
                {formatCurrency(customer.ar_balance)}
              </p>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
              <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium">
                Reliability
              </p>
              <p className="text-lg font-semibold text-white mt-2">
                {customer.reliability_score}%
              </p>
            </div>
          </div>

          {/* Existing Components Section */}
          <div className="space-y-3">
            <button
              onClick={() => toggleSection("existing")}
              className="flex items-center justify-between w-full text-left"
            >
              <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">
                Detailed Analysis
              </p>
              <ChevronDown
                className={`w-4 h-4 text-neutral-600 transition-transform ${
                  expandedSections.existing ? "rotate-180" : ""
                }`}
              />
            </button>

            {expandedSections.existing && (
              <div className="space-y-6">
                {/* Archetype Insights */}
                <ArchetypeInsights archetype={customer.archetype as any} />

                {/* Profile Info */}
                <div className="space-y-3">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">
                    Profile
                  </p>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                      <span className="text-[12px] text-neutral-400">Archetype</span>
                      <Badge className={`text-[10px] h-5 ${getArchetypeColor(customer.archetype)}`}>
                        {customer.archetype}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                      <span className="text-[12px] text-neutral-400">Transactions</span>
                      <span className="text-[12px] font-medium text-white">
                        {customer.transaction_count}
                      </span>
                    </div>
                    <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                      <span className="text-[12px] text-neutral-400">Last Active</span>
                      <span className="text-[12px] font-medium text-zinc-400">
                        {formatDate(customer.last_transaction_date)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Overdue Alert */}
                {customer.overdue_balance > 0 && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                    <p className="text-[12px] text-red-400 font-medium">
                      ⚠ {formatCurrency(customer.overdue_balance)} overdue
                    </p>
                    <p className="text-[11px] text-red-400/70 mt-1">
                      This customer has outstanding invoices past their due date.
                    </p>
                  </div>
                )}

                {/* Risk Gauge */}
                <RiskGauge riskScore={customer.risk_score} riskFactors={customer.risk_factors} />

                {/* Data Quality Score */}
                <DataQualityScore
                  transactionCount={customer.transaction_count}
                  paymentCount={customer.payment_count}
                  hasSeasonality={customer.peak_months.length > 0}
                />

                {/* Peer Comparison */}
                {customer.peer_percentiles && (
                  <PeerComparisonCard
                    archetype={customer.archetype}
                    percentiles={customer.peer_percentiles}
                  />
                )}

                {/* Seasonality Heatmap */}
                {customer.peak_months.length > 0 && (
                  <SeasonalityHeatmap
                    peakMonths={customer.peak_months}
                    lowMonths={customer.low_months}
                  />
                )}

                {/* Trends */}
                <TrendSparkline
                  amountTrend={customer.amount_trend}
                  transactionsPerMonth={customer.transactions_per_month}
                />

                {/* Payment Behavior Timeline */}
                <PaymentBehaviorTimeline
                  avgDaysToPay={customer.avg_days_to_pay}
                  onTimeRate={customer.on_time_payment_rate}
                  earlyRate={customer.early_payment_rate}
                />

                {/* Priority Recommendations */}
                <PriorityRecommendations
                  riskScore={customer.risk_score}
                  riskFactors={customer.risk_factors}
                  archetype={customer.archetype}
                  arBalance={customer.ar_balance}
                />
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

"use client"

import { useState, useEffect, useCallback } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { RefreshCw, Search, ArrowRight, Sparkles } from "lucide-react"

interface SuggestedMatch {
  movement_id: string
  invoice_id?: string
  bill_id?: string
  confidence: number
  reason: string
  matched_amount: number
  entity_name?: string | null
  waterfall_stage?: number
  auto_accepted: boolean
}

interface Movement {
  id: string
  date: string
  amount: number
  description: string
  raw_description?: string | null
  counterparty: string | null
  economic_class: string | null
  suggested_match?: SuggestedMatch
}

interface ReconciledMovement {
  movement_id: string
  matched_to: string
  matched_at: string
  matched_by: "ai" | "user"
  confidence: number
  amount_matched: number
}

interface ExcludedMovement {
  id: string
  date: string
  amount: number
  description: string
  economic_class: string
  reason: string
}

interface ReconciliationSummary {
  total_invoices?: number
  total_bills?: number
  matched_count: number
  partial_count: number
  unmatched_count: number
  matched_amount: number
  partial_matched_amount: number
  unmatched_amount: number
  match_rate: number
  accounting_outstanding: number
  bank_verified_outstanding: number
  bank_verified_matched: number
  discrepancy: number
  suspicious_count: number
  suspicious_amount: number
}

interface LifetimeLedger {
  total: number
  reconciled: number
  reconciled_pct: number
  paid: number
  paid_pct: number
  outstanding: number
  invoice_count?: number
  bill_count?: number
  paid_count: number
  open_count: number
}

interface LedgerItem {
  invoice_id?: string
  bill_id?: string
  customer_name?: string
  vendor_name?: string
  amount: number
  amount_due: number
  status: string
  due_date: string
  reconciliation_status?: string
  matched_amount?: number
}

interface ARAPStepResponse {
  ar?: {
    invoices: LedgerItem[]
    paid_invoices: LedgerItem[]
    reconciliation_summary: ReconciliationSummary
  }
  ap?: {
    bills: LedgerItem[]
    paid_bills: LedgerItem[]
    reconciliation_summary: ReconciliationSummary
  }
  recon?: {
    unmatched_inflows: any[]
    unmatched_outflows: any[]
    total_unmatched_inflows: number
    total_unmatched_outflows: number
  }
  lifetime?: {
    ar: LifetimeLedger
    ap: LifetimeLedger
  }
  is_reconciling: boolean
  reconciliation_status: any
  suggested_matches?: {
    ar: SuggestedMatch[]
    ap: SuggestedMatch[]
  }
  movements?: {
    unmatched_inflows: Movement[]
    unmatched_outflows: Movement[]
  }
  reconciled_movements?: {
    matched: ReconciledMovement[]
  }
  excluded_movements?: {
    count: number
    total_amount: number
    movements: ExcludedMovement[]
  }
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

function formatDate(d: string | null) {
  if (!d) return "—"
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function formatEconomicClass(ec: string) {
  const map: Record<string, string> = {
    transfer: "Internal Transfer",
    owner_draw: "Owner Draw",
    owner_contribution: "Owner Contribution",
    bank_fee: "Bank Fee",
    bank_fee_refund: "Fee Refund",
    interest: "Interest",
    processor_fee: "Processor Fee",
    processor_payout: "Processor Payout",
    opening_balance: "Opening Balance",
    account_verification: "Verification",
    system_adjustment: "Adjustment",
    settlement_in: "Settlement",
    settlement_adjustment: "Settlement Adj.",
  }
  return map[ec] || ec.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
}

function getConfidenceBadge(confidence: number) {
  if (confidence >= 0.88) return { label: `${Math.round(confidence * 100)}%`, tier: "high", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" }
  if (confidence >= 0.75) return { label: `${Math.round(confidence * 100)}%`, tier: "med", color: "bg-amber-500/10 text-amber-400 border-amber-500/20" }
  return { label: `${Math.round(confidence * 100)}%`, tier: "low", color: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20" }
}


export default function ReconciliationPage() {
  const [data, setData] = useState<ARAPStepResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedMovement, setSelectedMovement] = useState<Movement | null>(null)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedMatches, setSelectedMatches] = useState<Array<{ reference_id: string; component_type: "ar" | "ap"; amount: number }>>([])
  const [aiSummary, setAiSummary] = useState<string | null>(null)
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false)
  const [aiSummaryError, setAiSummaryError] = useState<string | null>(null)
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/ar-ap-step")
      if (!res.ok) throw new Error("Failed to fetch")
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    if (!data?.is_reconciling) return
    const timer = setTimeout(() => fetchData(), 3000)
    return () => clearTimeout(timer)
  }, [data?.is_reconciling, fetchData])

  const handleRunReconciliation = async () => {
    setRunning(true)
    try {
      await fetch("/api/ar-ap-step?run=true")
      await fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error")
    } finally {
      setRunning(false)
    }
  }

  const handleSearch = async (query: string, type: "ar" | "ap") => {
    if (!query.trim()) {
      setSearchResults([])
      return
    }
    setSearchLoading(true)
    try {
      const res = await fetch(`/api/dashboard/reconciliation/search?q=${encodeURIComponent(query)}&type=${type}`)
      if (res.ok) {
        const json = await res.json()
        setSearchResults(json.results)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setSearchLoading(false)
    }
  }

  const handleConfirmMatch = async () => {
    if (!selectedMovement || selectedMatches.length === 0) return
    try {
      const res = await fetch("/api/dashboard/reconciliation/split-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          movement_id: selectedMovement.id,
          matches: selectedMatches,
        }),
      })
      if (res.ok) {
        setIsDrawerOpen(false)
        setSelectedMovement(null)
        setSelectedMatches([])
        await fetchData()
      } else {
        const errorData = await res.json()
        setError(errorData.error || "Failed to confirm match")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error confirming match")
    }
  }

  const fetchAiSummary = useCallback(async (d: ARAPStepResponse) => {
    setAiSummaryLoading(true)
    setAiSummaryError(null)
    try {
      const reconMatched = d.reconciled_movements?.matched || []
      const body = {
        totalUnmatched: (d.recon?.total_unmatched_inflows || 0) + (d.recon?.total_unmatched_outflows || 0),
        unmatchedCount: (d.movements?.unmatched_inflows?.length || 0) + (d.movements?.unmatched_outflows?.length || 0),
        reconciledCount: reconMatched.length,
        reconciledAmount: reconMatched.reduce((s, m) => s + m.amount_matched, 0),
        excludedCount: d.excluded_movements?.count || 0,
        excludedAmount: d.excluded_movements?.total_amount || 0,
        arTotal: d.lifetime?.ar?.total || 0,
        arPaid: d.lifetime?.ar?.paid || 0,
        arOutstanding: d.lifetime?.ar?.outstanding || 0,
        arInvoiceCount: d.lifetime?.ar?.invoice_count || 0,
        arPaidCount: d.lifetime?.ar?.paid_count || 0,
        arOpenCount: d.lifetime?.ar?.open_count || 0,
        arMatchRate: d.ar?.reconciliation_summary?.match_rate || 0,
        arMatchedCount: d.ar?.reconciliation_summary?.matched_count || 0,
        arBankVerified: d.ar?.reconciliation_summary?.bank_verified_matched || 0,
        apTotal: d.lifetime?.ap?.total || 0,
        apPaid: d.lifetime?.ap?.paid || 0,
        apOutstanding: d.lifetime?.ap?.outstanding || 0,
        apBillCount: d.lifetime?.ap?.bill_count || 0,
        apPaidCount: d.lifetime?.ap?.paid_count || 0,
        apOpenCount: d.lifetime?.ap?.open_count || 0,
        apMatchRate: d.ap?.reconciliation_summary?.match_rate || 0,
        apMatchedCount: d.ap?.reconciliation_summary?.matched_count || 0,
        apBankVerified: d.ap?.reconciliation_summary?.bank_verified_matched || 0,
      }
      const res = await fetch("/api/dashboard/reconciliation/ai-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const json = await res.json()
        setAiSummary(json.summary)
      } else {
        setAiSummaryError("Could not generate summary")
      }
    } catch {
      setAiSummaryError("Could not generate summary")
    } finally {
      setAiSummaryLoading(false)
    }
  }, [])

  if (loading) {
    return (
      <div className="p-8 space-y-6 bg-[#0A0A0A] min-h-screen">
        <Skeleton className="h-12 w-64" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-96" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="p-8 bg-[#0A0A0A] min-h-screen">
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-6 text-red-400">
          <p className="font-semibold">Error loading reconciliation data</p>
          <p className="text-sm mt-2">{error || "Unknown error"}</p>
          <Button onClick={() => fetchData()} className="mt-4 bg-red-600 hover:bg-red-700">
            Retry
          </Button>
        </div>
      </div>
    )
  }

  if (data.is_reconciling && !data.ar) {
    return (
      <div className="p-8 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-white tracking-tight">Clearing House</h1>
            <p className="text-[12px] text-zinc-500 mt-0.5">Running reconciliation engine...</p>
          </div>
        </div>
        <div className="bg-[#141414] border border-white/10 rounded-lg p-8 text-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-4 w-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-[13px] text-zinc-300">Matching bank movements to AR/AP...</span>
          </div>
        </div>
      </div>
    )
  }

  const unmatched_inflows = data.movements?.unmatched_inflows || []
  const unmatched_outflows = data.movements?.unmatched_outflows || []
  const totalUnmatched = (data.recon?.total_unmatched_inflows || 0) + (data.recon?.total_unmatched_outflows || 0)
  const openAR = data.lifetime?.ar?.outstanding || 0
  const openAP = data.lifetime?.ap?.outstanding || 0

  const arSummary = data.ar?.reconciliation_summary
  const apSummary = data.ap?.reconciliation_summary
  const arLife = data.lifetime?.ar
  const apLife = data.lifetime?.ap

  return (
    <div className="p-8 space-y-5 bg-[#0A0A0A] min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">Clearing House</h1>
          <p className="text-[12px] text-zinc-500 mt-0.5">Operating cash only &middot; Excludes internal transfers</p>
        </div>
        <div className="flex items-center gap-2">
          {data.is_reconciling && (
            <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] px-2">
              <div className="h-2.5 w-2.5 border-[1.5px] border-amber-400 border-t-transparent rounded-full animate-spin mr-1.5" />
              Running
            </Badge>
          )}
          <Button
            size="sm"
            onClick={handleRunReconciliation}
            disabled={data.is_reconciling || running}
            className="bg-white/10 hover:bg-white/15 text-white text-[11px] h-7 px-3"
          >
            <RefreshCw className={`h-3 w-3 mr-1.5 ${data.is_reconciling || running ? "animate-spin" : ""}`} />
            Reconcile
          </Button>
        </div>
      </div>

      {/* AI Overview Panel */}
      <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-violet-400" />
            <span className="text-[11px] font-medium text-white uppercase tracking-wider">AI Reconciliation Overview</span>
            <span className="text-[10px] text-zinc-600">Plain English · Updated on demand</span>
          </div>
          <Button
            size="sm"
            onClick={() => fetchAiSummary(data)}
            disabled={aiSummaryLoading}
            className="bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/30 text-violet-300 text-[10px] h-6 px-2.5"
          >
            {aiSummaryLoading
              ? <><div className="h-2.5 w-2.5 border-[1.5px] border-violet-400 border-t-transparent rounded-full animate-spin mr-1.5" />Thinking...</>
              : <><Sparkles className="h-2.5 w-2.5 mr-1.5" />{aiSummary ? "Regenerate" : "Generate Overview"}</>
            }
          </Button>
        </div>
        <div className="px-4 py-3 min-h-[52px] flex items-center">
          {aiSummaryLoading && (
            <div className="flex items-center gap-3 w-full">
              <div className="space-y-2 flex-1">
                <div className="h-2.5 bg-white/5 rounded animate-pulse w-full" />
                <div className="h-2.5 bg-white/5 rounded animate-pulse w-4/5" />
                <div className="h-2.5 bg-white/5 rounded animate-pulse w-3/5" />
              </div>
            </div>
          )}
          {!aiSummaryLoading && aiSummaryError && (
            <p className="text-[12px] text-red-400">{aiSummaryError}</p>
          )}
          {!aiSummaryLoading && aiSummary && (
            <p className="text-[13px] text-zinc-300 leading-relaxed">{aiSummary}</p>
          )}
          {!aiSummaryLoading && !aiSummary && !aiSummaryError && (
            <p className="text-[12px] text-zinc-600 italic">Click "Generate Overview" for a plain-English summary of your reconciliation health.</p>
          )}
        </div>
      </div>

      {/* KPI Header — 3 cards */}
      <div className="grid grid-cols-3 gap-3">
        {/* Unmatched Cash */}
        <div className="bg-[#141414] border border-white/10 rounded-xl p-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-medium">Unmatched Cash</p>
          <p className="text-[26px] font-bold font-mono tabular-nums mt-2 text-red-400 leading-none">
            {formatCurrency(totalUnmatched)}
          </p>
          <p className="text-[11px] text-zinc-500 mt-1.5">
            {unmatched_inflows.length + unmatched_outflows.length} movements need action
          </p>
        </div>

        {/* Open AR */}
        <div className="bg-[#141414] border border-white/10 rounded-xl p-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-medium">Open AR Waiting</p>
          <p className="text-[26px] font-bold font-mono tabular-nums mt-2 text-emerald-400 leading-none">
            {formatCurrency(openAR)}
          </p>
          <p className="text-[11px] text-zinc-500 mt-1.5">
            {arLife?.open_count || 0} invoices unpaid · {arLife?.paid_count || 0} collected
          </p>
        </div>

        {/* Open AP */}
        <div className="bg-[#141414] border border-white/10 rounded-xl p-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-medium">Open AP Waiting</p>
          <p className="text-[26px] font-bold font-mono tabular-nums mt-2 text-amber-400 leading-none">
            {formatCurrency(openAP)}
          </p>
          <p className="text-[11px] text-zinc-500 mt-1.5">
            {apLife?.open_count || 0} bills unpaid · {apLife?.paid_count || 0} paid
          </p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="review" className="w-full">
        <TabsList className="bg-[#141414] border border-white/10 h-9">
          <TabsTrigger value="review" className="text-[12px] h-7 px-3">Review ({unmatched_inflows.length + unmatched_outflows.length})</TabsTrigger>
          <TabsTrigger value="reconciled" className="text-[12px] h-7 px-3">AR / AP ({(arLife?.invoice_count || 0) + (apLife?.bill_count || 0)})</TabsTrigger>
          <TabsTrigger value="excluded" className="text-[12px] h-7 px-3">Excluded ({data.excluded_movements?.count || 0})</TabsTrigger>
        </TabsList>

        {/* Review Queue Tab */}
        <TabsContent value="review" className="space-y-3 mt-3">
          {unmatched_inflows.length + unmatched_outflows.length === 0 ? (
            <div className="bg-[#141414] border border-white/10 rounded-xl p-14 text-center">
              <div className="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-3">
                <span className="text-emerald-400 text-lg">✓</span>
              </div>
              <p className="text-white font-medium">Inbox Zero</p>
              <p className="text-zinc-500 text-[12px] mt-1">All operating cash has been reconciled.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Column headers */}
              <div className="grid grid-cols-[1fr_80px_1fr_140px] gap-0 px-4">
                <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Bank Transaction</p>
                <p className="text-[10px] text-zinc-600 uppercase tracking-wider text-center">Match</p>
                <p className="text-[10px] text-zinc-600 uppercase tracking-wider pl-4">Ledger</p>
                <p className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">Action</p>
              </div>

              {[...unmatched_inflows, ...unmatched_outflows].map((movement) => {
                const sm = movement.suggested_match
                const badge = sm ? getConfidenceBadge(sm.confidence) : null
                const isInflow = movement.amount > 0
                const entityName = sm?.entity_name
                const refId = sm?.invoice_id || sm?.bill_id
                const refLabel = sm?.invoice_id ? `Inv #${refId}` : sm?.bill_id ? `Bill #${refId}` : null
                const isAR = !!sm?.invoice_id
                const hasMatch = !!sm

                return (
                  <div
                    key={movement.id}
                    className="grid grid-cols-[1fr_80px_1fr_140px] items-stretch bg-[#141414] border border-white/[0.06] rounded-xl overflow-hidden hover:border-white/[0.12] transition-colors duration-150 group"
                  >
                    {/* Left: Bank Side */}
                    <div className="px-4 py-3 border-r border-white/[0.06]">
                      <div className="flex items-start gap-3">
                        <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ring-2 ${isInflow ? "bg-emerald-500 ring-emerald-500/20" : "bg-red-500 ring-red-500/20"}`} />
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-white truncate leading-tight">{movement.description}</p>
                          {movement.raw_description && movement.raw_description !== movement.description && (
                            <p className="text-[11px] text-zinc-500 truncate mt-0.5 leading-tight">{movement.raw_description}</p>
                          )}
                          <div className="flex items-baseline gap-2 mt-1.5">
                            <span className={`text-[15px] font-mono tabular-nums font-bold ${isInflow ? "text-emerald-400" : "text-red-400"}`}>
                              {isInflow ? "+" : "−"}{formatCurrency(Math.abs(movement.amount))}
                            </span>
                            <span className="text-[11px] text-zinc-500">{formatDate(movement.date)}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Middle: Confidence bridge */}
                    <div className="flex flex-col items-center justify-center py-3 px-2 border-r border-white/[0.06] bg-[#111]">
                      {badge ? (
                        <>
                          <span className={`text-[11px] font-bold font-mono ${badge.tier === "high" ? "text-emerald-400" : badge.tier === "med" ? "text-amber-400" : "text-zinc-400"}`}>
                            {badge.label}
                          </span>
                          <div className="my-1.5 flex flex-col items-center gap-0.5">
                            <div className="w-px h-2 bg-white/10" />
                            <ArrowRight className="h-3 w-3 text-zinc-600" />
                            <div className="w-px h-2 bg-white/10" />
                          </div>
                          <span className="text-[9px] text-zinc-600 uppercase tracking-wider text-center leading-tight">
                            {badge.tier === "high" ? "Strong" : badge.tier === "med" ? "Likely" : "Possible"}
                          </span>
                        </>
                      ) : (
                        <div className="flex flex-col items-center gap-1">
                          <span className="text-[18px] text-zinc-700">?</span>
                          <span className="text-[9px] text-zinc-600 uppercase tracking-wider">Manual</span>
                        </div>
                      )}
                    </div>

                    {/* Right: Ledger Side */}
                    <div className="px-4 py-3 border-r border-white/[0.06]">
                      {hasMatch ? (
                        <div className="flex items-start gap-2.5 h-full">
                          <div className={`mt-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider shrink-0 ${isAR ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"}`}>
                            {isAR ? "AR" : "AP"}
                          </div>
                          <div className="min-w-0">
                            <p className="text-[13px] font-medium text-white truncate leading-tight">
                              {entityName || (isAR ? "Invoice" : "Bill")}
                            </p>
                            {refLabel && <p className="text-[11px] text-zinc-500 mt-0.5">{refLabel}</p>}
                            <div className="flex items-baseline gap-2 mt-1.5">
                              <span className="text-[15px] font-mono tabular-nums font-bold text-zinc-200">
                                {formatCurrency(sm.matched_amount)}
                              </span>
                              {sm.reason && (
                                <span className="text-[10px] text-zinc-600 truncate">{sm.reason}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center h-full">
                          <div>
                            <p className="text-[12px] text-zinc-500 italic">No AI match found</p>
                            <p className="text-[11px] text-zinc-600 mt-0.5">Use "Match" to link manually</p>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Action */}
                    <div className="flex items-center justify-end gap-2 px-3 py-3">
                      {sm && sm.confidence >= 0.75 ? (
                        <Button
                          size="sm"
                          className="bg-emerald-600 hover:bg-emerald-500 text-[11px] h-7 px-3 font-medium"
                          onClick={async () => {
                            const componentType = sm.invoice_id ? "ar" : "ap"
                            const referenceId = sm.invoice_id || sm.bill_id
                            try {
                              const res = await fetch("/api/dashboard/reconciliation/apply-match", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  movement_id: movement.id,
                                  reference_id: referenceId,
                                  component_type: componentType,
                                  entity_id: "",
                                  amount: sm.matched_amount,
                                }),
                              })
                              if (res.ok) await fetchData()
                              else setError("Failed to apply match")
                            } catch (err) {
                              setError(err instanceof Error ? err.message : "Error")
                            }
                          }}
                        >
                          ✓ Accept
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-[11px] h-7 px-2.5 text-zinc-400 hover:text-white border border-white/[0.06] hover:border-white/20"
                        onClick={() => {
                          setSelectedMovement(movement)
                          setSelectedMatches([])
                          setSearchQuery("")
                          setSearchResults([])
                          setIsDrawerOpen(true)
                        }}
                      >
                        Match
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </TabsContent>

        {/* Reconciled Tab */}
        <TabsContent value="reconciled" className="space-y-5">
          {/* Summary stats row */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-[#141414] border border-white/10 rounded-lg px-3 py-2.5">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider">AR Matched</p>
              <p className="text-lg font-mono tabular-nums text-emerald-400 font-semibold mt-0.5">{arSummary?.matched_count || 0}</p>
              <p className="text-[10px] text-zinc-600">{formatCurrency(arSummary?.matched_amount || 0)}</p>
            </div>
            <div className="bg-[#141414] border border-white/10 rounded-lg px-3 py-2.5">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider">AR Unmatched</p>
              <p className="text-lg font-mono tabular-nums text-red-400 font-semibold mt-0.5">{arSummary?.unmatched_count || 0}</p>
              <p className="text-[10px] text-zinc-600">{formatCurrency(arSummary?.unmatched_amount || 0)}</p>
            </div>
            <div className="bg-[#141414] border border-white/10 rounded-lg px-3 py-2.5">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider">AP Matched</p>
              <p className="text-lg font-mono tabular-nums text-amber-400 font-semibold mt-0.5">{apSummary?.matched_count || 0}</p>
              <p className="text-[10px] text-zinc-600">{formatCurrency(apSummary?.matched_amount || 0)}</p>
            </div>
            <div className="bg-[#141414] border border-white/10 rounded-lg px-3 py-2.5">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider">AP Unmatched</p>
              <p className="text-lg font-mono tabular-nums text-red-400 font-semibold mt-0.5">{apSummary?.unmatched_count || 0}</p>
              <p className="text-[10px] text-zinc-600">{formatCurrency(apSummary?.unmatched_amount || 0)}</p>
            </div>
          </div>

          {/* AR Invoices Table */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Invoices (AR)</p>
              <span className="text-[10px] text-zinc-600">
                {(data.ar?.paid_invoices?.length || 0)} paid &middot; {(data.ar?.invoices?.length || 0)} open
              </span>
            </div>
            <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
              {(() => {
                const matchedInvoices = [...(data.ar?.invoices || []), ...(data.ar?.paid_invoices || [])].filter(
                  i => i.reconciliation_status === "matched" || i.reconciliation_status === "partial"
                )
                const unmatchedInvoices = [...(data.ar?.invoices || [])].filter(
                  i => !i.reconciliation_status || i.reconciliation_status === "unmatched"
                )
                const allInvoices = [...matchedInvoices, ...unmatchedInvoices]
                if (allInvoices.length === 0) return (
                  <div className="p-8 text-center"><p className="text-zinc-500 text-[12px]">No invoices found.</p></div>
                )
                return (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-white/10">
                          <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Customer</th>
                          <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Invoice</th>
                          <th className="text-right text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Amount</th>
                          <th className="text-right text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Due</th>
                          <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Due Date</th>
                          <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allInvoices.slice(0, 30).map((inv, idx) => {
                          const isMatched = inv.reconciliation_status === "matched" || inv.reconciliation_status === "partial"
                          const isPaid = inv.status === "paid"
                          return (
                            <tr key={inv.invoice_id || idx} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors duration-100">
                              <td className="px-3 py-2">
                                <p className="text-[13px] text-white truncate max-w-[180px]">{inv.customer_name || "—"}</p>
                              </td>
                              <td className="px-3 py-2">
                                <p className="text-[12px] text-zinc-400 font-mono">{inv.invoice_id || "—"}</p>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <span className="text-[13px] font-mono tabular-nums text-white">{formatCurrency(inv.amount)}</span>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <span className={`text-[13px] font-mono tabular-nums ${inv.amount_due > 0 ? "text-amber-400" : "text-zinc-500"}`}>
                                  {formatCurrency(inv.amount_due)}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-[12px] text-zinc-400 whitespace-nowrap">{formatDate(inv.due_date)}</td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-1.5">
                                  {isPaid ? (
                                    <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] px-1.5 py-0">Paid</Badge>
                                  ) : (
                                    <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] px-1.5 py-0">Open</Badge>
                                  )}
                                  {isMatched ? (
                                    <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] px-1.5 py-0">
                                      {inv.reconciliation_status === "partial" ? "Partial" : "Matched"}
                                    </Badge>
                                  ) : (
                                    <Badge className="bg-zinc-500/10 text-zinc-500 border border-zinc-500/20 text-[10px] px-1.5 py-0">Unmatched</Badge>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {allInvoices.length > 30 && (
                      <div className="px-3 py-2 text-[11px] text-zinc-500 text-center border-t border-white/5">
                        Showing 30 of {allInvoices.length} invoices
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          </div>

          {/* AP Bills Table */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Bills (AP)</p>
              <span className="text-[10px] text-zinc-600">
                {(data.ap?.paid_bills?.length || 0)} paid &middot; {(data.ap?.bills?.length || 0)} open
              </span>
            </div>
            <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
              {(() => {
                const matchedBills = [...(data.ap?.bills || []), ...(data.ap?.paid_bills || [])].filter(
                  b => b.reconciliation_status === "matched" || b.reconciliation_status === "partial"
                )
                const unmatchedBills = [...(data.ap?.bills || [])].filter(
                  b => !b.reconciliation_status || b.reconciliation_status === "unmatched"
                )
                const allBills = [...matchedBills, ...unmatchedBills]
                if (allBills.length === 0) return (
                  <div className="p-8 text-center"><p className="text-zinc-500 text-[12px]">No bills found.</p></div>
                )
                return (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-white/10">
                          <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Vendor</th>
                          <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Bill</th>
                          <th className="text-right text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Amount</th>
                          <th className="text-right text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Due</th>
                          <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Due Date</th>
                          <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allBills.slice(0, 30).map((bill, idx) => {
                          const isMatched = bill.reconciliation_status === "matched" || bill.reconciliation_status === "partial"
                          const isPaid = bill.status === "paid"
                          return (
                            <tr key={bill.bill_id || idx} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors duration-100">
                              <td className="px-3 py-2">
                                <p className="text-[13px] text-white truncate max-w-[180px]">{bill.vendor_name || "—"}</p>
                              </td>
                              <td className="px-3 py-2">
                                <p className="text-[12px] text-zinc-400 font-mono">{bill.bill_id || "—"}</p>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <span className="text-[13px] font-mono tabular-nums text-white">{formatCurrency(bill.amount)}</span>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <span className={`text-[13px] font-mono tabular-nums ${bill.amount_due > 0 ? "text-amber-400" : "text-zinc-500"}`}>
                                  {formatCurrency(bill.amount_due)}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-[12px] text-zinc-400 whitespace-nowrap">{formatDate(bill.due_date)}</td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-1.5">
                                  {isPaid ? (
                                    <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] px-1.5 py-0">Paid</Badge>
                                  ) : (
                                    <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] px-1.5 py-0">Open</Badge>
                                  )}
                                  {isMatched ? (
                                    <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] px-1.5 py-0">
                                      {bill.reconciliation_status === "partial" ? "Partial" : "Matched"}
                                    </Badge>
                                  ) : (
                                    <Badge className="bg-zinc-500/10 text-zinc-500 border border-zinc-500/20 text-[10px] px-1.5 py-0">Unmatched</Badge>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {allBills.length > 30 && (
                      <div className="px-3 py-2 text-[11px] text-zinc-500 text-center border-t border-white/5">
                        Showing 30 of {allBills.length} bills
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          </div>

          {/* Bank-to-Ledger Matches */}
          {(data.reconciled_movements?.matched || []).length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Bank &#8594; Ledger Matches</p>
                <span className="text-[10px] text-zinc-600">{data.reconciled_movements!.matched.length} movements matched</span>
              </div>
              <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Movement</th>
                        <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Matched To</th>
                        <th className="text-right text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Amount</th>
                        <th className="text-center text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Confidence</th>
                        <th className="text-right text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data.reconciled_movements?.matched || []).map((m, i) => {
                        const confBadge = getConfidenceBadge(m.confidence)
                        return (
                          <tr key={`${m.movement_id}-${i}`} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors duration-100">
                            <td className="px-3 py-2">
                              <p className="text-[12px] text-zinc-300 font-mono truncate">{m.movement_id.slice(0, 8)}...</p>
                            </td>
                            <td className="px-3 py-2">
                              <p className="text-[13px] text-white truncate">{m.matched_to}</p>
                              <p className="text-[11px] text-zinc-500">{formatDate(m.matched_at)}</p>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <span className="text-[13px] font-mono tabular-nums text-zinc-300">{formatCurrency(m.amount_matched)}</span>
                            </td>
                            <td className="px-3 py-2 text-center">
                              <Badge className={`${confBadge.color} border text-[10px] px-1.5 py-0`}>{confBadge.label}</Badge>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Badge className={`${m.matched_by === "ai" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-blue-500/10 text-blue-400 border-blue-500/20"} border text-[10px] px-1.5 py-0`}>
                                {m.matched_by === "ai" ? "AI" : "Manual"}
                              </Badge>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        {/* Excluded Tab */}
        <TabsContent value="excluded" className="space-y-4">
          {data.excluded_movements && data.excluded_movements.count > 0 && (
            <div className="flex items-center gap-4 text-[11px] text-zinc-500">
              <span>{data.excluded_movements.count} non-operating movements</span>
              <span className="text-zinc-600">|</span>
              <span>Total: {formatCurrency(data.excluded_movements.total_amount)}</span>
              <span className="text-zinc-600">|</span>
              <span className="italic">Excluded from reconciliation KPIs</span>
            </div>
          )}
          <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
            {(data.excluded_movements?.movements || []).length === 0 ? (
              <div className="p-12 text-center">
                <p className="text-zinc-500 text-sm">No excluded movements.</p>
              </div>
            ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Date</th>
                    <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Description</th>
                    <th className="text-right text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Amount</th>
                    <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Classification</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.excluded_movements?.movements || []).map(m => (
                    <tr key={m.id} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors duration-100">
                      <td className="px-3 py-2 text-[13px] text-zinc-400 whitespace-nowrap">{formatDate(m.date)}</td>
                      <td className="px-3 py-2 text-[13px] text-white truncate max-w-[300px]">{m.description}</td>
                      <td className="px-3 py-2 text-right">
                        <span className="text-[13px] font-mono tabular-nums text-zinc-300">{formatCurrency(m.amount)}</span>
                      </td>
                      <td className="px-3 py-2">
                        <Badge className="bg-zinc-500/10 text-zinc-400 border border-zinc-500/20 text-[10px] px-1.5 py-0">
                          {formatEconomicClass(m.economic_class)}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Manual Match Sheet */}
      <Sheet open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
        <SheetContent className="bg-[#141414] border-l border-white/10 w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="text-white text-base">Manual Match</SheetTitle>
          </SheetHeader>

          {error && (
            <div className="mt-4 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-red-400 text-[12px]">
              {error}
            </div>
          )}

          {selectedMovement && (
            <div className="space-y-5 mt-5">
              {/* Frozen Movement */}
              <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-4">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">Selected Bank Transaction</p>
                <div className="flex items-baseline justify-between">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-white truncate">{selectedMovement.description}</p>
                    <p className="text-[11px] text-zinc-500 mt-0.5">{formatDate(selectedMovement.date)}</p>
                  </div>
                  <p className={`text-lg font-mono tabular-nums font-semibold shrink-0 ml-4 ${selectedMovement.amount > 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {selectedMovement.amount > 0 ? "+" : ""}{formatCurrency(selectedMovement.amount)}
                  </p>
                </div>
              </div>

              {/* Search */}
              <div className="space-y-2">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Find Invoices / Bills</p>
                <Tabs defaultValue="ar" className="w-full" onValueChange={(v) => {
                  setSearchResults([])
                  if (searchQuery) handleSearch(searchQuery, v as "ar" | "ap")
                }}>
                  <TabsList className="bg-[#0A0A0A] border border-white/10 h-8">
                    <TabsTrigger value="ar" className="text-[11px] h-6 px-3">Open Invoices (AR)</TabsTrigger>
                    <TabsTrigger value="ap" className="text-[11px] h-6 px-3">Open Bills (AP)</TabsTrigger>
                  </TabsList>
                  <div className="relative mt-2">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
                    <Input
                      placeholder="Search by entity name or reference..."
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value)
                        handleSearch(e.target.value, "ar")
                      }}
                      className="bg-[#0A0A0A] border-white/10 pl-9 h-8 text-[12px]"
                    />
                  </div>
                </Tabs>
              </div>

              {/* Search Results */}
              {searchLoading && (
                <div className="text-center py-3 text-zinc-500">
                  <div className="inline-flex items-center gap-2">
                    <div className="h-3.5 w-3.5 border-2 border-zinc-600 border-t-transparent rounded-full animate-spin" />
                    <span className="text-[11px]">Searching...</span>
                  </div>
                </div>
              )}

              {!searchLoading && searchResults.length > 0 && (
                <div className="space-y-1.5 max-h-56 overflow-y-auto">
                  {searchResults.map(result => {
                    const isSelected = selectedMatches.some(m => m.reference_id === result.id)
                    return (
                      <div
                        key={result.id}
                        className={`flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-colors duration-100 ${isSelected ? "bg-emerald-500/5 border border-emerald-500/30" : "bg-[#0A0A0A] border border-white/10 hover:border-white/20"}`}
                        onClick={() => {
                          if (isSelected) {
                            setSelectedMatches(selectedMatches.filter(m => m.reference_id !== result.id))
                          } else {
                            setSelectedMatches([...selectedMatches, {
                              reference_id: result.id,
                              component_type: "ar",
                              amount: Math.min(result.amount_due, Math.abs(selectedMovement.amount) - selectedMatches.reduce((s, m) => s + m.amount, 0)),
                            }])
                          }
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          className="w-3.5 h-3.5 shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium text-white truncate">{result.entity_name}</p>
                          <p className="text-[11px] text-zinc-500">
                            {result.id} &middot; Due {formatDate(result.due_date)}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-[13px] font-mono tabular-nums text-zinc-300">{formatCurrency(result.amount_due)}</p>
                          <p className="text-[10px] text-zinc-500">due</p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {!searchLoading && searchQuery && searchResults.length === 0 && (
                <div className="text-center py-3 text-zinc-500 text-[11px]">
                  No results for &ldquo;{searchQuery}&rdquo;
                </div>
              )}

              {/* Consumption Bar */}
              {selectedMatches.length > 0 && (() => {
                const matchedTotal = selectedMatches.reduce((sum, m) => sum + m.amount, 0)
                const movementAbs = Math.abs(selectedMovement.amount)
                const pct = Math.min(100, (matchedTotal / movementAbs) * 100)
                const fullyMatched = matchedTotal >= movementAbs - 0.01
                return (
                  <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-3 space-y-2">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-zinc-400">Consumption</span>
                      <span className="text-white font-mono tabular-nums">
                        {formatCurrency(matchedTotal)} / {formatCurrency(movementAbs)}
                      </span>
                    </div>
                    <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                      <div
                        className={`h-1.5 rounded-full transition-all duration-300 ease-out ${fullyMatched ? "bg-emerald-500" : "bg-amber-500"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="text-[11px]">
                      {fullyMatched ? (
                        <span className="text-emerald-400">Fully consumed</span>
                      ) : (
                        <span className="text-amber-400">Remaining: {formatCurrency(movementAbs - matchedTotal)}</span>
                      )}
                    </div>

                    {/* Editable Split Amounts */}
                    <div className="pt-2 space-y-1.5 border-t border-white/5">
                      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Split Amounts</p>
                      {selectedMatches.map((match, idx) => {
                        const result = searchResults.find(r => r.id === match.reference_id)
                        return (
                          <div key={match.reference_id} className="flex items-center gap-2">
                            <span className="text-[12px] text-zinc-300 truncate flex-1">{result?.entity_name || match.reference_id}</span>
                            <Input
                              type="number"
                              step="0.01"
                              value={match.amount}
                              onChange={(e) => {
                                const newAmount = parseFloat(e.target.value) || 0
                                const updated = [...selectedMatches]
                                updated[idx] = { ...updated[idx], amount: newAmount }
                                setSelectedMatches(updated)
                              }}
                              className="w-28 bg-[#141414] border-white/10 text-right font-mono tabular-nums text-[12px] h-7 px-2"
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

              {/* Action Buttons */}
              <div className="flex gap-2 justify-end pt-2">
                <Button variant="ghost" size="sm" className="text-[12px] h-8" onClick={() => setIsDrawerOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleConfirmMatch}
                  disabled={selectedMatches.length === 0}
                  className="bg-emerald-600 hover:bg-emerald-700 text-[12px] h-8"
                >
                  Confirm Match
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

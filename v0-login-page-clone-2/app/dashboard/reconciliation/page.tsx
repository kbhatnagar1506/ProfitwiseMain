"use client"

import { useState, useEffect, useCallback } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { RefreshCw, Search, ArrowRight, Copy, Mail, Phone, ExternalLink, Sparkles, Clock } from "lucide-react"

interface SuggestedMatch {
  movement_id: string
  invoice_id?: string
  bill_id?: string
  confidence: number
  reason: string
  matched_amount: number
  waterfall_stage?: number
  auto_accepted: boolean
}

interface Movement {
  id: string
  date: string
  amount: number
  description: string
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

interface ARAPStepResponse {
  ar?: {
    invoices: any[]
    paid_invoices: any[]
    reconciliation_summary: {
      match_rate: number
      discrepancy: number
    }
  }
  ap?: {
    bills: any[]
    paid_bills: any[]
    reconciliation_summary: {
      match_rate: number
      discrepancy: number
    }
  }
  recon?: {
    unmatched_inflows: any[]
    unmatched_outflows: any[]
    total_unmatched_inflows: number
    total_unmatched_outflows: number
  }
  lifetime?: {
    ar: { outstanding: number }
    ap: { outstanding: number }
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

function getConfidenceBadge(confidence: number) {
  if (confidence >= 0.88) return { label: `High ${Math.round(confidence * 100)}%`, color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" }
  if (confidence >= 0.75) return { label: `Medium ${Math.round(confidence * 100)}%`, color: "bg-amber-500/10 text-amber-400 border-amber-500/20" }
  return { label: `Low ${Math.round(confidence * 100)}%`, color: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20" }
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
      }
    } catch (err) {
      console.error(err)
    }
  }

  if (loading) {
    return (
      <div className="p-8 space-y-6">
        <Skeleton className="h-12 w-64" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-24" />)}
        </div>
      </div>
    )
  }

  if (!data) {
    return <div className="p-8 text-red-400">{error || "No data"}</div>
  }

  if (data.is_reconciling && !data.ar) {
    return (
      <div className="p-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white">Reconciliation</h1>
            <p className="text-zinc-400 mt-1">Running reconciliation...</p>
          </div>
        </div>
        <div className="bg-[#141414] border border-white/10 rounded-lg p-8 text-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-5 w-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-zinc-300">Reconciliation in progress. Polling for updates...</span>
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

  return (
    <div className="p-8 space-y-6 bg-[#0A0A0A] min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Reconciliation</h1>
          <p className="text-zinc-400 mt-1">Clearing House - Match bank cash to AR/AP</p>
        </div>
        <Button
          onClick={handleRunReconciliation}
          disabled={data.is_reconciling || running}
          className="bg-emerald-600 hover:bg-emerald-700"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          {data.is_reconciling ? "Running..." : "Run Reconciliation"}
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">Unmatched Cash</p>
          <p className={`text-2xl font-bold mt-2 ${totalUnmatched > 0 ? "text-red-400" : "text-emerald-400"}`}>
            {formatCurrency(totalUnmatched)}
          </p>
          <p className="text-xs text-zinc-400 mt-2">{unmatched_inflows.length + unmatched_outflows.length} movements</p>
        </div>

        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">Open AR Waiting</p>
          <p className="text-2xl font-bold mt-2 text-emerald-400">{formatCurrency(openAR)}</p>
          <p className="text-xs text-zinc-400 mt-2">{data.ar?.invoices?.length || 0} invoices</p>
        </div>

        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">Open AP Waiting</p>
          <p className="text-2xl font-bold mt-2 text-amber-400">{formatCurrency(openAP)}</p>
          <p className="text-xs text-zinc-400 mt-2">{data.ap?.bills?.length || 0} bills</p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="review" className="w-full">
        <TabsList className="bg-[#141414] border border-white/10">
          <TabsTrigger value="review">Review Queue ({unmatched_inflows.length + unmatched_outflows.length})</TabsTrigger>
          <TabsTrigger value="reconciled">Reconciled ({data.reconciled_movements?.matched?.length || 0})</TabsTrigger>
          <TabsTrigger value="excluded">Excluded ({data.excluded_movements?.count || 0})</TabsTrigger>
        </TabsList>

        {/* Review Queue Tab */}
        <TabsContent value="review" className="space-y-4">
          <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3 w-[30%]">Bank Side</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3 w-[20%]">Match Bridge</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3 w-[40%]">Ledger Side</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3 w-[10%]">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {[...unmatched_inflows, ...unmatched_outflows].map(movement => {
                    const badge = movement.suggested_match ? getConfidenceBadge(movement.suggested_match.confidence) : null
                    return (
                      <tr key={movement.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="px-4 py-3">
                          <div className="space-y-1">
                            <p className="text-xs text-zinc-400">{formatDate(movement.date)}</p>
                            <p className="text-sm text-white truncate">{movement.description}</p>
                            <p className={`text-sm font-mono tabular-nums ${movement.amount > 0 ? "text-emerald-400" : "text-red-400"}`}>
                              {movement.amount > 0 ? "+" : ""}{formatCurrency(movement.amount)}
                            </p>
                          </div>
                        </td>

                        <td className="px-4 py-3">
                          {badge ? (
                            <div className="flex items-center gap-2">
                              <Badge className={`${badge.color} border`}>
                                {badge.label}
                              </Badge>
                              <ArrowRight className="h-4 w-4 text-zinc-500" />
                            </div>
                          ) : (
                            <Badge className="bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">
                              Manual Review
                            </Badge>
                          )}
                        </td>

                        <td className="px-4 py-3">
                          {movement.suggested_match ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <Badge className={`${movement.suggested_match.invoice_id ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"} border text-xs`}>
                                  {movement.suggested_match.invoice_id ? "AR" : "AP"}
                                </Badge>
                                <span className="text-sm text-white">
                                  {movement.suggested_match.invoice_id ? "Invoice" : "Bill"}
                                </span>
                              </div>
                              <p className="text-xs text-zinc-400">{movement.suggested_match.reason}</p>
                              <p className="text-sm font-mono tabular-nums text-zinc-300">{formatCurrency(movement.suggested_match.matched_amount)}</p>
                            </div>
                          ) : (
                            <p className="text-sm text-zinc-400">—</p>
                          )}
                        </td>

                        <td className="px-4 py-3">
                          {movement.suggested_match && movement.suggested_match.confidence >= 0.88 ? (
                            <Button
                              size="sm"
                              className="bg-emerald-600 hover:bg-emerald-700 text-xs"
                              onClick={async () => {
                                const componentType = movement.suggested_match!.invoice_id ? "ar" : "ap"
                                const referenceId = movement.suggested_match!.invoice_id || movement.suggested_match!.bill_id
                                await fetch("/api/dashboard/reconciliation/apply-match", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    movement_id: movement.id,
                                    reference_id: referenceId,
                                    component_type: componentType,
                                    entity_id: "",
                                    amount: movement.suggested_match!.matched_amount,
                                  }),
                                })
                                await fetchData()
                              }}
                            >
                              ✓ Accept
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs"
                              onClick={() => {
                                setSelectedMovement(movement)
                                setSelectedMatches([])
                                setSearchQuery("")
                                setSearchResults([])
                                setIsDrawerOpen(true)
                              }}
                            >
                              ⋯ Match
                            </Button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>

        {/* Reconciled Tab */}
        <TabsContent value="reconciled" className="space-y-4">
          <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">Date</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">Description</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">Amount</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">Matched By</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.reconciled_movements?.matched || []).map(m => (
                    <tr key={m.movement_id} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="px-4 py-3 text-sm text-zinc-400">{formatDate(m.matched_at)}</td>
                      <td className="px-4 py-3 text-sm text-white">{m.matched_to}</td>
                      <td className="px-4 py-3 text-sm font-mono tabular-nums text-zinc-300">{formatCurrency(m.amount_matched)}</td>
                      <td className="px-4 py-3">
                        <Badge className={m.matched_by === "ai" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-blue-500/10 text-blue-400 border-blue-500/20"} variant="outline">
                          {m.matched_by === "ai" ? "AI" : "User"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>

        {/* Excluded Tab */}
        <TabsContent value="excluded" className="space-y-4">
          <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">Date</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">Description</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">Amount</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.excluded_movements?.movements || []).map(m => (
                    <tr key={m.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="px-4 py-3 text-sm text-zinc-400">{formatDate(m.date)}</td>
                      <td className="px-4 py-3 text-sm text-white">{m.description}</td>
                      <td className="px-4 py-3 text-sm font-mono tabular-nums text-zinc-300">{formatCurrency(m.amount)}</td>
                      <td className="px-4 py-3 text-xs text-zinc-400">{m.economic_class}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Manual Match Sheet */}
      <Sheet open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
        <SheetContent className="bg-[#141414] border-l border-white/10 w-full sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="text-white">Manual Match</SheetTitle>
          </SheetHeader>

          {selectedMovement && (
            <div className="space-y-6 mt-6">
              {/* Frozen Movement */}
              <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-4">
                <p className="text-xs text-zinc-500 uppercase tracking-wide">Bank Transaction</p>
                <div className="mt-3 space-y-2">
                  <p className="text-sm text-white">{selectedMovement.description}</p>
                  <p className={`text-lg font-mono tabular-nums ${selectedMovement.amount > 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {selectedMovement.amount > 0 ? "+" : ""}{formatCurrency(selectedMovement.amount)}
                  </p>
                </div>
              </div>

              {/* Search */}
              <div className="space-y-3">
                <p className="text-xs text-zinc-500 uppercase tracking-wide">Search Invoices/Bills</p>
                <Input
                  placeholder="Search by name or ID..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value)
                    handleSearch(e.target.value, "ar")
                  }}
                  className="bg-[#0A0A0A] border-white/10"
                />
              </div>

              {/* Search Results */}
              {searchResults.length > 0 && (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {searchResults.map(result => (
                    <div
                      key={result.id}
                      className="flex items-center gap-3 p-3 bg-[#0A0A0A] border border-white/10 rounded-lg cursor-pointer hover:border-emerald-500/50"
                      onClick={() => {
                        const existing = selectedMatches.find(m => m.reference_id === result.id)
                        if (existing) {
                          setSelectedMatches(selectedMatches.filter(m => m.reference_id !== result.id))
                        } else {
                          setSelectedMatches([...selectedMatches, {
                            reference_id: result.id,
                            component_type: "ar",
                            amount: Math.min(result.amount_due, Math.abs(selectedMovement.amount)),
                          }])
                        }
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedMatches.some(m => m.reference_id === result.id)}
                        onChange={() => {}}
                        className="w-4 h-4"
                      />
                      <div className="flex-1">
                        <p className="text-sm text-white">{result.entity_name}</p>
                        <p className="text-xs text-zinc-400">{formatCurrency(result.amount_due)} due</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Consumption Bar */}
              {selectedMatches.length > 0 && (
                <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-4 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-400">Matched</span>
                    <span className="text-white font-mono">
                      {formatCurrency(selectedMatches.reduce((sum, m) => sum + m.amount, 0))} / {formatCurrency(Math.abs(selectedMovement.amount))}
                    </span>
                  </div>
                  <div className="w-full bg-zinc-700 rounded-full h-2">
                    <div
                      className="bg-emerald-500 h-2 rounded-full transition-all"
                      style={{
                        width: `${Math.min(100, (selectedMatches.reduce((sum, m) => sum + m.amount, 0) / Math.abs(selectedMovement.amount)) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3 justify-end pt-4">
                <Button variant="ghost" onClick={() => setIsDrawerOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleConfirmMatch}
                  disabled={selectedMatches.length === 0}
                  className="bg-emerald-600 hover:bg-emerald-700"
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

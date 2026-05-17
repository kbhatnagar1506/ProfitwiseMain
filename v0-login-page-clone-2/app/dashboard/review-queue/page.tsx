"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { RefreshCw, Search, CheckCircle2, XCircle, Clock, AlertCircle, Info, ChevronRight, ChevronDown, Zap } from "lucide-react"

interface PendingMatch {
  id: string
  movement_id: string
  cash_event_id: string
  bank_date: string
  bank_description: string | null
  bank_counterparty: string | null
  bank_amount: number
  invoice_id: string
  invoice_number: string | null
  customer_name: string
  invoice_amount: number
  invoice_date: string | null
  due_date: string | null
  match_type: string
  confidence: number
  fee_amount: number
  matched_amount: number
  reasoning: string | null
  status: string
  created_at: string
}

interface Candidate {
  id: string
  entity_id: string
  entity_name: string
  invoice_number: string | null
  customer_name: string
  amount: number
  outstanding_amount: number
  due_date: string | null
  match_type: string
  amount_diff: number
  fee_implied: number | null
  is_direct_link: boolean
  reference_match: boolean
  is_customer_match?: boolean
  is_amount_match?: boolean
  invoice_date: string | null
}

interface MovementCandidates {
  movement: {
    id: string
    date: string
    amount: number
    direction: string
    counterparty: string | null
    raw_description: string | null
  }
  classification: {
    case_type: string
    is_operational: boolean
    flags: Record<string, boolean>
    suggested_action: string
  }
  candidates: Candidate[]
  existing_matches: Record<string, any>
  total_candidates: number
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

function formatDate(d: string | null) {
  if (!d) return "—"
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function getMatchTypeColor(matchType: string): string {
  switch (matchType) {
    case "EXACT": return "bg-emerald-500/20 text-emerald-300"
    case "FEE": return "bg-amber-500/20 text-amber-300"
    case "PARTIAL": return "bg-purple-500/20 text-purple-300"
    case "AGGREGATION": return "bg-cyan-500/20 text-cyan-300"
    default: return "bg-slate-500/20 text-slate-300"
  }
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.85) return "text-emerald-300"
  if (confidence >= 0.70) return "text-amber-300"
  return "text-rose-300"
}

function InfoButton({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="ml-1 text-slate-500 hover:text-slate-300 transition-colors">
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 bg-slate-900 border-slate-700 text-slate-200 p-3" side="bottom" align="start">
        <h4 className="font-semibold text-slate-100 text-sm mb-2">{title}</h4>
        <div className="text-xs space-y-1.5 text-slate-400">{children}</div>
      </PopoverContent>
    </Popover>
  )
}

export default function ReviewQueuePage() {
  const [pendingMatches, setPendingMatches] = useState<PendingMatch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [processingId, setProcessingId] = useState<string | null>(null)
  
  // Triage Drawer state
  const [triageOpen, setTriageOpen] = useState(false)
  const [selectedMatch, setSelectedMatch] = useState<PendingMatch | null>(null)
  const [candidates, setCandidates] = useState<MovementCandidates | null>(null)
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [selectedCandidateIdx, setSelectedCandidateIdx] = useState(0)
  const [splitMode, setSplitMode] = useState(false)
  const [splitAllocations, setSplitAllocations] = useState<Map<string, number>>(new Map())

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const matchesRes = await fetch("/api/ar-reconciliation/matches?status=pending&limit=500")
      if (!matchesRes.ok) throw new Error("Failed to fetch pending matches")
      const matchesJson = await matchesRes.json()
      setPendingMatches(matchesJson.matches || [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error loading review queue")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const openTriageDrawer = useCallback(async (match: PendingMatch) => {
    setSelectedMatch(match)
    setCandidatesLoading(true)
    setSelectedCandidateIdx(0)
    setSplitMode(false)
    setSplitAllocations(new Map())
    
    try {
      const res = await fetch(`/api/ar-reconciliation/candidates?movement_id=${match.movement_id}`)
      if (res.ok) {
        const data = await res.json()
        setCandidates(data)
      }
    } catch (err) {
      console.error("Failed to fetch candidates:", err)
    } finally {
      setCandidatesLoading(false)
      setTriageOpen(true)
    }
  }, [])

  const handleConfirmMatch = async (matchId: string) => {
    setProcessingId(matchId)
    try {
      const res = await fetch(`/api/ar-reconciliation/matches/${matchId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "confirmed" }),
      })
      if (res.ok) {
        setPendingMatches(prev => prev.filter(m => m.id !== matchId))
        setTriageOpen(false)
        setSelectedMatch(null)
      }
    } catch (err) {
      console.error("Failed to confirm match:", err)
    } finally {
      setProcessingId(null)
    }
  }

  const handleRejectMatch = async (matchId: string) => {
    setProcessingId(matchId)
    try {
      const res = await fetch(`/api/ar-reconciliation/matches/${matchId}`, {
        method: "DELETE",
      })
      if (res.ok) {
        setPendingMatches(prev => prev.filter(m => m.id !== matchId))
        setTriageOpen(false)
        setSelectedMatch(null)
      }
    } catch (err) {
      console.error("Failed to reject match:", err)
    } finally {
      setProcessingId(null)
    }
  }

  // Keyboard navigation
  useEffect(() => {
    if (!triageOpen || !candidates) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return

      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault()
        const direction = e.key === "ArrowUp" ? -1 : 1
        setSelectedCandidateIdx(prev => {
          const next = prev + direction
          return Math.max(0, Math.min(next, candidates.candidates.length - 1))
        })
      }

      if (e.key === "Enter" && selectedMatch && !splitMode) {
        e.preventDefault()
        handleConfirmMatch(selectedMatch.id)
      }

      if (e.key === "Escape") {
        e.preventDefault()
        setTriageOpen(false)
      }

      if (e.key === "s" || e.key === "S") {
        e.preventDefault()
        setSplitMode(!splitMode)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [triageOpen, candidates, selectedMatch, selectedCandidateIdx, splitMode])

  const filteredMatches = pendingMatches.filter(m => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      m.customer_name?.toLowerCase().includes(q) ||
      m.invoice_id?.toLowerCase().includes(q) ||
      m.bank_counterparty?.toLowerCase().includes(q) ||
      m.bank_description?.toLowerCase().includes(q)
    )
  })

  if (loading) {
    return (
      <div className="p-8 space-y-4 bg-black min-h-screen">
        <div className="h-8 w-48 bg-slate-800 rounded animate-pulse" />
        <div className="h-96 bg-slate-800 rounded animate-pulse" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8 bg-black min-h-screen">
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-6 text-rose-300">
          <p className="font-semibold">Error loading review queue</p>
          <p className="text-sm mt-2">{error}</p>
          <Button onClick={() => fetchData()} className="mt-4 bg-rose-600 hover:bg-rose-700">
            Retry
          </Button>
        </div>
      </div>
    )
  }

  const selectedCandidate = candidates?.candidates[selectedCandidateIdx]

  return (
    <div className="p-8 space-y-5 bg-black min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100 tracking-tight">Triage Terminal</h1>
          <p className="text-sm text-slate-400 mt-1">High-speed reconciliation review · Click to open drawer, use arrow keys to navigate</p>
        </div>
        <Button
          onClick={() => fetchData()}
          disabled={loading}
          className="bg-slate-800 hover:bg-slate-700 text-slate-200"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="bg-black border border-slate-800 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-slate-400">Pending Review</p>
            <p className="text-3xl font-semibold tracking-tight text-amber-300 tabular-nums mt-1">{pendingMatches.length}</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-400">Total Amount</p>
            <p className="text-2xl font-semibold tracking-tight text-slate-100 tabular-nums mt-1">
              {formatCurrency(pendingMatches.reduce((s, m) => s + m.invoice_amount, 0))}
            </p>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="relative w-full">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-500" />
        <Input
          placeholder="Search by customer, invoice, or bank description..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="bg-slate-900 border-slate-800 pl-9 h-10 text-sm text-slate-200 placeholder:text-slate-500"
        />
      </div>

      {/* Matches Table */}
      {filteredMatches.length === 0 ? (
        <div className="bg-black border border-slate-800 rounded-lg p-16 text-center">
          <div className="w-12 h-12 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="h-6 w-6 text-emerald-300" />
          </div>
          <p className="text-slate-100 font-medium text-lg">All Clear!</p>
          <p className="text-slate-400 text-sm mt-1">No pending matches. All reconciliation is complete.</p>
        </div>
      ) : (
        <div className="bg-black border border-slate-800 rounded-lg overflow-hidden">
          <div className="max-h-[600px] overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-black">
                <tr className="border-b border-slate-800">
                  <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wider px-4 py-3">Bank Payment</th>
                  <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wider px-4 py-3">Invoice</th>
                  <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wider px-4 py-3">Match Type</th>
                  <th className="text-center text-xs font-semibold text-slate-400 uppercase tracking-wider px-4 py-3">Confidence</th>
                  <th className="text-center text-xs font-semibold text-slate-400 uppercase tracking-wider px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredMatches.map((match) => (
                  <tr
                    key={match.id}
                    onClick={() => openTriageDrawer(match)}
                    className="border-b border-slate-800 hover:bg-slate-800/50 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <p className="text-sm text-slate-100">{match.bank_counterparty || "Bank deposit"}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{formatDate(match.bank_date)}</p>
                      <p className="text-sm font-medium text-emerald-300 tabular-nums mt-1">+{formatCurrency(match.bank_amount)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm text-slate-100">{match.customer_name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">#{match.invoice_id}</p>
                      <p className="text-sm text-slate-300 tabular-nums mt-1">{formatCurrency(match.invoice_amount)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-1 rounded ${getMatchTypeColor(match.match_type)}`}>
                        {match.match_type}
                      </span>
                      {match.fee_amount > 0 && (
                        <p className="text-xs text-amber-300 mt-1">Fee: {formatCurrency(match.fee_amount)}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-sm font-medium tabular-nums ${getConfidenceColor(match.confidence)}`}>
                        {Math.round(match.confidence * 100)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          openTriageDrawer(match)
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
                      >
                        <Zap className="h-3 w-3" />
                        Triage
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Triage Drawer */}
      <Sheet open={triageOpen} onOpenChange={setTriageOpen}>
        <SheetContent className="bg-black border-l border-slate-800 w-full sm:max-w-3xl overflow-y-auto p-0">
          {selectedMatch && candidates && (
            <>
              {/* Header - Bank Movement (Pinned) */}
              <div className="sticky top-0 bg-black border-b border-slate-800 p-6 space-y-4">
                <SheetHeader>
                  <SheetTitle className="text-slate-100 text-lg">Triage: Match Review</SheetTitle>
                </SheetHeader>

                {/* Bank Movement Card */}
                <div className="bg-black border border-slate-800 rounded-lg p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Bank Movement</p>
                      <p className="text-sm text-slate-100 mt-1">{candidates.movement.counterparty || "Bank deposit"}</p>
                    </div>
                    <p className="text-2xl font-semibold tracking-tight text-emerald-300 tabular-nums">
                      +{formatCurrency(candidates.movement.amount)}
                    </p>
                  </div>
                  <p className="text-xs text-slate-400">{candidates.movement.raw_description}</p>
                  <p className="text-xs text-slate-500 mt-2">{formatDate(candidates.movement.date)}</p>
                </div>
              </div>

              {/* Candidates Lineup */}
              <div className="p-6 space-y-3">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Candidates ({candidates.candidates.length})
                  </p>
                  <p className="text-xs text-slate-500">
                    {selectedCandidateIdx + 1} / {candidates.candidates.length}
                  </p>
                </div>

                {candidatesLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3].map(i => (
                      <div key={i} className="h-24 bg-slate-800 rounded-lg animate-pulse" />
                    ))}
                  </div>
                ) : candidates.candidates.length === 0 ? (
                  <div className="bg-black border border-slate-800 rounded-lg p-8 text-center">
                    <AlertCircle className="h-8 w-8 text-amber-300 mx-auto mb-2" />
                    <p className="text-sm text-slate-300">No candidates found for this payment</p>
                  </div>
                ) : (
                  candidates.candidates.map((candidate, idx) => {
                    const isSelected = idx === selectedCandidateIdx
                    const existing = candidates.existing_matches[candidate.id]
                    const amountDiff = Math.abs(candidates.movement.amount - candidate.amount)
                    const diffPct = candidate.amount > 0 ? ((amountDiff / candidate.amount) * 100).toFixed(1) : "0"
                    const shortInvoiceId = candidate.invoice_number || candidate.id.slice(-6)

                    return (
                      <button
                        key={candidate.id}
                        onClick={() => setSelectedCandidateIdx(idx)}
                        className={`w-full text-left p-4 rounded-lg border transition-all ${
                          isSelected
                            ? "bg-black border-slate-700"
                            : "bg-black border-slate-800 hover:border-slate-700"
                        }`}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex-1">
                            <p className="text-sm font-semibold text-slate-100">{candidate.customer_name}</p>
                            <p className="text-xs text-slate-500 mt-0.5">#{shortInvoiceId}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-semibold text-slate-100 tabular-nums">{formatCurrency(candidate.amount)}</p>
                            {candidate.outstanding_amount < candidate.amount && (
                              <p className="text-xs text-amber-300 mt-0.5">Outstanding: {formatCurrency(candidate.outstanding_amount)}</p>
                            )}
                          </div>
                        </div>

                        {/* Match Signals */}
                        <div className="flex flex-wrap gap-2 mb-2">
                          {candidate.is_direct_link && (
                            <span className="text-xs px-2 py-1 rounded bg-emerald-500/20 text-emerald-300">Direct Link</span>
                          )}
                          {candidate.is_customer_match && (
                            <span className="text-xs px-2 py-1 rounded bg-emerald-500/20 text-emerald-300">Customer Match</span>
                          )}
                          {candidate.is_amount_match && (
                            <span className="text-xs px-2 py-1 rounded bg-emerald-500/20 text-emerald-300">Amount Match</span>
                          )}
                          {candidate.reference_match && (
                            <span className="text-xs px-2 py-1 rounded bg-blue-500/20 text-blue-300">Reference</span>
                          )}
                          {candidate.fee_implied && candidate.fee_implied > 0 && (
                            <span className="text-xs px-2 py-1 rounded bg-amber-500/20 text-amber-300">Fee: {formatCurrency(candidate.fee_implied)}</span>
                          )}
                        </div>

                        {/* Amount Diff & Match Type */}
                        <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
                          <span>Diff: {formatCurrency(amountDiff)} ({diffPct}%)</span>
                          <span className={`text-xs px-2 py-1 rounded ${getMatchTypeColor(candidate.match_type)}`}>
                            {candidate.match_type}
                          </span>
                        </div>

                        {/* Dates */}
                        <div className="flex items-center gap-4 text-xs text-slate-500">
                          {candidate.invoice_date && <span>Invoice: {formatDate(candidate.invoice_date)}</span>}
                          {candidate.due_date && <span>Due: {formatDate(candidate.due_date)}</span>}
                        </div>

                        {/* Existing Match Badge */}
                        {existing && (
                          <div className="mt-2 pt-2 border-t border-slate-800">
                            <p className="text-xs text-slate-500">
                              Already matched: {existing.match_type} @ {Math.round(existing.confidence * 100)}%
                            </p>
                          </div>
                        )}
                      </button>
                    )
                  })
                )}
              </div>

              {/* Action Bar */}
              {selectedCandidate && (
                <div className="sticky bottom-0 bg-black border-t border-slate-800 p-6">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex gap-3 flex-1">
                      <Button
                        onClick={() => handleConfirmMatch(selectedMatch.id)}
                        disabled={processingId === selectedMatch.id}
                        className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md py-2 px-4 font-medium"
                      >
                        <CheckCircle2 className="h-4 w-4 mr-2" />
                        Accept Match
                      </Button>
                      <Button
                        onClick={() => handleRejectMatch(selectedMatch.id)}
                        disabled={processingId === selectedMatch.id}
                        className="flex-1 bg-transparent border border-slate-700 text-slate-300 hover:text-slate-100 hover:bg-slate-800 rounded-md py-2 px-4 font-medium"
                      >
                        <XCircle className="h-4 w-4 mr-2" />
                        Reject
                      </Button>
                    </div>
                    <p className="text-xs text-slate-500 whitespace-nowrap">
                      Press <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono text-[9px]">Enter</kbd>
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

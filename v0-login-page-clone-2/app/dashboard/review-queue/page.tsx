"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { Zap, Search, ChevronRight, RefreshCw } from "lucide-react"

interface SuggestedMatch {
  movement_id: string
  invoice_id?: string
  bill_id?: string
  confidence: number
  reason: string
  matched_amount: number
  entity_name?: string | null
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

interface ARAPStepResponse {
  movements?: {
    unmatched_inflows: Movement[]
    unmatched_outflows: Movement[]
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
  if (confidence >= 0.88) return { label: `${Math.round(confidence * 100)}%`, tier: "high", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" }
  if (confidence >= 0.75) return { label: `${Math.round(confidence * 100)}%`, tier: "med", color: "bg-amber-500/10 text-amber-400 border-amber-500/20" }
  return { label: `${Math.round(confidence * 100)}%`, tier: "low", color: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20" }
}

export default function ReviewQueuePage() {
  const [data, setData] = useState<ARAPStepResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cmdQueue, setCmdQueue] = useState<Movement[]>([])
  const [cmdIndex, setCmdIndex] = useState(0)
  const [cmdProcessed, setCmdProcessed] = useState<Map<string, "accepted" | "skipped">>(new Map())
  const [selectedMovement, setSelectedMovement] = useState<Movement | null>(null)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedMatches, setSelectedMatches] = useState<Array<{ reference_id: string; component_type: "ar" | "ap"; amount: number }>>([])
  const cmdSidebarRef = useRef<HTMLDivElement>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/ar-ap-step")
      if (!res.ok) throw new Error("Failed to fetch")
      const json = await res.json()
      setData(json)
      setError(null)
      // Auto-populate queue
      const all = [
        ...(json.movements?.unmatched_inflows || []),
        ...(json.movements?.unmatched_outflows || []),
      ]
      const sorted = [...all].sort((a, b) => {
        const ca = a.suggested_match?.confidence ?? 0
        const cb = b.suggested_match?.confidence ?? 0
        if (cb !== ca) return cb - ca
        return Math.abs(b.amount) - Math.abs(a.amount)
      })
      setCmdQueue(sorted)
      setCmdIndex(0)
      setCmdProcessed(new Map())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const advanceQueue = useCallback((queue: Movement[], idx: number, processed: Map<string, "accepted" | "skipped">) => {
    for (let i = idx + 1; i < queue.length; i++) {
      if (!processed.has(queue[i].id)) {
        setCmdIndex(i)
        setTimeout(() => {
          const el = cmdSidebarRef.current?.querySelector(`[data-idx="${i}"]`)
          el?.scrollIntoView({ block: "nearest", behavior: "smooth" })
        }, 0)
        return
      }
    }
  }, [])

  const handleCmdAccept = useCallback(() => {
    const movement = cmdQueue[cmdIndex]
    if (!movement) return
    const sm = movement.suggested_match
    if (!sm || sm.confidence < 0.75) return
    fetch("/api/dashboard/reconciliation/apply-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        movement_id: movement.id,
        reference_id: sm.invoice_id || sm.bill_id,
        component_type: sm.invoice_id ? "ar" : "ap",
        entity_id: "",
        amount: sm.matched_amount,
      }),
    }).catch(() => {})
    const next = new Map(cmdProcessed)
    next.set(movement.id, "accepted")
    setCmdProcessed(next)
    advanceQueue(cmdQueue, cmdIndex, next)
  }, [cmdQueue, cmdIndex, cmdProcessed, advanceQueue])

  const handleCmdSkip = useCallback(() => {
    const movement = cmdQueue[cmdIndex]
    if (!movement) return
    const next = new Map(cmdProcessed)
    next.set(movement.id, "skipped")
    setCmdProcessed(next)
    advanceQueue(cmdQueue, cmdIndex, next)
  }, [cmdQueue, cmdIndex, cmdProcessed, advanceQueue])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return
      if (e.key === "y" || e.key === "Y") { e.preventDefault(); handleCmdAccept() }
      if (e.key === "n" || e.key === "N") { e.preventDefault(); handleCmdSkip() }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [handleCmdAccept, handleCmdSkip])

  if (loading) {
    return (
      <div className="p-8 space-y-4 bg-[#0A0A0A] min-h-screen">
        <div className="h-8 w-48 bg-white/10 rounded animate-pulse" />
        <div className="h-32 bg-white/10 rounded animate-pulse" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8 bg-[#0A0A0A] min-h-screen">
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-6 text-red-400">
          <p className="font-semibold">Error loading review queue</p>
          <p className="text-sm mt-2">{error}</p>
          <Button onClick={() => fetchData()} className="mt-4 bg-red-600 hover:bg-red-700">
            Retry
          </Button>
        </div>
      </div>
    )
  }

  const unmatched_inflows = data?.movements?.unmatched_inflows || []
  const unmatched_outflows = data?.movements?.unmatched_outflows || []
  const all = [...unmatched_inflows, ...unmatched_outflows]
  const withAI = all.filter(m => m.suggested_match && m.suggested_match.confidence >= 0.75)
  const highConf = all.filter(m => m.suggested_match && m.suggested_match.confidence >= 0.88)
  const manual = all.filter(m => !m.suggested_match || m.suggested_match.confidence < 0.75)
  const totalCash = all.reduce((s, m) => s + Math.abs(m.amount), 0)
  const activeMov = cmdQueue[cmdIndex] || null
  const sm = activeMov?.suggested_match
  const isAR = !!sm?.invoice_id
  const isInflow = (activeMov?.amount ?? 0) > 0
  const processedCount = cmdProcessed.size
  const totalCount = cmdQueue.length
  const pct = totalCount > 0 ? Math.round((processedCount / totalCount) * 100) : 0
  const hasMatch = sm && sm.confidence >= 0.75
  const confBadge = sm ? getConfidenceBadge(sm.confidence) : null
  const refId = sm?.invoice_id || sm?.bill_id
  const refLabel = sm?.invoice_id ? `Inv #${refId}` : sm?.bill_id ? `Bill #${refId}` : null

  return (
    <div className="p-8 space-y-6 bg-[#0A0A0A] min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Review Queue</h1>
          <p className="text-[12px] text-zinc-500 mt-0.5">Keyboard-driven batch matching · press Y to accept, N to skip</p>
        </div>
        <Button onClick={() => fetchData()} variant="ghost" size="sm" className="text-zinc-400 hover:text-white">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-4 divide-x divide-white/[0.06] border border-white/[0.07] rounded-xl overflow-hidden bg-[#141414]">
        <div className="px-5 py-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Needs Review</p>
          <p className="text-[22px] font-mono tabular-nums font-bold text-white mt-1">{all.length}</p>
          <p className="text-[11px] text-zinc-600 mt-0.5">{formatCurrency(totalCash)} unmatched</p>
        </div>
        <div className="px-5 py-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">AI Suggested</p>
          <p className="text-[22px] font-mono tabular-nums font-bold text-emerald-400 mt-1">{withAI.length}</p>
          <p className="text-[11px] text-zinc-600 mt-0.5">ready to accept</p>
        </div>
        <div className="px-5 py-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">High Confidence</p>
          <p className="text-[22px] font-mono tabular-nums font-bold text-emerald-400/70 mt-1">{highConf.length}</p>
          <p className="text-[11px] text-zinc-600 mt-0.5">≥88% · clear auto-accept</p>
        </div>
        <div className="px-5 py-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Need Manual</p>
          <p className="text-[22px] font-mono tabular-nums font-bold text-zinc-400 mt-1">{manual.length}</p>
          <p className="text-[11px] text-zinc-600 mt-0.5">search to link</p>
        </div>
      </div>

      {/* Main queue display */}
      {all.length === 0 ? (
        <div className="bg-[#141414] border border-white/10 rounded-xl p-14 text-center">
          <div className="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-3">
            <span className="text-emerald-400 text-lg">✓</span>
          </div>
          <p className="text-white font-medium">Inbox Zero</p>
          <p className="text-zinc-500 text-[12px] mt-1">All operating cash has been reconciled.</p>
        </div>
      ) : (
        <div className="grid grid-cols-[240px_1fr] gap-4 bg-[#141414] border border-white/[0.07] rounded-xl overflow-hidden h-[600px]">
          {/* Left sidebar */}
          <div ref={cmdSidebarRef} className="border-r border-white/[0.07] overflow-y-auto bg-[#0a0a0a]">
            <div className="px-3 py-2 border-b border-white/[0.05] sticky top-0 bg-[#0a0a0a]">
              <span className="text-[9px] text-zinc-600 uppercase tracking-wider">Queue</span>
            </div>
            {cmdQueue.map((mov, idx) => {
              const movSm = mov.suggested_match
              const status = cmdProcessed.get(mov.id)
              const isActive = idx === cmdIndex
              const movIsInflow = mov.amount > 0
              const tier = movSm ? getConfidenceBadge(movSm.confidence).tier : null
              return (
                <button
                  key={mov.id}
                  data-idx={idx}
                  onClick={() => setCmdIndex(idx)}
                  className={`w-full text-left px-3 py-2.5 border-b border-white/[0.04] flex items-center gap-2.5 transition-none
                    ${isActive ? "bg-white/[0.07] border-l-2 border-l-emerald-500" : "border-l-2 border-l-transparent hover:bg-white/[0.03]"}
                    ${status ? "opacity-40" : ""}`}
                >
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${movIsInflow ? "bg-emerald-500" : "bg-red-500"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className={`text-[11px] font-mono tabular-nums font-semibold ${movIsInflow ? "text-emerald-400" : "text-red-400"} ${status ? "line-through" : ""}`}>
                        {movIsInflow ? "+" : "−"}{formatCurrency(Math.abs(mov.amount))}
                      </span>
                      {tier && !status && (
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tier === "high" ? "bg-emerald-500" : tier === "med" ? "bg-amber-500" : "bg-zinc-600"}`} />
                      )}
                      {status === "accepted" && <span className="text-[9px] text-emerald-500">✓</span>}
                      {status === "skipped" && <span className="text-[9px] text-zinc-600">—</span>}
                    </div>
                    <p className={`text-[10px] truncate mt-0.5 ${isActive ? "text-zinc-300" : "text-zinc-600"}`}>
                      {movSm?.entity_name || mov.description}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Right panel */}
          <div className="flex flex-col">
            {!activeMov ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <div className="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-3">
                    <span className="text-emerald-400 text-lg">✓</span>
                  </div>
                  <p className="text-white font-medium">Queue Empty</p>
                  <p className="text-zinc-500 text-[12px] mt-1">All movements processed.</p>
                </div>
              </div>
            ) : (
              <>
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.07]">
                  <span className="text-[10px] text-zinc-600 font-mono">#{cmdIndex + 1} of {cmdQueue.length}</span>
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-1.5 bg-white/[0.07] rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full transition-none" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[10px] font-mono text-zinc-400 tabular-nums">{processedCount} / {totalCount}</span>
                  </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    {/* Bank side */}
                    <div className="bg-[#0a0a0a] border border-white/[0.07] rounded-lg p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-medium">Bank Movement</span>
                        <div className={`w-1.5 h-1.5 rounded-full ${isInflow ? "bg-emerald-500" : "bg-red-500"}`} />
                      </div>
                      <p className="text-[14px] font-medium text-white leading-snug mb-1">{activeMov.description}</p>
                      {activeMov.raw_description && activeMov.raw_description !== activeMov.description && (
                        <p className="text-[11px] text-zinc-500 mb-2">{activeMov.raw_description}</p>
                      )}
                      <p className={`text-[24px] font-mono tabular-nums font-bold mt-2 ${isInflow ? "text-emerald-400" : "text-red-400"}`}>
                        {isInflow ? "+" : "−"}{formatCurrency(Math.abs(activeMov.amount))}
                      </p>
                      <p className="text-[11px] text-zinc-500 mt-1">{formatDate(activeMov.date)}</p>
                    </div>

                    {/* Ledger side */}
                    {hasMatch ? (
                      <div className="bg-[#0a0a0a] border border-white/[0.07] rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-medium">Ledger Match</span>
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${isAR ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"}`}>
                            {isAR ? "AR" : "AP"}
                          </span>
                        </div>
                        <p className="text-[14px] font-medium text-white leading-snug mb-1">{sm.entity_name || (isAR ? "Invoice" : "Bill")}</p>
                        {refLabel && <p className="text-[11px] text-zinc-500 mb-2">{refLabel}</p>}
                        <p className="text-[24px] font-mono tabular-nums font-bold mt-2 text-zinc-200">{formatCurrency(sm.matched_amount)}</p>
                        <div className="mt-3 space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-zinc-500">Confidence</span>
                            <span className={`text-[10px] font-mono font-bold ${confBadge?.tier === "high" ? "text-emerald-400" : confBadge?.tier === "med" ? "text-amber-400" : "text-zinc-400"}`}>
                              {confBadge?.label}
                            </span>
                          </div>
                          <div className="w-full h-1 bg-white/[0.06] rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${confBadge?.tier === "high" ? "bg-emerald-500" : confBadge?.tier === "med" ? "bg-amber-500" : "bg-zinc-600"}`}
                              style={{ width: `${Math.round(sm.confidence * 100)}%` }}
                            />
                          </div>
                        </div>
                        {sm.reason && <p className="text-[10px] text-zinc-500 mt-2">{sm.reason}</p>}
                      </div>
                    ) : (
                      <div className="bg-[#0a0a0a] border border-white/[0.07] rounded-lg p-4 flex flex-col justify-between">
                        <div>
                          <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-medium">Ledger Match</span>
                          <p className="text-[12px] text-zinc-500 italic mt-2">No AI suggestion</p>
                        </div>
                        <Button
                          size="sm"
                          className="mt-3 bg-white/[0.07] hover:bg-white/[0.12] text-zinc-300 text-[11px] h-7 border border-white/10 w-full"
                          onClick={() => {
                            setSelectedMovement(activeMov)
                            setSelectedMatches([])
                            setSearchQuery("")
                            setSearchResults([])
                            setIsDrawerOpen(true)
                          }}
                        >
                          <Search className="h-3 w-3 mr-2" />
                          Search &amp; Match
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Action bar */}
                <div className="shrink-0 border-t border-white/[0.07] px-5 py-3 flex items-center justify-between bg-[#0a0a0a]">
                  <div className="flex items-center gap-2 text-zinc-600 text-[10px]">
                    <ChevronRight className="h-3 w-3" />
                    <span>Click queue item to jump</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCmdSkip}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.07] text-zinc-300 text-[11px] font-medium"
                    >
                      <kbd className="inline-flex items-center px-0.5 py-0 rounded bg-white/[0.07] text-[9px] font-mono text-zinc-400 border border-white/10">N</kbd>
                      Skip
                    </button>
                    {hasMatch && !cmdProcessed.has(activeMov.id) && (
                      <button
                        onClick={handleCmdAccept}
                        className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold"
                      >
                        <kbd className="inline-flex items-center px-0.5 py-0 rounded bg-white/20 text-[9px] font-mono text-white border border-white/20">Y</kbd>
                        Accept
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Manual Match Sheet */}
      <Sheet open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
        <SheetContent className="bg-[#141414] border-l border-white/10 w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="text-white text-base">Manual Match</SheetTitle>
          </SheetHeader>
          {selectedMovement && (
            <div className="space-y-4 mt-5">
              <div className="bg-[#0a0a0a] border border-white/[0.07] rounded-lg p-4">
                <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-2">Selected Movement</p>
                <p className="text-[13px] font-medium text-white">{selectedMovement.description}</p>
                <p className="text-[12px] font-mono tabular-nums text-emerald-400 mt-2">
                  {selectedMovement.amount > 0 ? "+" : "−"}{formatCurrency(Math.abs(selectedMovement.amount))}
                </p>
              </div>
              <p className="text-[12px] text-zinc-500 text-center py-4">Search and match functionality coming soon</p>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

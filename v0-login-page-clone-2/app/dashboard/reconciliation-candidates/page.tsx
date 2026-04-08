"use client"

import { useState, useEffect, useCallback } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { RefreshCw, Search, ChevronRight, Download, Sparkles } from "lucide-react"
import type { ClassificationResult, CaseType, Candidate } from "@/lib/reconciliation-case-classifier"

interface ClassifiedMovement {
  id: string
  date: string
  amount: number
  direction: "inflow" | "outflow"
  counterparty: string | null
  economic_class: string | null
  classification: ClassificationResult
}

interface CaseSummary {
  total: number
  by_case_type: Record<CaseType, number>
  operational: number
  non_operational: number
  auto_matchable: number
  needs_review: number
  zero_candidates: number
}

interface ResponseData {
  movements: ClassifiedMovement[]
  summary: CaseSummary
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

function formatDate(d: string | null) {
  if (!d) return "—"
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function getCaseTypeColor(caseType: CaseType): string {
  if (caseType.startsWith("DIRECT_LINK")) return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
  if (caseType.startsWith("EXACT")) return "bg-blue-500/10 text-blue-400 border-blue-500/20"
  if (caseType.startsWith("FEE")) return "bg-amber-500/10 text-amber-400 border-amber-500/20"
  if (caseType.startsWith("PARTIAL")) return "bg-purple-500/10 text-purple-400 border-purple-500/20"
  if (caseType.startsWith("AGGREGATION")) return "bg-cyan-500/10 text-cyan-400 border-cyan-500/20"
  if (caseType.startsWith("NO_MATCH")) return "bg-red-500/10 text-red-400 border-red-500/20"
  if (caseType.startsWith("REVERSAL")) return "bg-orange-500/10 text-orange-400 border-orange-500/20"
  // Zero-candidate sub-cases - different colors for each type
  if (caseType === "ZERO_MISSING_INVOICE") return "bg-rose-500/10 text-rose-400 border-rose-500/20"
  if (caseType === "ZERO_MISSING_BILL") return "bg-rose-500/10 text-rose-400 border-rose-500/20"
  if (caseType === "ZERO_PREPAYMENT_DEPOSIT") return "bg-violet-500/10 text-violet-400 border-violet-500/20"
  if (caseType === "ZERO_SUBSCRIPTION") return "bg-sky-500/10 text-sky-400 border-sky-500/20"
  if (caseType === "ZERO_SMALL_EXPENSE") return "bg-slate-500/10 text-slate-400 border-slate-500/20"
  if (caseType === "ZERO_REFUND_CREDIT") return "bg-teal-500/10 text-teal-400 border-teal-500/20"
  if (caseType === "ZERO_DELETED_COUNTERPARTY") return "bg-gray-500/10 text-gray-400 border-gray-500/20"
  if (caseType === "ZERO_UNCLASSIFIED") return "bg-red-500/10 text-red-400 border-red-500/20"
  return "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"
}

function getActionColor(action: string): string {
  if (action === "auto_match") return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
  if (action === "review") return "bg-amber-500/10 text-amber-400 border-amber-500/20"
  if (action === "manual") return "bg-blue-500/10 text-blue-400 border-blue-500/20"
  return "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"
}

function getMatchTypeColor(matchType: string): string {
  switch (matchType) {
    case "EXACT":
      return "bg-emerald-500/10 text-emerald-400"
    case "FEE":
      return "bg-amber-500/10 text-amber-400"
    case "PARTIAL":
      return "bg-purple-500/10 text-purple-400"
    case "AGGREGATION":
      return "bg-cyan-500/10 text-cyan-400"
    case "ROUNDING":
      return "bg-blue-500/10 text-blue-400"
    case "DISCOUNT":
      return "bg-pink-500/10 text-pink-400"
    case "REVERSAL":
      return "bg-orange-500/10 text-orange-400"
    case "DIRECT_LINK":
      return "bg-emerald-500/10 text-emerald-400"
    default:
      return "bg-zinc-500/10 text-zinc-400"
  }
}

export default function ReconciliationCandidatesPage() {
  const [data, setData] = useState<ResponseData | null>(null)
  const [loading, setLoading] = useState(true)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiMatchLoading, setAiMatchLoading] = useState(false)
  const [aiMatchResults, setAiMatchResults] = useState<Map<string, { decision: string; confidence: number; reasoning: string; matched_id: string | null }>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<"all" | "operational" | "non_op" | "review">("all")
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedMovement, setSelectedMovement] = useState<ClassifiedMovement | null>(null)
  const [isDetailsPanelOpen, setIsDetailsPanelOpen] = useState(false)
  const [aiEnhancements, setAiEnhancements] = useState<Map<string, { suggested_case_type: string; confidence: number; reasoning: string }>>(new Map())

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      if (filter !== "all") params.append("filter", filter)
      if (searchQuery) params.append("search", searchQuery)

      const res = await fetch(`/api/dashboard/reconciliation-candidates?${params.toString()}`)
      if (!res.ok) throw new Error("Failed to fetch")
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error")
    } finally {
      setLoading(false)
    }
  }, [filter, searchQuery])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleSelectMovement = (movement: ClassifiedMovement) => {
    setSelectedMovement(movement)
    setIsDetailsPanelOpen(true)
  }

  const downloadCSV = () => {
    if (!data || !data.movements || data.movements.length === 0) {
      console.error("No data to download")
      return
    }

    try {
      // Build CSV header
      const headers = [
        "Date",
        "Counterparty",
        "Amount",
        "Direction",
        "Case Type",
        "Is Operational",
        "Suggested Action",
        "Candidates Count",
        "Candidate 1 Entity",
        "Candidate 1 Amount",
        "Candidate 1 Match Type",
        "Candidate 1 Amount Diff",
        "Candidate 2 Entity",
        "Candidate 2 Amount",
        "Candidate 2 Match Type",
        "Candidate 2 Amount Diff",
        "Candidate 3 Entity",
        "Candidate 3 Amount",
        "Candidate 3 Match Type",
        "Candidate 3 Amount Diff",
        "Flags",
        "Economic Class",
        "Movement ID",
      ]

      // Build CSV rows
      const rows = data.movements.map((m) => {
        const c = m.classification
        const candidates = c?.candidates || []
        const flags = c?.flags
          ? Object.entries(c.flags)
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join("; ")
          : ""

        return [
          m.date || "",
          m.counterparty || "",
          m.amount != null ? Number(m.amount).toFixed(2) : "0.00",
          m.direction || "",
          c?.case_type || "",
          c?.is_operational ? "Yes" : "No",
          c?.suggested_action || "",
          candidates.length,
          candidates[0]?.entity_name || "",
          candidates[0]?.amount != null ? Number(candidates[0].amount).toFixed(2) : "",
          candidates[0]?.match_type || "",
          candidates[0]?.amount_diff != null ? Number(candidates[0].amount_diff).toFixed(2) : "",
          candidates[1]?.entity_name || "",
          candidates[1]?.amount != null ? Number(candidates[1].amount).toFixed(2) : "",
          candidates[1]?.match_type || "",
          candidates[1]?.amount_diff != null ? Number(candidates[1].amount_diff).toFixed(2) : "",
          candidates[2]?.entity_name || "",
          candidates[2]?.amount != null ? Number(candidates[2].amount).toFixed(2) : "",
          candidates[2]?.match_type || "",
          candidates[2]?.amount_diff != null ? Number(candidates[2].amount_diff).toFixed(2) : "",
          flags,
          m.economic_class || "",
          m.id || "",
        ]
      })

      // Escape CSV values
      const escapeCSV = (val: string | number) => {
        const str = String(val ?? "")
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`
        }
        return str
      }

      // Build CSV content
      const csvContent = [
        headers.map(escapeCSV).join(","),
        ...rows.map((row) => row.map(escapeCSV).join(",")),
      ].join("\n")

      // Download using data URI approach (more compatible)
      const blob = new Blob(["\ufeff" + csvContent], { type: "text/csv;charset=utf-8;" })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.setAttribute("href", url)
      link.setAttribute("download", `reconciliation-candidates-${new Date().toISOString().split("T")[0]}.csv`)
      link.style.visibility = "hidden"
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
    } catch (err) {
      console.error("CSV download error:", err)
      alert("Failed to download CSV: " + (err instanceof Error ? err.message : "Unknown error"))
    }
  }

  const runAIEnhancement = async () => {
    try {
      setAiLoading(true)
      
      // Start the background job
      const startRes = await fetch("/api/dashboard/reconciliation-candidates/ai-enhance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxMovements: 50 }),
      })
      
      if (!startRes.ok) throw new Error("Failed to start AI enhancement")
      
      const startJson = await startRes.json()
      const jobId = startJson.jobId
      
      if (!jobId) throw new Error("No job ID returned")
      
      // Poll for completion
      let attempts = 0
      const maxAttempts = 60 // 2 minutes max (2s intervals)
      
      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000)) // Wait 2 seconds
        
        const pollRes = await fetch(`/api/dashboard/reconciliation-candidates/ai-enhance?jobId=${jobId}`)
        if (!pollRes.ok) throw new Error("Failed to check job status")
        
        const pollJson = await pollRes.json()
        
        if (pollJson.status === "completed") {
          // Store AI enhancements
          const enhancements = new Map<string, { suggested_case_type: string; confidence: number; reasoning: string }>()
          for (const m of pollJson.result?.movements || []) {
            if (m.ai_enhanced) {
              enhancements.set(m.id, {
                suggested_case_type: m.ai_enhanced.suggested_case_type,
                confidence: m.ai_enhanced.confidence,
                reasoning: m.ai_enhanced.reasoning,
              })
            }
          }
          setAiEnhancements(enhancements)
          
          // Show summary
          const summary = pollJson.result?.summary || {}
          alert(`AI Enhancement Complete!\n\n• ${summary.ai_enhanced || 0} movements analyzed\n• ${summary.case_type_changes || 0} classifications improved\n• ${summary.high_confidence || 0} high-confidence matches`)
          return
        } else if (pollJson.status === "failed") {
          throw new Error(pollJson.error || "AI enhancement job failed")
        }
        
        // Still running, continue polling
        attempts++
      }
      
      throw new Error("AI enhancement timed out")
    } catch (err) {
      alert("AI enhancement failed: " + (err instanceof Error ? err.message : "Unknown error"))
    } finally {
      setAiLoading(false)
    }
  }

  const runAIMatching = async () => {
    try {
      setAiMatchLoading(true)
      
      // Start the background job
      const startRes = await fetch("/api/dashboard/reconciliation-candidates/ai-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxMovements: 100, batchSize: 10 }),
      })
      
      if (!startRes.ok) throw new Error("Failed to start AI matching")
      
      const startJson = await startRes.json()
      const jobId = startJson.jobId
      
      if (!jobId) throw new Error("No job ID returned")
      
      // Poll for completion
      let attempts = 0
      const maxAttempts = 90 // 3 minutes max (2s intervals)
      
      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000)) // Wait 2 seconds
        
        const pollRes = await fetch(`/api/dashboard/reconciliation-candidates/ai-match?jobId=${jobId}`)
        if (!pollRes.ok) throw new Error("Failed to check job status")
        
        const pollJson = await pollRes.json()
        
        if (pollJson.status === "completed") {
          // Store AI match results
          const results = new Map<string, { decision: string; confidence: number; reasoning: string; matched_id: string | null }>()
          for (const match of pollJson.result?.matches || []) {
            results.set(match.movement_id, {
              decision: match.decision,
              confidence: match.confidence,
              reasoning: match.reasoning,
              matched_id: match.matched_candidate_id,
            })
          }
          setAiMatchResults(results)
          
          // Show summary
          const result = pollJson.result || {}
          const matchCount = result.matches?.filter((m: { decision: string }) => m.decision === "match").length || 0
          const reviewCount = result.matches?.filter((m: { decision: string }) => m.decision === "needs_review").length || 0
          alert(`AI Matching Complete!\n\n• ${result.total_processed || 0} movements analyzed\n• ${matchCount} matches found\n• ${reviewCount} need review\n• ${result.errors?.length || 0} errors\n• Time: ${(result.processing_time_ms / 1000).toFixed(1)}s`)
          return
        } else if (pollJson.status === "failed") {
          throw new Error(pollJson.error || "AI matching job failed")
        }
        
        // Still running, continue polling
        attempts++
      }
      
      throw new Error("AI matching timed out")
    } catch (err) {
      alert("AI matching failed: " + (err instanceof Error ? err.message : "Unknown error"))
    } finally {
      setAiMatchLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="p-8 space-y-6 bg-[#0A0A0A] min-h-screen">
        <Skeleton className="h-12 w-64" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="p-8 bg-[#0A0A0A] min-h-screen">
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-6 text-red-400">
          <p className="font-semibold">Error loading reconciliation candidates</p>
          <p className="text-sm mt-2">{error || "Unknown error"}</p>
          <Button onClick={() => fetchData()} className="mt-4 bg-red-600 hover:bg-red-700">
            Retry
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 space-y-5 bg-[#0A0A0A] min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">Reconciliation Candidates</h1>
          <p className="text-[12px] text-zinc-500 mt-0.5">Deterministic case classification · Data-driven matching</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={runAIMatching}
            disabled={loading || aiMatchLoading || !data}
            className="bg-blue-600 hover:bg-blue-700 text-white text-[11px] h-7 px-3"
          >
            <Sparkles className={`h-3 w-3 mr-1.5 ${aiMatchLoading ? "animate-pulse" : ""}`} />
            {aiMatchLoading ? "Matching..." : "AI Match"}
          </Button>
          <Button
            size="sm"
            onClick={runAIEnhancement}
            disabled={loading || aiLoading || !data}
            className="bg-purple-600 hover:bg-purple-700 text-white text-[11px] h-7 px-3"
          >
            <Sparkles className={`h-3 w-3 mr-1.5 ${aiLoading ? "animate-pulse" : ""}`} />
            {aiLoading ? "Analyzing..." : "AI Enhance"}
          </Button>
          <Button
            size="sm"
            onClick={downloadCSV}
            disabled={loading || !data}
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] h-7 px-3"
          >
            <Download className="h-3 w-3 mr-1.5" />
            Download CSV
          </Button>
          <Button
            size="sm"
            onClick={() => fetchData()}
            disabled={loading}
            className="bg-white/10 hover:bg-white/15 text-white text-[11px] h-7 px-3"
          >
            <RefreshCw className={`h-3 w-3 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Total Movements</p>
          <p className="text-2xl font-bold font-mono tabular-nums mt-1.5 text-white">{data.summary.total}</p>
        </div>
        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Operational</p>
          <p className="text-2xl font-bold font-mono tabular-nums mt-1.5 text-emerald-400">{data.summary.operational}</p>
        </div>
        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Non-Operational</p>
          <p className="text-2xl font-bold font-mono tabular-nums mt-1.5 text-zinc-400">{data.summary.non_operational}</p>
        </div>
        <div className="bg-[#141414] border border-red-500/30 rounded-lg p-4">
          <p className="text-[10px] text-red-400 uppercase tracking-wider">Review</p>
          <p className="text-2xl font-bold font-mono tabular-nums mt-1.5 text-red-400">{data.summary.zero_candidates || 0}</p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-[#141414] border border-white/10 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-3">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | "operational" | "non_op" | "review")} className="w-full">
            <TabsList className="bg-[#0A0A0A] border border-white/10 h-8">
              <TabsTrigger value="all" className="text-[11px] h-6 px-3">
                All ({data.summary.total})
              </TabsTrigger>
              <TabsTrigger value="operational" className="text-[11px] h-6 px-3">
                Operational ({data.summary.operational})
              </TabsTrigger>
              <TabsTrigger value="non_op" className="text-[11px] h-6 px-3">
                Non-Op ({data.summary.non_operational})
              </TabsTrigger>
              <TabsTrigger value="review" className="text-[11px] h-6 px-3 text-red-400">
                Review ({data.summary.zero_candidates || 0})
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
          <Input
            placeholder="Search by description, counterparty, or case type..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="bg-[#0A0A0A] border-white/10 pl-9 h-8 text-[12px]"
          />
        </div>
      </div>

      {/* Movements Table */}
      <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
        {data.movements.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-zinc-500 text-sm">No movements found matching your filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Date</th>
                  <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Description</th>
                  <th className="text-right text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Amount</th>
                  <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Direction</th>
                  <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Case Type</th>
                  <th className="text-center text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Candidates</th>
                  <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Action</th>
                  <th className="text-center text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {data.movements.map((movement) => (
                  <tr key={movement.id} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors duration-100">
                    <td className="px-3 py-2 text-[12px] text-zinc-400 whitespace-nowrap">{formatDate(movement.date)}</td>
                    <td className="px-3 py-2">
                      <p className="text-[12px] text-white truncate max-w-[250px]">{movement.counterparty || movement.id.slice(0, 12)}</p>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`text-[12px] font-mono tabular-nums font-semibold ${movement.direction === "inflow" ? "text-emerald-400" : "text-red-400"}`}>
                        {movement.direction === "inflow" ? "+" : "−"}{formatCurrency(Math.abs(movement.amount))}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${movement.direction === "inflow" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                        {movement.direction === "inflow" ? "AR" : "AP"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Badge className={`text-[10px] px-2 py-0.5 border ${getCaseTypeColor(movement.classification.case_type)}`}>
                        {movement.classification.case_type.replace(/_/g, " ")}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className="text-[12px] font-mono text-zinc-300">{movement.classification.candidates.length}</span>
                    </td>
                    <td className="px-3 py-2">
                      <Badge className={`text-[10px] px-2 py-0.5 border capitalize ${getActionColor(movement.classification.suggested_action)}`}>
                        {movement.classification.suggested_action}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => handleSelectMovement(movement)}
                        className="text-zinc-500 hover:text-zinc-300 transition-colors"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Details Panel */}
      <Sheet open={isDetailsPanelOpen} onOpenChange={setIsDetailsPanelOpen}>
        <SheetContent className="bg-[#141414] border-l border-white/10 w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="text-white text-base">Movement Details</SheetTitle>
          </SheetHeader>

          {selectedMovement && (
            <div className="space-y-5 mt-5">
              {/* Movement Card */}
              <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-4">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-3">Bank Movement</p>
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <p className="text-[13px] font-medium text-white">{selectedMovement.counterparty || "Unknown"}</p>
                    <p className={`text-lg font-mono tabular-nums font-semibold ${selectedMovement.direction === "inflow" ? "text-emerald-400" : "text-red-400"}`}>
                      {selectedMovement.direction === "inflow" ? "+" : "−"}{formatCurrency(Math.abs(selectedMovement.amount))}
                    </p>
                  </div>
                  <p className="text-[11px] text-zinc-500">{formatDate(selectedMovement.date)}</p>
                  {selectedMovement.economic_class && (
                    <p className="text-[11px] text-zinc-600">Class: {selectedMovement.economic_class}</p>
                  )}
                </div>
              </div>

              {/* Classification Info */}
              <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-4">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-3">Classification</p>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-zinc-400">Case Type:</span>
                    <Badge className={`text-[10px] px-2 py-0.5 border ${getCaseTypeColor(selectedMovement.classification.case_type)}`}>
                      {selectedMovement.classification.case_type.replace(/_/g, " ")}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-zinc-400">Suggested Action:</span>
                    <Badge className={`text-[10px] px-2 py-0.5 border capitalize ${getActionColor(selectedMovement.classification.suggested_action)}`}>
                      {selectedMovement.classification.suggested_action}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-zinc-400">Operational:</span>
                    <Badge className={`text-[10px] px-2 py-0.5 border ${selectedMovement.classification.is_operational ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"}`}>
                      {selectedMovement.classification.is_operational ? "Yes" : "No"}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* Flags */}
              {Object.values(selectedMovement.classification.flags).some((v) => v) && (
                <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-4">
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-3">Flags</p>
                  <div className="flex flex-wrap gap-2">
                    {selectedMovement.classification.flags.has_direct_link && (
                      <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px]">Direct Link</Badge>
                    )}
                    {selectedMovement.classification.flags.has_reference && (
                      <Badge className="bg-blue-500/10 text-blue-400 border border-blue-500/20 text-[10px]">Reference Match</Badge>
                    )}
                    {selectedMovement.classification.flags.has_fee && (
                      <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px]">Has Fee</Badge>
                    )}
                    {selectedMovement.classification.flags.is_partial && (
                      <Badge className="bg-purple-500/10 text-purple-400 border border-purple-500/20 text-[10px]">Partial</Badge>
                    )}
                    {selectedMovement.classification.flags.is_aggregation && (
                      <Badge className="bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 text-[10px]">Aggregation</Badge>
                    )}
                    {selectedMovement.classification.flags.is_reversal && (
                      <Badge className="bg-orange-500/10 text-orange-400 border border-orange-500/20 text-[10px]">Reversal</Badge>
                    )}
                    {selectedMovement.classification.flags.same_amount_conflict && (
                      <Badge className="bg-red-500/10 text-red-400 border border-red-500/20 text-[10px]">Conflict</Badge>
                    )}
                    {selectedMovement.classification.flags.cross_entity && (
                      <Badge className="bg-pink-500/10 text-pink-400 border border-pink-500/20 text-[10px]">Cross-Entity</Badge>
                    )}
                  </div>
                </div>
              )}

              {/* Candidates Table */}
              {selectedMovement.classification.candidates.length > 0 ? (
                <div className="bg-[#0A0A0A] border border-white/10 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-white/5">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Candidates ({selectedMovement.classification.candidates.length})</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="border-b border-white/5">
                          <th className="text-left text-[10px] text-zinc-600 uppercase tracking-wider px-3 py-2">Entity</th>
                          <th className="text-right text-[10px] text-zinc-600 uppercase tracking-wider px-3 py-2">Amount</th>
                          <th className="text-right text-[10px] text-zinc-600 uppercase tracking-wider px-3 py-2">Outstanding</th>
                          <th className="text-left text-[10px] text-zinc-600 uppercase tracking-wider px-3 py-2">Match Type</th>
                          <th className="text-right text-[10px] text-zinc-600 uppercase tracking-wider px-3 py-2">Diff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedMovement.classification.candidates.map((candidate: Candidate) => (
                          <tr key={candidate.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                            <td className="px-3 py-2">
                              <p className="text-white truncate">{candidate.entity_name}</p>
                              <p className="text-[10px] text-zinc-600">{candidate.id.slice(0, 12)}</p>
                            </td>
                            <td className="px-3 py-2 text-right text-zinc-300 font-mono tabular-nums">{formatCurrency(candidate.amount)}</td>
                            <td className="px-3 py-2 text-right text-zinc-300 font-mono tabular-nums">{formatCurrency(candidate.outstanding_amount)}</td>
                            <td className="px-3 py-2">
                              <Badge className={`text-[9px] px-1.5 py-0 ${getMatchTypeColor(candidate.match_type)}`}>{candidate.match_type}</Badge>
                            </td>
                            <td className="px-3 py-2 text-right text-zinc-400 font-mono tabular-nums">{formatCurrency(candidate.amount_diff)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-4 text-center">
                  <p className="text-[12px] text-zinc-500">No candidates found for this movement.</p>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

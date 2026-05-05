"use client"

import { useState, useEffect, useCallback } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { RefreshCw, Search, ChevronRight, Download, Sparkles, Users } from "lucide-react"
import type { ClassificationResult, CaseType, Candidate } from "@/lib/reconciliation-case-classifier"

interface ARMatch {
  id: string
  movement_id: string
  cash_event_id: string
  bank_date: string
  bank_description: string | null
  bank_counterparty: string | null
  bank_amount: number
  invoice_id: string
  customer_name: string
  invoice_amount: number
  match_type: string
  confidence: number
  fee_amount: number
  matched_amount: number
  matched_by: string
  status: string
  confirmed_at: string | null
  created_at: string
}

interface InvoiceWithMatch {
  invoice_id: string
  cash_event_id: string
  customer_name: string
  invoice_number: string | null
  invoice_amount: number
  outstanding_amount: number
  invoice_date: string | null
  due_date: string | null
  invoice_status: string
  is_matched: boolean
  match_id: string | null
  match_count: number
  bank_amount: number | null
  bank_date: string | null
  bank_counterparty: string | null
  bank_description: string | null
  match_type: string | null
  confidence: number | null
  match_status: string | null
}

interface InvoiceSummary {
  // Totals
  total_invoices: number
  total_invoice_amount: number
  // Matched breakdown
  matched_count: number
  matched_invoice_amount: number
  matched_bank_amount: number
  total_matched_amount: number
  total_fee_amount: number
  avg_confidence: number
  // Status breakdown
  pending_count: number
  confirmed_count: number
  pending_amount: number
  confirmed_amount: number
  // Unmatched
  unmatched_count: number
  unmatched_invoice_amount: number
  unmatched_outstanding_amount: number
}

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
  ar_count: number
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
  if (caseType.startsWith("REFUND")) return "bg-orange-500/10 text-orange-400 border-orange-500/20"
  if (caseType.startsWith("OVERPAYMENT")) return "bg-pink-500/10 text-pink-400 border-pink-500/20"
  if (caseType.startsWith("ROUNDING")) return "bg-slate-500/10 text-slate-400 border-slate-500/20"
  if (caseType.startsWith("DISCOUNT") || caseType.startsWith("EARLY") || caseType.startsWith("VOLUME")) return "bg-teal-500/10 text-teal-400 border-teal-500/20"
  // Zero-candidate sub-cases - AR focused
  if (caseType === "ZERO_MISSING_INVOICE") return "bg-rose-500/10 text-rose-400 border-rose-500/20"
  if (caseType === "ZERO_PREPAYMENT") return "bg-violet-500/10 text-violet-400 border-violet-500/20"
  if (caseType === "ZERO_REFUND_RECEIVED") return "bg-teal-500/10 text-teal-400 border-teal-500/20"
  if (caseType === "ZERO_DELETED_CUSTOMER") return "bg-gray-500/10 text-gray-400 border-gray-500/20"
  if (caseType === "ZERO_UNCLASSIFIED") return "bg-red-500/10 text-red-400 border-red-500/20"
  // AP excluded
  if (caseType === "AP_EXCLUDED") return "bg-zinc-500/10 text-zinc-500 border-zinc-500/20"
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
  const [customerMatchLoading, setCustomerMatchLoading] = useState(false)
  const [customerMatchStatus, setCustomerMatchStatus] = useState<{ status: string; matchCount: number } | null>(null)
  const [aiMatchResults, setAiMatchResults] = useState<Map<string, { decision: string; confidence: number; reasoning: string; matched_id: string | null }>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<"all" | "ar" | "operational" | "non_op" | "review">("ar")
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedMovement, setSelectedMovement] = useState<ClassifiedMovement | null>(null)
  const [isDetailsPanelOpen, setIsDetailsPanelOpen] = useState(false)
  const [aiEnhancements, setAiEnhancements] = useState<Map<string, { suggested_case_type: string; confidence: number; reasoning: string }>>(new Map())
  
  // AR Matches state
  const [arMatches, setArMatches] = useState<ARMatch[]>([])
  const [arMatchesTotal, setArMatchesTotal] = useState(0)
  const [arMatchesSummary, setArMatchesSummary] = useState<{
    total: number
    pending: number
    confirmed: number
    total_amount: number
    confirmed_amount: number
    pending_amount: number
    unmatched_count: number
    unmatched_amount: number
  }>({ total: 0, pending: 0, confirmed: 0, total_amount: 0, confirmed_amount: 0, pending_amount: 0, unmatched_count: 0, unmatched_amount: 0 })
  const [arMatchesLoading, setArMatchesLoading] = useState(false)
  const [arMatchFilter, setArMatchFilter] = useState<"all" | "pending" | "confirmed">("all")
  
  // Invoice View state
  const [invoices, setInvoices] = useState<InvoiceWithMatch[]>([])
  const [invoiceSummary, setInvoiceSummary] = useState<InvoiceSummary>({
    total_invoices: 0, total_invoice_amount: 0,
    matched_count: 0, matched_invoice_amount: 0, matched_bank_amount: 0,
    total_matched_amount: 0, total_fee_amount: 0, avg_confidence: 0,
    pending_count: 0, confirmed_count: 0, pending_amount: 0, confirmed_amount: 0,
    unmatched_count: 0, unmatched_invoice_amount: 0, unmatched_outstanding_amount: 0
  })
  const [invoicesLoading, setInvoicesLoading] = useState(false)
  const [invoiceFilter, setInvoiceFilter] = useState<"all" | "matched" | "unmatched">("all")
  const [activeView, setActiveView] = useState<"bank" | "invoice">("bank")

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

  // Fetch AR matches from database
  const fetchArMatches = useCallback(async () => {
    try {
      setArMatchesLoading(true)
      const params = new URLSearchParams()
      if (arMatchFilter !== "all") params.append("status", arMatchFilter)
      params.append("limit", "1000") // Load all matches
      
      const res = await fetch(`/api/ar-reconciliation/matches?${params.toString()}`)
      if (!res.ok) throw new Error("Failed to fetch AR matches")
      const json = await res.json()
      setArMatches(json.matches || [])
      setArMatchesTotal(json.total || 0)
      if (json.summary) {
        setArMatchesSummary(json.summary)
      }
    } catch (err) {
      console.error("Failed to fetch AR matches:", err)
    } finally {
      setArMatchesLoading(false)
    }
  }, [arMatchFilter])

  useEffect(() => {
    fetchArMatches()
  }, [fetchArMatches])

  // Fetch invoices with match status
  const fetchInvoices = useCallback(async () => {
    try {
      setInvoicesLoading(true)
      const params = new URLSearchParams()
      if (invoiceFilter !== "all") params.append("filter", invoiceFilter)
      params.append("limit", "1000")
      
      const res = await fetch(`/api/ar-reconciliation/invoices?${params.toString()}`)
      if (!res.ok) throw new Error("Failed to fetch invoices")
      const json = await res.json()
      setInvoices(json.invoices || [])
      if (json.summary) {
        setInvoiceSummary(json.summary)
      }
    } catch (err) {
      console.error("Failed to fetch invoices:", err)
    } finally {
      setInvoicesLoading(false)
    }
  }, [invoiceFilter])

  useEffect(() => {
    fetchInvoices()
  }, [fetchInvoices])

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

  const runCustomerMatching = async () => {
    try {
      setCustomerMatchLoading(true)
      setCustomerMatchStatus(null)
      
      // Start the background job
      const startRes = await fetch("/api/reconciliation/match-customers", {
        method: "POST",
      })
      
      if (!startRes.ok) throw new Error("Failed to start customer matching")
      
      // Poll for completion
      let attempts = 0
      const maxAttempts = 120 // 4 minutes max (2s intervals)
      
      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000)) // Wait 2 seconds
        
        const pollRes = await fetch("/api/reconciliation/match-customers")
        if (!pollRes.ok) throw new Error("Failed to check status")
        
        const pollJson = await pollRes.json()
        
        if (pollJson.status === "complete") {
          setCustomerMatchStatus({ status: "complete", matchCount: pollJson.matchCount || 0 })
          alert(`Customer Matching Complete!\n\n• ${pollJson.matchCount || 0} customers matched to invoices\n\nRefresh to see updated candidates.`)
          fetchData() // Refresh data
          return
        } else if (pollJson.status === "failed") {
          throw new Error(pollJson.error || "Customer matching failed")
        }
        
        // Still processing, continue polling
        attempts++
      }
      
      throw new Error("Customer matching timed out")
    } catch (err) {
      console.error("Customer matching error:", err)
      alert("Customer matching failed: " + (err instanceof Error ? err.message : "Unknown error"))
    } finally {
      setCustomerMatchLoading(false)
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
        body: JSON.stringify({}), // Let backend determine optimal batch sizing
      })
      
      if (!startRes.ok) throw new Error("Failed to start AI matching")
      
      const startJson = await startRes.json()
      const jobId = startJson.jobId
      
      if (!jobId) throw new Error("No job ID returned")
      
      // Poll for completion
      let attempts = 0
      const maxAttempts = 300 // 10 minutes max (2s intervals)
      
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
          <h1 className="text-xl font-semibold text-white tracking-tight">AR Reconciliation</h1>
          <p className="text-[12px] text-zinc-500 mt-0.5">Match customer payments to invoices · AR-focused classification</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={runCustomerMatching}
            disabled={loading || customerMatchLoading || !data}
            className="bg-cyan-600 hover:bg-cyan-700 text-white text-[11px] h-7 px-3"
          >
            <Users className={`h-3 w-3 mr-1.5 ${customerMatchLoading ? "animate-pulse" : ""}`} />
            {customerMatchLoading ? "Matching..." : "Match Customers"}
          </Button>
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
          <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | "ar" | "operational" | "non_op" | "review")} className="w-full">
            <TabsList className="bg-[#0A0A0A] border border-white/10 h-8">
              <TabsTrigger value="ar" className="text-[11px] h-6 px-3 text-emerald-400">
                AR Only ({data.summary.ar_count || 0})
              </TabsTrigger>
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
                  <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">AI Match</th>
                  <th className="text-center text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {data.movements.map((movement) => {
                  const aiMatch = aiMatchResults.get(movement.id)
                  return (
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
                      {aiMatch ? (
                        <div className="flex items-center gap-1.5">
                          <Badge className={`text-[10px] px-2 py-0.5 border ${
                            aiMatch.decision === "match" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                            aiMatch.decision === "create_invoice" || aiMatch.decision === "create_bill" ? "bg-blue-500/10 text-blue-400 border-blue-500/20" :
                            aiMatch.decision === "needs_review" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                            "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"
                          }`}>
                            {aiMatch.decision.replace(/_/g, " ")}
                          </Badge>
                          <span className="text-[10px] text-zinc-500">{Math.round(aiMatch.confidence * 100)}%</span>
                        </div>
                      ) : (
                        <span className="text-[10px] text-zinc-600">—</span>
                      )}
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
                )})}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* AR Matches Section - Persisted matches from database */}
      <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-white/10">
          {/* View Toggle */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <h2 className="text-[13px] font-semibold text-white">AR Reconciliation</h2>
              <div className="flex items-center bg-[#0A0A0A] rounded-lg p-0.5">
                <button
                  onClick={() => setActiveView("bank")}
                  className={`px-3 py-1 text-[10px] rounded-md transition-colors ${activeView === "bank" ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                >
                  Bank → Invoice
                </button>
                <button
                  onClick={() => setActiveView("invoice")}
                  className={`px-3 py-1 text-[10px] rounded-md transition-colors ${activeView === "invoice" ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                >
                  Invoice → Bank
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {activeView === "bank" ? (
                <>
                  <button
                    onClick={() => setArMatchFilter("all")}
                    className={`px-2 py-1 text-[10px] rounded ${arMatchFilter === "all" ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    All ({arMatchesSummary.total})
                  </button>
                  <button
                    onClick={() => setArMatchFilter("pending")}
                    className={`px-2 py-1 text-[10px] rounded ${arMatchFilter === "pending" ? "bg-amber-500/20 text-amber-400" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    Pending ({arMatchesSummary.pending})
                  </button>
                  <button
                    onClick={() => setArMatchFilter("confirmed")}
                    className={`px-2 py-1 text-[10px] rounded ${arMatchFilter === "confirmed" ? "bg-emerald-500/20 text-emerald-400" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    Confirmed ({arMatchesSummary.confirmed})
                  </button>
                  <Button
                    size="sm"
                    onClick={fetchArMatches}
                    disabled={arMatchesLoading}
                    className="bg-white/5 hover:bg-white/10 text-white text-[10px] h-6 px-2 ml-2"
                  >
                    <RefreshCw className={`h-3 w-3 ${arMatchesLoading ? "animate-spin" : ""}`} />
                  </Button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setInvoiceFilter("all")}
                    className={`px-2 py-1 text-[10px] rounded ${invoiceFilter === "all" ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    All ({invoiceSummary.total_invoices})
                  </button>
                  <button
                    onClick={() => setInvoiceFilter("matched")}
                    className={`px-2 py-1 text-[10px] rounded ${invoiceFilter === "matched" ? "bg-emerald-500/20 text-emerald-400" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    Matched ({invoiceSummary.matched_count})
                  </button>
                  <button
                    onClick={() => setInvoiceFilter("unmatched")}
                    className={`px-2 py-1 text-[10px] rounded ${invoiceFilter === "unmatched" ? "bg-red-500/20 text-red-400" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    Unmatched ({invoiceSummary.unmatched_count})
                  </button>
                  <Button
                    size="sm"
                    onClick={fetchInvoices}
                    disabled={invoicesLoading}
                    className="bg-white/5 hover:bg-white/10 text-white text-[10px] h-6 px-2 ml-2"
                  >
                    <RefreshCw className={`h-3 w-3 ${invoicesLoading ? "animate-spin" : ""}`} />
                  </Button>
                </>
              )}
            </div>
          </div>
          
          {/* Summary Stats - Bank View */}
          {activeView === "bank" && (
            <div className="grid grid-cols-4 gap-3">
              <div className="bg-[#0A0A0A] border border-white/5 rounded px-3 py-2">
                <p className="text-[9px] text-zinc-500 uppercase tracking-wider">Total Matched</p>
                <p className="text-lg font-bold font-mono tabular-nums text-white">{formatCurrency(arMatchesSummary.total_amount)}</p>
                <p className="text-[10px] text-zinc-500">{arMatchesSummary.total} transactions</p>
              </div>
              <div className="bg-[#0A0A0A] border border-emerald-500/20 rounded px-3 py-2">
                <p className="text-[9px] text-emerald-400 uppercase tracking-wider">Confirmed</p>
                <p className="text-lg font-bold font-mono tabular-nums text-emerald-400">{formatCurrency(arMatchesSummary.confirmed_amount)}</p>
                <p className="text-[10px] text-zinc-500">{arMatchesSummary.confirmed} transactions</p>
              </div>
              <div className="bg-[#0A0A0A] border border-amber-500/20 rounded px-3 py-2">
                <p className="text-[9px] text-amber-400 uppercase tracking-wider">Pending Review</p>
                <p className="text-lg font-bold font-mono tabular-nums text-amber-400">{formatCurrency(arMatchesSummary.pending_amount)}</p>
                <p className="text-[10px] text-zinc-500">{arMatchesSummary.pending} transactions</p>
              </div>
              <div className="bg-[#0A0A0A] border border-red-500/20 rounded px-3 py-2">
                <p className="text-[9px] text-red-400 uppercase tracking-wider">Unmatched Bank</p>
                <p className="text-lg font-bold font-mono tabular-nums text-red-400">{formatCurrency(arMatchesSummary.unmatched_amount)}</p>
                <p className="text-[10px] text-zinc-500">{arMatchesSummary.unmatched_count} transactions</p>
              </div>
            </div>
          )}
          
          {/* Summary Stats - Invoice View */}
          {activeView === "invoice" && (
            <div className="grid grid-cols-5 gap-3">
              <div className="bg-[#0A0A0A] border border-white/5 rounded px-3 py-2">
                <p className="text-[9px] text-zinc-500 uppercase tracking-wider">Total Invoices</p>
                <p className="text-lg font-bold font-mono tabular-nums text-white">{formatCurrency(invoiceSummary.total_invoice_amount)}</p>
                <p className="text-[10px] text-zinc-500">{invoiceSummary.total_invoices} invoices</p>
              </div>
              <div className="bg-[#0A0A0A] border border-emerald-500/20 rounded px-3 py-2">
                <p className="text-[9px] text-emerald-400 uppercase tracking-wider">Matched</p>
                <p className="text-lg font-bold font-mono tabular-nums text-emerald-400">{formatCurrency(invoiceSummary.matched_invoice_amount)}</p>
                <p className="text-[10px] text-zinc-500">{invoiceSummary.matched_count} invoices • {invoiceSummary.avg_confidence > 0 ? `${Math.round(invoiceSummary.avg_confidence * 100)}% avg` : ""}</p>
              </div>
              <div className="bg-[#0A0A0A] border border-red-500/20 rounded px-3 py-2">
                <p className="text-[9px] text-red-400 uppercase tracking-wider">Unmatched</p>
                <p className="text-lg font-bold font-mono tabular-nums text-red-400">{formatCurrency(invoiceSummary.unmatched_invoice_amount)}</p>
                <p className="text-[10px] text-zinc-500">{invoiceSummary.unmatched_count} invoices</p>
              </div>
              <div className="bg-[#0A0A0A] border border-cyan-500/20 rounded px-3 py-2">
                <p className="text-[9px] text-cyan-400 uppercase tracking-wider">Bank Received</p>
                <p className="text-lg font-bold font-mono tabular-nums text-cyan-400">{formatCurrency(invoiceSummary.matched_bank_amount)}</p>
                <p className="text-[10px] text-zinc-500">{invoiceSummary.total_fee_amount > 0 ? `${formatCurrency(invoiceSummary.total_fee_amount)} fees` : "from matched"}</p>
              </div>
              <div className="bg-[#0A0A0A] border border-amber-500/20 rounded px-3 py-2">
                <p className="text-[9px] text-amber-400 uppercase tracking-wider">Outstanding</p>
                <p className="text-lg font-bold font-mono tabular-nums text-amber-400">{formatCurrency(invoiceSummary.unmatched_outstanding_amount)}</p>
                <p className="text-[10px] text-zinc-500">remaining balance</p>
              </div>
            </div>
          )}
        </div>
        
        {/* Bank View Table */}
        {activeView === "bank" && (
          <>
            {arMatchesLoading ? (
              <div className="p-8 text-center">
                <p className="text-zinc-500 text-sm">Loading matches...</p>
              </div>
            ) : arMatches.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-zinc-500 text-sm">No AR matches found. Run AI Match to create matches.</p>
              </div>
            ) : (
              <div className="max-h-[400px] overflow-y-auto">
                <table className="w-full">
                  <thead className="sticky top-0 bg-[#141414]">
                    <tr className="border-b border-white/10">
                      <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Bank Transaction</th>
                      <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Date</th>
                      <th className="text-right text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Bank Amount</th>
                      <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Invoice</th>
                      <th className="text-right text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Invoice Amount</th>
                      <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Match Type</th>
                      <th className="text-center text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Confidence</th>
                      <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {arMatches.map((match) => (
                      <tr key={match.id} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors duration-100">
                        <td className="px-3 py-2">
                          <p className="text-[12px] text-white truncate max-w-[200px]">{match.bank_counterparty || "Unknown"}</p>
                          <p className="text-[10px] text-zinc-600 truncate max-w-[200px]">{match.bank_description || ""}</p>
                        </td>
                        <td className="px-3 py-2 text-[12px] text-zinc-400 whitespace-nowrap">{formatDate(match.bank_date)}</td>
                        <td className="px-3 py-2 text-right">
                          <span className="text-[12px] font-mono tabular-nums font-semibold text-emerald-400">
                            +{formatCurrency(match.bank_amount)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <p className="text-[12px] text-white">#{match.invoice_id}</p>
                          <p className="text-[10px] text-zinc-500">{match.customer_name}</p>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="text-[12px] font-mono tabular-nums text-zinc-300">
                            {formatCurrency(match.invoice_amount)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <Badge className={`text-[9px] px-1.5 py-0 ${getMatchTypeColor(match.match_type)}`}>
                            {match.match_type}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className="text-[11px] font-mono text-zinc-400">{Math.round(match.confidence * 100)}%</span>
                        </td>
                        <td className="px-3 py-2">
                          <Badge className={`text-[9px] px-1.5 py-0 ${
                            match.status === "confirmed" ? "bg-emerald-500/10 text-emerald-400" :
                            match.status === "pending" ? "bg-amber-500/10 text-amber-400" :
                            "bg-zinc-500/10 text-zinc-400"
                          }`}>
                            {match.status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* Invoice View Table */}
        {activeView === "invoice" && (
          <>
            {invoicesLoading ? (
              <div className="p-8 text-center">
                <p className="text-zinc-500 text-sm">Loading invoices...</p>
              </div>
            ) : invoices.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-zinc-500 text-sm">No invoices found.</p>
              </div>
            ) : (
              <div className="max-h-[400px] overflow-y-auto">
                <table className="w-full">
                  <thead className="sticky top-0 bg-[#141414]">
                    <tr className="border-b border-white/10">
                      <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Invoice</th>
                      <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Customer</th>
                      <th className="text-right text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Invoice Amount</th>
                      <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Bank Payment</th>
                      <th className="text-right text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Bank Amount</th>
                      <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Match Type</th>
                      <th className="text-center text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Confidence</th>
                      <th className="text-left text-[10px] text-zinc-500 uppercase tracking-wider px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((invoice) => (
                      <tr key={invoice.cash_event_id} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors duration-100">
                        <td className="px-3 py-2">
                          <p className="text-[12px] text-white">#{invoice.invoice_number || invoice.cash_event_id.slice(0, 8)}</p>
                          <p className="text-[10px] text-zinc-600">{invoice.due_date ? formatDate(invoice.due_date) : "No due date"}</p>
                        </td>
                        <td className="px-3 py-2">
                          <p className="text-[12px] text-white truncate max-w-[180px]">{invoice.customer_name}</p>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="text-[12px] font-mono tabular-nums text-zinc-300">
                            {formatCurrency(invoice.invoice_amount)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {invoice.is_matched ? (
                            <>
                              <p className="text-[12px] text-white truncate max-w-[180px]">{invoice.bank_counterparty || "Bank deposit"}</p>
                              <p className="text-[10px] text-zinc-600">{invoice.bank_date ? formatDate(invoice.bank_date) : ""}</p>
                            </>
                          ) : (
                            <span className="text-[11px] text-zinc-600 italic">No payment matched</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {invoice.is_matched && invoice.bank_amount ? (
                            <span className="text-[12px] font-mono tabular-nums font-semibold text-emerald-400">
                              +{formatCurrency(invoice.bank_amount)}
                            </span>
                          ) : (
                            <span className="text-[11px] text-zinc-600">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {invoice.is_matched && invoice.match_type ? (
                            <Badge className={`text-[9px] px-1.5 py-0 ${getMatchTypeColor(invoice.match_type)}`}>
                              {invoice.match_type}
                            </Badge>
                          ) : (
                            <span className="text-[11px] text-zinc-600">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {invoice.is_matched && invoice.confidence ? (
                            <span className="text-[11px] font-mono text-zinc-400">{Math.round(invoice.confidence * 100)}%</span>
                          ) : (
                            <span className="text-[11px] text-zinc-600">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {invoice.is_matched ? (
                            <div className="flex items-center gap-1">
                              <Badge className={`text-[9px] px-1.5 py-0 ${
                                invoice.match_status === "confirmed" ? "bg-emerald-500/10 text-emerald-400" :
                                invoice.match_status === "pending" ? "bg-amber-500/10 text-amber-400" :
                                "bg-zinc-500/10 text-zinc-400"
                              }`}>
                                {invoice.match_status || "matched"}
                              </Badge>
                              {invoice.match_count > 1 && (
                                <span className="text-[9px] text-cyan-400" title={`${invoice.match_count} potential matches - showing best`}>
                                  +{invoice.match_count - 1}
                                </span>
                              )}
                            </div>
                          ) : (
                            <Badge className="text-[9px] px-1.5 py-0 bg-red-500/10 text-red-400">
                              unmatched
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
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
              {/* AI Match Result */}
              {aiMatchResults.get(selectedMovement.id) && (
                <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-4">
                  <p className="text-[10px] text-blue-400 uppercase tracking-wider mb-3">AI Match Result</p>
                  {(() => {
                    const aiMatch = aiMatchResults.get(selectedMovement.id)!
                    return (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-zinc-400">Decision:</span>
                          <Badge className={`text-[10px] px-2 py-0.5 border ${
                            aiMatch.decision === "match" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                            aiMatch.decision === "create_invoice" || aiMatch.decision === "create_bill" ? "bg-blue-500/10 text-blue-400 border-blue-500/20" :
                            aiMatch.decision === "needs_review" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                            "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"
                          }`}>
                            {aiMatch.decision.replace(/_/g, " ")}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-zinc-400">Confidence:</span>
                          <span className="text-[11px] text-white font-mono">{Math.round(aiMatch.confidence * 100)}%</span>
                        </div>
                        {aiMatch.matched_id && (
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] text-zinc-400">Matched To:</span>
                            <span className="text-[11px] text-emerald-400 font-mono">{aiMatch.matched_id.slice(0, 12)}...</span>
                          </div>
                        )}
                        <div className="pt-2 border-t border-white/5">
                          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Reasoning</p>
                          <p className="text-[11px] text-zinc-300">{aiMatch.reasoning}</p>
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

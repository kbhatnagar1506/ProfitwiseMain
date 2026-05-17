"use client"

import { useState, useEffect, useCallback } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RefreshCw, Search, ChevronRight, Download, Sparkles, Users, TrendingUp, CheckCircle2, AlertCircle, Clock, Zap, DollarSign, FileText, ArrowUpRight, ArrowDownRight, PieChart, BarChart3, Activity, Info } from "lucide-react"
import type { ClassificationResult, CaseType, Candidate } from "@/lib/reconciliation-case-classifier"

// Info Button Component
function InfoButton({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="ml-1 text-zinc-500 hover:text-zinc-300 transition-colors">
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 bg-zinc-900 border-zinc-800 text-zinc-300 p-4" side="bottom" align="start">
        <h4 className="font-semibold text-white text-sm mb-2">{title}</h4>
        <div className="text-xs space-y-2 text-zinc-400">
          {children}
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface ReconciliationStats {
  // Invoice-Centric Coverage (PRIMARY)
  total_invoices: number
  total_invoice_amount: number
  paid_invoices: number
  paid_invoice_amount: number
  unpaid_invoices: number
  unpaid_invoice_amount: number
  outstanding_amount: number
  coverage_percentage: number

  // Match Status
  pending_review: number
  pending_review_amount: number
  confirmed: number
  confirmed_amount: number

  // Match Quality
  high_confidence_matches: number
  low_confidence_matches: number
  avg_confidence: number

  // Match Types
  match_types: { type: string; count: number; amount: number }[]

  // Fee Analysis
  total_fees_detected: number
  fee_amount: number

  // Time-based
  matches_today: number
  matches_this_week: number
  matches_this_month: number
}

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
  total_invoices: number
  matched_count: number
  unmatched_count: number
  total_invoice_amount: number
  matched_amount: number
  unmatched_amount: number
  outstanding_amount: number
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
  if (caseType.startsWith("ROUNDING")) return "bg-slate-500/10 text-zinc-400 border-slate-500/20"
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
    total_invoices: 0, matched_count: 0, unmatched_count: 0,
    total_invoice_amount: 0, matched_amount: 0, unmatched_amount: 0, outstanding_amount: 0
  })
  const [invoicesLoading, setInvoicesLoading] = useState(false)
  const [invoiceFilter, setInvoiceFilter] = useState<"all" | "matched" | "unmatched">("all")
  const [activeView, setActiveView] = useState<"bank" | "invoice">("bank")
  
  // Comprehensive stats
  const [stats, setStats] = useState<ReconciliationStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

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

  // Fetch comprehensive stats
  const fetchStats = useCallback(async () => {
    try {
      setStatsLoading(true)
      const res = await fetch("/api/ar-reconciliation/stats")
      if (!res.ok) throw new Error("Failed to fetch stats")
      const json = await res.json()
      setStats(json)
    } catch (err) {
      console.error("Failed to fetch stats:", err)
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

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
          
          // Refresh all data
          fetchStats()
          fetchArMatches()
          fetchInvoices()
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
      <div className="p-8 space-y-6 bg-black min-h-screen">
        <Skeleton className="h-12 w-64 bg-zinc-900" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24 bg-zinc-900" />
          ))}
        </div>
        <Skeleton className="h-96 bg-zinc-900" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="p-8 bg-black min-h-screen">
        <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-6 text-rose-400">
          <p className="font-semibold">Error loading reconciliation candidates</p>
          <p className="text-sm mt-2">{error || "Unknown error"}</p>
          <Button onClick={() => fetchData()} className="mt-4 bg-rose-600 hover:bg-rose-700">
            Retry
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 space-y-5 bg-black min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">AR Reconciliation</h1>
          <p className="text-sm text-zinc-500 mt-1">Match customer payments to invoices · AR-focused classification</p>
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

      {/* Comprehensive Stats Dashboard - Enterprise Grade */}
      {stats && (
        <div className="space-y-4">
          {/* Summary Banner - Unified Top Row */}
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-5">
            <div className="flex items-center divide-x divide-zinc-800">
              {/* Coverage */}
              <div className="flex-1 pr-6">
                <div className="flex items-center">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1">Coverage</p>
                  <InfoButton title="Coverage Calculation">
                    <p><strong className="text-zinc-200">Formula:</strong> (Paid Invoices / Total Invoices) × 100</p>
                    <div className="mt-2 p-2 bg-zinc-800/50 rounded">
                      <p>= ({stats.paid_invoices} / {stats.total_invoices}) × 100</p>
                      <p className="text-emerald-400 font-medium">= {stats.coverage_percentage}%</p>
                    </div>
                    <p className="mt-2 text-zinc-500">An invoice is "paid" if it has an EXACT, FEE, or AGGREGATION match, or if total matched amount ≥ invoice amount.</p>
                  </InfoButton>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-semibold tracking-tight text-white tabular-nums">{stats.coverage_percentage}%</span>
                  <span className="text-sm text-zinc-500">{stats.paid_invoices}/{stats.total_invoices}</span>
                </div>
                <div className="mt-2 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(stats.coverage_percentage, 100)}%` }}
                  />
                </div>
              </div>

              {/* Paid */}
              <div className="flex-1 px-6">
                <div className="flex items-center">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1">Paid</p>
                  <InfoButton title="Paid Invoices">
                    <p><strong className="text-zinc-200">Definition:</strong> Sum of invoice amounts that are fully matched.</p>
                    <div className="mt-2 p-2 bg-zinc-800/50 rounded space-y-1">
                      <p>Invoices: <span className="text-emerald-400">{stats.paid_invoices}</span></p>
                      <p>Amount: <span className="text-emerald-400">{formatCurrency(stats.paid_invoice_amount)}</span></p>
                    </div>
                    <p className="mt-2 text-zinc-500">Includes EXACT matches, FEE matches (payment minus processing fee), and AGGREGATION matches.</p>
                  </InfoButton>
                </div>
                <p className="text-2xl font-semibold tracking-tight text-white tabular-nums">{formatCurrency(stats.paid_invoice_amount)}</p>
                <p className="text-sm text-zinc-500 mt-0.5">{stats.paid_invoices} invoices</p>
              </div>

              {/* Unpaid */}
              <div className="flex-1 px-6">
                <div className="flex items-center">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1">Unpaid</p>
                  <InfoButton title="Unpaid Invoices">
                    <p><strong className="text-zinc-200">Definition:</strong> Invoices with no bank payment matches.</p>
                    <div className="mt-2 p-2 bg-zinc-800/50 rounded space-y-1">
                      <p>Invoices: <span className="text-rose-400">{stats.unpaid_invoices}</span></p>
                      <p>Amount: <span className="text-rose-400">{formatCurrency(stats.unpaid_invoice_amount)}</span></p>
                    </div>
                    <p className="mt-2 text-zinc-500">These invoices have not been matched to any bank deposit. They may be awaiting payment or need manual review.</p>
                  </InfoButton>
                </div>
                <p className="text-2xl font-semibold tracking-tight text-rose-400 tabular-nums">{formatCurrency(stats.unpaid_invoice_amount)}</p>
                <p className="text-sm text-zinc-500 mt-0.5">{stats.unpaid_invoices} invoices</p>
              </div>

              {/* Divider - Visual separator between ledger and recon states */}
              <div className="w-px h-12 bg-zinc-700 mx-2" />

              {/* Pending Review */}
              <div className="flex-1 px-6">
                <div className="flex items-center">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1">Pending Review</p>
                  <InfoButton title="Pending Review">
                    <p><strong className="text-zinc-200">Definition:</strong> AI-matched invoices awaiting human verification.</p>
                    <div className="mt-2 p-2 bg-zinc-800/50 rounded space-y-1">
                      <p>Matches: <span className="text-amber-400">{stats.pending_review}</span></p>
                      <p>Amount: <span className="text-amber-400">{formatCurrency(stats.pending_review_amount)}</span></p>
                    </div>
                    <p className="mt-2 text-zinc-500">Matches are marked "pending" when: confidence &lt; 85%, match type is PARTIAL or AGGREGATION, or AI reasoning suggests review.</p>
                  </InfoButton>
                </div>
                <p className="text-2xl font-semibold tracking-tight text-amber-400 tabular-nums">{formatCurrency(stats.pending_review_amount)}</p>
                <p className="text-sm text-zinc-500 mt-0.5">{stats.pending_review} awaiting</p>
              </div>

              {/* Confirmed */}
              <div className="flex-1 pl-6">
                <div className="flex items-center">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1">Confirmed</p>
                  <InfoButton title="Confirmed Matches">
                    <p><strong className="text-zinc-200">Definition:</strong> High-confidence matches verified by AI.</p>
                    <div className="mt-2 p-2 bg-zinc-800/50 rounded space-y-1">
                      <p>Matches: <span className="text-emerald-400">{stats.confirmed}</span></p>
                      <p>Amount: <span className="text-emerald-400">{formatCurrency(stats.confirmed_amount)}</span></p>
                    </div>
                    <p className="mt-2 text-zinc-500">Matches are auto-confirmed when: confidence ≥ 85% AND match type is EXACT or FEE with clear reasoning.</p>
                  </InfoButton>
                </div>
                <p className="text-2xl font-semibold tracking-tight text-emerald-400 tabular-nums">{formatCurrency(stats.confirmed_amount)}</p>
                <p className="text-sm text-zinc-500 mt-0.5">{stats.confirmed} verified</p>
              </div>
            </div>
          </div>

          {/* Second Row - Invoice Status, Match Quality, Match Types */}
          <div className="grid grid-cols-12 gap-4">
            {/* Invoice Status */}
            <div className="col-span-5 bg-zinc-900/50 border border-zinc-800/60 rounded-xl p-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Invoice Status</p>
                  <InfoButton title="Invoice Status Breakdown">
                    <p><strong className="text-zinc-200">Data Source:</strong> Invoices synced from QuickBooks/Xero</p>
                    <div className="mt-2 space-y-2">
                      <div className="p-2 bg-zinc-800/50 rounded">
                        <p className="text-zinc-300">Total: {stats.total_invoices} invoices</p>
                        <p className="text-zinc-500 text-[10px]">All AR invoices in the system</p>
                      </div>
                      <div className="p-2 bg-emerald-500/10 rounded border border-emerald-500/20">
                        <p className="text-emerald-400">Paid: {stats.paid_invoices} ({formatCurrency(stats.paid_invoice_amount)})</p>
                        <p className="text-zinc-500 text-[10px]">Matched to bank deposits</p>
                      </div>
                      <div className="p-2 bg-rose-500/10 rounded border border-rose-500/20">
                        <p className="text-rose-400">Unpaid: {stats.unpaid_invoices} ({formatCurrency(stats.unpaid_invoice_amount)})</p>
                        <p className="text-zinc-500 text-[10px]">No matching bank deposit found</p>
                      </div>
                    </div>
                  </InfoButton>
                </div>
                <span className="text-xs text-zinc-500">{stats.coverage_percentage}% paid</span>
              </div>
              
              {/* Stacked Bar */}
              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden mb-4 flex">
                <div 
                  className="bg-emerald-500 transition-all duration-500"
                  style={{ width: `${(stats.paid_invoices / Math.max(stats.total_invoices, 1)) * 100}%` }}
                />
                <div 
                  className="bg-rose-500/80 transition-all duration-500"
                  style={{ width: `${(stats.unpaid_invoices / Math.max(stats.total_invoices, 1)) * 100}%` }}
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1">Total</p>
                  <p className="text-lg font-semibold tracking-tight text-white tabular-nums">{stats.total_invoices}</p>
                  <p className="text-xs text-zinc-500">{formatCurrency(stats.total_invoice_amount)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1">Paid</p>
                  <p className="text-lg font-semibold tracking-tight text-emerald-400 tabular-nums">{stats.paid_invoices}</p>
                  <p className="text-xs text-zinc-500">{formatCurrency(stats.paid_invoice_amount)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1">Unpaid</p>
                  <p className="text-lg font-semibold tracking-tight text-rose-400 tabular-nums">{stats.unpaid_invoices}</p>
                  <p className="text-xs text-zinc-500">{formatCurrency(stats.unpaid_invoice_amount)}</p>
                </div>
              </div>
            </div>

            {/* Match Quality */}
            <div className="col-span-4 bg-zinc-900/50 border border-zinc-800/60 rounded-xl p-4">
              <div className="flex items-center mb-4">
                <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Match Quality</p>
                <InfoButton title="Match Quality Metrics">
                  <p><strong className="text-zinc-200">AI Confidence Score:</strong> How certain the AI is about each match.</p>
                  <div className="mt-2 space-y-2">
                    <div className="p-2 bg-zinc-800/50 rounded">
                      <p className="text-zinc-300">Average: {stats.avg_confidence}%</p>
                      <p className="text-zinc-500 text-[10px]">Mean confidence across all matches</p>
                    </div>
                    <div className="p-2 bg-emerald-500/10 rounded border border-emerald-500/20">
                      <p className="text-emerald-400">High (≥85%): {stats.high_confidence_matches}</p>
                      <p className="text-zinc-500 text-[10px]">Auto-confirmed, reliable matches</p>
                    </div>
                    <div className="p-2 bg-amber-500/10 rounded border border-amber-500/20">
                      <p className="text-amber-400">Low (&lt;70%): {stats.low_confidence_matches}</p>
                      <p className="text-zinc-500 text-[10px]">Needs human review</p>
                    </div>
                  </div>
                  <p className="mt-2 text-zinc-500">Confidence is determined by the AI based on multiple matching signals.</p>
                </InfoButton>
              </div>

              <div className="flex items-center gap-4 mb-4">
                <div>
                  <p className="text-3xl font-semibold tracking-tight text-white tabular-nums">{stats.avg_confidence}%</p>
                  <p className="text-xs text-zinc-500">avg confidence</p>
                </div>
                <div className="flex-1 grid grid-cols-2 gap-3">
                  <div className="bg-zinc-800/50 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-semibold tracking-tight text-emerald-400 tabular-nums">{stats.high_confidence_matches}</p>
                    <p className="text-[10px] text-zinc-500">High ≥85%</p>
                  </div>
                  <div className="bg-zinc-800/50 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-semibold tracking-tight text-amber-400 tabular-nums">{stats.low_confidence_matches}</p>
                    <p className="text-[10px] text-zinc-500">Low &lt;70%</p>
                  </div>
                </div>
              </div>

              {/* Confidence Distribution */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-[10px] text-zinc-500">
                  <span>Distribution</span>
                  <span>{stats.paid_invoices} matches</span>
                </div>
                <div className="h-2 bg-zinc-800 rounded-full overflow-hidden flex">
                  <div 
                    className="bg-emerald-500 transition-all duration-500"
                    style={{ width: `${(stats.high_confidence_matches / Math.max(stats.paid_invoices, 1)) * 100}%` }}
                  />
                  <div 
                    className="bg-zinc-500 transition-all duration-500"
                    style={{ width: `${((stats.paid_invoices - stats.high_confidence_matches - stats.low_confidence_matches) / Math.max(stats.paid_invoices, 1)) * 100}%` }}
                  />
                  <div 
                    className="bg-amber-500 transition-all duration-500"
                    style={{ width: `${(stats.low_confidence_matches / Math.max(stats.paid_invoices, 1)) * 100}%` }}
                  />
                </div>
                <div className="flex gap-4 text-[10px] text-zinc-500">
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" />High</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-zinc-500" />Medium</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500" />Low</span>
                </div>
              </div>
            </div>

            {/* Match Types */}
            <div className="col-span-3 bg-zinc-900/50 border border-zinc-800/60 rounded-xl p-4">
              <div className="flex items-center mb-4">
                <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Match Types</p>
                <InfoButton title="Match Type Definitions">
                  <div className="space-y-2">
                    <div className="p-2 bg-emerald-500/10 rounded border border-emerald-500/20">
                      <p className="text-emerald-400 font-medium">EXACT</p>
                      <p className="text-zinc-500 text-[10px]">Bank amount = Invoice amount (±$0.01)</p>
                    </div>
                    <div className="p-2 bg-amber-500/10 rounded border border-amber-500/20">
                      <p className="text-amber-400 font-medium">FEE</p>
                      <p className="text-zinc-500 text-[10px]">Bank amount = Invoice - Processing fee (1-5%)</p>
                    </div>
                    <div className="p-2 bg-purple-500/10 rounded border border-purple-500/20">
                      <p className="text-purple-400 font-medium">PARTIAL</p>
                      <p className="text-zinc-500 text-[10px]">Bank amount &lt; Invoice (partial payment)</p>
                    </div>
                    <div className="p-2 bg-cyan-500/10 rounded border border-cyan-500/20">
                      <p className="text-cyan-400 font-medium">AGGREGATION</p>
                      <p className="text-zinc-500 text-[10px]">One payment covers multiple invoices</p>
                    </div>
                  </div>
                </InfoButton>
              </div>

              <div className="space-y-3">
                {stats.match_types.slice(0, 4).map((mt) => {
                  const maxCount = Math.max(...stats.match_types.map(t => t.count))
                  const barWidth = (mt.count / maxCount) * 100
                  return (
                    <div key={mt.type} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-zinc-300">{mt.type}</span>
                        <span className="text-xs font-medium text-white tabular-nums">{mt.count}</span>
                      </div>
                      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div 
                          className="h-full rounded-full bg-slate-500 transition-all duration-500"
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>

              {stats.total_fees_detected > 0 && (
                <div className="mt-3 pt-3 border-t border-zinc-800">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-500">Fees Detected</span>
                    <span className="text-xs text-amber-400 tabular-nums">{stats.total_fees_detected} ({formatCurrency(stats.fee_amount)})</span>
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>
      )}

      {/* Stats Loading State */}
      {statsLoading && !stats && (
        <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl p-5">
          <div className="flex items-center divide-x divide-zinc-800">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex-1 px-6">
                <Skeleton className="h-4 w-16 mb-2 bg-zinc-800" />
                <Skeleton className="h-8 w-24 bg-zinc-800" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-3">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | "ar" | "operational" | "non_op" | "review")} className="w-full">
            <TabsList className="bg-zinc-800/50 border border-slate-700/50 h-8">
              <TabsTrigger value="ar" className="text-[11px] h-6 px-3 data-[state=active]:text-emerald-400">
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
              <TabsTrigger value="review" className="text-[11px] h-6 px-3 data-[state=active]:text-rose-400">
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
            className="bg-zinc-800/50 border-slate-700/50 pl-9 h-8 text-[12px] text-zinc-300 placeholder:text-zinc-500"
          />
        </div>
      </div>

      {/* Movements Table */}
      <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl overflow-hidden">
        {data.movements.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-zinc-500 text-sm">No movements found matching your filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Date</th>
                  <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Description</th>
                  <th className="text-right text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Amount</th>
                  <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Direction</th>
                  <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Case Type</th>
                  <th className="text-center text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Candidates</th>
                  <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">AI Match</th>
                  <th className="text-center text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {data.movements.map((movement) => {
                  const aiMatch = aiMatchResults.get(movement.id)
                  return (
                  <tr key={movement.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors duration-100">
                    <td className="px-4 py-3 text-[12px] text-zinc-400 whitespace-nowrap">{formatDate(movement.date)}</td>
                    <td className="px-4 py-3">
                      <p className="text-[12px] text-zinc-200 truncate max-w-[250px]">{movement.counterparty || movement.id.slice(0, 12)}</p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`text-[12px] tabular-nums font-medium ${movement.direction === "inflow" ? "text-emerald-400" : "text-rose-400"}`}>
                        {movement.direction === "inflow" ? "+" : "−"}{formatCurrency(Math.abs(movement.amount))}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${movement.direction === "inflow" ? "bg-emerald-400/10 text-emerald-400" : "bg-rose-400/10 text-rose-400"}`}>
                        {movement.direction === "inflow" ? "AR" : "AP"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[11px] text-zinc-300">
                        {movement.classification.case_type.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="text-[12px] tabular-nums text-zinc-400">{movement.classification.candidates.length}</span>
                    </td>
                    <td className="px-4 py-3">
                      {aiMatch ? (
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[10px] px-2 py-0.5 rounded ${
                            aiMatch.decision === "match" ? "bg-emerald-400/10 text-emerald-400" :
                            aiMatch.decision === "create_invoice" || aiMatch.decision === "create_bill" ? "bg-blue-400/10 text-blue-400" :
                            aiMatch.decision === "needs_review" ? "bg-amber-400/10 text-amber-400" :
                            "bg-slate-700 text-zinc-400"
                          }`}>
                            {aiMatch.decision.replace(/_/g, " ")}
                          </span>
                          <span className="text-[10px] text-zinc-500">{Math.round(aiMatch.confidence * 100)}%</span>
                        </div>
                      ) : (
                        <span className="text-[10px] text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
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
      <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl overflow-hidden flex flex-col h-[700px]">
        <div className="px-4 py-3 border-b border-zinc-800 flex-shrink-0 overflow-y-auto">
          {/* View Toggle */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-medium text-zinc-200">AR Reconciliation</h2>
              <div className="flex items-center bg-zinc-800/50 rounded-lg p-0.5">
                <button
                  onClick={() => setActiveView("bank")}
                  className={`px-3 py-1 text-[10px] rounded-md transition-colors ${activeView === "bank" ? "bg-slate-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                >
                  Bank → Invoice
                </button>
                <button
                  onClick={() => setActiveView("invoice")}
                  className={`px-3 py-1 text-[10px] rounded-md transition-colors ${activeView === "invoice" ? "bg-slate-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
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
                    className={`px-2 py-1 text-[10px] rounded ${arMatchFilter === "all" ? "bg-slate-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    All ({arMatchesSummary.total})
                  </button>
                  <button
                    onClick={() => setArMatchFilter("pending")}
                    className={`px-2 py-1 text-[10px] rounded ${arMatchFilter === "pending" ? "bg-amber-400/10 text-amber-400" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    Pending ({arMatchesSummary.pending})
                  </button>
                  <button
                    onClick={() => setArMatchFilter("confirmed")}
                    className={`px-2 py-1 text-[10px] rounded ${arMatchFilter === "confirmed" ? "bg-emerald-400/10 text-emerald-400" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    Confirmed ({arMatchesSummary.confirmed})
                  </button>
                  <Button
                    size="sm"
                    onClick={fetchArMatches}
                    disabled={arMatchesLoading}
                    className="bg-zinc-800 hover:bg-slate-700 text-zinc-300 text-[10px] h-6 px-2 ml-2"
                  >
                    <RefreshCw className={`h-3 w-3 ${arMatchesLoading ? "animate-spin" : ""}`} />
                  </Button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setInvoiceFilter("all")}
                    className={`px-2 py-1 text-[10px] rounded ${invoiceFilter === "all" ? "bg-slate-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    All ({invoiceSummary.total_invoices})
                  </button>
                  <button
                    onClick={() => setInvoiceFilter("matched")}
                    className={`px-2 py-1 text-[10px] rounded ${invoiceFilter === "matched" ? "bg-emerald-400/10 text-emerald-400" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    Matched ({invoiceSummary.matched_count})
                  </button>
                  <button
                    onClick={() => setInvoiceFilter("unmatched")}
                    className={`px-2 py-1 text-[10px] rounded ${invoiceFilter === "unmatched" ? "bg-rose-400/10 text-rose-400" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    Unmatched ({invoiceSummary.unmatched_count})
                  </button>
                  <Button
                    size="sm"
                    onClick={fetchInvoices}
                    disabled={invoicesLoading}
                    className="bg-zinc-800 hover:bg-slate-700 text-zinc-300 text-[10px] h-6 px-2 ml-2"
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
              <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Total Matched</p>
                <p className="text-lg font-semibold tracking-tight text-white tabular-nums">{formatCurrency(arMatchesSummary.total_amount)}</p>
                <p className="text-[10px] text-zinc-500">{arMatchesSummary.total} transactions</p>
              </div>
              <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Confirmed</p>
                <p className="text-lg font-semibold tracking-tight text-emerald-400 tabular-nums">{formatCurrency(arMatchesSummary.confirmed_amount)}</p>
                <p className="text-[10px] text-zinc-500">{arMatchesSummary.confirmed} transactions</p>
              </div>
              <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Pending Review</p>
                <p className="text-lg font-semibold tracking-tight text-amber-400 tabular-nums">{formatCurrency(arMatchesSummary.pending_amount)}</p>
                <p className="text-[10px] text-zinc-500">{arMatchesSummary.pending} transactions</p>
              </div>
              <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Unmatched Bank</p>
                <p className="text-lg font-semibold tracking-tight text-rose-400 tabular-nums">{formatCurrency(arMatchesSummary.unmatched_amount)}</p>
                <p className="text-[10px] text-zinc-500">{arMatchesSummary.unmatched_count} transactions</p>
              </div>
            </div>
          )}
          
          {/* Summary Stats - Invoice View */}
          {activeView === "invoice" && (
            <div className="grid grid-cols-4 gap-3">
              <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Total Invoices</p>
                <p className="text-lg font-semibold tracking-tight text-white tabular-nums">{formatCurrency(invoiceSummary.total_invoice_amount)}</p>
                <p className="text-[10px] text-zinc-500">{invoiceSummary.total_invoices} invoices</p>
              </div>
              <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Matched</p>
                <p className="text-lg font-semibold tracking-tight text-emerald-400 tabular-nums">{formatCurrency(invoiceSummary.matched_amount)}</p>
                <p className="text-[10px] text-zinc-500">{invoiceSummary.matched_count} invoices</p>
              </div>
              <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Unmatched</p>
                <p className="text-lg font-semibold tracking-tight text-rose-400 tabular-nums">{formatCurrency(invoiceSummary.unmatched_amount)}</p>
                <p className="text-[10px] text-zinc-500">{invoiceSummary.unmatched_count} invoices</p>
              </div>
              <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Outstanding</p>
                <p className="text-lg font-semibold tracking-tight text-amber-400 tabular-nums">{formatCurrency(invoiceSummary.outstanding_amount)}</p>
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
              <div className="overflow-y-auto flex-1 min-h-0">
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
              <div className="overflow-y-auto flex-1 min-h-0">
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

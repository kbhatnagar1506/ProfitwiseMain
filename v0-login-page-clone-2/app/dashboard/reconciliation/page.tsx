"use client"

import { useState, useEffect, useCallback } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CheckCircle2, XCircle, AlertCircle, RefreshCw, ChevronDown, ChevronRight, Link2Off, DollarSign, ArrowDownRight, ArrowUpRight, Sparkles } from "lucide-react"

interface ARAPStepResponse {
  ar: {
    invoices: any[]
    paid_invoices: any[]
    reconciliation_summary: {
      match_rate: number
      discrepancy: number
    }
  }
  ap: {
    bills: any[]
    paid_bills: any[]
    reconciliation_summary: {
      match_rate: number
      discrepancy: number
    }
  }
  recon: {
    unmatched_inflows: any[]
    unmatched_outflows: any[]
  }
  lifetime: {
    ar: { reconciled_pct: number }
    ap: { reconciled_pct: number }
  }
  is_reconciling: boolean
  reconciliation_status: any
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

function formatDate(d: string | null) {
  if (!d) return "—"
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export default function ReconciliationPage() {
  const [data, setData] = useState<ARAPStepResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [llmSuggestions, setLlmSuggestions] = useState<any>(null)
  const [llmLoading, setLlmLoading] = useState(false)

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
      setData(prev => prev ? { ...prev, is_reconciling: true } : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error")
    }
  }

  const handleMarkPaid = async (eventId: string) => {
    try {
      const res = await fetch("/api/dashboard/reconciliation/mark-paid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId, action: "paid" }),
      })
      if (res.ok) await fetchData()
    } catch (err) {
      console.error(err)
    }
  }

  const handleLoadLLMSuggestions = async () => {
    setLlmLoading(true)
    try {
      const res = await fetch("/api/ar-ap-reconciliation/llm-match", { method: "POST" })
      if (res.ok) {
        const json = await res.json()
        setLlmSuggestions(json)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLlmLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="p-8 space-y-6">
        <Skeleton className="h-12 w-64" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-20" />)}
        </div>
      </div>
    )
  }

  if (!data) {
    return <div className="p-8 text-red-400">{error || "No data"}</div>
  }

  const arMatchRate = data.ar.reconciliation_summary.match_rate || 0
  const apMatchRate = data.ap.reconciliation_summary.match_rate || 0

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Reconciliation</h1>
          <p className="text-zinc-400 mt-1">Match bank movements to AR/AP invoices and bills</p>
        </div>
        <Button
          onClick={handleRunReconciliation}
          disabled={data.is_reconciling || running}
          className="bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          {data.is_reconciling ? "Running..." : "Run Reconciliation"}
        </Button>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">AR Match Rate</p>
          <p className="text-2xl font-bold text-emerald-400 mt-2">{arMatchRate.toFixed(0)}%</p>
        </div>
        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">AP Match Rate</p>
          <p className="text-2xl font-bold text-emerald-400 mt-2">{apMatchRate.toFixed(0)}%</p>
        </div>
        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">AR Gap</p>
          <p className="text-2xl font-bold text-amber-400 mt-2">{formatCurrency(data.ar.reconciliation_summary.discrepancy)}</p>
        </div>
        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">AP Gap</p>
          <p className="text-2xl font-bold text-amber-400 mt-2">{formatCurrency(data.ap.reconciliation_summary.discrepancy)}</p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="ar" className="w-full">
        <TabsList className="bg-[#141414] border border-white/10">
          <TabsTrigger value="ar">AR ({data.ar.invoices.length})</TabsTrigger>
          <TabsTrigger value="ap">AP ({data.ap.bills.length})</TabsTrigger>
          <TabsTrigger value="unmatched">Unmatched ({data.recon.unmatched_inflows.length + data.recon.unmatched_outflows.length})</TabsTrigger>
          <TabsTrigger value="llm">LLM Queue</TabsTrigger>
        </TabsList>

        {/* AR Tab */}
        <TabsContent value="ar" className="space-y-4">
          <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-white/10 hover:bg-transparent">
                  <TableHead className="text-xs text-zinc-500">Customer</TableHead>
                  <TableHead className="text-xs text-zinc-500 text-right">Amount</TableHead>
                  <TableHead className="text-xs text-zinc-500 text-right">Outstanding</TableHead>
                  <TableHead className="text-xs text-zinc-500">Status</TableHead>
                  <TableHead className="text-xs text-zinc-500">Due</TableHead>
                  <TableHead className="text-xs text-zinc-500">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.ar.invoices.map(inv => (
                  <TableRow key={inv.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <TableCell className="text-sm text-white">{inv.customer_name}</TableCell>
                    <TableCell className="text-sm text-right text-zinc-300">{formatCurrency(inv.amount)}</TableCell>
                    <TableCell className="text-sm text-right text-zinc-300">{formatCurrency(inv.amount_due)}</TableCell>
                    <TableCell>
                      <Badge className={inv.status === "paid" ? "bg-emerald-500/20 text-emerald-400" : inv.status === "partially_paid" ? "bg-amber-500/20 text-amber-400" : "bg-red-500/20 text-red-400"}>
                        {inv.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-zinc-400">{formatDate(inv.due_date)}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" onClick={() => handleMarkPaid(inv.id)} className="text-xs">
                        Mark Paid
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* AP Tab */}
        <TabsContent value="ap" className="space-y-4">
          <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-white/10 hover:bg-transparent">
                  <TableHead className="text-xs text-zinc-500">Vendor</TableHead>
                  <TableHead className="text-xs text-zinc-500 text-right">Amount</TableHead>
                  <TableHead className="text-xs text-zinc-500 text-right">Outstanding</TableHead>
                  <TableHead className="text-xs text-zinc-500">Status</TableHead>
                  <TableHead className="text-xs text-zinc-500">Due</TableHead>
                  <TableHead className="text-xs text-zinc-500">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.ap.bills.map(bill => (
                  <TableRow key={bill.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <TableCell className="text-sm text-white">{bill.vendor_name}</TableCell>
                    <TableCell className="text-sm text-right text-zinc-300">{formatCurrency(bill.amount)}</TableCell>
                    <TableCell className="text-sm text-right text-zinc-300">{formatCurrency(bill.amount_due)}</TableCell>
                    <TableCell>
                      <Badge className={bill.status === "paid" ? "bg-emerald-500/20 text-emerald-400" : bill.status === "partially_paid" ? "bg-amber-500/20 text-amber-400" : "bg-red-500/20 text-red-400"}>
                        {bill.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-zinc-400">{formatDate(bill.due_date)}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" onClick={() => handleMarkPaid(bill.id)} className="text-xs">
                        Mark Paid
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* Unmatched Tab */}
        <TabsContent value="unmatched" className="space-y-4">
          <div className="text-sm text-zinc-400">
            {data.recon.unmatched_inflows.length + data.recon.unmatched_outflows.length} unmatched movements
          </div>
        </TabsContent>

        {/* LLM Queue Tab */}
        <TabsContent value="llm" className="space-y-4">
          {!llmSuggestions && (
            <Button onClick={handleLoadLLMSuggestions} disabled={llmLoading} className="bg-blue-600 hover:bg-blue-700">
              <Sparkles className="h-4 w-4 mr-2" />
              {llmLoading ? "Loading..." : "Load LLM Suggestions"}
            </Button>
          )}
          {llmSuggestions && (
            <div className="text-sm text-zinc-400">
              {llmSuggestions.ar?.length || 0} AR + {llmSuggestions.ap?.length || 0} AP suggestions
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

"use client"

import { useState, useEffect, useCallback } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer"
import { Input } from "@/components/ui/input"
import { CheckCircle2, XCircle, AlertCircle, RefreshCw, ChevronDown, ChevronRight, Sparkles, ArrowRight } from "lucide-react"

interface Movement {
  id: string
  date: string
  direction: "inflow" | "outflow"
  amount: number
  description: string
  counterparty: string | null
  economic_class: string | null
  movement_type: string | null
}

interface OutstandingInvoice {
  invoice_id: string
  customer_name: string
  amount: number
  amount_due: number
  due_date: string | null
  status: "open" | "overdue" | "partially_paid" | "paid"
  reconciliation_status?: "matched" | "unmatched" | "partial"
}

interface OutstandingBill {
  bill_id: string
  vendor_name: string
  amount: number
  amount_due: number
  due_date: string | null
  status: "open" | "overdue" | "partially_paid" | "paid"
  reconciliation_status?: "matched" | "unmatched" | "partial"
}

interface ClearingHouseData {
  unmatched_movements: {
    inflows: Movement[]
    outflows: Movement[]
    total_inflows: number
    total_outflows: number
  }
  open_ar: OutstandingInvoice[]
  open_ap: OutstandingBill[]
  total_ar_waiting: number
  total_ap_waiting: number
  ai_suggestions: {
    high_confidence: any[]
    medium_confidence: any[]
    low_confidence: any[]
  }
  internal_transfers: {
    paired: any[]
    unpaired: Movement[]
  }
  reconciliation_stats: {
    total_matched_today: number
    total_matched_this_week: number
    match_rate_pct: number
  }
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

function formatDate(d: string | null) {
  if (!d) return "—"
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export default function ClearingHousePage() {
  const [data, setData] = useState<ClearingHouseData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedMovement, setSelectedMovement] = useState<Movement | null>(null)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [selectedInvoices, setSelectedInvoices] = useState<OutstandingInvoice[]>([])
  const [selectedBills, setSelectedBills] = useState<OutstandingBill[]>([])
  const [isMatching, setIsMatching] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/reconciliation/clearing-house")
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

  // Poll every 5 seconds
  useEffect(() => {
    const timer = setInterval(fetchData, 5000)
    return () => clearInterval(timer)
  }, [fetchData])

  const handleRunReconciliation = async () => {
    try {
      await fetch("/api/ar-ap-step?run=true")
      setTimeout(fetchData, 1000)
    } catch (err) {
      console.error(err)
    }
  }

  const handleClearMatch = async (movement: Movement, invoice?: OutstandingInvoice, bill?: OutstandingBill) => {
    setIsMatching(true)
    try {
      const target = invoice || bill
      if (!target) return

      const componentType = invoice ? "ar" : "ap"
      const referenceId = invoice ? invoice.invoice_id : bill!.bill_id
      const entityId = `${componentType}://${componentType === "ar" ? "invoice" : "bill"}/${referenceId}`

      const res = await fetch("/api/dashboard/reconciliation/apply-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          movement_id: movement.id,
          reference_id: referenceId,
          component_type: componentType,
          entity_id: entityId,
          amount: movement.amount,
        }),
      })

      if (res.ok) {
        await fetchData()
      }
    } catch (err) {
      console.error(err)
    } finally {
      setIsMatching(false)
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

  const totalUnmatched = data.unmatched_movements.total_inflows + data.unmatched_movements.total_outflows

  return (
    <div className="p-8 space-y-6 bg-[#0A0A0A] min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Clearing House</h1>
          <p className="text-zinc-400 mt-1">Match bank cash to open AR/AP</p>
        </div>
        <Button onClick={handleRunReconciliation} className="bg-emerald-600 hover:bg-emerald-700">
          <RefreshCw className="h-4 w-4 mr-2" />
          Run Reconciliation
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">Unmatched Cash</p>
          <p className={`text-2xl font-bold mt-2 ${totalUnmatched > 0 ? "text-red-400" : "text-emerald-400"}`}>
            {formatCurrency(totalUnmatched)}
          </p>
          <p className="text-xs text-zinc-400 mt-2">{data.unmatched_movements.inflows.length + data.unmatched_movements.outflows.length} movements</p>
        </div>

        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">Open AR Waiting</p>
          <p className="text-2xl font-bold mt-2 text-emerald-400">{formatCurrency(data.total_ar_waiting)}</p>
          <p className="text-xs text-zinc-400 mt-2">{data.open_ar.length} invoices</p>
        </div>

        <div className="bg-[#141414] border border-white/10 rounded-lg p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">Open AP Waiting</p>
          <p className="text-2xl font-bold mt-2 text-amber-400">{formatCurrency(data.total_ap_waiting)}</p>
          <p className="text-xs text-zinc-400 mt-2">{data.open_ap.length} bills</p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="review" className="w-full">
        <TabsList className="bg-[#141414] border border-white/10">
          <TabsTrigger value="review">Review Queue ({data.unmatched_movements.inflows.length + data.unmatched_movements.outflows.length})</TabsTrigger>
          <TabsTrigger value="reconciled">Reconciled</TabsTrigger>
          <TabsTrigger value="transfers">Internal Transfers ({data.internal_transfers.paired.length + data.internal_transfers.unpaired.length})</TabsTrigger>
        </TabsList>

        {/* Review Queue Tab */}
        <TabsContent value="review" className="space-y-4">
          <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3 w-[30%]">Bank Movement</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3 w-[20%]">Match</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3 w-[40%]">Ledger</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3 w-[10%]">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.unmatched_movements.inflows, ...data.unmatched_movements.outflows].map(movement => {
                    // Find matching AR/AP suggestion
                    const suggestion = data.ai_suggestions.high_confidence.find(s => s.movement_id === movement.id)
                    const matchedInvoice = suggestion && suggestion.component_type === "ar" 
                      ? data.open_ar.find(i => i.invoice_id === suggestion.reference_id)
                      : undefined
                    const matchedBill = suggestion && suggestion.component_type === "ap"
                      ? data.open_ap.find(b => b.bill_id === suggestion.reference_id)
                      : undefined

                    return (
                      <tr key={movement.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                        {/* Left: Bank Movement */}
                        <td className="px-4 py-3">
                          <div className="space-y-1">
                            <p className="text-xs text-zinc-400">{formatDate(movement.date)}</p>
                            <p className="text-sm text-white truncate">{movement.description}</p>
                            <p className={`text-sm font-mono tabular-nums ${movement.direction === "inflow" ? "text-emerald-400" : "text-red-400"}`}>
                              {movement.direction === "inflow" ? "+" : "-"}{formatCurrency(movement.amount)}
                            </p>
                          </div>
                        </td>

                        {/* Middle: Match Badge */}
                        <td className="px-4 py-3">
                          {suggestion ? (
                            <div className="flex items-center gap-2">
                              <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                {Math.round(suggestion.confidence * 100)}% Match
                              </Badge>
                              <ArrowRight className="h-4 w-4 text-zinc-500" />
                            </div>
                          ) : (
                            <Badge className="bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">
                              No Match
                            </Badge>
                          )}
                        </td>

                        {/* Right: Ledger */}
                        <td className="px-4 py-3">
                          {matchedInvoice ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs">AR</Badge>
                                <span className="text-sm text-white">{matchedInvoice.customer_name}</span>
                              </div>
                              <p className="text-xs text-zinc-400">Inv-{matchedInvoice.invoice_id.slice(-4)}</p>
                              <p className="text-sm font-mono tabular-nums text-zinc-300">{formatCurrency(matchedInvoice.amount_due)}</p>
                            </div>
                          ) : matchedBill ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs">AP</Badge>
                                <span className="text-sm text-white">{matchedBill.vendor_name}</span>
                              </div>
                              <p className="text-xs text-zinc-400">Bill-{matchedBill.bill_id.slice(-4)}</p>
                              <p className="text-sm font-mono tabular-nums text-zinc-300">{formatCurrency(matchedBill.amount_due)}</p>
                            </div>
                          ) : (
                            <p className="text-sm text-zinc-400">—</p>
                          )}
                        </td>

                        {/* Action */}
                        <td className="px-4 py-3">
                          {matchedInvoice || matchedBill ? (
                            <Button
                              size="sm"
                              onClick={() => handleClearMatch(movement, matchedInvoice, matchedBill)}
                              disabled={isMatching}
                              className="bg-emerald-600 hover:bg-emerald-700 text-xs"
                            >
                              ✓ Clear
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setSelectedMovement(movement)
                                setSelectedInvoices([])
                                setSelectedBills([])
                                setIsDrawerOpen(true)
                              }}
                              className="text-xs"
                            >
                              Match
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
          <div className="bg-[#141414] border border-white/10 rounded-lg p-6 text-center">
            <p className="text-zinc-400">Reconciled matches will appear here</p>
            <p className="text-sm text-zinc-500 mt-2">Total matched this week: {data.reconciliation_stats.total_matched_this_week}</p>
          </div>
        </TabsContent>

        {/* Internal Transfers Tab */}
        <TabsContent value="transfers" className="space-y-4">
          <div className="bg-[#141414] border border-white/10 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">Date</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">From</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">To</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">Amount</th>
                    <th className="text-left text-xs text-zinc-500 uppercase tracking-wide px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.internal_transfers.paired.map((pair, idx) => (
                    <tr key={idx} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="px-4 py-3 text-sm text-zinc-400">—</td>
                      <td className="px-4 py-3 text-sm text-white">Account A</td>
                      <td className="px-4 py-3 text-sm text-white">Account B</td>
                      <td className="px-4 py-3 text-sm font-mono tabular-nums text-zinc-300">{formatCurrency(pair.amount)}</td>
                      <td className="px-4 py-3">
                        <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs">
                          Auto-Paired
                        </Badge>
                      </td>
                    </tr>
                  ))}
                  {data.internal_transfers.unpaired.map(transfer => (
                    <tr key={transfer.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="px-4 py-3 text-sm text-zinc-400">{formatDate(transfer.date)}</td>
                      <td className="px-4 py-3 text-sm text-white">{transfer.description}</td>
                      <td className="px-4 py-3 text-sm text-white">—</td>
                      <td className="px-4 py-3 text-sm font-mono tabular-nums text-zinc-300">{formatCurrency(transfer.amount)}</td>
                      <td className="px-4 py-3">
                        <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs">
                          Unpaired
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Manual Match Drawer */}
      <Drawer open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
        <DrawerContent className="bg-[#141414] border-t border-white/10">
          <DrawerHeader>
            <DrawerTitle className="text-white">Match Movement</DrawerTitle>
          </DrawerHeader>
          
          {selectedMovement && (
            <div className="p-6 space-y-6">
              {/* Frozen Header */}
              <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-4">
                <p className="text-xs text-zinc-500 uppercase tracking-wide">Selected Movement</p>
                <div className="mt-3 space-y-2">
                  <p className="text-sm text-white">{selectedMovement.description}</p>
                  <p className={`text-lg font-mono tabular-nums ${selectedMovement.direction === "inflow" ? "text-emerald-400" : "text-red-400"}`}>
                    {selectedMovement.direction === "inflow" ? "+" : "-"}{formatCurrency(selectedMovement.amount)}
                  </p>
                </div>
              </div>

              {/* Tabs for AR/AP */}
              <Tabs defaultValue="ar" className="w-full">
                <TabsList className="bg-[#0A0A0A] border border-white/10">
                  <TabsTrigger value="ar">Open Invoices (AR)</TabsTrigger>
                  <TabsTrigger value="ap">Open Bills (AP)</TabsTrigger>
                </TabsList>

                <TabsContent value="ar" className="space-y-3 mt-4">
                  {data.open_ar.map(invoice => (
                    <div
                      key={invoice.invoice_id}
                      className="flex items-center gap-3 p-3 bg-[#0A0A0A] border border-white/10 rounded-lg cursor-pointer hover:border-emerald-500/50"
                      onClick={() => {
                        if (selectedInvoices.find(i => i.invoice_id === invoice.invoice_id)) {
                          setSelectedInvoices(selectedInvoices.filter(i => i.invoice_id !== invoice.invoice_id))
                        } else {
                          setSelectedInvoices([...selectedInvoices, invoice])
                        }
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedInvoices.some(i => i.invoice_id === invoice.invoice_id)}
                        onChange={() => {}}
                        className="w-4 h-4"
                      />
                      <div className="flex-1">
                        <p className="text-sm text-white">{invoice.customer_name}</p>
                        <p className="text-xs text-zinc-400">{formatCurrency(invoice.amount_due)} due</p>
                      </div>
                    </div>
                  ))}
                </TabsContent>

                <TabsContent value="ap" className="space-y-3 mt-4">
                  {data.open_ap.map(bill => (
                    <div
                      key={bill.bill_id}
                      className="flex items-center gap-3 p-3 bg-[#0A0A0A] border border-white/10 rounded-lg cursor-pointer hover:border-amber-500/50"
                      onClick={() => {
                        if (selectedBills.find(b => b.bill_id === bill.bill_id)) {
                          setSelectedBills(selectedBills.filter(b => b.bill_id !== bill.bill_id))
                        } else {
                          setSelectedBills([...selectedBills, bill])
                        }
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedBills.some(b => b.bill_id === bill.bill_id)}
                        onChange={() => {}}
                        className="w-4 h-4"
                      />
                      <div className="flex-1">
                        <p className="text-sm text-white">{bill.vendor_name}</p>
                        <p className="text-xs text-zinc-400">{formatCurrency(bill.amount_due)} due</p>
                      </div>
                    </div>
                  ))}
                </TabsContent>
              </Tabs>

              {/* Action Buttons */}
              <div className="flex gap-3 justify-end">
                <Button variant="ghost" onClick={() => setIsDrawerOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={async () => {
                    for (const invoice of selectedInvoices) {
                      await handleClearMatch(selectedMovement, invoice)
                    }
                    for (const bill of selectedBills) {
                      await handleClearMatch(selectedMovement, undefined, bill)
                    }
                    setIsDrawerOpen(false)
                  }}
                  disabled={selectedInvoices.length === 0 && selectedBills.length === 0}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  Match Selected
                </Button>
              </div>
            </div>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  )
}

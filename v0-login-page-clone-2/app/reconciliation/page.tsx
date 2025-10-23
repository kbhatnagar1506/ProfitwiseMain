"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

type InvoiceRow = { invoice_id: string; type: "ar"; display_name: string; amount: number; amount_due: number; due_date: string | null; status: string }
type BillRow = { bill_id: string; type: "ap"; display_name: string; amount: number; amount_due: number; due_date: string | null; status: string; allocated_total: number; remaining_balance: number; payment_count: number }
type Allocation = { entity_type: string; entity_id: string; gross: number; fee: number; net: number; fee_anomaly?: boolean }
type PaymentRow = {
  movement_id: string
  direction: string
  amount: number
  date: string
  counterparty: string | null
  display_name?: string | null
  allocations: Allocation[]
}

type ARSuggestion = { invoice_id: string; customer_name: string; amount_due: number; confidence: string; reasoning: string; gross_applied: number; fee_amount: number; net_applied: number }
type APSuggestion = { obligation_id: string; vendor_name: string; confidence: string; reasoning: string }

export default function ReconciliationPage() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [bills, setBills] = useState<BillRow[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [filter, setFilter] = useState<"all" | "matched" | "unmatched">("all")
  const [arApOnly, setArApOnly] = useState(true)
  const [loading, setLoading] = useState(true)
  const [linkModal, setLinkModal] = useState<{ payment: PaymentRow; suggestions: ARSuggestion[] | APSuggestion[]; loading: boolean; error: string | null } | null>(null)
  const [unmappedAr, setUnmappedAr] = useState<{ movement_id: string; amount: number; date: string; counterparty: string | null }[]>([])
  const [totalUnmappedAr, setTotalUnmappedAr] = useState(0)

  const refresh = useCallback(() => {
    const params = new URLSearchParams()
    if (!arApOnly) params.set("arApOnly", "false")
    return fetch(`/api/ar-ap-reconciliation${params.toString() ? `?${params}` : ""}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed"))))
      .then((data) => {
        setInvoices(data.invoices ?? [])
        setBills(data.bills ?? [])
        const matched: PaymentRow[] = [
          ...(data.matched_inflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations: Allocation[] }) => ({ ...m, direction: "inflow" })),
          ...(data.matched_outflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations: Allocation[] }) => ({ ...m, direction: "outflow" })),
        ]
        const unmatched: PaymentRow[] = [
          ...(data.unmatched_inflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null }) => ({ ...m, direction: "inflow", allocations: [] })),
          ...(data.unmatched_outflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null }) => ({ ...m, direction: "outflow", allocations: [] })),
        ]
        setPayments([...matched, ...unmatched].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()))
        setUnmappedAr(data.unmapped_ar ?? [])
        setTotalUnmappedAr(data.total_unmapped_ar ?? 0)
      })
      .catch(() => { setInvoices([]); setBills([]); setPayments([]); setUnmappedAr([]); setTotalUnmappedAr(0) })
  }, [arApOnly])

  useEffect(() => {
    setLoading(true)
    refresh().finally(() => setLoading(false))
  }, [refresh])

  const filteredPayments =
    filter === "matched"
      ? payments.filter((r) => r.allocations.length > 0)
      : filter === "unmatched"
        ? payments.filter((r) => r.allocations.length === 0)
        : payments

  const allInvoices = [...invoices, ...bills].sort((a, b) => {
    const da = a.due_date ?? "9999"
    const db = b.due_date ?? "9999"
    return da.localeCompare(db)
  })

  if (loading) {
    return (
      <div className="min-h-screen flex bg-black font-sans items-center justify-center">
        <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-black font-sans text-white p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold">Payment → Invoice Reconciliation</h1>
            <p className="text-sm text-gray-500 mt-0.5">All time · Bank payments matched to AR/AP</p>
          </div>
          <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white">
            Dashboard
          </Link>
        </div>

        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <div className="flex gap-2">
            <button
              onClick={() => setFilter("all")}
              className={`px-3 py-1.5 rounded text-sm ${filter === "all" ? "bg-white/20" : "bg-white/5 hover:bg-white/10"}`}
            >
              All
            </button>
            <button
              onClick={() => setFilter("matched")}
              className={`px-3 py-1.5 rounded text-sm ${filter === "matched" ? "bg-white/20" : "bg-white/5 hover:bg-white/10"}`}
            >
              Matched
            </button>
            <button
              onClick={() => setFilter("unmatched")}
              className={`px-3 py-1.5 rounded text-sm ${filter === "unmatched" ? "bg-white/20" : "bg-white/5 hover:bg-white/10"}`}
            >
              Unmatched
            </button>
          </div>
          <span className="text-gray-500 text-sm">|</span>
          <div className="flex gap-2">
            <button
              onClick={() => setArApOnly(true)}
              className={`px-3 py-1.5 rounded text-sm ${arApOnly ? "bg-white/20" : "bg-white/5 hover:bg-white/10"}`}
            >
              AR/AP only
            </button>
            <button
              onClick={() => setArApOnly(false)}
              className={`px-3 py-1.5 rounded text-sm ${!arApOnly ? "bg-white/20" : "bg-white/5 hover:bg-white/10"}`}
            >
              All payments
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Invoices (AR + AP) */}
          <div className="border border-white/10 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-white/10 bg-white/5">
              <h2 className="text-sm font-semibold text-white">Invoices</h2>
              <p className="text-xs text-gray-500">AR & AP with entity names</p>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/10 hover:bg-transparent bg-white/5 sticky top-0 z-10 backdrop-blur-sm">
                    <TableHead className="text-[10px] uppercase text-gray-500">Entity</TableHead>
                    <TableHead className="text-[10px] uppercase text-gray-500 w-24">Amount</TableHead>
                    <TableHead className="text-[10px] uppercase text-gray-500 w-20">Due</TableHead>
                    <TableHead className="text-[10px] uppercase text-gray-500 w-16">Type</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allInvoices.map((row) => (
                    <TableRow key={row.type === "ar" ? row.invoice_id : row.bill_id} className="border-white/5">
                      <TableCell className="py-2">
                        <span className="text-white font-medium">{row.display_name}</span>
                        </TableCell>
                      <TableCell className="py-2 font-mono text-sm">
                        {row.type === "ar" ? (
                          <span className="text-emerald-400">{money(row.amount_due)}</span>
                        ) : (
                          <span className="text-red-400">
                            {money(row.amount_due)} due · {money(row.allocated_total ?? 0)} paid · {money(row.remaining_balance ?? row.amount_due)} remaining
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="py-2 text-xs text-gray-400">{row.due_date ?? "—"}</TableCell>
                      <TableCell className="py-2">
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            row.type === "ar" ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
                          }`}
                        >
                          {row.type.toUpperCase()}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="px-4 py-2 border-t border-white/10 text-xs text-gray-500">
              {allInvoices.length} invoice{allInvoices.length !== 1 ? "s" : ""} shown
            </div>
            {unmappedAr.length > 0 && (
              <div className="px-4 py-3 border-t border-white/10 bg-amber-500/5">
                <h3 className="text-xs font-semibold text-amber-300">Unmapped AR</h3>
                <p className="text-[10px] text-gray-500 mt-0.5">Merchant deposits not yet decomposed to invoices. Use manual Link when available.</p>
                <p className="text-sm font-mono text-amber-400 mt-1">{money(totalUnmappedAr)} total</p>
                <ul className="mt-2 space-y-1 text-xs text-gray-400">
                  {unmappedAr.slice(0, 5).map((u) => (
                    <li key={u.movement_id}>{u.date} · {money(u.amount)} · {u.counterparty ?? "—"}</li>
                  ))}
                  {unmappedAr.length > 5 && <li className="text-gray-500">+{unmappedAr.length - 5} more</li>}
                </ul>
              </div>
            )}
          </div>

          {/* Right: Bank payments (tagged) */}
          <div className="border border-white/10 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-white/10 bg-white/5">
              <h2 className="text-sm font-semibold text-white">Bank payments</h2>
              <p className="text-xs text-gray-500">Tagged movements</p>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/10 hover:bg-transparent bg-white/5 sticky top-0 z-10 backdrop-blur-sm">
                    <TableHead className="text-[10px] uppercase text-gray-500">Payment</TableHead>
                    <TableHead className="text-[10px] uppercase text-gray-500 w-24">Gross</TableHead>
                    <TableHead className="text-[10px] uppercase text-gray-500 w-20">Fee</TableHead>
                    <TableHead className="text-[10px] uppercase text-gray-500 w-24">Net</TableHead>
                    <TableHead className="text-[10px] uppercase text-gray-500 w-28">Linked</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPayments.map((r) => {
                    const totalFee = r.allocations.reduce((s, a) => s + a.fee, 0)
                    const totalGross = r.allocations.reduce((s, a) => s + a.gross, 0)
                    const totalNet = r.allocations.reduce((s, a) => s + a.net, 0)
                    const linked =
                      r.allocations.length > 0
                        ? r.allocations.map((a) => `${a.entity_type.toUpperCase()}`).join(", ")
                        : null
                    return (
                      <TableRow
                        key={r.movement_id}
                        className={`border-white/5 ${r.allocations.length === 0 ? "bg-amber-500/5" : ""}`}
                      >
                        <TableCell className="py-2.5">
                          <span className={r.direction === "inflow" ? "text-emerald-400" : "text-red-400"}>
                            {r.direction === "inflow" ? "+" : "-"}
                            {money(r.amount)}
                          </span>
                          <span className="text-gray-500 text-xs block">
                            {r.date} · {r.display_name ?? r.counterparty ?? "—"}
                          </span>
                        </TableCell>
                        <TableCell className="py-2.5 font-mono text-sm">
                          {totalGross > 0 ? money(totalGross) : money(r.amount)}
                        </TableCell>
                        <TableCell className="py-2.5 font-mono text-amber-400 text-sm">
                          {totalFee > 0 ? money(totalFee) : "—"}
                        </TableCell>
                        <TableCell className="py-2.5 font-mono text-sm">
                          {totalNet > 0 ? money(totalNet) : money(r.amount)}
                        </TableCell>
                        <TableCell className="py-2.5">
                          {linked ? (
                            <span className="text-xs text-gray-400">{linked}</span>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300" title="Not yet linked to an invoice. Use Link or wait for auto-match.">
                                Unallocated
                              </span>
                              <button
                                type="button"
                                onClick={async () => {
                                  setLinkModal({ payment: r, suggestions: [], loading: true, error: null })
                                  try {
                                    if (r.direction === "inflow") {
                                      const res = await fetch("/api/ar-match", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ movement_id: r.movement_id }),
                                      })
                                      const data = await res.json()
                                      if (!res.ok) throw new Error(data.error ?? "Failed")
                                      setLinkModal((m) => m ? { ...m, suggestions: data.suggestions ?? [], loading: false, error: null } : null)
                                    } else {
                                      const res = await fetch("/api/ap-match", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ movement_id: r.movement_id }),
                                      })
                                      const data = await res.json()
                                      if (!res.ok) throw new Error(data.error ?? "Failed")
                                      setLinkModal((m) => m ? { ...m, suggestions: data.suggestions ?? [], loading: false, error: null } : null)
                                    }
                                  } catch (e) {
                                    setLinkModal((m) => m ? { ...m, loading: false, error: e instanceof Error ? e.message : "Failed" } : null)
                                  }
                                }}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-gray-400"
                              >
                                Link
                              </button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="px-4 py-2 border-t border-white/10 text-xs text-gray-500">
              {filteredPayments.length} payment{filteredPayments.length !== 1 ? "s" : ""} shown
            </div>
          </div>
        </div>

        {linkModal && (
          <div
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
            onClick={() => setLinkModal(null)}
          >
            <div
              className="bg-zinc-900 border border-white/10 rounded-xl p-4 max-w-md w-full shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-sm font-medium text-white mb-2">Link payment to invoice</h3>
              <p className="text-xs text-gray-500 mb-3">
                {linkModal.payment.direction === "inflow" ? "+" : "-"}
                {money(linkModal.payment.amount)} · {linkModal.payment.display_name ?? linkModal.payment.counterparty ?? "—"}
              </p>
              {linkModal.loading && (
                <div className="flex gap-2 py-4 text-gray-400">
                  <div className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Loading suggestions…
                </div>
              )}
              {linkModal.error && (
                <p className="text-red-300 text-sm mb-3">{linkModal.error}</p>
              )}
              {!linkModal.loading && linkModal.suggestions.length === 0 && !linkModal.error && (
                <p className="text-gray-400 text-sm">No suggestions found.</p>
              )}
              {!linkModal.loading && linkModal.suggestions.length > 0 && (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {linkModal.payment.direction === "inflow"
                    ? (linkModal.suggestions as ARSuggestion[]).map((s) => (
                        <button
                          key={s.invoice_id}
                          type="button"
                          onClick={async () => {
                            try {
                              const res = await fetch("/api/ar-match", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ movement_id: linkModal!.payment.movement_id, invoice_id: s.invoice_id }),
                              })
                              if (!res.ok) throw new Error((await res.json()).error ?? "Failed")
                              setLinkModal(null)
                              refresh()
                            } catch (e) {
                              setLinkModal((m) => m ? { ...m, error: e instanceof Error ? e.message : "Failed" } : null)
                            }
                          }}
                          className="w-full text-left px-3 py-2 rounded bg-white/5 hover:bg-white/10 text-sm"
                        >
                          <span className="text-white">{s.customer_name}</span>
                          <span className="text-emerald-400 ml-2">{money(s.amount_due)}</span>
                          <span className="text-[10px] text-gray-500 ml-2">({s.confidence})</span>
                        </button>
                      ))
                    : (linkModal.suggestions as APSuggestion[]).map((s) => (
                        <button
                          key={s.obligation_id}
                          type="button"
                          onClick={async () => {
                            try {
                              const res = await fetch("/api/ap-match", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ movement_id: linkModal!.payment.movement_id, obligation_id: s.obligation_id }),
                              })
                              if (!res.ok) throw new Error((await res.json()).error ?? "Failed")
                              setLinkModal(null)
                              refresh()
                            } catch (e) {
                              setLinkModal((m) => m ? { ...m, error: e instanceof Error ? e.message : "Failed" } : null)
                            }
                          }}
                          className="w-full text-left px-3 py-2 rounded bg-white/5 hover:bg-white/10 text-sm"
                        >
                          <span className="text-white">{s.vendor_name}</span>
                          <span className="text-[10px] text-gray-500 ml-2">({s.confidence})</span>
                        </button>
                      ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setLinkModal(null)}
                className="mt-3 text-sm text-gray-400 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

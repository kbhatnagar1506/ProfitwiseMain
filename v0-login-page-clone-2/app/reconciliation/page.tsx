"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

type InvoiceRow = { invoice_id: string; type: "ar"; display_name: string; amount: number; amount_due: number; due_date: string | null; status: string }
type BillRow = { bill_id: string; type: "ap"; display_name: string; amount: number; amount_due: number; due_date: string | null; status: string }
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

export default function ReconciliationPage() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [bills, setBills] = useState<BillRow[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [filter, setFilter] = useState<"all" | "matched" | "unmatched">("all")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch("/api/ar-ap-reconciliation")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed"))))
      .then((data) => {
        setInvoices(data.invoices ?? [])
        setBills(data.bills ?? [])
        const matched: PaymentRow[] = [
          ...(data.matched_inflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations: Allocation[] }) => ({
            ...m,
            direction: "inflow",
          })),
          ...(data.matched_outflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations: Allocation[] }) => ({
            ...m,
            direction: "outflow",
          })),
        ]
        const unmatched: PaymentRow[] = [
          ...(data.unmatched_inflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null }) => ({
            ...m,
            direction: "inflow",
            allocations: [],
          })),
          ...(data.unmatched_outflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null }) => ({
            ...m,
            direction: "outflow",
            allocations: [],
          })),
        ]
        setPayments(
          [...matched, ...unmatched].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        )
      })
      .catch(() => {
        setInvoices([])
        setBills([])
        setPayments([])
      })
      .finally(() => setLoading(false))
  }, [])

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

        <div className="flex gap-2 mb-4">
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
                          <span className="text-red-400">{money(row.amount_due)}</span>
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
                    <TableHead className="text-[10px] uppercase text-gray-500">Linked</TableHead>
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
                        : "—"
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
                        <TableCell className="py-2.5 text-xs text-gray-400">{linked}</TableCell>
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
      </div>
    </div>
  )
}

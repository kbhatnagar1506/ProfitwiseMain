"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

type Allocation = { entity_type: string; entity_id: string; gross: number; fee: number; net: number; fee_anomaly?: boolean }
type PaymentRow = {
  movement_id: string
  direction: string
  amount: number
  date: string
  counterparty: string | null
  allocations: Allocation[]
  confidence?: number
}

function ExplainButton({ movementId, allocations, onExplain }: { movementId: string; allocations: Allocation[]; onExplain: (text: string) => void }) {
  const [loading, setLoading] = useState(false)
  const handleClick = async () => {
    if (loading || allocations.length === 0) return
    setLoading(true)
    try {
      const alloc = allocations[0]
      const res = await fetch("/api/explain-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          movement_id: movementId,
          entity_type: alloc.entity_type,
          entity_id: alloc.entity_id,
        }),
      })
      const data = await res.json()
      if (data.explanation) onExplain(data.explanation)
    } catch {
      onExplain("Could not load explanation.")
    } finally {
      setLoading(false)
    }
  }
  return (
    <button
      onClick={handleClick}
      disabled={loading || allocations.length === 0}
      className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50 text-gray-400"
    >
      {loading ? "…" : "Explain"}
    </button>
  )
}

export default function ReconciliationPage() {
  const [rows, setRows] = useState<PaymentRow[]>([])
  const [filter, setFilter] = useState<"all" | "matched" | "unmatched">("all")
  const [loading, setLoading] = useState(true)
  const [explainText, setExplainText] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/ar-ap-reconciliation")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed"))))
      .then((data) => {
        const matched: PaymentRow[] = [
          ...(data.matched_inflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; allocations: Allocation[] }) => ({
            ...m,
            direction: "inflow",
            confidence: 0.9,
          })),
          ...(data.matched_outflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; allocations: Allocation[] }) => ({
            ...m,
            direction: "outflow",
            confidence: 0.9,
          })),
        ]
        const unmatched: PaymentRow[] = [
          ...(data.unmatched_inflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null }) => ({
            ...m,
            direction: "inflow",
            allocations: [],
            confidence: 0,
          })),
          ...(data.unmatched_outflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null }) => ({
            ...m,
            direction: "outflow",
            allocations: [],
            confidence: 0,
          })),
        ]
        setRows([...matched, ...unmatched].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()))
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }, [])

  const filtered = filter === "matched" ? rows.filter((r) => r.allocations.length > 0) : filter === "unmatched" ? rows.filter((r) => r.allocations.length === 0) : rows

  if (loading) {
    return (
      <div className="min-h-screen flex bg-black font-sans items-center justify-center">
        <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-black font-sans text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Reconciliation</h1>
          <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white">Dashboard</Link>
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

        <div className="border border-white/10 rounded-xl overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent bg-white/5">
                <TableHead className="text-[10px] uppercase text-gray-500">Payment</TableHead>
                <TableHead className="text-[10px] uppercase text-gray-500 w-24">Gross</TableHead>
                <TableHead className="text-[10px] uppercase text-gray-500 w-20">Fee</TableHead>
                <TableHead className="text-[10px] uppercase text-gray-500 w-24">Net</TableHead>
                <TableHead className="text-[10px] uppercase text-gray-500">Linked AR/AP</TableHead>
                <TableHead className="text-[10px] uppercase text-gray-500 w-20">Confidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => {
                const totalFee = r.allocations.reduce((s, a) => s + a.fee, 0)
                const totalGross = r.allocations.reduce((s, a) => s + a.gross, 0)
                const totalNet = r.allocations.reduce((s, a) => s + a.net, 0)
                const hasFeeAnomaly = r.allocations.some((a) => a.fee_anomaly)
                const linked = r.allocations.length > 0
                  ? r.allocations.map((a) => `${a.entity_type.toUpperCase()}: ${a.entity_id.slice(0, 12)}...`).join(", ")
                  : "—"
                return (
                  <TableRow
                    key={r.movement_id}
                    className={`border-white/5 ${r.allocations.length === 0 ? "bg-amber-500/5" : ""}`}
                  >
                    <TableCell className="py-2.5">
                      <span className={r.direction === "inflow" ? "text-emerald-400" : "text-red-400"}>
                        {r.direction === "inflow" ? "+" : "-"}{money(r.amount)}
                      </span>
                      <span className="text-gray-500 text-xs block">{r.date} · {r.counterparty ?? "—"}</span>
                    </TableCell>
                    <TableCell className="py-2.5 font-mono text-sm">{totalGross > 0 ? money(totalGross) : money(r.amount)}</TableCell>
                    <TableCell className="py-2.5 font-mono text-amber-400 text-sm">
                      {totalFee > 0 ? money(totalFee) : "—"}
                      {hasFeeAnomaly && <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-amber-500/30 text-amber-200" title="Fee >7% of gross">⚠</span>}
                    </TableCell>
                    <TableCell className="py-2.5 font-mono text-sm">{totalNet > 0 ? money(totalNet) : money(r.amount)}</TableCell>
                    <TableCell className="py-2.5 text-xs text-gray-400 truncate max-w-[200px]">{linked}</TableCell>
                    <TableCell className="py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          (r.confidence ?? 0) >= 0.8 ? "bg-emerald-500/20 text-emerald-300" :
                          (r.confidence ?? 0) >= 0.5 ? "bg-amber-500/20 text-amber-300" : "bg-gray-500/20 text-gray-400"
                        }`}>
                          {r.allocations.length > 0 ? "high" : "—"}
                        </span>
                        {r.allocations.length > 0 && (
                          <ExplainButton
                            movementId={r.movement_id}
                            allocations={r.allocations}
                            onExplain={setExplainText}
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>

        {explainText && (
          <div
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
            onClick={() => setExplainText(null)}
          >
            <div
              className="bg-zinc-900 border border-white/10 rounded-xl p-4 max-w-md w-full shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-sm font-medium text-white mb-2">Explain This</h3>
              <p className="text-sm text-gray-300 whitespace-pre-wrap">{explainText}</p>
              <button
                onClick={() => setExplainText(null)}
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

"use client"

import { useEffect, useState } from "react"
import Link from "next/link"

const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

type Movement = { id: string; direction: string; amount: number; date: string; counterparty: string | null; raw_description: string | null }
type Allocation = { movement_id: string; entity_type: string; entity_id: string; gross: number; fee: number; net: number }
type ReconData = {
  matched_inflows: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations: Allocation[] }[]
  matched_outflows: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations: Allocation[] }[]
  unmatched_inflows: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null }[]
  unmatched_outflows: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null }[]
}

export default function PaymentsPage() {
  const [recon, setRecon] = useState<ReconData | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch("/api/ar-ap-reconciliation")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed"))))
      .then(setRecon)
      .catch(() => setRecon(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex bg-black font-sans items-center justify-center">
        <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
      </div>
    )
  }

  const allPayments = [
    ...(recon?.matched_inflows ?? []).map((m) => ({ ...m, direction: "inflow" as const })),
    ...(recon?.matched_outflows ?? []).map((m) => ({ ...m, direction: "outflow" as const })),
    ...(recon?.unmatched_inflows ?? []).map((m) => ({ ...m, direction: "inflow" as const, allocations: [] as Allocation[] })),
    ...(recon?.unmatched_outflows ?? []).map((m) => ({ ...m, direction: "outflow" as const, allocations: [] as Allocation[] })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  const selected = allPayments.find((p) => p.movement_id === selectedId)

  return (
    <div className="min-h-screen bg-black font-sans text-white p-6">
      <div className="max-w-5xl mx-auto flex gap-6">
        <div className="flex-1">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-semibold">Payments</h1>
            <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white">Dashboard</Link>
          </div>
          <div className="space-y-1 max-h-[70vh] overflow-y-auto">
            {allPayments.map((p) => (
              <div
                key={p.movement_id}
                onClick={() => setSelectedId(selectedId === p.movement_id ? null : p.movement_id)}
                className={`p-3 rounded-lg cursor-pointer border ${
                  selectedId === p.movement_id ? "border-white/30 bg-white/10" : "border-white/5 hover:bg-white/5"
                }`}
              >
                <div className="flex justify-between items-center">
                  <span className={p.direction === "inflow" ? "text-emerald-400" : "text-red-400"}>
                    {p.direction === "inflow" ? "+" : "-"}{money(p.amount)}
                  </span>
                  <span className="text-gray-400 text-sm">{p.date}</span>
                </div>
                <div className="text-xs text-gray-500 truncate">{p.counterparty ?? p.raw_description ?? "—"}</div>
                {p.allocations && p.allocations.length > 0 && (
                  <div className="text-[10px] text-amber-400 mt-1">Allocated to {p.allocations.length} item(s)</div>
                )}
              </div>
            ))}
          </div>
        </div>
        {selected && (
          <div className="w-80 shrink-0 bg-white/5 border border-white/10 rounded-xl p-5 sticky top-6">
            <h2 className="text-sm font-semibold mb-3">Payment Detail</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Amount</span>
                <span className={selected.direction === "inflow" ? "text-emerald-400" : "text-red-400"}>
                  {selected.direction === "inflow" ? "+" : "-"}{money(selected.amount)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Date</span>
                <span>{selected.date}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Counterparty</span>
                <span className="truncate max-w-[140px]">{(selected as { display_name?: string | null }).display_name ?? selected.counterparty ?? "—"}</span>
              </div>
            </div>
            {selected.allocations && selected.allocations.length > 0 && (
              <div className="mt-4 pt-4 border-t border-white/10">
                <h3 className="text-xs font-semibold text-gray-400 mb-2">Allocated To</h3>
                {selected.allocations.map((a, i) => (
                  <div key={i} className="text-xs py-1.5">
                    <span className="text-amber-400">{a.entity_type.toUpperCase()}</span>
                    <span className="text-gray-500">{a.entity_id.slice(0, 20)}...</span>
                    <div className="flex gap-2 text-gray-400 mt-0.5">
                      <span>Gross {money(a.gross)}</span>
                      {a.fee > 0 && <span className="text-amber-400">Fee {money(a.fee)}</span>}
                      <span>Net {money(a.net)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

"use client"

import { useEffect, useState } from "react"
import Link from "next/link"

const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
const moneySmall = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

type ARData = { total_outstanding: number; total_overdue: number; overdue_count: number; invoice_count: number }
type APData = { total_expected_30d: number; obligation_count: number }
type ReconData = {
  total_matched_inflows: number
  total_matched_outflows: number
  total_unmatched_inflows: number
  total_unmatched_outflows: number
  total_fees_paid: number
}

export default function DashboardPage() {
  const [arAp, setArAp] = useState<{ ar: ARData; ap: APData } | null>(null)
  const [recon, setRecon] = useState<ReconData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const pollRecon = (): Promise<Record<string, unknown>> =>
      fetch("/api/ar-ap-reconciliation")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Reconciliation failed"))))
        .then((data: Record<string, unknown>) => {
          if (cancelled) return Promise.reject(new Error("Cancelled"))
          if (data.status === "processing") {
            return new Promise<Record<string, unknown>>((resolve, reject) => {
              setTimeout(() => {
                if (cancelled) return reject(new Error("Cancelled"))
                pollRecon().then(resolve).catch(reject)
              }, 2500)
            })
          }
          return data
        })
    pollRecon()
      .then((reconData) => {
        if (cancelled) return
        setRecon(reconData as ReconData)
        return fetch("/api/ar-ap").then((r) => (r.ok ? r.json() : Promise.reject(new Error("AR/AP failed"))))
      })
      .then((arApData) => {
        if (cancelled) return
        setArAp(arApData)
      })
      .catch((e) => {
        if (cancelled || (e instanceof Error && e.message === "Cancelled")) return
        setError(e instanceof Error ? e.message : "Failed to load")
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex bg-black font-sans items-center justify-center">
        <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex bg-black font-sans items-center justify-center">
        <p className="text-red-400">{error}</p>
      </div>
    )
  }

  const ar = arAp?.ar
  const ap = arAp?.ap
  const collectionRate = ar && ar.total_outstanding > 0 && recon
    ? Math.round(((recon.total_matched_inflows / (recon.total_matched_inflows + ar.total_outstanding)) || 0) * 100)
    : null

  return (
    <div className="min-h-screen bg-black font-sans text-white p-6">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">AR/AP Dashboard</h1>
          <Link href="/onboarding" className="text-sm text-gray-400 hover:text-white">
            Onboarding
          </Link>
        </div>

        {/* Tier 1: Executive View */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* AR Section */}
          <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-6">
            <h2 className="text-base font-semibold text-emerald-400 mb-4">AR (Accounts Receivable)</h2>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-400">Total Outstanding</span>
                <span className="font-mono font-semibold text-emerald-400">{ar ? money(ar.total_outstanding) : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Collected This Period</span>
                <span className="font-mono text-white">{recon ? money(recon.total_matched_inflows) : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Overdue</span>
                <span className="font-mono text-red-400">{ar ? `${money(ar.total_overdue)} (${ar.overdue_count})` : "—"}</span>
              </div>
              {collectionRate != null && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Collection Rate</span>
                  <span className="font-mono text-white">{collectionRate}%</span>
                </div>
              )}
            </div>
          </div>

          {/* AP Section */}
          <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-6">
            <h2 className="text-base font-semibold text-red-400 mb-4">AP (Accounts Payable)</h2>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-400">Total Due (30d)</span>
                <span className="font-mono font-semibold text-red-400">{ap ? money(ap.total_expected_30d) : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Paid This Period</span>
                <span className="font-mono text-white">{recon ? money(recon.total_matched_outflows) : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Obligations</span>
                <span className="font-mono text-white">{ap ? ap.obligation_count : "—"}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Payments Section */}
        <div className="bg-white/5 border border-white/10 rounded-xl p-6">
          <h2 className="text-base font-semibold text-white mb-4">Payments</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-2xl font-bold font-mono text-emerald-400">{recon ? money(recon.total_matched_inflows + recon.total_unmatched_inflows) : "—"}</div>
              <div className="text-[10px] text-gray-500">Total Inflows</div>
            </div>
            <div>
              <div className="text-2xl font-bold font-mono text-red-400">{recon ? money(recon.total_matched_outflows + recon.total_unmatched_outflows) : "—"}</div>
              <div className="text-[10px] text-gray-500">Total Outflows</div>
            </div>
            <div>
              <div className="text-2xl font-bold font-mono text-amber-400">{recon ? money(recon.total_fees_paid) : "—"}</div>
              <div className="text-[10px] text-gray-500">Fees Paid</div>
            </div>
            <div>
              <div className="text-2xl font-bold font-mono text-white">
                {recon ? money((recon.total_matched_inflows + recon.total_unmatched_inflows) - (recon.total_matched_outflows + recon.total_unmatched_outflows)) : "—"}
              </div>
              <div className="text-[10px] text-gray-500">Net Cash Movement</div>
            </div>
          </div>
        </div>

        <div className="flex gap-4">
          <Link
            href="/payments"
            className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 hover:bg-emerald-500/15 transition text-sm font-medium text-white"
          >
            Open AR/AP dashboard
          </Link>
        </div>
      </div>
    </div>
  )
}

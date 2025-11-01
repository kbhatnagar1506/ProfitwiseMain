"use client"

import { useEffect, useState, useCallback, useRef, useMemo } from "react"
import Link from "next/link"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { MovementDetailResponse } from "@/lib/movement-detail-types"

/** Unsigned currency — tabular alignment */
const money = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const moneyClass = "tabular-nums"

/** ISO date → localized short date */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/** Relative due: "3d overdue" / "in 5d" / "—" */
function dueLabel(dueIso: string | null): { line: string; tone: "danger" | "ok" | "muted" } {
  if (!dueIso) return { line: "—", tone: "muted" }
  const due = new Date(dueIso)
  if (Number.isNaN(due.getTime())) return { line: "—", tone: "muted" }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  due.setHours(0, 0, 0, 0)
  const diffDays = Math.round((due.getTime() - today.getTime()) / (86400 * 1000))
  if (diffDays < 0) return { line: `${Math.abs(diffDays)}d overdue`, tone: "danger" }
  if (diffDays === 0) return { line: "today", tone: "ok" }
  return { line: `in ${diffDays}d`, tone: "ok" }
}

/** Normalize bookkeeping status for display */
function normalizeStatus(raw: string | null | undefined, dueIso: string | null): string {
  const s = (raw ?? "").trim().toLowerCase()
  if (s.includes("paid") || s === "closed") return "Paid"
  if (s === "overdue") return "Overdue"
  const due = dueLabel(dueIso)
  if (due.tone === "danger") return "Overdue"
  if (s.includes("open") || s === "") return "Open"
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : "—"
}

/** Human label for allocation entity_type */
function entityRoleLabel(t: string): string {
  const x = t.toLowerCase()
  if (x === "ar") return "Receivable"
  if (x === "ap") return "Payable"
  if (x === "fee") return "Fee"
  return t.toUpperCase()
}

/** Shorten entity_uri for display while keeping meaning */
function shortenEntityId(uri: string, max = 36): string {
  if (uri.length <= max) return uri
  const start = uri.slice(0, 18)
  const end = uri.slice(-10)
  return `${start}…${end}`
}

type InvoiceRow = { invoice_id: string; type: "ar"; display_name: string; amount: number; amount_due: number; due_date: string | null; status: string }
type BillRow = { bill_id: string; type: "ap"; entity_uri?: string; display_name: string; amount: number; amount_due: number; due_date: string | null; status: string; allocated_total: number; remaining_balance: number; payment_count: number }
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

type MovementDetailModalState = {
  movementId: string
  loading: boolean
  error: string | null
  detail: MovementDetailResponse | null
}

type ARSuggestion = { invoice_id: string; customer_name: string; amount_due: number; confidence: string; reasoning: string; gross_applied: number; fee_amount: number; net_applied: number }
type APSuggestion = { obligation_id: string; vendor_name: string; confidence: string; reasoning: string }
type LLMARMatch = { movement_id: string; invoice_id: string; confidence: string; reasoning: string }
type LLMAPMatch = { movement_id: string; obligation_id: string; confidence: string; reasoning: string }
type RunARSuggestion = { movement_id: string; invoice_id: string; customer_name: string; confidence: number; gross_applied: number; fee_amount: number; net_applied: number }
type RunAPSuggestion = { movement_id: string; obligation_id: string; vendor_name: string; confidence: number; gross_applied: number; fee_amount: number; net_applied: number }

export type ArApReconciliationViewProps = {
  /** Main heading */
  pageTitle?: string
  /** Subtitle under the heading */
  pageSubtitle?: string
  backHref?: string
  backLabel?: string
}

export function ArApReconciliationView({
  pageTitle = "AR/AP dashboard",
  pageSubtitle = "Ledger snapshot, cash explanation, receivables, payables, and bank links — all on one screen.",
  backHref = "/dashboard",
  backLabel = "Dashboard",
}: ArApReconciliationViewProps) {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [bills, setBills] = useState<BillRow[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [filter, setFilter] = useState<"all" | "matched" | "unmatched">("all")
  const [arApOnly, setArApOnly] = useState(true)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [linkModal, setLinkModal] = useState<{ payment: PaymentRow; suggestions: ARSuggestion[] | APSuggestion[]; loading: boolean; error: string | null } | null>(null)
  const [unmappedAr, setUnmappedAr] = useState<{ movement_id: string; amount: number; date: string; counterparty: string | null }[]>([])
  const [totalUnmappedAr, setTotalUnmappedAr] = useState(0)
  const [cashExplanation, setCashExplanation] = useState<{
    fully_explained: number
    partially_explained: number
    unexplained: number
    explanation_pct: number
    ar_explained?: number
    ap_explained?: number
    fee_explained?: number
  } | null>(null)
  const [llmMatching, setLlmMatching] = useState(false)
  const [llmResults, setLlmResults] = useState<{ ar: LLMARMatch[]; ap: LLMAPMatch[] } | null>(null)
  const [runSuggestions, setRunSuggestions] = useState<{ ar: RunARSuggestion[]; ap: RunAPSuggestion[] }>({ ar: [], ap: [] })
  const [movementDetail, setMovementDetail] = useState<MovementDetailModalState | null>(null)
  const [recatIntent, setRecatIntent] = useState("")
  const [recatLoading, setRecatLoading] = useState(false)
  const [unmergeLoading, setUnmergeLoading] = useState(false)
  const [policyLoading, setPolicyLoading] = useState(false)
  const llmRunRef = useRef(false)

  const applyData = useCallback((data: Record<string, unknown>) => {
    setInvoices((data.invoices as InvoiceRow[]) ?? [])
    setBills((data.bills as BillRow[]) ?? [])
    const matchedInflows = ((data.matched_inflows as Array<{ movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations: Allocation[] }>) ?? [])
    const matchedOutflows = ((data.matched_outflows as Array<{ movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations: Allocation[] }>) ?? [])
    const unmatchedInflows = ((data.unmatched_inflows as Array<{ movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null }>) ?? [])
    const unmatchedOutflows = ((data.unmatched_outflows as Array<{ movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null }>) ?? [])
    const matched: PaymentRow[] = [
      ...matchedInflows.map((m) => ({ ...m, direction: "inflow" })),
      ...matchedOutflows.map((m) => ({ ...m, direction: "outflow" })),
    ]
    const unmatched: PaymentRow[] = [
      ...unmatchedInflows.map((m) => ({ ...m, direction: "inflow", allocations: [] })),
      ...unmatchedOutflows.map((m) => ({ ...m, direction: "outflow", allocations: [] })),
    ]
    setPayments([...matched, ...unmatched].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()))
    setUnmappedAr((data.unmapped_ar as { movement_id: string; amount: number; date: string; counterparty: string | null }[]) ?? [])
    setTotalUnmappedAr((data.total_unmapped_ar as number) ?? 0)
    setCashExplanation((data.cash_explanation as { fully_explained: number; partially_explained: number; unexplained: number; explanation_pct: number; ar_explained?: number; ap_explained?: number; fee_explained?: number }) ?? null)
    setRunSuggestions({
      ar: (data.ar_suggestions as RunARSuggestion[]) ?? [],
      ap: (data.ap_suggestions as RunAPSuggestion[]) ?? [],
    })
  }, [])

  const fetchReconciliation = useCallback(() => {
    const params = new URLSearchParams()
    if (!arApOnly) params.set("arApOnly", "false")
    return fetch(`/api/ar-ap-reconciliation${params.toString() ? `?${params}` : ""}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed"))))
  }, [arApOnly])

  const refresh = useCallback(() => {
    return fetchReconciliation()
      .then((data) => {
        if (data?.status === "processing") {
          return new Promise<Record<string, unknown>>((resolve, reject) => {
            const poll = () => {
              fetchReconciliation()
                .then((d) => {
                  if (d?.status === "processing") {
                    setTimeout(poll, 2000)
                    return
                  }
                  applyData(d ?? {})
                  resolve(d ?? {})
                })
                .catch(reject)
            }
            setTimeout(poll, 2000)
          })
        }
        applyData(data ?? {})
        return data
      })
      .catch(() => {
        setInvoices([])
        setBills([])
        setPayments([])
        setUnmappedAr([])
        setTotalUnmappedAr(0)
        throw new Error("Failed")
      })
  }, [fetchReconciliation, applyData])

  const openMovementDetail = useCallback(async (movementId: string) => {
    setMovementDetail({ movementId, loading: true, error: null, detail: null })
    setRecatIntent("")
    try {
      const res = await fetch(`/api/movements/${movementId}/detail`)
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? "Failed to load movement detail")
      setMovementDetail({ movementId, loading: false, error: null, detail: data as MovementDetailResponse })
    } catch (e) {
      setMovementDetail({
        movementId,
        loading: false,
        error: e instanceof Error ? e.message : "Failed to load movement detail",
        detail: null,
      })
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    refresh().finally(() => setLoading(false))
  }, [refresh])

  useEffect(() => {
    if (loading || llmRunRef.current) return
    const unmatched = payments.filter((r) => r.allocations.length === 0)
    if (unmatched.length === 0) return
    llmRunRef.current = true
    setLlmMatching(true)
    fetch("/api/ar-ap-reconciliation/llm-match", { method: "POST" })
      .then((r) => r.json())
      .then((data) => {
        setLlmResults({ ar: data.ar ?? [], ap: data.ap ?? [] })
      })
      .catch(() => setLlmResults({ ar: [], ap: [] }))
      .finally(() => setLlmMatching(false))
  }, [loading, payments])

  const filteredPayments =
    filter === "matched"
      ? payments.filter((r) => r.allocations.length > 0)
      : filter === "unmatched"
        ? payments.filter((r) => r.allocations.length === 0)
        : payments

  const arRows = useMemo(
    () => [...invoices].sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999")),
    [invoices]
  )
  const apRows = useMemo(
    () => [...bills].sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999")),
    [bills]
  )
  const ledgerForLookup = useMemo(() => [...invoices, ...bills] as (InvoiceRow | BillRow)[], [invoices, bills])

  const ledgerStats = useMemo(() => {
    const totalArOutstanding = invoices.reduce((s, i) => s + (Number(i.amount_due) || 0), 0)
    const totalApRemaining = bills.reduce((s, b) => s + (Number(b.remaining_balance ?? b.amount_due) || 0), 0)
    const totalApAllocated = bills.reduce((s, b) => s + (Number(b.allocated_total) || 0), 0)
    const matched = payments.filter((p) => p.allocations.length > 0).length
    const unmatched = payments.length - matched
    const netExpected = totalArOutstanding - totalApRemaining
    return {
      totalArOutstanding,
      totalApRemaining,
      totalApAllocated,
      matched,
      unmatched,
      paymentsCount: payments.length,
      arCount: invoices.length,
      apCount: bills.length,
      netExpected,
    }
  }, [invoices, bills, payments])

  if (loading) {
    return (
      <div className="min-h-screen flex bg-black font-sans items-center justify-center flex-col gap-4">
        <div className="h-8 w-8 rounded-full border-2 border-white/30 border-t-white animate-spin" />
        <p className="text-sm text-gray-400">Loading reconciliation…</p>
        <p className="text-xs text-gray-500">This may take a moment</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-black font-sans text-white p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold">{pageTitle}</h1>
            <p className="text-sm text-gray-500 mt-0.5 max-w-2xl">{pageSubtitle}</p>
          </div>
          <Link
            href={backHref}
            className="text-sm text-gray-400 hover:text-white shrink-0 rounded-lg border border-white/15 px-4 py-2 hover:bg-white/5 transition-colors"
          >
            ← {backLabel}
          </Link>
        </div>

        {/* Normalized ledger snapshot — same basis as onboarding AR/AP step */}
        <div className="mb-6 rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.06] to-transparent p-4 md:p-5">
          <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-3">Normalized snapshot</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 md:gap-4">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
              <p className="text-[10px] text-emerald-400/80 uppercase tracking-wide">AR outstanding</p>
              <p className={`text-lg font-semibold text-emerald-300 mt-0.5 ${moneyClass}`}>{money(ledgerStats.totalArOutstanding)}</p>
              <p className="text-[10px] text-gray-500 mt-1">{ledgerStats.arCount} open invoice{ledgerStats.arCount !== 1 ? "s" : ""}</p>
            </div>
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2.5">
              <p className="text-[10px] text-red-400/80 uppercase tracking-wide">AP remaining</p>
              <p className={`text-lg font-semibold text-red-300 mt-0.5 ${moneyClass}`}>{money(ledgerStats.totalApRemaining)}</p>
              <p className="text-[10px] text-gray-500 mt-1">{ledgerStats.apCount} bill{ledgerStats.apCount !== 1 ? "s" : ""}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
              <p className="text-[10px] text-gray-500 uppercase tracking-wide">Net (AR − AP rem.)</p>
              <p className={`text-lg font-semibold mt-0.5 ${ledgerStats.netExpected >= 0 ? "text-sky-300" : "text-amber-300"} ${moneyClass}`}>
                {ledgerStats.netExpected >= 0 ? "" : "−"}
                {money(Math.abs(ledgerStats.netExpected))}
              </p>
              <p className="text-[10px] text-gray-500 mt-1">Normalized expectation</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
              <p className="text-[10px] text-gray-500 uppercase tracking-wide">Bank movements</p>
              <p className={`text-lg font-semibold text-white mt-0.5 ${moneyClass}`}>{ledgerStats.paymentsCount}</p>
              <p className="text-[10px] text-gray-500 mt-1">
                <span className="text-emerald-400/90">{ledgerStats.matched} linked</span>
                {" · "}
                <span className="text-amber-400/90">{ledgerStats.unmatched} open</span>
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 col-span-2 lg:col-span-2">
              <p className="text-[10px] text-gray-500 uppercase tracking-wide">AP paid (allocated)</p>
              <p className={`text-lg font-semibold text-rose-200/90 mt-0.5 ${moneyClass}`}>{money(ledgerStats.totalApAllocated)}</p>
              <p className="text-[10px] text-gray-500 mt-1">Sum of payments applied to bills in view</p>
            </div>
          </div>
        </div>

        {cashExplanation && (
          <div className="mb-6 space-y-4">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">Cash explanation (bank-tied)</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-4">
                <p className="text-[10px] text-gray-400 uppercase tracking-wide">Fully explained</p>
                <p className={`text-xl font-semibold text-emerald-400 mt-1 ${moneyClass}`}>{money(cashExplanation.fully_explained)}</p>
              </div>
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-4">
                <p className="text-[10px] text-gray-400 uppercase tracking-wide">Partially explained</p>
                <p className={`text-xl font-semibold text-amber-400 mt-1 ${moneyClass}`}>{money(cashExplanation.partially_explained)}</p>
              </div>
              <div className="rounded-xl border border-red-500/25 bg-red-500/[0.07] p-4">
                <p className="text-[10px] text-gray-400 uppercase tracking-wide">Unexplained</p>
                <p className={`text-xl font-semibold text-red-400 mt-1 ${moneyClass}`}>{money(cashExplanation.unexplained)}</p>
              </div>
              <div className="rounded-xl border border-white/15 bg-white/[0.04] p-4">
                <p className="text-[10px] text-gray-400 uppercase tracking-wide">Explanation %</p>
                <p className={`text-xl font-semibold text-white mt-1 ${moneyClass}`}>{cashExplanation.explanation_pct}%</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm border-t border-white/10 pt-4">
              <span className="text-gray-500">
                AR reconciled (cash): <span className={`text-emerald-400 font-medium ${moneyClass}`}>{money(cashExplanation.ar_explained ?? 0)}</span>
              </span>
              <span className="text-gray-500">
                AP reconciled (cash): <span className={`text-red-400 font-medium ${moneyClass}`}>{money(cashExplanation.ap_explained ?? 0)}</span>
              </span>
              {(cashExplanation.fee_explained ?? 0) > 0 && (
                <span className="text-gray-500">
                  Fees: <span className={`text-amber-400 font-medium ${moneyClass}`}>{money(cashExplanation.fee_explained ?? 0)}</span>
                </span>
              )}
            </div>
          </div>
        )}

        {(runSuggestions.ar.length > 0 || runSuggestions.ap.length > 0) && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 mb-6">
            <h3 className="text-sm font-medium text-amber-300 mb-2">Suggested matches (65–85% confidence)</h3>
            <p className="text-xs text-gray-500 mb-3">Review and apply each match</p>
            <div className="flex flex-wrap gap-3">
              {runSuggestions.ar.map((s) => {
                const pay = payments.find((p) => p.movement_id === s.movement_id)
                return (
                  <div key={`ar-${s.movement_id}-${s.invoice_id}`} className="flex items-center gap-2 p-2 rounded bg-white/5 border border-white/5">
                    <span className="text-emerald-400 text-sm">{pay ? money(pay.amount) : s.movement_id.slice(0, 8)}</span>
                    <span className="text-gray-500 text-xs">→ {s.customer_name}</span>
                    <span className="text-[10px] text-gray-500">({(s.confidence * 100).toFixed(0)}%)</span>
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch("/api/ar-match", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ movement_id: s.movement_id, invoice_id: s.invoice_id }),
                          })
                          if (!res.ok) throw new Error((await res.json()).error ?? "Failed")
                          setRunSuggestions((r) => ({ ...r, ar: r.ar.filter((x) => x.movement_id !== s.movement_id || x.invoice_id !== s.invoice_id) }))
                          refresh()
                        } catch (e) {
                          console.error(e)
                        }
                      }}
                      className="text-[10px] px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500"
                    >
                      Apply
                    </button>
                  </div>
                )
              })}
              {runSuggestions.ap.map((s) => {
                const pay = payments.find((p) => p.movement_id === s.movement_id)
                return (
                  <div key={`ap-${s.movement_id}-${s.obligation_id}`} className="flex items-center gap-2 p-2 rounded bg-white/5 border border-white/5">
                    <span className="text-red-400 text-sm">{pay ? money(pay.amount) : s.movement_id.slice(0, 8)}</span>
                    <span className="text-gray-500 text-xs">→ {s.vendor_name}</span>
                    <span className="text-[10px] text-gray-500">({(s.confidence * 100).toFixed(0)}%)</span>
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch("/api/ap-match", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ movement_id: s.movement_id, obligation_id: s.obligation_id }),
                          })
                          if (!res.ok) throw new Error((await res.json()).error ?? "Failed")
                          setRunSuggestions((r) => ({ ...r, ap: r.ap.filter((x) => x.movement_id !== s.movement_id || x.obligation_id !== s.obligation_id) }))
                          refresh()
                        } catch (e) {
                          console.error(e)
                        }
                      }}
                      className="text-[10px] px-2 py-1 rounded bg-red-600 hover:bg-red-500"
                    >
                      Apply
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between mb-5">
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 mr-1">Bank filter</span>
            <div className="inline-flex rounded-lg border border-white/10 p-0.5 bg-black/40">
              {(["all", "matched", "unmatched"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 rounded-md text-sm capitalize transition-colors ${
                    filter === f ? "bg-white/15 text-white shadow-sm" : "text-gray-400 hover:text-white hover:bg-white/5"
                  }`}
                >
                  {f === "all" ? "All" : f === "matched" ? "Linked" : "Unallocated"}
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-lg border border-white/10 p-0.5 bg-black/40">
              <button
                type="button"
                onClick={() => setArApOnly(true)}
                className={`px-3 py-1.5 rounded-md text-sm transition-colors ${arApOnly ? "bg-white/15 text-white" : "text-gray-400 hover:text-white"}`}
              >
                AR/AP operating
              </button>
              <button
                type="button"
                onClick={() => setArApOnly(false)}
                className={`px-3 py-1.5 rounded-md text-sm transition-colors ${!arApOnly ? "bg-white/15 text-white" : "text-gray-400 hover:text-white"}`}
              >
                All bank lines
              </button>
            </div>
          </div>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true)
              refresh().finally(() => setRefreshing(false))
            }}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 disabled:opacity-50 disabled:pointer-events-none"
          >
            {refreshing ? (
              <>
                <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                Refreshing…
              </>
            ) : (
              "Refresh data"
            )}
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
          {/* Left: AR + AP ledger (normalized columns) */}
          <div className="space-y-5">
            <section className="rounded-2xl border border-emerald-500/20 overflow-hidden bg-zinc-950/80">
              <div className="px-4 py-3 border-b border-emerald-500/15 bg-emerald-500/[0.07]">
                <h2 className="text-sm font-semibold text-emerald-100">Accounts receivable (AR)</h2>
                <p className="text-[11px] text-emerald-400/70 mt-0.5">Customer · amount due · due date · status · receivable</p>
              </div>
              <div className="max-h-[min(42vh,420px)] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/10 hover:bg-transparent bg-white/[0.04] sticky top-0 z-10">
                      <TableHead className="text-[10px] uppercase text-gray-500 font-medium">Customer</TableHead>
                      <TableHead className="text-[10px] uppercase text-gray-500 w-28 text-right">Due</TableHead>
                      <TableHead className="text-[10px] uppercase text-gray-500 w-28 text-right">Amount</TableHead>
                      <TableHead className="text-[10px] uppercase text-gray-500 w-24">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {arRows.length === 0 && (
                      <TableRow className="border-white/[0.06]">
                        <TableCell colSpan={4} className="py-8 text-center text-sm text-gray-500">
                          No open receivables in this view.
                        </TableCell>
                      </TableRow>
                    )}
                    {arRows.map((row, idx) => {
                      const due = dueLabel(row.due_date)
                      const status = normalizeStatus(row.status, row.due_date)
                      return (
                        <TableRow
                          key={`${row.invoice_id}-${idx}`}
                          className={`border-white/[0.06] ${idx % 2 === 1 ? "bg-white/[0.02]" : ""}`}
                        >
                          <TableCell className="py-2.5 align-top max-w-[200px]">
                            <span className="text-white font-medium leading-snug">{row.display_name}</span>
                            <span className="block text-[10px] text-gray-500 font-mono mt-0.5 truncate" title={row.invoice_id}>
                              {row.invoice_id}
                            </span>
                          </TableCell>
                          <TableCell className={`py-2.5 align-top text-right text-xs ${moneyClass}`}>
                            <span className="text-gray-300 block">{formatDate(row.due_date)}</span>
                            <span
                              className={
                                due.tone === "danger" ? "text-red-400/90" : due.tone === "ok" ? "text-emerald-400/80" : "text-gray-500"
                              }
                            >
                              {due.line}
                            </span>
                          </TableCell>
                          <TableCell className={`py-2.5 align-top text-right text-emerald-400 ${moneyClass}`}>{money(row.amount_due)}</TableCell>
                          <TableCell className="py-2.5 align-top">
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded-md font-medium ${
                                status === "Overdue"
                                  ? "bg-red-500/20 text-red-300"
                                  : status === "Paid"
                                    ? "bg-emerald-500/20 text-emerald-200"
                                    : "bg-white/10 text-gray-300"
                              }`}
                            >
                              {status}
                            </span>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="px-4 py-2 border-t border-white/10 text-[11px] text-gray-500 flex justify-between">
                <span>{arRows.length} receivable{arRows.length !== 1 ? "s" : ""}</span>
                <span className={moneyClass}>Σ {money(ledgerStats.totalArOutstanding)}</span>
              </div>
            </section>

            <section className="rounded-2xl border border-red-500/20 overflow-hidden bg-zinc-950/80">
              <div className="px-4 py-3 border-b border-red-500/15 bg-red-500/[0.07]">
                <h2 className="text-sm font-semibold text-red-100">Accounts payable (AP)</h2>
                <p className="text-[11px] text-red-400/70 mt-0.5">Vendor · due · remaining · allocated · payable</p>
              </div>
              <div className="max-h-[min(42vh,420px)] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/10 hover:bg-transparent bg-white/[0.04] sticky top-0 z-10">
                      <TableHead className="text-[10px] uppercase text-gray-500 font-medium">Vendor</TableHead>
                      <TableHead className="text-[10px] uppercase text-gray-500 w-24 text-right">Due</TableHead>
                      <TableHead className="text-[10px] uppercase text-gray-500 w-24 text-right">Remaining</TableHead>
                      <TableHead className="text-[10px] uppercase text-gray-500 w-24 text-right">Paid</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {apRows.length === 0 && (
                      <TableRow className="border-white/[0.06]">
                        <TableCell colSpan={4} className="py-8 text-center text-sm text-gray-500">
                          No payables in this view.
                        </TableCell>
                      </TableRow>
                    )}
                    {apRows.map((row, idx) => {
                      const b = row as BillRow
                      const rem = Number(b.remaining_balance ?? b.amount_due) || 0
                      const alloc = Number(b.allocated_total) || 0
                      return (
                        <TableRow
                          key={`${b.bill_id}-${idx}`}
                          className={`border-white/[0.06] ${idx % 2 === 1 ? "bg-white/[0.02]" : ""}`}
                        >
                          <TableCell className="py-2.5 align-top max-w-[200px]">
                            <span className="text-white font-medium leading-snug">{b.display_name}</span>
                            <span className="block text-[10px] text-gray-500 font-mono mt-0.5 truncate" title={b.entity_uri ?? b.bill_id}>
                              {b.entity_uri ?? b.bill_id}
                            </span>
                          </TableCell>
                          <TableCell className={`py-2.5 align-top text-right text-xs text-gray-300 ${moneyClass}`}>{formatDate(b.due_date)}</TableCell>
                          <TableCell className={`py-2.5 align-top text-right text-red-300 ${moneyClass}`}>{money(rem)}</TableCell>
                          <TableCell className={`py-2.5 align-top text-right text-rose-200/80 ${moneyClass}`}>{money(alloc)}</TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="px-4 py-2 border-t border-white/10 text-[11px] text-gray-500 flex justify-between">
                <span>{apRows.length} obligation{apRows.length !== 1 ? "s" : ""}</span>
                <span className={moneyClass}>
                  Σ remaining {money(ledgerStats.totalApRemaining)} · paid {money(ledgerStats.totalApAllocated)}
                </span>
              </div>
            </section>

            {unmappedAr.length > 0 && (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3">
                <h3 className="text-xs font-semibold text-amber-200">Unmapped merchant AR</h3>
                <p className="text-[10px] text-gray-500 mt-0.5">Deposits not yet split to invoices — use Link on bank rows.</p>
                <p className={`text-sm text-amber-300 mt-1 ${moneyClass}`}>{money(totalUnmappedAr)} total</p>
                <ul className="mt-2 space-y-1.5 text-xs text-gray-400">
                  {unmappedAr.slice(0, 6).map((u) => (
                    <li key={u.movement_id} className="flex flex-wrap gap-x-2 gap-y-0.5">
                      <span className="text-gray-500">{formatDate(u.date)}</span>
                      <span className={`text-white ${moneyClass}`}>{money(u.amount)}</span>
                      <span className="truncate max-w-[200px]">{u.counterparty ?? "—"}</span>
                    </li>
                  ))}
                  {unmappedAr.length > 6 && <li className="text-gray-500">+{unmappedAr.length - 6} more</li>}
                </ul>
              </div>
            )}
          </div>

          {/* Right: Bank movements — every line: gross − fee = net, normalized links */}
          <div className="rounded-2xl border border-white/10 overflow-hidden bg-zinc-950/80 xl:sticky xl:top-6">
            <div className="px-4 py-3 border-b border-white/10 bg-white/[0.06]">
              <h2 className="text-sm font-semibold text-white">Tagged bank transactions</h2>
              <p className="text-[11px] text-gray-500 mt-0.5">
                Bank amount · allocation gross / fee / net · normalized links to receivable / payable / fee
              </p>
            </div>
            <div className="max-h-[min(88vh,900px)] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/10 hover:bg-transparent bg-white/[0.04] sticky top-0 z-10">
                    <TableHead className="text-[10px] uppercase text-gray-500">Bank movement</TableHead>
                    <TableHead className="text-[10px] uppercase text-gray-500 w-[4.5rem] text-right">Gross</TableHead>
                    <TableHead className="text-[10px] uppercase text-gray-500 w-[4rem] text-right">Fee</TableHead>
                    <TableHead className="text-[10px] uppercase text-gray-500 w-[4.5rem] text-right">Net</TableHead>
                    <TableHead className="text-[10px] uppercase text-gray-500 min-w-[140px]">Links</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPayments.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-12 text-center text-sm text-gray-500">
                        No bank movements match this filter.
                      </TableCell>
                    </TableRow>
                  )}
                  {filteredPayments.map((r, idx) => {
                    const totalFee = r.allocations.reduce((s, a) => s + a.fee, 0)
                    const totalGross = r.allocations.reduce((s, a) => s + a.gross, 0)
                    const totalNet = r.allocations.reduce((s, a) => s + a.net, 0)
                    const gross = totalGross > 0 ? totalGross : Math.abs(r.amount)
                    const net = totalNet !== 0 ? totalNet : r.amount
                    return (
                      <TableRow
                        key={r.movement_id}
                        className={`border-white/[0.06] ${idx % 2 === 1 ? "bg-white/[0.02]" : ""} ${r.allocations.length === 0 ? "bg-amber-500/[0.07]" : ""}`}
                      >
                        <TableCell className="py-3 align-top min-w-[180px]">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                                r.direction === "inflow" ? "bg-emerald-500/25 text-emerald-300" : "bg-red-500/25 text-red-300"
                              }`}
                            >
                              {r.direction === "inflow" ? "IN" : "OUT"}
                            </span>
                            <span className={`text-sm font-semibold ${r.direction === "inflow" ? "text-emerald-400" : "text-red-400"} ${moneyClass}`}>
                              {r.direction === "inflow" ? "+" : "−"}
                              {money(r.amount)}
                            </span>
                          </div>
                          <p className="text-xs text-gray-400 mt-1">{formatDate(r.date)}</p>
                          <p className="text-xs text-gray-300 mt-0.5 leading-snug">{r.display_name ?? r.counterparty ?? "—"}</p>
                          <p className="text-[10px] text-gray-500 font-mono mt-1 truncate" title={r.movement_id}>
                            {r.movement_id}
                          </p>
                          <button
                            type="button"
                            onClick={() => openMovementDetail(r.movement_id)}
                            className="mt-1 text-[10px] px-2 py-0.5 rounded-md bg-sky-500/15 text-sky-300 hover:bg-sky-500/25"
                          >
                            View details
                          </button>
                        </TableCell>
                        <TableCell className={`py-3 align-top text-right text-sm text-gray-200 ${moneyClass}`}>{money(gross)}</TableCell>
                        <TableCell className={`py-3 align-top text-right text-sm ${totalFee > 0 ? "text-amber-400" : "text-gray-600"} ${moneyClass}`}>
                          {totalFee > 0 ? money(totalFee) : "—"}
                        </TableCell>
                        <TableCell className={`py-3 align-top text-right text-sm text-gray-100 ${moneyClass}`}>{money(Math.abs(net))}</TableCell>
                        <TableCell className="py-3 align-top">
                          {r.allocations.length > 0 ? (
                            <ul className="space-y-1.5">
                              {r.allocations.map((a) => (
                                <li
                                  key={`${r.movement_id}-${a.entity_id}-${a.net}`}
                                  className="text-[11px] text-gray-300 leading-snug rounded-md border border-white/5 bg-white/[0.03] px-2 py-1"
                                  title={`${a.entity_type}:${a.entity_id}`}
                                >
                                  <span
                                    className={
                                      a.entity_type.toLowerCase() === "ar"
                                        ? "text-emerald-400/90"
                                        : a.entity_type.toLowerCase() === "ap"
                                          ? "text-red-400/90"
                                          : "text-amber-400/90"
                                    }
                                  >
                                    {entityRoleLabel(a.entity_type)}
                                  </span>
                                  <span className="text-gray-500"> · </span>
                                  <span className={`text-gray-200 ${moneyClass}`}>G {money(a.gross)}</span>
                                  <span className="text-gray-600"> · </span>
                                  <span className="text-amber-400/80">F {money(a.fee)}</span>
                                  <span className="text-gray-600"> · </span>
                                  <span className={`text-white ${moneyClass}`}>N {money(a.net)}</span>
                                  <span className="block text-[10px] text-gray-500 font-mono mt-0.5 break-all">{shortenEntityId(a.entity_id, 40)}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[10px] px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-200">Unallocated</span>
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
                                      setLinkModal((m) => (m ? { ...m, suggestions: data.suggestions ?? [], loading: false, error: null } : null))
                                    } else {
                                      const res = await fetch("/api/ap-match", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ movement_id: r.movement_id }),
                                      })
                                      const data = await res.json()
                                      if (!res.ok) throw new Error(data.error ?? "Failed")
                                      setLinkModal((m) => (m ? { ...m, suggestions: data.suggestions ?? [], loading: false, error: null } : null))
                                    }
                                  } catch (e) {
                                    setLinkModal((m) => (m ? { ...m, loading: false, error: e instanceof Error ? e.message : "Failed" } : null))
                                  }
                                }}
                                className="text-[10px] px-2 py-0.5 rounded-md bg-white/10 hover:bg-white/20 text-gray-300"
                              >
                                Link to AR/AP
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
            <div className="px-4 py-2 border-t border-white/10 text-[11px] text-gray-500 flex flex-wrap justify-between gap-2">
              <span>
                Showing {filteredPayments.length} of {payments.length} movements
              </span>
              <span className="text-gray-600">Gross − Fee = Net per allocation</span>
            </div>
          </div>
        </div>

        {llmMatching && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
            <div className="bg-zinc-900 border border-white/10 rounded-xl p-6 max-w-sm text-center">
              <div className="h-8 w-8 rounded-full border-2 border-violet-400 border-t-white animate-spin mx-auto mb-3" />
              <p className="text-white font-medium">Matching with LLM…</p>
              <p className="text-xs text-gray-500 mt-1">Analyzing unmatched transactions and invoices</p>
            </div>
          </div>
        )}

        {llmResults && (llmResults.ar.length > 0 || llmResults.ap.length > 0) && (
          <div
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
            onClick={() => setLlmResults(null)}
          >
            <div
              className="bg-zinc-900 border border-white/10 rounded-xl p-4 max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-sm font-medium text-white mb-2">LLM suggested matches</h3>
              <p className="text-xs text-gray-500 mb-3">Review and apply each match</p>
              <div className="flex-1 overflow-y-auto space-y-3">
                {llmResults.ar.map((s) => {
                  const pay = payments.find((p) => p.movement_id === s.movement_id)
                  const inv = ledgerForLookup.find((i) => i.type === "ar" && i.invoice_id === s.invoice_id)
                  return (
                    <div key={`ar-${s.movement_id}-${s.invoice_id}`} className="p-3 rounded bg-white/5 border border-white/5">
                      <div className="flex justify-between items-start gap-2">
                        <div>
                          <span className="text-emerald-400">+{pay ? money(pay.amount) : s.movement_id.slice(0, 8)}</span>
                          <span className="text-gray-500 text-xs ml-2">→ {inv?.display_name ?? s.invoice_id}</span>
                          <p className="text-xs text-gray-400 mt-1">{s.reasoning}</p>
                          <span className="text-[10px] text-gray-500">({s.confidence})</span>
                        </div>
                        <button
                          onClick={async () => {
                            try {
                              const res = await fetch("/api/ar-match", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ movement_id: s.movement_id, invoice_id: s.invoice_id }),
                              })
                              if (!res.ok) throw new Error((await res.json()).error ?? "Failed")
                              setLlmResults((r) => {
                                if (!r) return null
                                const next = { ...r, ar: r.ar.filter((x) => x.movement_id !== s.movement_id || x.invoice_id !== s.invoice_id) }
                                return next.ar.length === 0 && next.ap.length === 0 ? null : next
                              })
                              refresh()
                            } catch (e) {
                              console.error(e)
                            }
                          }}
                          className="text-[10px] px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500"
                        >
                          Apply
                        </button>
                      </div>
                    </div>
                  )
                })}
                {llmResults.ap.map((s) => {
                  const pay = payments.find((p) => p.movement_id === s.movement_id)
                  const bill = ledgerForLookup.find(
                    (i) => i.type === "ap" && ((i as BillRow).entity_uri === s.obligation_id || `ap://bill/legacy/${(i as BillRow).bill_id}` === s.obligation_id)
                  )
                  return (
                    <div key={`ap-${s.movement_id}-${s.obligation_id}`} className="p-3 rounded bg-white/5 border border-white/5">
                      <div className="flex justify-between items-start gap-2">
                        <div>
                          <span className="text-red-400">-{pay ? money(pay.amount) : s.movement_id.slice(0, 8)}</span>
                          <span className="text-gray-500 text-xs ml-2">→ {bill?.display_name ?? s.obligation_id}</span>
                          <p className="text-xs text-gray-400 mt-1">{s.reasoning}</p>
                          <span className="text-[10px] text-gray-500">({s.confidence})</span>
                        </div>
                        <button
                          onClick={async () => {
                            try {
                              const res = await fetch("/api/ap-match", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ movement_id: s.movement_id, obligation_id: s.obligation_id }),
                              })
                              if (!res.ok) throw new Error((await res.json()).error ?? "Failed")
                              setLlmResults((r) => {
                                if (!r) return null
                                const next = { ...r, ap: r.ap.filter((x) => x.movement_id !== s.movement_id || x.obligation_id !== s.obligation_id) }
                                return next.ar.length === 0 && next.ap.length === 0 ? null : next
                              })
                              refresh()
                            } catch (e) {
                              console.error(e)
                            }
                          }}
                          className="text-[10px] px-2 py-1 rounded bg-red-600 hover:bg-red-500"
                        >
                          Apply
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              <button
                type="button"
                onClick={() => setLlmResults(null)}
                className="mt-3 text-sm text-gray-400 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {llmResults && llmResults.ar.length === 0 && llmResults.ap.length === 0 && (
          <div
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
            onClick={() => setLlmResults(null)}
          >
            <div
              className="bg-zinc-900 border border-white/10 rounded-xl p-4 max-w-sm text-center"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-gray-400">No matches suggested by LLM.</p>
              <button onClick={() => setLlmResults(null)} className="mt-3 text-sm text-gray-400 hover:text-white">Close</button>
            </div>
          </div>
        )}

        {movementDetail && (
          <div
            className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
            onClick={() => setMovementDetail(null)}
          >
            <div
              className="bg-zinc-900 border border-white/10 rounded-xl p-4 max-w-3xl w-full max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">Movement detail</h3>
                  <p className="text-[11px] text-gray-500">Explainability drawer: what, why, and source receipts.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setMovementDetail(null)}
                  className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-gray-300"
                >
                  Close
                </button>
              </div>

              {movementDetail.loading && (
                <div className="flex items-center gap-2 py-6 text-gray-400">
                  <div className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Loading detail…
                </div>
              )}

              {movementDetail.error && (
                <p className="text-sm text-red-300">{movementDetail.error}</p>
              )}

              {movementDetail.detail && (
                <div className="space-y-4">
                  {/* 1) Headline */}
                  <section className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">Canonical truth</p>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
                      <div>
                        <p className="text-gray-500 text-[11px]">Amount</p>
                        <p className={`text-white font-semibold ${moneyClass}`}>{money(movementDetail.detail.headline.amount)}</p>
                      </div>
                      <div>
                        <p className="text-gray-500 text-[11px]">Direction</p>
                        <p className="text-white">{movementDetail.detail.headline.direction}</p>
                      </div>
                      <div>
                        <p className="text-gray-500 text-[11px]">Date</p>
                        <p className="text-white">{formatDate(movementDetail.detail.headline.date)}</p>
                      </div>
                      <div className="col-span-2 md:col-span-3">
                        <p className="text-gray-500 text-[11px]">Canonical entity</p>
                        <p className="text-white">{movementDetail.detail.headline.canonical_entity_name ?? "—"}</p>
                      </div>
                      <div className="col-span-2 md:col-span-3">
                        <span className={`text-[10px] px-2 py-0.5 rounded ${
                          movementDetail.detail.headline.status_badge === "included_pnl"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : movementDetail.detail.headline.status_badge === "included_non_pnl"
                              ? "bg-sky-500/20 text-sky-300"
                              : movementDetail.detail.headline.status_badge === "unresolved"
                                ? "bg-amber-500/20 text-amber-300"
                                : "bg-red-500/20 text-red-300"
                        }`}>
                          {movementDetail.detail.headline.status_badge}
                        </span>
                      </div>
                    </div>
                  </section>

                  {/* 2) Economic semantics */}
                  <section className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">Economic semantics</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      <div><p className="text-gray-500">Economic class</p><p className="text-white">{movementDetail.detail.economic_semantics.economic_class ?? "—"}</p></div>
                      <div><p className="text-gray-500">Bucket</p><p className="text-white">{movementDetail.detail.economic_semantics.cashflow_bucket ?? "—"}</p></div>
                      <div><p className="text-gray-500">Role</p><p className="text-white">{movementDetail.detail.economic_semantics.counterparty_role ?? "—"}</p></div>
                      <div><p className="text-gray-500">Policy</p><p className="text-white">{movementDetail.detail.economic_semantics.policy_status ?? "—"}</p></div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                      <span className={`px-2 py-0.5 rounded ${movementDetail.detail.economic_semantics.flags.hits_pnl ? "bg-emerald-500/20 text-emerald-300" : "bg-white/10 text-gray-400"}`}>Hits P&L</span>
                      <span className={`px-2 py-0.5 rounded ${movementDetail.detail.economic_semantics.flags.hits_working_capital ? "bg-sky-500/20 text-sky-300" : "bg-white/10 text-gray-400"}`}>Working capital</span>
                      <span className={`px-2 py-0.5 rounded ${movementDetail.detail.economic_semantics.flags.is_recurring ? "bg-violet-500/20 text-violet-300" : "bg-white/10 text-gray-400"}`}>Recurring</span>
                      <span className={`px-2 py-0.5 rounded ${movementDetail.detail.economic_semantics.flags.is_owner_related ? "bg-rose-500/20 text-rose-300" : "bg-white/10 text-gray-400"}`}>Owner related</span>
                    </div>
                  </section>

                  {/* 3) Evidence trail + normalized bank info */}
                  <section className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">Evidence + normalized bank info</p>
                    <div className="space-y-1.5 text-xs mb-2">
                      <p><span className="text-gray-500">Raw bank text:</span> <span className="text-white">{movementDetail.detail.normalized_bank_info.raw_bank_text ?? "—"}</span></p>
                      <p><span className="text-gray-500">Scrubbed text:</span> <span className="text-white">{movementDetail.detail.normalized_bank_info.scrubbed_bank_text || "—"}</span></p>
                      <p><span className="text-gray-500">Normalized display:</span> <span className="text-white">{movementDetail.detail.normalized_bank_info.normalized_display_name ?? "—"}</span></p>
                      <p><span className="text-gray-500">Resolver path:</span> <span className="text-white">{movementDetail.detail.normalized_bank_info.resolution_path.classification_precedence ?? "—"}</span></p>
                    </div>
                    <div className="space-y-2">
                      {movementDetail.detail.evidence_trail.observations.map((o, idx) => (
                        <div key={`${o.source_id}-${idx}`} className="rounded border border-white/10 bg-black/20 p-2 text-[11px]">
                          <p className="text-gray-300">
                            {o.source}/{o.source_type} · {o.source_id}
                          </p>
                          <p className="text-gray-500">{o.date ? formatDate(o.date) : "—"} · {o.amount != null ? money(o.amount) : "—"} · {o.counterparty ?? "—"}</p>
                          <p className="text-gray-400 break-words">{o.raw_description ?? "—"}</p>
                        </div>
                      ))}
                      {movementDetail.detail.evidence_trail.observations.length === 0 && (
                        <p className="text-xs text-gray-500">No observations found.</p>
                      )}
                    </div>
                  </section>

                  {/* 4) Confidence */}
                  <section className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">Confidence engine</p>
                    <p className="text-sm text-white">
                      Classification {Math.round(movementDetail.detail.confidence_engine.overall.classification_score * 100)}%
                      {" / "}
                      Evidence {Math.round(movementDetail.detail.confidence_engine.overall.evidence_strength * 100)}%
                    </p>
                    <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-2 text-[11px]">
                      {Object.entries(movementDetail.detail.confidence_engine.breakdown).map(([k, v]) => (
                        <div key={k} className="rounded border border-white/10 px-2 py-1">
                          <p className="text-gray-500">{k}</p>
                          <p className="text-white">{v == null ? "—" : `${Math.round(v * 100)}%`}</p>
                        </div>
                      ))}
                    </div>
                    {movementDetail.detail.confidence_engine.explanation_lines.length > 0 && (
                      <ul className="mt-2 list-disc list-inside text-[11px] text-gray-400">
                        {movementDetail.detail.confidence_engine.explanation_lines.map((line, i) => (
                          <li key={`${line}-${i}`}>{line}</li>
                        ))}
                      </ul>
                    )}
                  </section>

                  {/* 5) Controls */}
                  <section className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">Control panel</p>
                    <div className="space-y-2">
                      <label className="block text-[11px] text-gray-400">Re-categorize (intent)</label>
                      <input
                        value={recatIntent}
                        onChange={(e) => setRecatIntent(e.target.value)}
                        placeholder="e.g. change this movement to owner_draw"
                        className="w-full rounded bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={recatLoading || !recatIntent.trim()}
                          onClick={async () => {
                            if (!movementDetail?.detail) return
                            setRecatLoading(true)
                            try {
                              const editRes = await fetch("/api/movements/edit", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  intent: recatIntent.trim(),
                                  movement_ids: [movementDetail.detail.headline.movement_id],
                                }),
                              })
                              const editData = await editRes.json()
                              if (!editRes.ok) throw new Error(editData?.error ?? "Failed to recategorize")
                              const tagRes = await fetch("/api/movements/tag", { method: "POST" })
                              if (!tagRes.ok) throw new Error("Retag failed")
                              await refresh()
                              await openMovementDetail(movementDetail.detail.headline.movement_id)
                              setRecatIntent("")
                            } catch (e) {
                              setMovementDetail((m) => m ? { ...m, error: e instanceof Error ? e.message : "Failed to recategorize" } : null)
                            } finally {
                              setRecatLoading(false)
                            }
                          }}
                          className="text-xs px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
                        >
                          {recatLoading ? "Applying..." : "Apply recategorize"}
                        </button>
                        <button
                          type="button"
                          disabled={unmergeLoading || !movementDetail.detail.controls.can_unmerge_entity}
                          onClick={async () => {
                            if (!movementDetail?.detail) return
                            setUnmergeLoading(true)
                            try {
                              const previewRes = await fetch("/api/movements/unmerge", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  movement_id: movementDetail.detail.headline.movement_id,
                                  apply_to_related: true,
                                  reason: "manual_unmerge_from_detail_drawer",
                                  preview_only: true,
                                }),
                              })
                              const previewData = await previewRes.json()
                              if (!previewRes.ok) throw new Error(previewData?.error ?? "Failed to preview unmerge")
                              const yes = window.confirm(`Unmerge this entity link? This will affect ${previewData?.affected ?? 1} movement(s).`)
                              if (!yes) return
                              const res = await fetch("/api/movements/unmerge", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  movement_id: movementDetail.detail.headline.movement_id,
                                  apply_to_related: true,
                                  reason: "manual_unmerge_from_detail_drawer",
                                }),
                              })
                              const data = await res.json()
                              if (!res.ok) throw new Error(data?.error ?? "Failed to unmerge")
                              await refresh()
                              await openMovementDetail(movementDetail.detail.headline.movement_id)
                            } catch (e) {
                              setMovementDetail((m) => m ? { ...m, error: e instanceof Error ? e.message : "Failed to unmerge" } : null)
                            } finally {
                              setUnmergeLoading(false)
                            }
                          }}
                          className="text-xs px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50"
                        >
                          {unmergeLoading ? "Unmerging..." : "Unmerge entity"}
                        </button>
                        <button type="button" disabled className="text-xs px-2 py-1 rounded bg-white/10 text-gray-500 cursor-not-allowed">Split movement (soon)</button>
                        <button
                          type="button"
                          disabled={policyLoading || !movementDetail.detail.controls.can_force_policy}
                          onClick={async () => {
                            if (!movementDetail?.detail) return
                            setPolicyLoading(true)
                            try {
                              const nextOverride = movementDetail.detail.controls.current_overrides.forced_include ? "exclude" : "include"
                              const res = await fetch("/api/movements/override-policy", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  movement_id: movementDetail.detail.headline.movement_id,
                                  override: nextOverride,
                                  reason: "manual_policy_toggle_from_detail_drawer",
                                }),
                              })
                              const data = await res.json()
                              if (!res.ok) throw new Error(data?.error ?? "Failed to update policy override")
                              await refresh()
                              await openMovementDetail(movementDetail.detail.headline.movement_id)
                            } catch (e) {
                              setMovementDetail((m) => m ? { ...m, error: e instanceof Error ? e.message : "Failed to update policy" } : null)
                            } finally {
                              setPolicyLoading(false)
                            }
                          }}
                          className="text-xs px-2 py-1 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50"
                        >
                          {policyLoading
                            ? "Applying..."
                            : movementDetail.detail.controls.current_overrides.forced_include
                              ? "Force Exclude"
                              : "Force Include"}
                        </button>
                        <button
                          type="button"
                          disabled={policyLoading || !movementDetail.detail.controls.can_force_policy}
                          onClick={async () => {
                            if (!movementDetail?.detail) return
                            setPolicyLoading(true)
                            try {
                              const res = await fetch("/api/movements/override-policy", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  movement_id: movementDetail.detail.headline.movement_id,
                                  override: "clear",
                                  reason: "manual_policy_clear_from_detail_drawer",
                                }),
                              })
                              const data = await res.json()
                              if (!res.ok) throw new Error(data?.error ?? "Failed to clear policy override")
                              await refresh()
                              await openMovementDetail(movementDetail.detail.headline.movement_id)
                            } catch (e) {
                              setMovementDetail((m) => m ? { ...m, error: e instanceof Error ? e.message : "Failed to clear policy" } : null)
                            } finally {
                              setPolicyLoading(false)
                            }
                          }}
                          className="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50"
                        >
                          Clear Override
                        </button>
                      </div>
                    </div>
                  </section>
                </div>
              )}
            </div>
          </div>
        )}

        {linkModal && (
          <div
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
            onClick={() => setLinkModal(null)}
          >
            <div
              className="bg-zinc-900 border border-white/10 rounded-xl p-4 max-w-md w-full shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-sm font-medium text-white mb-2">
                {linkModal.payment.direction === "inflow" ? "Link inflow to receivable" : "Link outflow to payable"}
              </h3>
              <p className="text-xs text-gray-500 mb-3">
                {formatDate(linkModal.payment.date)} · {linkModal.payment.direction === "inflow" ? "+" : "−"}
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

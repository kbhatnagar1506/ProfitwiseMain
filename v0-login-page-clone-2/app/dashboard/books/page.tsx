"use client"

import { useState, useEffect, useCallback } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Sparkles, ChevronDown, ChevronUp, Plus, Trash2, Lock } from "lucide-react"

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// Chart of Accounts Tab
function ChartOfAccountsTab() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  useEffect(() => {
    fetch("/api/books/chart-of-accounts")
      .then(r => r.json())
      .then(setData)
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-zinc-500 text-sm">Loading chart of accounts...</div>

  const groups = [
    { key: "assets", label: "Assets", color: "emerald" },
    { key: "liabilities", label: "Liabilities", color: "red" },
    { key: "equity", label: "Equity", color: "blue" },
    { key: "revenue", label: "Revenue", color: "green" },
    { key: "expenses", label: "Expenses", color: "amber" },
    { key: "nonOperating", label: "Non-Operating", color: "zinc" },
  ]

  return (
    <div className="space-y-4">
      {groups.map(grp => {
        const accounts = data?.[grp.key] ?? []
        const isExp = expanded[grp.key]
        const total = accounts.reduce((s: number, a: any) => s + (a.balance ?? 0), 0)

        return (
          <div key={grp.key} className="border border-white/[0.07] rounded-lg overflow-hidden">
            <button
              onClick={() => setExpanded(p => ({ ...p, [grp.key]: !p[grp.key] }))}
              className="w-full px-4 py-3 bg-white/[0.03] hover:bg-white/[0.06] flex items-center justify-between text-left"
            >
              <div className="flex items-center gap-3">
                {isExp ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                <span className="font-medium text-white">{grp.label}</span>
                <span className="text-xs text-zinc-600">({accounts.length})</span>
              </div>
              <span className="font-mono text-sm text-emerald-400">{fmt(total)}</span>
            </button>
            {isExp && (
              <div className="divide-y divide-white/[0.07]">
                {accounts.map((acct: any) => (
                  <div key={acct.code} className="px-4 py-2 text-sm flex items-center justify-between hover:bg-white/[0.02]">
                    <div className="flex-1">
                      <div className="font-mono text-xs text-zinc-600">{acct.code}</div>
                      <div className="text-white">{acct.name}</div>
                      <div className="text-xs text-zinc-600">{acct.type}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-sm text-emerald-400">{fmt(acct.balance)}</div>
                      {acct.movement_count !== undefined && acct.movement_count !== null && <div className="text-xs text-zinc-600">{acct.movement_count} moves</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// General Ledger Tab
function GeneralLedgerTab() {
  const [entries, setEntries] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [filters, setFilters] = useState({ search: "", account: "", dateFrom: "", dateTo: "" })

  const fetchEntries = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), limit: "50", ...filters })
    const res = await fetch(`/api/books/general-ledger?${params}`)
    const json = await res.json()
    setEntries(json.entries)
    setTotal(json.total)
    setLoading(false)
  }, [page, filters])

  useEffect(() => {
    fetchEntries()
  }, [fetchEntries])

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <Input
          placeholder="Search..."
          value={filters.search}
          onChange={e => setFilters(p => ({ ...p, search: e.target.value }))}
          className="bg-[#0a0a0a] border-white/[0.07] text-white placeholder:text-zinc-600 w-48 h-8 text-sm"
        />
        <Input
          type="date"
          value={filters.dateFrom}
          onChange={e => setFilters(p => ({ ...p, dateFrom: e.target.value }))}
          className="bg-[#0a0a0a] border-white/[0.07] text-white h-8 text-sm"
        />
        <Input
          type="date"
          value={filters.dateTo}
          onChange={e => setFilters(p => ({ ...p, dateTo: e.target.value }))}
          className="bg-[#0a0a0a] border-white/[0.07] text-white h-8 text-sm"
        />
      </div>

      {loading ? (
        <div className="text-zinc-500 text-sm">Loading ledger...</div>
      ) : (
        <>
          <div className="space-y-2">
            {entries.map((je: any) => (
              <div key={je.id} className="border border-white/[0.07] rounded-lg overflow-hidden">
                <div className="bg-white/[0.03] px-4 py-2 flex items-center justify-between text-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-zinc-600">{je.id.slice(0, 8)}</span>
                    <span className="text-white">{formatDate(je.date)}</span>
                    <span className="text-zinc-400">{je.memo}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-emerald-400">D: {fmt(je.total_debit)}</span>
                    <span className="font-mono text-xs text-amber-400">C: {fmt(je.total_credit)}</span>
                    {je.is_balanced && <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">✓</Badge>}
                  </div>
                </div>
                <div className="divide-y divide-white/[0.07]">
                  {je.lines.map((line: any, i: number) => (
                    <div key={i} className="px-4 py-2 text-sm flex items-center justify-between hover:bg-white/[0.02]">
                      <div className="flex-1">
                        <div className="text-white">{line.account}</div>
                        <div className="text-xs text-zinc-600">{line.entity_name}</div>
                      </div>
                      <div className="flex items-center gap-4">
                        {line.debit ? <span className="font-mono text-emerald-400 w-24 text-right">{fmt(line.debit)}</span> : <span className="w-24" />}
                        {line.credit ? <span className="font-mono text-amber-400 w-24 text-right">{fmt(line.credit)}</span> : <span className="w-24" />}
                        <Badge variant="outline" className="text-xs">{line.source}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-600">{total} total entries</span>
            <div className="flex gap-2">
              <Button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} size="sm" variant="outline">
                Prev
              </Button>
              <span className="text-zinc-600">Page {page}</span>
              <Button onClick={() => setPage(p => p + 1)} disabled={entries.length < 50} size="sm" variant="outline">
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// Manual Journal Entries Tab
function ManualJETab() {
  const [entries, setEntries] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [lines, setLines] = useState<any[]>([{ account_code: "", description: "", debit: 0, credit: 0 }])
  const [memo, setMemo] = useState("")
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [autoReverse, setAutoReverse] = useState(false)
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    fetch("/api/books/journal-entry").then(r => r.json()).then(d => setEntries(d.entries))
  }, [])

  const totalDebits = lines.reduce((s, l) => s + (l.debit ?? 0), 0)
  const totalCredits = lines.reduce((s, l) => s + (l.credit ?? 0), 0)
  const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01

  const handlePost = async () => {
    if (!isBalanced) return
    setPosting(true)
    const res = await fetch("/api/books/journal-entry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memo, date, lines, auto_reverse: autoReverse }),
    })
    if (res.ok) {
      setShowForm(false)
      setLines([{ account_code: "", description: "", debit: 0, credit: 0 }])
      setMemo("")
      setDate(new Date().toISOString().slice(0, 10))
      setAutoReverse(false)
      const json = await res.json()
      setEntries(p => [{ id: json.movement_id, date, memo, amount: Math.max(totalDebits, totalCredits), auto_reverse: autoReverse, lines }, ...p])
    }
    setPosting(false)
  }

  return (
    <div className="space-y-4">
      {!showForm ? (
        <Button onClick={() => setShowForm(true)} className="bg-emerald-600 hover:bg-emerald-500">
          <Plus className="w-4 h-4 mr-2" /> New Entry
        </Button>
      ) : (
        <div className="border border-white/[0.07] rounded-lg p-4 space-y-3">
          <div className="flex gap-2">
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="bg-[#0a0a0a] border-white/[0.07] text-white h-8 text-sm flex-1" />
            <Input placeholder="Memo" value={memo} onChange={e => setMemo(e.target.value)} className="bg-[#0a0a0a] border-white/[0.07] text-white h-8 text-sm flex-1" />
          </div>

          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="flex gap-2 items-end">
                <Input placeholder="Account" value={line.account_code} onChange={e => { const l = [...lines]; l[i].account_code = e.target.value; setLines(l) }} className="bg-[#0a0a0a] border-white/[0.07] text-white h-8 text-sm flex-1" />
                <Input placeholder="Description" value={line.description} onChange={e => { const l = [...lines]; l[i].description = e.target.value; setLines(l) }} className="bg-[#0a0a0a] border-white/[0.07] text-white h-8 text-sm flex-1" />
                <Input type="number" placeholder="Debit" value={line.debit} onChange={e => { const l = [...lines]; l[i].debit = parseFloat(e.target.value) || 0; setLines(l) }} className="bg-[#0a0a0a] border-white/[0.07] text-white h-8 text-sm w-24" />
                <Input type="number" placeholder="Credit" value={line.credit} onChange={e => { const l = [...lines]; l[i].credit = parseFloat(e.target.value) || 0; setLines(l) }} className="bg-[#0a0a0a] border-white/[0.07] text-white h-8 text-sm w-24" />
                <Button onClick={() => setLines(lines.filter((_, idx) => idx !== i))} size="sm" variant="ghost"><Trash2 className="w-4 h-4" /></Button>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-4">
              <span className={`font-mono ${isBalanced ? "text-emerald-400" : "text-red-400"}`}>D: {fmt(totalDebits)} | C: {fmt(totalCredits)}</span>
              <label className="flex items-center gap-2 text-zinc-400">
                <input type="checkbox" checked={autoReverse} onChange={e => setAutoReverse(e.target.checked)} className="w-4 h-4" />
                Auto-reverse next month
              </label>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setShowForm(false)} variant="ghost" size="sm">Cancel</Button>
              <Button onClick={() => setLines([...lines, { account_code: "", description: "", debit: 0, credit: 0 }])} size="sm" variant="outline"><Plus className="w-4 h-4" /></Button>
              <Button onClick={handlePost} disabled={!isBalanced || posting} className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50" size="sm">Post</Button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {entries.map(e => (
          <div key={e.id} className="border border-white/[0.07] rounded p-3 text-sm">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-white font-medium">{e.memo}</div>
                <div className="text-xs text-zinc-600">{formatDate(e.date)}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-emerald-400">{fmt(e.amount)}</span>
                {e.auto_reverse && <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs">Auto-Reverse</Badge>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Month-End Close Tab
function MonthEndCloseTab() {
  const [status, setStatus] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [year, setYear] = useState(new Date().getFullYear())
  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [locking, setLocking] = useState(false)

  const fetchStatus = useCallback(async () => {
    setLoading(true)
    const res = await fetch(`/api/books/period-status?year=${year}&month=${month}`)
    const json = await res.json()
    setStatus(json)
    setLoading(false)
  }, [year, month])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const handleLock = async () => {
    setLocking(true)
    const res = await fetch("/api/books/period-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year, month }),
    })
    if (res.ok) {
      await fetchStatus()
    }
    setLocking(false)
  }

  if (loading) return <div className="text-zinc-500 text-sm">Loading period status...</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button onClick={() => setMonth(m => m === 1 ? 12 : m - 1)} size="sm" variant="outline">&lt;</Button>
        <span className="text-white font-medium w-32 text-center">{new Date(year, month - 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
        <Button onClick={() => setMonth(m => m === 12 ? 1 : m + 1)} size="sm" variant="outline">&gt;</Button>
      </div>

      <div className="space-y-2">
        {status?.checklist?.map((item: any) => (
          <div key={item.id} className={`border rounded-lg p-3 ${item.passed ? "border-emerald-500/20 bg-emerald-500/5" : "border-red-500/20 bg-red-500/5"}`}>
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  {item.passed ? <span className="text-emerald-400">✓</span> : <span className="text-red-400">✗</span>}
                  <span className="text-white font-medium">{item.label}</span>
                </div>
                <div className="text-xs text-zinc-600 mt-1">{item.detail}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <Button
        onClick={handleLock}
        disabled={!status?.can_lock || locking}
        className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 h-10"
      >
        <Lock className="w-4 h-4 mr-2" /> Lock Period: {new Date(year, month - 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
      </Button>

      {status?.locked_periods?.length > 0 && (
        <div className="border border-white/[0.07] rounded-lg p-3">
          <div className="text-xs text-zinc-600 mb-2">Locked Periods</div>
          <div className="flex flex-wrap gap-2">
            {status.locked_periods.map((p: any) => (
              <Badge key={`${p.year}-${p.month}`} className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                <Lock className="w-3 h-3 mr-1" /> {new Date(p.year, p.month - 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" })}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// AI Auditor Panel
function AIAuditorPanel() {
  const [auditor, setAuditor] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [coaData, setCoaData] = useState<any>(null)

  const runAudit = async () => {
    setLoading(true)
    const [auditorRes, coaRes] = await Promise.all([
      fetch("/api/books/ai-auditor"),
      fetch("/api/books/chart-of-accounts"),
    ])
    const auditorJson = await auditorRes.json()
    const coaJson = await coaRes.json()
    setAuditor(auditorJson)
    setCoaData(coaJson)
    setExpanded(true)
    setLoading(false)
  }

  // Find suspense account balance
  const suspenseAccount = coaData?.nonOperating?.find((a: any) => a.code === "9999")
  const suspenseBalance = suspenseAccount?.balance ?? 0
  const hasSuspense = suspenseBalance > 0.01

  // Determine if we should show error state
  const hasAnomalies = (auditor?.anomalies?.length ?? 0) > 0 || hasSuspense

  return (
    <div className={`border rounded-lg overflow-hidden ${hasSuspense ? "border-red-500/20 bg-red-500/5" : "border-white/[0.07]"}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full px-4 py-3 flex items-center justify-between ${hasSuspense ? "bg-red-500/10 hover:bg-red-500/15" : "bg-white/[0.03] hover:bg-white/[0.06]"}`}
      >
        <div className="flex items-center gap-2">
          <Sparkles className={`w-4 h-4 ${hasSuspense ? "text-red-400" : "text-amber-400"}`} />
          <span className={`font-medium ${hasSuspense ? "text-red-400" : "text-white"}`}>AI Auditor</span>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {expanded && (
        <div className="px-4 py-3 space-y-3 border-t border-white/[0.07]">
          {!auditor ? (
            <Button onClick={runAudit} disabled={loading} className="w-full bg-amber-600 hover:bg-amber-500">
              {loading ? "Running..." : "Run Audit"}
            </Button>
          ) : (
            <div className="space-y-2">
              {hasSuspense && (
                <div className="text-xs p-2 rounded border border-red-500/20 bg-red-500/5">
                  <div className="flex items-start gap-2">
                    <Badge className="bg-red-500/10 text-red-400 border-red-500/20" variant="outline">
                      error
                    </Badge>
                    <span className="text-red-300">⚠️ Anomaly Detected: You have {fmt(suspenseBalance)} sitting in Suspense / Unclassified. Reconcile these unmatched transactions before closing the books.</span>
                  </div>
                </div>
              )}

              {auditor.anomalies?.length > 0 ? (
                <>
                  {auditor.anomalies.map((a: any, i: number) => (
                    <div key={i} className={`text-xs p-2 rounded border ${a.severity === "error" ? "border-red-500/20 bg-red-500/5" : "border-amber-500/20 bg-amber-500/5"}`}>
                      <div className="flex items-start gap-2">
                        <Badge className={a.severity === "error" ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"} variant="outline">
                          {a.severity}
                        </Badge>
                        <span className="text-zinc-300">{a.message}</span>
                      </div>
                    </div>
                  ))}
                  <div className="text-xs text-zinc-600 mt-3 p-2 bg-white/[0.02] rounded">{auditor.narrative}</div>
                </>
              ) : !hasSuspense ? (
                <div className="text-xs text-emerald-400">✓ Books look clean. No anomalies detected.</div>
              ) : null}

              <Button onClick={runAudit} disabled={loading} size="sm" variant="outline" className="w-full">
                {loading ? "Running..." : "Re-run Audit"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function BooksPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Books</h1>
          <p className="text-zinc-600 text-sm mt-1">Double-entry ledger & month-end close</p>
        </div>

        <AIAuditorPanel />

        <Tabs defaultValue="coa" className="w-full">
          <TabsList className="bg-white/[0.05] border border-white/[0.07]">
            <TabsTrigger value="coa">Chart of Accounts</TabsTrigger>
            <TabsTrigger value="gl">General Ledger</TabsTrigger>
            <TabsTrigger value="je">Journal Entries</TabsTrigger>
            <TabsTrigger value="close">Month-End Close</TabsTrigger>
          </TabsList>

          <TabsContent value="coa" className="mt-4">
            <ChartOfAccountsTab />
          </TabsContent>

          <TabsContent value="gl" className="mt-4">
            <GeneralLedgerTab />
          </TabsContent>

          <TabsContent value="je" className="mt-4">
            <ManualJETab />
          </TabsContent>

          <TabsContent value="close" className="mt-4">
            <MonthEndCloseTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

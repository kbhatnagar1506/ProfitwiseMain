"use client"

import { useEffect, useState, useCallback } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Download,
  Building2,
  User,
  Copy,
  Mail,
  Phone,
  ExternalLink,
  Sparkles,
  Clock,
} from "lucide-react"

interface Contact {
  id: string
  canonical_name: string
  display_name: string | null
  entity_type: "customer" | "vendor"
  transaction_count: number
  last_transaction_date: string | null
  metadata?: Record<string, string | null | undefined>
}

interface EntityProfilesResponse {
  summary: {
    total_customers: number
    total_vendors: number
  }
  customers: Contact[]
  pagination: {
    page: number
    limit: number
    total: number
    total_pages: number
  }
}

interface ContactContext {
  contractTerms: string | null
  relationshipNotes: string | null
  rawContext: string
}

function getEmail(c: Contact): string {
  return (c.metadata?.email || c.metadata?.billing_email || c.metadata?.contact_email || "") as string
}

function getPhone(c: Contact): string {
  return (c.metadata?.phone || c.metadata?.phone_number || "") as string
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—"
  const date = new Date(dateStr)
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

const MAX_POLL_ATTEMPTS = 5
const POLL_INTERVAL_MS = 2000

export default function ContactsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [data, setData] = useState<EntityProfilesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(parseInt(searchParams.get("page") || "1", 10))
  const [search, setSearch] = useState(searchParams.get("search") || "")
  const [debouncedSearch, setDebouncedSearch] = useState(search)
  const [entityType, setEntityType] = useState(searchParams.get("entity_type") || "")
  const [sortBy, setSortBy] = useState(searchParams.get("sort_by") || "txn_count")

  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [copiedEmail, setCopiedEmail] = useState(false)

  // Supermemory context state: null = loading, object = done
  const [contactContext, setContactContext] = useState<ContactContext | null | "exhausted">(null)

  const fetchContacts = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (entityType) params.set("entity_type", entityType)
      params.set("page", String(page))
      params.set("limit", "50")
      params.set("sort_by", sortBy)
      if (debouncedSearch) params.set("search", debouncedSearch)

      const response = await fetch(`/api/dashboard/entity-profiles?${params}`)
      if (!response.ok) throw new Error("Failed to fetch contacts")
      const json = await response.json()
      setData(json)
      setError(null)
      setLoading(false)
      return json
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
      setLoading(false)
      throw err
    }
  }, [page, sortBy, debouncedSearch, entityType])

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    fetchContacts()
  }, [fetchContacts])

  // Poll Supermemory context when a contact is selected
  useEffect(() => {
    if (!selectedContact) return
    setContactContext(null)
    let attempt = 0
    let cancelled = false

    const poll = async () => {
      if (cancelled || attempt >= MAX_POLL_ATTEMPTS) {
        if (!cancelled) setContactContext("exhausted")
        return
      }
      attempt++
      try {
        const res = await fetch(`/api/dashboard/contact-context/${selectedContact.id}`)
        if (!res.ok) throw new Error("not ready")
        const json: ContactContext = await res.json()
        if (json.contractTerms || json.relationshipNotes || json.rawContext) {
          if (!cancelled) setContactContext(json)
          return
        }
        throw new Error("empty")
      } catch {
        if (!cancelled) setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    poll()
    return () => { cancelled = true }
  }, [selectedContact?.id])

  const handleExportCSV = () => {
    if (!data?.customers) return
    const headers = ["Name", "Type", "Email", "Phone", "Last Contacted"]
    const rows = data.customers.map(c => [
      c.display_name || c.canonical_name,
      c.entity_type === "customer" ? "Customer" : "Vendor",
      getEmail(c),
      getPhone(c),
      c.last_transaction_date || ""
    ])
    const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv" })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `contacts-${new Date().toISOString().split("T")[0]}.csv`
    a.click()
    window.URL.revokeObjectURL(url)
  }

  const handleRowClick = (contact: Contact) => {
    setSelectedContact(contact)
    setDrawerOpen(true)
  }

  const handleCopyEmail = (email: string) => {
    navigator.clipboard.writeText(email).then(() => {
      setCopiedEmail(true)
      setTimeout(() => setCopiedEmail(false), 2000)
    })
  }

  if (error) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Contacts</h1>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400 text-sm">
          {error}
        </div>
      </div>
    )
  }

  const summary = data?.summary
  const totalCount = (summary?.total_customers || 0) + (summary?.total_vendors || 0)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[11px] text-zinc-500 uppercase tracking-widest mb-1">Relationships / Contacts</p>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Contacts</h1>
        </div>
        <Button
          onClick={handleExportCSV}
          disabled={!data?.customers || data.customers.length === 0}
          className="bg-white/5 hover:bg-white/10 text-white border border-white/10 h-8 px-3 text-sm"
        >
          <Download className="h-3.5 w-3.5 mr-2" />
          Export CSV
        </Button>
      </div>

      {/* Directory KPI Row */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-[#141414] border border-white/[0.06] rounded-xl p-5">
              <Skeleton className="h-3 w-20 mb-3" />
              <Skeleton className="h-7 w-16" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-[#141414] border border-white/[0.08] rounded-xl p-5 hover:border-white/[0.12] transition-colors">
            <p className="text-[11px] text-zinc-500 font-medium uppercase tracking-widest">Total Contacts</p>
            <p className="text-3xl font-semibold text-white mt-3 tracking-tight">{totalCount}</p>
            <p className="text-[11px] text-zinc-600 mt-2">
              {summary?.total_customers || 0} customers · {summary?.total_vendors || 0} vendors
            </p>
          </div>
          <div className="bg-[#141414] border border-white/[0.08] rounded-xl p-5 hover:border-white/[0.12] transition-colors">
            <div className="flex items-center gap-2 mb-3">
              <User className="h-3.5 w-3.5 text-blue-400" />
              <p className="text-[11px] text-zinc-500 font-medium uppercase tracking-widest">Customers</p>
            </div>
            <p className="text-3xl font-semibold text-blue-400 tracking-tight">{summary?.total_customers || 0}</p>
          </div>
          <div className="bg-[#141414] border border-white/[0.08] rounded-xl p-5 hover:border-white/[0.12] transition-colors">
            <div className="flex items-center gap-2 mb-3">
              <Building2 className="h-3.5 w-3.5 text-purple-400" />
              <p className="text-[11px] text-zinc-500 font-medium uppercase tracking-widest">Vendors</p>
            </div>
            <p className="text-3xl font-semibold text-purple-400 tracking-tight">{summary?.total_vendors || 0}</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            placeholder="Search contacts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-white/5 border-white/10 text-zinc-300 placeholder:text-zinc-700"
          />

          <Select value={entityType || "__all__"} onValueChange={(v) => { setEntityType(v === "__all__" ? "" : v); setPage(1) }}>
            <SelectTrigger className="bg-white/5 border-white/10 text-zinc-300">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent className="bg-[#1a1a1a] border-white/10">
              <SelectItem value="__all__">All types</SelectItem>
              <SelectItem value="customer">Customers</SelectItem>
              <SelectItem value="vendor">Vendors</SelectItem>
            </SelectContent>
          </Select>

          <Select value={sortBy} onValueChange={(v) => { setSortBy(v); setPage(1) }}>
            <SelectTrigger className="bg-white/5 border-white/10 text-zinc-300">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent className="bg-[#1a1a1a] border-white/10">
              <SelectItem value="txn_count">Most Active</SelectItem>
              <SelectItem value="last_active">Most Recent</SelectItem>
              <SelectItem value="name">Name A–Z</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Contacts Table */}
      {loading ? (
        <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-12 text-center">
          <div className="inline-flex items-center justify-center">
            <div className="h-5 w-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
            <span className="ml-3 text-zinc-400">Loading contacts...</span>
          </div>
        </div>
      ) : data && data.customers.length > 0 ? (
        <>
          <div className="bg-[#141414] border border-white/[0.06] rounded-xl overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-white/[0.06] hover:bg-transparent">
                  <TableHead className="text-[11px] text-zinc-600 font-medium uppercase tracking-widest">Name</TableHead>
                  <TableHead className="text-[11px] text-zinc-600 font-medium uppercase tracking-widest">Type</TableHead>
                  <TableHead className="text-[11px] text-zinc-600 font-medium uppercase tracking-widest">Email</TableHead>
                  <TableHead className="text-[11px] text-zinc-600 font-medium uppercase tracking-widest">Last Contacted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.customers.map((contact) => {
                  const email = getEmail(contact)
                  return (
                    <TableRow
                      key={contact.id}
                      onClick={() => handleRowClick(contact)}
                      className="hover:bg-white/[0.03] transition-colors cursor-pointer border-b border-white/[0.04]"
                    >
                      <TableCell className="text-[13px] text-white font-medium py-3 px-4">
                        {contact.display_name || contact.canonical_name}
                      </TableCell>
                      <TableCell className="py-3 px-4">
                        {contact.entity_type === "customer" ? (
                          <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-[10px] h-5 font-medium">
                            <User className="h-2.5 w-2.5 mr-1" />
                            Customer
                          </Badge>
                        ) : (
                          <Badge className="bg-purple-500/10 text-purple-400 border-purple-500/20 text-[10px] h-5 font-medium">
                            <Building2 className="h-2.5 w-2.5 mr-1" />
                            Vendor
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="py-3 px-4">
                        {email ? (
                          <a
                            href={`mailto:${email}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-[12px] text-zinc-300 hover:text-white transition-colors"
                          >
                            {email}
                          </a>
                        ) : (
                          <span className="text-[12px] text-zinc-700">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-[12px] text-zinc-400 py-3 px-4">
                        {formatDate(contact.last_transaction_date)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {data.pagination.total_pages > 1 && (
            <div className="flex items-center justify-between">
              <div className="text-[12px] text-zinc-600">
                Page {data.pagination.page} of {data.pagination.total_pages} ({data.pagination.total} total)
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                  className="bg-white/5 border-white/10 text-zinc-400 disabled:opacity-50"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.min(data.pagination.total_pages, page + 1))}
                  disabled={page === data.pagination.total_pages}
                  className="bg-white/5 border-white/10 text-zinc-400 disabled:opacity-50"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-8 text-center">
          <p className="text-zinc-400">No contacts found</p>
          <p className="text-sm text-zinc-600 mt-2">Try adjusting your filters</p>
        </div>
      )}

      {/* Deep Dive Drawer */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent className="bg-[#0A0A0A] border-l border-white/[0.06] w-full sm:w-[480px] overflow-y-auto">
          {selectedContact && (
            <>
              <SheetHeader className="border-b border-white/[0.06] pb-5 mb-6">
                <SheetTitle className="text-white text-2xl font-semibold tracking-tight">
                  {selectedContact.display_name || selectedContact.canonical_name}
                </SheetTitle>
                <div className="flex items-center gap-2 mt-2">
                  {selectedContact.entity_type === "customer" ? (
                    <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-[11px]">
                      <User className="h-3 w-3 mr-1" />
                      Customer
                    </Badge>
                  ) : (
                    <Badge className="bg-purple-500/10 text-purple-400 border-purple-500/20 text-[11px]">
                      <Building2 className="h-3 w-3 mr-1" />
                      Vendor
                    </Badge>
                  )}
                </div>
              </SheetHeader>

              <div className="space-y-6">

                {/* Contact Info */}
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-3">
                  <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Contact Info</p>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-zinc-400">
                        <Mail className="h-3.5 w-3.5" />
                        <span className="text-[11px] uppercase tracking-wide">Email</span>
                      </div>
                      {getEmail(selectedContact) ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] text-zinc-200">{getEmail(selectedContact)}</span>
                          <button
                            onClick={() => handleCopyEmail(getEmail(selectedContact))}
                            className="text-zinc-600 hover:text-zinc-300 transition-colors"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      ) : (
                        <span className="text-[12px] text-zinc-700">—</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-zinc-400">
                        <Phone className="h-3.5 w-3.5" />
                        <span className="text-[11px] uppercase tracking-wide">Phone</span>
                      </div>
                      {getPhone(selectedContact) ? (
                        <span className="text-[12px] text-zinc-200">{getPhone(selectedContact)}</span>
                      ) : (
                        <span className="text-[12px] text-zinc-700">—</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Quick Actions */}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    onClick={() => getEmail(selectedContact) && handleCopyEmail(getEmail(selectedContact))}
                    disabled={!getEmail(selectedContact)}
                    className="bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 text-[12px] h-9 disabled:opacity-30"
                  >
                    <Copy className="h-3.5 w-3.5 mr-2" />
                    {copiedEmail ? "Copied!" : "Copy Email"}
                  </Button>
                  <Button
                    onClick={() => getEmail(selectedContact) && window.open(`mailto:${getEmail(selectedContact)}`, "_blank")}
                    disabled={!getEmail(selectedContact)}
                    className="bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 text-[12px] h-9 disabled:opacity-30"
                  >
                    <Mail className="h-3.5 w-3.5 mr-2" />
                    Draft Email
                  </Button>
                </div>

                {/* Associated Entity */}
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-3">
                  <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Associated Entity</p>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {selectedContact.entity_type === "customer" ? (
                        <div className="h-8 w-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                          <User className="h-4 w-4 text-blue-400" />
                        </div>
                      ) : (
                        <div className="h-8 w-8 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                          <Building2 className="h-4 w-4 text-purple-400" />
                        </div>
                      )}
                      <div>
                        <p className="text-[13px] text-white font-medium">
                          {selectedContact.display_name || selectedContact.canonical_name}
                        </p>
                        <p className="text-[11px] text-zinc-500 mt-0.5">
                          Last transaction {formatDate(selectedContact.last_transaction_date)}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => router.push(selectedContact.entity_type === "customer" ? "/dashboard/customers" : "/dashboard/vendors")}
                      className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      View Profile
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {/* Activity Log */}
                <div className="space-y-3">
                  <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Activity Log</p>
                  <div className="relative pl-4">
                    <div className="absolute left-0 top-0 bottom-0 w-px bg-white/[0.06]" />
                    {selectedContact.last_transaction_date && (
                      <div className="relative mb-4">
                        <div className="absolute -left-[17px] top-1 h-2 w-2 rounded-full bg-zinc-500 border border-[#0A0A0A]" />
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-[12px] text-zinc-300">Last transaction</p>
                            <p className="text-[11px] text-zinc-600 mt-0.5">{formatDate(selectedContact.last_transaction_date)}</p>
                          </div>
                          <Clock className="h-3.5 w-3.5 text-zinc-700" />
                        </div>
                      </div>
                    )}
                    <div className="relative mb-4 opacity-30">
                      <div className="absolute -left-[17px] top-1 h-2 w-2 rounded-full bg-zinc-700 border border-[#0A0A0A]" />
                      <p className="text-[11px] text-zinc-600 italic">Email sent — coming soon</p>
                    </div>
                    <div className="relative opacity-30">
                      <div className="absolute -left-[17px] top-1 h-2 w-2 rounded-full bg-zinc-700 border border-[#0A0A0A]" />
                      <p className="text-[11px] text-zinc-600 italic">Call logged — coming soon</p>
                    </div>
                  </div>
                </div>

                {/* Relationship Context (Supermemory) */}
                <div className="space-y-3 border-t border-white/[0.06] pt-6">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 text-zinc-500" />
                    <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Relationship Context</p>
                  </div>

                  {contactContext === null && (
                    <div className="space-y-2">
                      <p className="text-[11px] text-zinc-600 italic">Searching memory…</p>
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-4/5" />
                      <Skeleton className="h-3 w-3/5" />
                    </div>
                  )}

                  {contactContext === "exhausted" && (
                    <p className="text-[12px] text-zinc-700 italic">No documents found in memory layer</p>
                  )}

                  {contactContext !== null && contactContext !== "exhausted" && (
                    <div className="space-y-3">
                      {contactContext.contractTerms && (
                        <div className="flex items-start gap-2">
                          <span className="text-[10px] text-zinc-600 uppercase tracking-wide w-24 shrink-0 pt-0.5">Contract</span>
                          <span className="text-[12px] text-zinc-300">{contactContext.contractTerms}</span>
                        </div>
                      )}
                      {contactContext.relationshipNotes && (
                        <div className="flex items-start gap-2">
                          <span className="text-[10px] text-zinc-600 uppercase tracking-wide w-24 shrink-0 pt-0.5">Relationship</span>
                          <Badge className="bg-white/5 text-zinc-400 border-white/10 text-[10px]">
                            {contactContext.relationshipNotes}
                          </Badge>
                        </div>
                      )}
                      {contactContext.rawContext && (
                        <div className="bg-white/[0.02] border border-white/[0.05] rounded-lg p-3 space-y-2">
                          {contactContext.rawContext
                            .split("\n\n")
                            .filter(Boolean)
                            .slice(0, 3)
                            .map((snippet, i) => (
                              <p key={i} className="text-[11px] text-zinc-500 leading-relaxed border-b border-white/[0.04] last:border-0 pb-2 last:pb-0">
                                {snippet.slice(0, 180)}{snippet.length > 180 ? "…" : ""}
                              </p>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

"use client"

import { useEffect, useState } from "react"
import { Loader2, FileText, CreditCard, FileJson } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"

interface SearchResult {
  type: "transaction" | "invoice" | "document"
  id: string
  title: string
  snippet: string
  date: string
  amount?: number
  relevanceScore: number
  source?: string
}

interface CustomerSearchResultsProps {
  customerId: string
  query: string
}

function getSourceIcon(type: string) {
  switch (type) {
    case "transaction":
      return <CreditCard className="w-4 h-4 text-blue-400" />
    case "invoice":
      return <FileText className="w-4 h-4 text-amber-400" />
    case "document":
      return <FileJson className="w-4 h-4 text-purple-400" />
    default:
      return <FileText className="w-4 h-4 text-neutral-400" />
  }
}

function getSourceColor(type: string): string {
  switch (type) {
    case "transaction":
      return "bg-blue-500/10 border-blue-500/20"
    case "invoice":
      return "bg-amber-500/10 border-amber-500/20"
    case "document":
      return "bg-purple-500/10 border-purple-500/20"
    default:
      return "bg-white/[0.03] border-white/[0.06]"
  }
}

function formatCurrency(amount: number | undefined): string {
  if (!amount) return ""
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`
  return `$${amount.toFixed(0)}`
}

function formatDate(dateString: string): string {
  try {
    return new Date(dateString).toLocaleDateString()
  } catch {
    return dateString
  }
}

export function CustomerSearchResults({
  customerId,
  query,
}: CustomerSearchResultsProps) {
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!query || query.length < 2) {
      setResults([])
      return
    }

    const searchTimeout = setTimeout(() => {
      performSearch()
    }, 300)

    return () => clearTimeout(searchTimeout)
  }, [query, customerId])

  const performSearch = async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(
        `/api/dashboard/customer-detail/${customerId}/search?q=${encodeURIComponent(query)}`
      )

      if (!response.ok) {
        throw new Error("Search failed")
      }

      const data = await response.json()
      setResults(data.results || [])
    } catch (err) {
      console.error("Search error:", err)
      setError("Failed to search")
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full bg-white/10 rounded" />
        <Skeleton className="h-12 w-full bg-white/10 rounded" />
        <Skeleton className="h-12 w-full bg-white/10 rounded" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
        <p className="text-[12px] text-red-400">{error}</p>
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
        <p className="text-[12px] text-neutral-500">No results found for "{query}"</p>
      </div>
    )
  }

  return (
    <div className="space-y-2 max-h-[400px] overflow-y-auto">
      {results.map((result) => (
        <div
          key={`${result.type}-${result.id}`}
          className={`border rounded-lg p-3 cursor-pointer transition-colors hover:bg-white/[0.05] ${getSourceColor(result.type)}`}
        >
          <div className="flex items-start gap-3">
            <div className="mt-1">{getSourceIcon(result.type)}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-[12px] font-medium text-neutral-300 truncate">
                  {result.title}
                </p>
                <span className="text-[10px] text-neutral-600 whitespace-nowrap">
                  {result.relevanceScore.toFixed(0)}%
                </span>
              </div>
              <p className="text-[11px] text-neutral-400 line-clamp-2 mb-2">
                {result.snippet}
              </p>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-neutral-600">
                  {result.source}
                </span>
                <div className="flex items-center gap-2">
                  {result.date && (
                    <span className="text-[10px] text-neutral-600">
                      {formatDate(result.date)}
                    </span>
                  )}
                  {result.amount !== undefined && (
                    <span className="text-[10px] font-medium text-neutral-300">
                      {formatCurrency(result.amount)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

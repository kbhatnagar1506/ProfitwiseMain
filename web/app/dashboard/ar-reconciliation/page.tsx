"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { ArrowUpRight, ArrowDownLeft, RefreshCw } from "lucide-react"

interface ARReconciliationSummary {
  unmatched_cash: number
  unmatched_count: number
  reconciled_count: number
  bank_cash_cleared: number
  excluded_count: number
  excluded_amount: number
  coverage_percent: number
  matched_amount: number
  unmatched_amount: number
  ar: {
    total_invoices: number
    total_amount: number
    matched_count: number
    matched_amount: number
    unmatched_count: number
    unmatched_amount: number
    outstanding_count: number
    outstanding_amount: number
    verified_percent: number
    books_paid_amount: number
  }
  matches: {
    by_type: {
      exact: number
      fee_adjusted: number
      partial: number
    }
    by_source: {
      ai: number
      manual: number
    }
    avg_confidence: number
    total_fees: number
  }
  review_count: number
}

interface ARMatch {
  id: string
  movement_id: string
  cash_event_id: string
  bank_date: string
  bank_description: string
  bank_counterparty: string
  bank_amount: number
  invoice_id: string
  customer_name: string
  invoice_amount: number
  match_type: string
  confidence: number
  fee_amount: number
  matched_amount: number
  matched_by: string
  status: string
  confirmed_at: string | null
  created_at: string
}

export default function ARReconciliationPage() {
  const [summary, setSummary] = useState<ARReconciliationSummary | null>(null)
  const [matches, setMatches] = useState<ARMatch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)
  const [searchTerm, setSearchTerm] = useState("")

  const fetchData = async () => {
    try {
      setLoading(true)
      setError(null)

      // Fetch summary
      const summaryRes = await fetch("/api/ar-reconciliation/summary")
      if (!summaryRes.ok) throw new Error("Failed to fetch summary")
      const summaryData = await summaryRes.json()
      setSummary(summaryData)

      // Fetch matches
      const matchesRes = await fetch(
        `/api/ar-reconciliation/matches?${statusFilter ? `status=${statusFilter}` : ""}`
      )
      if (!matchesRes.ok) throw new Error("Failed to fetch matches")
      const matchesData = await matchesRes.json()
      setMatches(matchesData.matches)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [statusFilter])

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value)
  }

  const formatPercent = (value: number) => `${Math.round(value)}%`

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "confirmed":
        return <Badge className="bg-green-500">Confirmed</Badge>
      case "pending":
        return <Badge className="bg-yellow-500">Pending</Badge>
      case "rejected":
        return <Badge className="bg-red-500">Rejected</Badge>
      default:
        return <Badge>{status}</Badge>
    }
  }

  const getMatchTypeBadge = (type: string) => {
    switch (type) {
      case "EXACT":
        return <Badge className="bg-blue-500">Exact</Badge>
      case "FEE":
        return <Badge className="bg-purple-500">Fee Adjusted</Badge>
      case "PARTIAL":
        return <Badge className="bg-orange-500">Partial</Badge>
      default:
        return <Badge>{type}</Badge>
    }
  }

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-2" />
          <p>Loading AR Reconciliation...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-red-500">
          <CardHeader>
            <CardTitle className="text-red-500">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{error}</p>
            <Button onClick={fetchData} className="mt-4">
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">AR Reconciliation</h1>
          <p className="text-gray-500">Match customer payments to invoices</p>
        </div>
        <Button onClick={fetchData} variant="outline" size="sm">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">
              UNMATCHED CASH
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-500">
              {formatCurrency(summary?.unmatched_cash || 0)}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {summary?.unmatched_count || 0} movements need action
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">
              RECONCILED MOVEMENTS
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-500">
              {summary?.reconciled_count || 0}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {formatCurrency(summary?.bank_cash_cleared || 0)} bank cleared
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">
              EXCLUDED
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {summary?.excluded_count || 0}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {formatCurrency(summary?.excluded_amount || 0)} non-operating
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">
              COVERAGE
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-500">
              {formatPercent(summary?.coverage_percent || 0)}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {formatCurrency(summary?.matched_amount || 0)} matched
            </p>
          </CardContent>
        </Card>
      </div>

      {/* AR Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">ACCOUNTS RECEIVABLE</CardTitle>
            <CardDescription>
              {formatPercent(summary?.ar.verified_percent || 0)} verified
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Total</span>
                <span className="font-semibold">
                  {formatCurrency(summary?.ar.total_amount || 0)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Matched (Bank Verified)</span>
                <span className="font-semibold text-green-500">
                  {formatCurrency(summary?.ar.matched_amount || 0)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Unmatched</span>
                <span className="font-semibold text-red-500">
                  {formatCurrency(summary?.ar.unmatched_amount || 0)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Outstanding</span>
                <span className="font-semibold">
                  {formatCurrency(summary?.ar.outstanding_amount || 0)}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">MATCH STATISTICS</CardTitle>
            <CardDescription>
              Avg confidence: {(summary?.matches.avg_confidence || 0).toFixed(2)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Exact Matches</span>
                <span className="font-semibold">
                  {summary?.matches.by_type.exact || 0}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Fee Adjusted</span>
                <span className="font-semibold">
                  {summary?.matches.by_type.fee_adjusted || 0}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Partial Matches</span>
                <span className="font-semibold">
                  {summary?.matches.by_type.partial || 0}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Total Fees Detected</span>
                <span className="font-semibold">
                  {formatCurrency(summary?.matches.total_fees || 0)}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Matches Table */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <div>
              <CardTitle>Bank to Invoice Matches</CardTitle>
              <CardDescription>
                {matches.length} matches
                {statusFilter && ` (${statusFilter})`}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Search..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-48"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="all" onValueChange={setStatusFilter}>
            <TabsList>
              <TabsTrigger value={undefined as any}>All</TabsTrigger>
              <TabsTrigger value="confirmed">Confirmed</TabsTrigger>
              <TabsTrigger value="pending">Pending</TabsTrigger>
              <TabsTrigger value="rejected">Rejected</TabsTrigger>
            </TabsList>

            <TabsContent value={statusFilter as any} className="mt-4">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Bank Description</TableHead>
                      <TableHead>Bank Amount</TableHead>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Invoice Amount</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Confidence</TableHead>
                      <TableHead>Fee</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {matches
                      .filter(
                        (m) =>
                          !searchTerm ||
                          m.bank_description
                            .toLowerCase()
                            .includes(searchTerm.toLowerCase()) ||
                          m.customer_name
                            .toLowerCase()
                            .includes(searchTerm.toLowerCase()) ||
                          m.invoice_id.includes(searchTerm)
                      )
                      .map((match) => (
                        <TableRow key={match.id}>
                          <TableCell className="text-sm">
                            {new Date(match.bank_date).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-sm">
                            {match.bank_description}
                          </TableCell>
                          <TableCell className="text-sm font-semibold">
                            {formatCurrency(match.bank_amount)}
                          </TableCell>
                          <TableCell className="text-sm">
                            #{match.invoice_id}
                          </TableCell>
                          <TableCell className="text-sm">
                            {match.customer_name}
                          </TableCell>
                          <TableCell className="text-sm">
                            {formatCurrency(match.invoice_amount)}
                          </TableCell>
                          <TableCell>
                            {getMatchTypeBadge(match.match_type)}
                          </TableCell>
                          <TableCell className="text-sm">
                            {(match.confidence * 100).toFixed(0)}%
                          </TableCell>
                          <TableCell className="text-sm">
                            {match.fee_amount > 0
                              ? formatCurrency(match.fee_amount)
                              : "-"}
                          </TableCell>
                          <TableCell>
                            {getStatusBadge(match.status)}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}

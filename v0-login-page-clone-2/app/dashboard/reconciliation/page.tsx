"use client"

import { useState, useEffect } from "react"
import { ARAPReconciliationTable } from "@/components/shared/ar-ap-reconciliation-table"

interface Invoice {
  id: string
  customer_name: string
  amount: number
  outstanding_amount: number
  status: "open" | "partially_paid" | "paid"
  due_date: string
}

interface ReconciliationResponse {
  invoices: Invoice[]
  bills: Invoice[]
}

export default function ReconciliationPage() {
  const [data, setData] = useState<ReconciliationResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        setError(null)
        const response = await fetch("/api/dashboard/reconciliation")
        if (!response.ok) {
          throw new Error("Failed to fetch reconciliation data")
        }
        const result = await response.json()
        setData(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred")
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Reconciliation</h1>
        <p className="text-gray-400">Expected inflows (AR) and outflows (AP). Bank payments matched to invoices. Gross − Fee = Net.</p>
      </div>

      <ARAPReconciliationTable
        invoices={data?.invoices || []}
        bills={data?.bills || []}
        loading={loading}
        error={error}
      />
    </div>
  )
}

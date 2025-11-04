"use client"

import Link from "next/link"

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-black font-sans text-white p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <Link href="/onboarding" className="text-sm text-gray-400 hover:text-white">Onboarding</Link>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-6">
          <p className="text-gray-300 text-sm">
            AR/AP reconciliation, state objects, and cashflow forecast are being rebuilt.
            This page currently shows placeholders.
          </p>
          <div className="mt-4">
            <Link
              href="/payments"
              className="rounded-lg border border-white/15 bg-white/5 px-4 py-3 hover:bg-white/10 transition text-sm font-medium text-white"
            >
              Go to payments placeholder
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

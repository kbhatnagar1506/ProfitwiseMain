"use client"

/**
 * Single full-screen AR/AP dashboard: snapshot, cash explanation, AR table, AP table, bank tagging, suggestions — no other route needed.
 */
export default function PaymentsPage() {
  return (
    <div className="min-h-screen bg-black text-white p-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-2">AR/AP dashboard (disabled)</h1>
        <p className="text-sm text-gray-400">
          AR/AP reconciliation, state objects, and cashflow forecast are temporarily disabled while we rebuild the
          logic.
        </p>
      </div>
    </div>
  )
}

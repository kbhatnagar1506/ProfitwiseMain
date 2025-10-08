"use client"

import { ArApReconciliationView } from "@/components/ar-ap-reconciliation-view"

/**
 * Single full-screen AR/AP dashboard: snapshot, cash explanation, AR table, AP table, bank tagging, suggestions — no other route needed.
 */
export default function PaymentsPage() {
  return (
    <ArApReconciliationView
      pageTitle="AR/AP dashboard"
      pageSubtitle="Normalized snapshot, cash explanation, receivables, payables, and bank links (Gross − Fee = Net) — everything on this page."
    />
  )
}

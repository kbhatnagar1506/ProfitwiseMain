"use client"

import { useState } from "react"
import { Header } from "@/components/dashboard/header"
import { Sidebar } from "@/components/dashboard/sidebar"
import { AccountsSidebar } from "@/components/dashboard/accounts-sidebar"
import { TransactionsPanel } from "@/components/dashboard/transactions-panel"
import { AskDigits } from "@/components/dashboard/ask-digits"
import { CustomReportsPage } from "@/components/dashboard/pages/custom-reports"
import { LedgerPage } from "@/components/dashboard/pages/ledger"
import { BillsPage } from "@/components/dashboard/pages/bills"
import { InvoicesPage } from "@/components/dashboard/pages/invoices"
import { VendorsPage } from "@/components/dashboard/pages/vendors"
import { CustomersPage } from "@/components/dashboard/pages/customers"
import { FinancialsPage } from "@/components/dashboard/pages/financials"
import { DocumentsPage } from "@/components/dashboard/pages/documents"
import { ReconciliationsPage } from "@/components/dashboard/pages/reconciliations"
import { ConnectionsPage } from "@/components/dashboard/pages/connections"
import { HomePage } from "@/components/dashboard/pages/home"

export default function DashboardPage() {
  const [activePage, setActivePage] = useState("Home")

  const renderContent = () => {
    switch (activePage) {
      case "Home":
        return <HomePage />
      case "Custom Reports":
        return <CustomReportsPage />
      case "Ledger":
        return <LedgerPage />
      case "Bills":
        return <BillsPage />
      case "Invoices":
        return <InvoicesPage />
      case "Vendors":
        return <VendorsPage />
      case "Customers":
        return <CustomersPage />
      case "Financials":
        return <FinancialsPage />
      case "Documents":
        return <DocumentsPage />
      case "Reconciliations":
        return <ReconciliationsPage />
      case "Connections":
        return <ConnectionsPage />
      case "Banks & Cards":
      default:
        return (
          <>
            <AccountsSidebar />
            <div className="flex-1 flex flex-col overflow-hidden">
              <TransactionsPanel />
            </div>
          </>
        )
    }
  }

  return (
    <div className="flex flex-col h-screen bg-black">
      {activePage !== "Home" && <Header activePage={activePage} />}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar activePage={activePage} setActivePage={setActivePage} />
        {renderContent()}
      </div>
      {activePage !== "Connections" && activePage !== "Home" && <AskDigits />}
    </div>
  )
}

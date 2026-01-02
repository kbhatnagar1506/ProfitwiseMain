"use client"

import { useState, useEffect } from "react"
import { Sidebar, SidebarProvider } from "@/components/ui/sidebar"
import { TopNavBar } from "./top-nav-bar"
import { SidebarNavigation } from "./sidebar-navigation"
import { SyncStatusPoller } from "./sync-status-poller"

interface DashboardLayoutProps {
  children: React.ReactNode
}

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const [mounted, setMounted] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return null
  }

  return (
    <div className="flex flex-col h-screen w-full bg-[#111111] overflow-hidden">
      <TopNavBar />

      <SidebarProvider defaultOpen={true}>
        <div className="flex flex-1 w-full overflow-hidden">
          <Sidebar className="!bg-[#0c0c0c] !border-r !border-white/[0.06] !text-white !relative !h-full !inset-auto">
            <SidebarNavigation />
          </Sidebar>

          <main className="flex-1 overflow-auto px-8 py-6 bg-[#111111]">
            <div className="max-w-6xl">
              {children}
            </div>
          </main>
        </div>
      </SidebarProvider>

      <SyncStatusPoller key={refreshKey} onComplete={() => setRefreshKey(k => k + 1)} />
    </div>
  )
}

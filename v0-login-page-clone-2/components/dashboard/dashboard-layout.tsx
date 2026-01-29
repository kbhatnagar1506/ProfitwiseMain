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
    <div className="flex h-screen w-full bg-black overflow-hidden">
      <SidebarProvider defaultOpen={true}>
        <div className="flex flex-1 w-full overflow-hidden">
          <Sidebar className="!bg-transparent !border-r-0 !text-white !relative !h-full !inset-auto">
            <SidebarNavigation />
          </Sidebar>

          <div className="flex flex-col flex-1 min-w-0 bg-[#0A0A0A] rounded-tl-2xl border-t border-l border-white/[0.06] shadow-2xl">
            <TopNavBar />
            <main className="flex-1 overflow-auto px-8 py-6">
              <div className="max-w-6xl">
                {children}
              </div>
            </main>
          </div>
        </div>
      </SidebarProvider>

      <SyncStatusPoller key={refreshKey} onComplete={() => setRefreshKey(k => k + 1)} />
    </div>
  )
}

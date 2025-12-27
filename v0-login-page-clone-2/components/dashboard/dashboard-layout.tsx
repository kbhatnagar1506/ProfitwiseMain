"use client"

import { useState, useEffect } from "react"
import { Sidebar, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TopNavBar } from "./top-nav-bar"
import { SidebarNavigation } from "./sidebar-navigation"

interface DashboardLayoutProps {
  children: React.ReactNode
}

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return null
  }

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex h-screen w-full bg-background">
        {/* Sidebar */}
        <Sidebar className="border-r border-border bg-sidebar text-sidebar-foreground">
          <SidebarNavigation isCollapsed={false} />
        </Sidebar>

        {/* Main Content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Top Navigation */}
          <TopNavBar />

          {/* Page Content */}
          <main className="flex-1 overflow-auto pt-16 px-6 py-6">
            <div className="max-w-7xl mx-auto">
              {children}
            </div>
          </main>
        </div>
      </div>
    </SidebarProvider>
  )
}

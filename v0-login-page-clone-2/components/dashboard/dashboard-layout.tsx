"use client"

import { useState, useEffect } from "react"
import { Sidebar, SidebarProvider } from "@/components/ui/sidebar"
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
    <>
      {/* Top Navigation - Fixed at top */}
      <TopNavBar />

      {/* Main Layout - Below header */}
      <SidebarProvider defaultOpen={true}>
        <div className="flex h-[calc(100vh-64px)] w-full bg-background pt-0 mt-16">
          {/* Sidebar - Black background with forced styles */}
          <Sidebar className="!bg-black !border-r !border-white/10 !text-white transition-all duration-300 ease-in-out">
            <SidebarNavigation isCollapsed={false} />
          </Sidebar>

          {/* Main Content */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Page Content */}
            <main className="flex-1 overflow-auto px-6 py-6">
              <div className="max-w-7xl mx-auto">
                {children}
              </div>
            </main>
          </div>
        </div>
      </SidebarProvider>
    </>
  )
}

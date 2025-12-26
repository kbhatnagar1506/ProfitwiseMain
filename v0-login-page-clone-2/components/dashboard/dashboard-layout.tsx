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
    <div className="flex flex-col h-screen w-full bg-background overflow-hidden">
      <TopNavBar />

      <SidebarProvider defaultOpen={true}>
        <div className="flex flex-1 w-full overflow-hidden">
          <Sidebar className="!bg-black !border-r !border-white/10 !text-white !relative !h-full !inset-auto transition-all duration-300 ease-in-out">
            <SidebarNavigation isCollapsed={false} />
          </Sidebar>

          <main className="flex-1 overflow-auto px-6 py-6">
            <div className="max-w-7xl mx-auto">
              {children}
            </div>
          </main>
        </div>
      </SidebarProvider>
    </div>
  )
}

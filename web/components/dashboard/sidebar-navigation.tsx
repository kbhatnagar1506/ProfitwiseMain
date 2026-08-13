"use client"

import { useState, useEffect } from "react"
import { SidebarContent, SidebarFooter } from "@/components/ui/sidebar"
import { NavigationGroup } from "./navigation-group"
import { BottomBar } from "./bottom-bar"
import { dashboardNavigation, type NavGroup } from "@/lib/dashboard-navigation"

const badgeMap: Record<string, { countKey: string; color: "amber" | "red" | "green" }> = {
  "/dashboard/review-queue": { countKey: "review_queue", color: "amber" },
  "/dashboard/chase-queue": { countKey: "chase_queue", color: "amber" },
  "/dashboard/alerts": { countKey: "alerts", color: "red" },
}

export function SidebarNavigation() {
  const [counts, setCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    let cancelled = false
    const fetchCounts = async () => {
      try {
        const res = await fetch("/api/dashboard/sidebar-counts")
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setCounts(data)
      } catch { /* silent */ }
    }
    fetchCounts()
    const interval = setInterval(fetchCounts, 60_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const enrichedNav: NavGroup[] = dashboardNavigation.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      const mapping = badgeMap[item.href]
      if (!mapping) return item
      const count = counts[mapping.countKey]
      if (!count || count <= 0) return item
      return { ...item, badge: count, badgeColor: mapping.color }
    }),
  }))

  return (
    <>
      <SidebarContent className="flex flex-col gap-0 overflow-y-auto scrollbar-thin">
        {enrichedNav.map((group, i) => (
          <NavigationGroup key={group.label} group={group} isFirst={i === 0} />
        ))}
        <div className="h-4" />
      </SidebarContent>
      <SidebarFooter className="p-0 mt-auto shrink-0">
        <BottomBar />
      </SidebarFooter>
    </>
  )
}

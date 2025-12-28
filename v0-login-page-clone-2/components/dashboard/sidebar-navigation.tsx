"use client"

import { useEffect, useState } from "react"
import { SidebarContent, SidebarFooter } from "@/components/ui/sidebar"
import { NavigationGroup } from "./navigation-group"
import { BottomBar } from "./bottom-bar"
import { dashboardNavigation } from "@/lib/dashboard-navigation"

interface SidebarNavigationProps {
  isCollapsed: boolean
}

const EXPANDED_GROUP_KEY = "profitwise-expanded-group"

export function SidebarNavigation({ isCollapsed }: SidebarNavigationProps) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)

  // Load expanded group from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(EXPANDED_GROUP_KEY)
    setExpandedGroup(saved || dashboardNavigation[0]?.label || null)
    setMounted(true)
  }, [])

  const handleToggleGroup = (groupLabel: string) => {
    const newExpanded = expandedGroup === groupLabel ? null : groupLabel
    setExpandedGroup(newExpanded)
    if (newExpanded) {
      localStorage.setItem(EXPANDED_GROUP_KEY, newExpanded)
    } else {
      localStorage.removeItem(EXPANDED_GROUP_KEY)
    }
  }

  if (!mounted) {
    return null
  }

  return (
    <>
      <SidebarContent className="flex flex-col gap-1 px-1 py-2 transition-all duration-300 ease-in-out">
        {dashboardNavigation.map((group) => (
          <NavigationGroup
            key={group.label}
            group={group}
            isExpanded={expandedGroup === group.label}
            onToggle={() => handleToggleGroup(group.label)}
            isCollapsed={isCollapsed}
          />
        ))}
      </SidebarContent>
      <SidebarFooter className="px-1 py-2 transition-all duration-300 ease-in-out">
        <BottomBar isCollapsed={isCollapsed} />
      </SidebarFooter>
    </>
  )
}

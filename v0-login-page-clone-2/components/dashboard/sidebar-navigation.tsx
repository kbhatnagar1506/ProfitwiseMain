"use client"

import { useEffect, useState } from "react"
import { SidebarContent, SidebarFooter } from "@/components/ui/sidebar"
import { NavigationGroup } from "./navigation-group"
import { BottomBar } from "./bottom-bar"
import { dashboardNavigation } from "@/lib/dashboard-navigation"

interface SidebarNavigationProps {
  isCollapsed: boolean
}

const EXPANDED_GROUPS_KEY = "profitwise-expanded-groups"

export function SidebarNavigation({ isCollapsed }: SidebarNavigationProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(EXPANDED_GROUPS_KEY)
        if (saved) {
          setExpandedGroups(new Set(JSON.parse(saved)))
        } else {
          setExpandedGroups(new Set(dashboardNavigation.map(g => g.label)))
        }
      } else {
        setExpandedGroups(new Set(dashboardNavigation.map(g => g.label)))
      }
    } catch {
      setExpandedGroups(new Set(dashboardNavigation.map(g => g.label)))
    }
    setMounted(true)
  }, [])

  const handleToggleGroup = (groupLabel: string) => {
    const newExpanded = new Set(expandedGroups)
    if (newExpanded.has(groupLabel)) {
      newExpanded.delete(groupLabel)
    } else {
      newExpanded.add(groupLabel)
    }
    setExpandedGroups(newExpanded)
    
    try {
      if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        localStorage.setItem(EXPANDED_GROUPS_KEY, JSON.stringify(Array.from(newExpanded)))
      }
    } catch {
      // Silently fail if localStorage not available
    }
  }

  if (!mounted) {
    return null
  }

  return (
    <>
      <SidebarContent className="flex flex-col gap-0 pt-3 overflow-y-auto">
        {dashboardNavigation.map((group) => (
          <NavigationGroup
            key={group.label}
            group={group}
            isExpanded={expandedGroups.has(group.label)}
            onToggle={() => handleToggleGroup(group.label)}
            isCollapsed={isCollapsed}
          />
        ))}
      </SidebarContent>
      <SidebarFooter className="py-2 mt-auto">
        <BottomBar isCollapsed={isCollapsed} />
      </SidebarFooter>
    </>
  )
}

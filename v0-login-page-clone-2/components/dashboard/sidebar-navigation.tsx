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

  // Load expanded groups from localStorage on mount
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(EXPANDED_GROUPS_KEY)
        if (saved) {
          setExpandedGroups(new Set(JSON.parse(saved)))
        } else {
          // Open all groups by default
          setExpandedGroups(new Set(dashboardNavigation.map(g => g.label)))
        }
      } else {
        // Fallback: open all groups if localStorage not available
        setExpandedGroups(new Set(dashboardNavigation.map(g => g.label)))
      }
    } catch (error) {
      // Fallback: open all groups if localStorage access fails
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
    } catch (error) {
      // Silently fail if localStorage not available
    }
  }

  if (!mounted) {
    return null
  }

  return (
    <>
      <SidebarContent className="flex flex-col gap-1 px-1 py-2 transition-all duration-300 ease-in-out overflow-y-auto">
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
      <SidebarFooter className="px-1 py-2 transition-all duration-300 ease-in-out">
        <BottomBar isCollapsed={isCollapsed} />
      </SidebarFooter>
    </>
  )
}

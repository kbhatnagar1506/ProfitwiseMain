"use client"

import { SidebarContent, SidebarFooter } from "@/components/ui/sidebar"
import { NavigationGroup } from "./navigation-group"
import { BottomBar } from "./bottom-bar"
import { dashboardNavigation } from "@/lib/dashboard-navigation"

export function SidebarNavigation() {
  return (
    <>
      <SidebarContent className="flex flex-col gap-0 overflow-y-auto scrollbar-thin">
        {dashboardNavigation.map((group, i) => (
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

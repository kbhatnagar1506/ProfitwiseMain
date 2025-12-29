"use client"

import { SidebarContent, SidebarFooter } from "@/components/ui/sidebar"
import { NavigationGroup } from "./navigation-group"
import { BottomBar } from "./bottom-bar"
import { dashboardNavigation } from "@/lib/dashboard-navigation"

export function SidebarNavigation() {
  return (
    <>
      <SidebarContent className="flex flex-col gap-0 pt-1 overflow-y-auto">
        {dashboardNavigation.map((group) => (
          <NavigationGroup key={group.label} group={group} />
        ))}
      </SidebarContent>
      <SidebarFooter className="py-2 mt-auto">
        <BottomBar />
      </SidebarFooter>
    </>
  )
}

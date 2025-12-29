"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { NavGroup } from "@/lib/dashboard-navigation"
import { cn } from "@/lib/utils"

interface NavigationGroupProps {
  group: NavGroup
}

const badgeColors = {
  red: "bg-red-500/90 text-white",
  green: "bg-emerald-600/90 text-white",
  amber: "bg-amber-600/90 text-white",
}

export function NavigationGroup({ group }: NavigationGroupProps) {
  const pathname = usePathname()

  return (
    <div className="mb-1">
      <div className="px-3 pt-4 pb-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
          {group.label}
        </span>
      </div>
      <div className="space-y-px">
        {group.items.map((item) => {
          const isActive = pathname === item.href
          const Icon = item.icon

          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "group flex items-center gap-3 px-3 py-2 mx-1.5 rounded-md text-[13px] transition-colors duration-100 cursor-pointer",
                  isActive
                    ? "bg-white/[0.08] text-white"
                    : "text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.04]",
                )}
              >
                <Icon
                  className={cn(
                    "h-[18px] w-[18px] flex-shrink-0",
                    isActive ? "text-neutral-200" : "text-neutral-500 group-hover:text-neutral-400"
                  )}
                  strokeWidth={1.75}
                />
                <span className="flex-1">{item.label}</span>
                {item.badge !== undefined && (
                  <span
                    className={cn(
                      "flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none",
                      badgeColors[item.badgeColor ?? "red"]
                    )}
                  >
                    {item.badge}
                  </span>
                )}
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

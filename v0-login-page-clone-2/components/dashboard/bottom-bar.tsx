"use client"

import Link from "next/link"
import { bottomBarItems } from "@/lib/dashboard-navigation"
import { cn } from "@/lib/utils"

export function BottomBar() {
  return (
    <div className="border-t border-white/[0.06] pt-2">
      <div className="space-y-px">
        {bottomBarItems.map((item) => {
          const Icon = item.icon
          const isLink = item.href.startsWith("/")

          const content = (
            <div className="group flex items-center gap-3 px-3 py-2 mx-1.5 rounded-md text-[13px] text-neutral-500 hover:text-neutral-300 hover:bg-white/[0.04] transition-colors duration-100 cursor-pointer">
              <Icon
                className="h-[18px] w-[18px] flex-shrink-0 text-neutral-600 group-hover:text-neutral-400 transition-colors"
                strokeWidth={1.75}
              />
              <span>{item.label}</span>
            </div>
          )

          if (isLink) {
            return <Link key={item.label} href={item.href}>{content}</Link>
          }

          return <div key={item.label}>{content}</div>
        })}
      </div>
    </div>
  )
}

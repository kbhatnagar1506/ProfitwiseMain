"use client"

import Link from "next/link"
import { bottomBarItems } from "@/lib/dashboard-navigation"

export function BottomBar() {
  return (
    <div className="border-t border-white/[0.06] py-2">
      <div className="space-y-0.5">
        {bottomBarItems.map((item) => {
          const Icon = item.icon
          const isLink = item.href.startsWith("/")

          const content = (
            <div className="group flex items-center gap-2.5 px-3 py-[7px] mx-2 rounded-md text-[13px] text-neutral-500 hover:text-neutral-300 hover:bg-white/[0.05] transition-colors duration-100 cursor-pointer">
              <Icon
                className="h-4 w-4 flex-shrink-0 text-neutral-600 group-hover:text-neutral-400 transition-colors"
                strokeWidth={1.75}
              />
              <span className="leading-none">{item.label}</span>
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

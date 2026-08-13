import { NextRequest, NextResponse } from "next/server"
import { getAppBaseUrl } from "@/lib/supermemory"
import { log } from "@/lib/logger"

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ provider: string }> }
) {
  const { provider } = await context.params
  const base = getAppBaseUrl()

  log("oauth.callback.received", { provider }, "supermemory")

  const url = new URL("/onboarding", base)
  url.searchParams.set("integration", provider)
  url.searchParams.set("supermemory_status", "connected")

  return NextResponse.redirect(url, 302)
}


import { NextRequest, NextResponse } from "next/server"
import {
  createSupermemoryConnection,
  getAppBaseUrl,
  type SupermemoryProvider,
} from "@/lib/supermemory"
import { log } from "@/lib/logger"

const SUPPORTED_PROVIDERS: SupermemoryProvider[] = ["google-drive", "onedrive", "notion"]

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ provider: string }> }
) {
  const { provider: rawProvider } = await context.params
  const provider = rawProvider as SupermemoryProvider
  const base = getAppBaseUrl()

  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    log("connection.create.rejected", {
      provider: rawProvider,
      reason: "unsupported_provider",
    }, "supermemory")
    return NextResponse.redirect(new URL("/onboarding?error=supermemory_unsupported_provider", base), 302)
  }

  try {
    const connection = await createSupermemoryConnection(provider)
    log("connection.create.redirecting", {
      provider,
      redirectsTo: connection.redirectsTo ?? null,
      authLinkHost: (() => {
        try {
          return new URL(connection.authLink).host
        } catch {
          return null
        }
      })(),
    }, "supermemory")
    return NextResponse.redirect(connection.authLink, 302)
  } catch (err) {
    log("connection.create.failed", {
      provider,
      error: err instanceof Error ? err.message : String(err),
    }, "supermemory")
    return NextResponse.redirect(new URL("/onboarding?error=supermemory_connection_failed", base), 302)
  }
}


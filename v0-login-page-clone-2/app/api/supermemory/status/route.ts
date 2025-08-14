import { NextRequest, NextResponse } from "next/server"
import Supermemory from "supermemory"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getOrgFinanceTag, type SupermemoryProvider } from "@/lib/supermemory"
import { log } from "@/lib/logger"

const PROVIDERS: { provider: SupermemoryProvider; name: string }[] = [
  { provider: "google-drive", name: "Google Drive" },
  { provider: "onedrive", name: "OneDrive" },
  { provider: "notion", name: "Notion" },
]

function getClient(): Supermemory {
  const apiKey = process.env.SUPERMEMORY_API_KEY
  if (!apiKey) throw new Error("SUPERMEMORY_API_KEY is not set")
  return new Supermemory({ apiKey })
}

/** GET /api/supermemory/status — returns which context-layer providers are connected (Drive, OneDrive, Notion). */
export async function GET(_req: NextRequest) {
  const token = _req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const containerTag = getOrgFinanceTag()
  const client = getClient()
  const connected: string[] = []

  await Promise.all(
    PROVIDERS.map(async ({ provider, name }) => {
      try {
        const res = await client.connections.getByTag(provider, { containerTags: [containerTag] })
        if (res && typeof (res as { id?: string }).id === "string") {
          connected.push(name)
        }
      } catch {
        // 404 or other = not connected for this provider
      }
    })
  )

  return NextResponse.json({ connected })
}

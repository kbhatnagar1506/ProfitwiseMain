import IntuitOAuth from "intuit-oauth"
import { getToken, setToken } from "@/lib/quickbooks-token-store"
import { log } from "@/lib/logger"

const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company"
const QBO_SANDBOX_BASE = "https://sandbox-quickbooks.api.intuit.com/v3/company"
const TOKEN_BUFFER_MS = 60 * 1000

function getOAuthClient() {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  const redirectUri = appUrl ? `${appUrl}/api/quickbooks/oauth/callback` : undefined
  if (!clientId || !clientSecret || !redirectUri) throw new Error("QuickBooks OAuth not configured")
  const OAuthClient = "default" in IntuitOAuth ? (IntuitOAuth as { default: new (c: object) => IntuitOAuthInstance }).default : IntuitOAuth
  return new OAuthClient({
    clientId,
    clientSecret,
    redirectUri,
    environment: process.env.QUICKBOOKS_SANDBOX === "true" ? "sandbox" : "production",
  })
}

interface IntuitOAuthInstance {
  refreshUsingToken(refreshToken: string): Promise<{ getToken: () => QBOTokenShape }>
}

interface QBOTokenShape {
  access_token: string
  refresh_token: string
  expires_in: number
}

export async function getValidAccessToken(realmId: string): Promise<string> {
  log("token.resolve.started", { realmId })
  const stored = await getToken(realmId)
  if (!stored) {
    log("token.resolve.failed", { realmId, reason: "token_missing" })
    throw new Error(`No token for realmId ${realmId}`)
  }
  const now = Date.now()
  const expiresAt = stored.expiresAt ?? 0
  if (stored.accessToken && expiresAt > now + TOKEN_BUFFER_MS) {
    log("token.resolve.succeeded", { realmId, source: "cached" })
    return stored.accessToken
  }

  const oauthClient = getOAuthClient()
  try {
    const authResponse = await oauthClient.refreshUsingToken(stored.refreshToken)
    const token = authResponse.getToken() as QBOTokenShape
    const expiresIn = typeof token.expires_in === "number" ? token.expires_in : parseInt(String(token.expires_in), 10) || 3600
    await setToken(realmId, {
      refreshToken: token.refresh_token ?? stored.refreshToken,
      accessToken: token.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    })
    log("token.refresh.succeeded", { realmId })
    return token.access_token
  } catch (err) {
    log("token.refresh.failed", { realmId, error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

const baseUrl = () =>
  process.env.QUICKBOOKS_SANDBOX === "true" ? QBO_SANDBOX_BASE : QBO_BASE

export async function query(
  realmId: string,
  queryString: string,
  options?: { startPosition?: number; maxResults?: number }
): Promise<{ QueryResponse?: Record<string, unknown[]> }> {
  let q = queryString
  if (options?.startPosition != null || options?.maxResults != null) {
    const sp = options.startPosition ?? 1
    const mr = options.maxResults ?? 1000
    q = `${queryString.trim()} STARTPOSITION ${sp} MAXRESULTS ${mr}`
  }
  const accessToken = await getValidAccessToken(realmId)
  const url = new URL(`${baseUrl()}/${realmId}/query`)
  url.searchParams.set("query", q)

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  })

  if (res.status === 401) {
    const stored = await getToken(realmId)
    if (stored) {
      await setToken(realmId, { ...stored, accessToken: undefined, expiresAt: undefined })
      const retryToken = await getValidAccessToken(realmId)
      const retryRes = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${retryToken}`,
          Accept: "application/json",
        },
      })
      if (!retryRes.ok) {
        const errBody = await retryRes.text()
        log("query.execute.failed", { realmId, status: retryRes.status, error: errBody.slice(0, 200) })
        throw new Error(`QBO query failed: ${retryRes.status}`)
      }
      const retryData = (await retryRes.json()) as { QueryResponse?: Record<string, unknown[]> }
      const retryKey = retryData.QueryResponse ? Object.keys(retryData.QueryResponse)[0] : null
      const retryCount = retryKey ? (retryData.QueryResponse![retryKey] as unknown[]).length : 0
      log("query.execute.succeeded", { realmId, resultCount: retryCount, retried: true })
      return retryData
    }
  }

  if (!res.ok) {
    const errBody = await res.text()
    log("query.execute.failed", { realmId, status: res.status, error: errBody.slice(0, 200) })
    throw new Error(`QBO query failed: ${res.status}`)
  }

  const data = (await res.json()) as { QueryResponse?: Record<string, unknown[]> }
  const key = data.QueryResponse ? Object.keys(data.QueryResponse)[0] : null
  const count = key ? (data.QueryResponse![key] as unknown[]).length : 0
  log("query.execute.succeeded", { realmId, resultCount: count, retried: false })
  return data
}

export const ENTITY_TYPES = [
  "CompanyInfo",
  "Account",
  "Customer",
  "Vendor",
  "Item",
  "Class",
  "Department",
  "Term",
  "PaymentMethod",
  "TaxCode",
  "Preferences",
  "Invoice",
  "Payment",
  "Bill",
  "BillPayment",
  "Purchase",
  "PurchaseOrder",
  "JournalEntry",
  "Transfer",
  "Estimate",
  "CreditMemo",
  "SalesReceipt",
  "RefundReceipt",
  "Deposit",
  "TimeActivity",
  "VendorCredit",
  "Budget",
] as const

export type QBOEntityType = (typeof ENTITY_TYPES)[number]

export async function getEntities(
  realmId: string,
  entityType: QBOEntityType,
  startPosition = 1,
  maxResults = 1000
): Promise<unknown[]> {
  const result = await query(realmId, `SELECT * FROM ${entityType}`, { startPosition, maxResults })
  const key = result.QueryResponse ? Object.keys(result.QueryResponse)[0] : null
  if (!key) return []
  return (result.QueryResponse![key] as unknown[]) ?? []
}

export async function getAllForEntity(
  realmId: string,
  entityType: QBOEntityType
): Promise<unknown[]> {
  const all: unknown[] = []
  let start = 1
  const pageSize = 1000
  for (;;) {
    const page = await getEntities(realmId, entityType, start, pageSize)
    all.push(...page)
    if (page.length < pageSize) break
    start += page.length
  }
  return all
}

const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES)

/** Fetch a single entity by ID (for webhook-driven updates). Returns null if not found or type invalid. */
export async function getEntityById(
  realmId: string,
  entityType: string,
  entityId: string
): Promise<unknown | null> {
  if (!ENTITY_TYPE_SET.has(entityType) || !entityId || !/^[0-9A-Za-z_-]+$/.test(entityId)) {
    return null
  }
  try {
    const result = await query(realmId, `SELECT * FROM ${entityType} WHERE Id = '${entityId}'`, { startPosition: 1, maxResults: 1 })
    const key = result.QueryResponse ? Object.keys(result.QueryResponse)[0] : null
    if (!key) return null
    const arr = (result.QueryResponse![key] as unknown[]) ?? []
    return arr[0] ?? null
  } catch {
    return null
  }
}

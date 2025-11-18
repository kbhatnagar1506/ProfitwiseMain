"use client"

import { useParams, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import Image from "next/image"
import { Loader2, Copy, Check, Plus, Trash2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import whatsappQr from "../../../Screenshot 2026-03-08 at 03.57.15.png"

function CopyableRow({
  label,
  value,
  instruction,
  size = "default",
}: {
  label: string
  value: string
  instruction?: string
  size?: "default" | "large"
}) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  const isLarge = size === "large"
  return (
    <div
      className={`flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 ${isLarge ? "p-4" : "p-3"}`}
    >
      <div className="flex-1 min-w-0">
        {instruction && (
          <p className={`text-gray-400 mb-2 ${isLarge ? "text-sm" : "text-xs"}`}>{instruction}</p>
        )}
        <p className={`text-gray-500 mb-1 ${isLarge ? "text-sm" : "text-xs"}`}>{label}</p>
        <p className={`text-white font-mono break-all ${isLarge ? "text-base" : "text-sm"}`}>{value}</p>
      </div>
      <button
        type="button"
        onClick={copy}
        className={`shrink-0 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors ${isLarge ? "p-3" : "p-2"}`}
        title="Copy"
      >
        {copied ? <Check className={isLarge ? "w-5 h-5 text-emerald-400" : "w-4 h-4 text-emerald-400"} /> : <Copy className={isLarge ? "w-5 h-5" : "w-4 h-4"} />}
      </button>
    </div>
  )
}

export default function OAuthConnectorPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const integration = params.integration as string

  // WhatsApp-specific state
  const [whatsappStatus, setWhatsappStatus] = useState<{ phone: string | null; verified: boolean } | null>(null)
  const [whatsappPhoneInput, setWhatsappPhoneInput] = useState("")
  const [whatsappOtpSent, setWhatsappOtpSent] = useState(false)
  const [whatsappCodeInput, setWhatsappCodeInput] = useState("")
  const [whatsappSendLoading, setWhatsappSendLoading] = useState(false)
  const [whatsappVerifyLoading, setWhatsappVerifyLoading] = useState(false)

  // Gmail invoice senders (emails we'll receive invoices from)
  const [gmailInvoiceSenders, setGmailInvoiceSenders] = useState<string[]>([])
  const [gmailNewEmail, setGmailNewEmail] = useState("")
  const [gmailSaveLoading, setGmailSaveLoading] = useState(false)
  const [gmailSaveMessage, setGmailSaveMessage] = useState<string | null>(null)
  // Gmail inbox connection (single system inbox; only admin can connect)
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null)
  const [gmailConnectedEmail, setGmailConnectedEmail] = useState<string | null>(null)
  const [gmailCanConnect, setGmailCanConnect] = useState(false)
  const [shopDomain, setShopDomain] = useState("")
  const [shopClientId, setShopClientId] = useState("")
  const [shopClientSecret, setShopClientSecret] = useState("")
  const [shopRetentionMode, setShopRetentionMode] = useState<"default" | "12m" | "24m" | "indefinite">("default")
  const [shopConsent, setShopConsent] = useState(false)
  const [shopConnectLoading, setShopConnectLoading] = useState(false)
  const [shopConnectError, setShopConnectError] = useState<string | null>(null)
  const [shopScopesCopied, setShopScopesCopied] = useState(false)
  const [shopConnections, setShopConnections] = useState<Array<{
    shop_domain: string
    status: string
    missing_scopes: string[]
    granted_scopes: string[]
    retention_mode: string
    updated_at: string
  }>>([])

  // Format integration name for display
  const integrationName = integration?.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())

  useEffect(() => {
    if (integration === "whatsapp") {
      // WhatsApp uses in-app setup instead of external OAuth redirect
      setWhatsappStatus(null)
      fetch("/api/whatsapp/status")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { phone: string | null; verified: boolean } | null) => {
          if (data) setWhatsappStatus({ phone: data.phone ?? null, verified: data.verified })
          else setWhatsappStatus({ phone: null, verified: false })
        })
        .catch(() => setWhatsappStatus({ phone: null, verified: false }))
      return
    }

    if (integration === "quickbooks-online") {
      window.location.href = "/api/quickbooks/oauth/authorize"
      return
    }
    if (integration === "stripe") {
      window.location.href = "/api/stripe/oauth/authorize"
      return
    }
    if (integration === "xero") {
      window.location.href = "/api/xero/oauth/authorize"
      return
    }
    if (integration === "google-drive") {
      window.location.href = "/api/supermemory/connections/google-drive"
      return
    }
    if (integration === "onedrive") {
      window.location.href = "/api/supermemory/connections/onedrive"
      return
    }
    if (integration === "notion") {
      window.location.href = "/api/supermemory/connections/notion"
      return
    }
    if (integration === "slack") {
      window.location.href = "/api/slack/oauth/authorize"
      return
    }
    if (integration === "gmail") {
      fetch("/api/gmail/invoice-senders")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { emails?: string[] } | null) => {
          if (data && Array.isArray(data.emails)) setGmailInvoiceSenders(data.emails)
        })
        .catch(() => {})
      fetch("/api/gmail/status")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { connected?: boolean; email?: string; canConnect?: boolean } | null) => {
          if (data) {
            setGmailConnected(!!data.connected)
            setGmailConnectedEmail(data.email ?? null)
            setGmailCanConnect(!!data.canConnect)
          } else setGmailConnected(false)
        })
        .catch(() => setGmailConnected(false))
      return
    }
    if (integration === "shopify") {
      fetch("/api/shopify/status")
        .then((res) => (res.ok ? res.json() : { connections: [] }))
        .then((data: { connections?: Array<{
          shop_domain: string
          status: string
          missing_scopes: string[]
          granted_scopes: string[]
          retention_mode: string
          updated_at: string
        }> }) => setShopConnections(data.connections ?? []))
        .catch(() => setShopConnections([]))
      return
    }
  }, [integration, integrationName])

  if (integration === "shopify") {
    const normalizedShop = shopDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")
    const hasShop = normalizedShop.endsWith(".myshopify.com")
    const adminBase = hasShop ? `https://${normalizedShop}/admin` : "https://admin.shopify.com"
    const appSetupLink = hasShop ? `${adminBase}/apps` : "https://help.shopify.com/en/manual/apps/app-types/custom-apps"
    const appConfigLink = hasShop ? `${adminBase}/settings/apps/development` : "https://help.shopify.com/en/manual/apps/app-types/custom-apps"
    const scopesGuideLink = "https://shopify.dev/docs/api/usage/access-scopes"
    const webhookGuideLink = "https://shopify.dev/docs/apps/build/webhooks/subscribe/https"
    const shopifyDashboardLink = "https://dev.shopify.com/dashboard"
    const scopeCsv = "read_orders,read_customers,read_discounts,read_shopify_payments_payouts"

    return (
      <div className="min-h-screen bg-black flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <h1 className="text-2xl font-semibold text-white mb-2">Connect Shopify (BYO App)</h1>
          <p className="text-sm text-gray-400 mb-6">
            Enter your Shopify app credentials. We use OAuth, enforce required scopes, and securely store only the access token after connection.
          </p>
          <div className="mb-6 rounded-lg border border-white/10 bg-white/[0.02] p-4">
            <p className="text-sm text-white font-medium mb-2">Procedure to connect</p>
            <ol className="list-decimal ml-5 space-y-1 text-sm text-gray-300">
              <li>Create or open your custom Shopify app in your store admin.</li>
              <li>Set app URL/callback URL to this portal callback: <span className="font-mono text-xs text-emerald-300">{`${typeof window !== "undefined" ? window.location.origin : ""}/api/shopify/oauth/callback`}</span></li>
              <li>Enable required read scopes for orders, customers, payouts, disputes, and all-orders history.</li>
              <li>Copy the app Client ID and Client Secret into the form below.</li>
              <li>Click <span className="text-white">Connect Shopify</span> and approve OAuth on Shopify.</li>
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={shopifyDashboardLink} target="_blank" rel="noopener noreferrer" className="text-xs px-2 py-1 rounded border border-white/20 text-gray-200 hover:bg-white/10">
                Open Shopify Dashboard
              </a>
              <a href={appSetupLink} target="_blank" rel="noopener noreferrer" className="text-xs px-2 py-1 rounded border border-white/20 text-gray-200 hover:bg-white/10">
                Open Shopify Apps
              </a>
              <a href={appConfigLink} target="_blank" rel="noopener noreferrer" className="text-xs px-2 py-1 rounded border border-white/20 text-gray-200 hover:bg-white/10">
                Open App Config
              </a>
              <a href={scopesGuideLink} target="_blank" rel="noopener noreferrer" className="text-xs px-2 py-1 rounded border border-white/20 text-gray-200 hover:bg-white/10">
                Scope Docs
              </a>
              <a href={webhookGuideLink} target="_blank" rel="noopener noreferrer" className="text-xs px-2 py-1 rounded border border-white/20 text-gray-200 hover:bg-white/10">
                Webhook Docs
              </a>
            </div>
            <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-3">
              <p className="text-xs text-gray-300 mb-2">Scopes CSV (copy and paste in Shopify app scopes)</p>
              <div className="flex items-center gap-2">
                <code className="text-[11px] text-emerald-300 break-all">{scopeCsv}</code>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(scopeCsv).then(() => {
                      setShopScopesCopied(true)
                      setTimeout(() => setShopScopesCopied(false), 2000)
                    })
                  }}
                  className="shrink-0 rounded-md border border-white/20 px-2 py-1 text-xs text-white hover:bg-white/10"
                >
                  {shopScopesCopied ? "Copied" : "Copy CSV"}
                </button>
              </div>
            </div>
          </div>
          <div className="space-y-4">
            <Input
              placeholder="your-store.myshopify.com"
              value={shopDomain}
              onChange={(e) => setShopDomain(e.target.value)}
              className="bg-white/5 border-white/20 text-white"
            />
            <Input
              placeholder="Client ID"
              value={shopClientId}
              onChange={(e) => setShopClientId(e.target.value)}
              className="bg-white/5 border-white/20 text-white"
            />
            <Input
              type="password"
              placeholder="Client Secret"
              value={shopClientSecret}
              onChange={(e) => setShopClientSecret(e.target.value)}
              className="bg-white/5 border-white/20 text-white"
            />
            <select
              value={shopRetentionMode}
              onChange={(e) => setShopRetentionMode(e.target.value as "default" | "12m" | "24m" | "indefinite")}
              className="w-full rounded-md bg-white/5 border border-white/20 text-white h-10 px-3"
            >
              <option value="default">Retention: default</option>
              <option value="12m">Retention: 12 months</option>
              <option value="24m">Retention: 24 months</option>
              <option value="indefinite">Retention: indefinite</option>
            </select>
            <label className="flex items-start gap-2 text-sm text-gray-300">
              <input type="checkbox" checked={shopConsent} onChange={(e) => setShopConsent(e.target.checked)} className="mt-1" />
              <span>I consent to storing Shopify data per selected retention mode.</span>
            </label>
            {shopConnectError && <p className="text-sm text-red-400">{shopConnectError}</p>}
            <Button
              disabled={shopConnectLoading}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white"
              onClick={async () => {
                setShopConnectError(null)
                setShopConnectLoading(true)
                try {
                  const res = await fetch("/api/shopify/oauth/authorize", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      shop_domain: shopDomain,
                      client_id: shopClientId,
                      client_secret: shopClientSecret,
                      retention_mode: shopRetentionMode,
                      accept_storage_consent: shopConsent,
                    }),
                  })
                  const data = await res.json().catch(() => ({}))
                  if (!res.ok) {
                    setShopConnectError(data.error || "Failed to start Shopify OAuth")
                    return
                  }
                  if (!data.authorize_url) {
                    setShopConnectError("Missing authorize URL")
                    return
                  }
                  window.location.href = data.authorize_url
                } catch {
                  setShopConnectError("Failed to start Shopify OAuth")
                } finally {
                  setShopConnectLoading(false)
                }
              }}
            >
              {shopConnectLoading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Redirecting...
                </span>
              ) : (
                "Connect Shopify"
              )}
            </Button>
            {shopConnections.length > 0 && (
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-sm">
                <p className="text-gray-300 mb-2">Connected stores</p>
                <div className="space-y-2">
                  {shopConnections.map((conn) => (
                    <div key={conn.shop_domain} className="rounded-md border border-white/10 p-2">
                      <p className="text-white font-medium">{conn.shop_domain}</p>
                      <p className="text-xs text-gray-400">Status: {conn.status} | Retention: {conn.retention_mode}</p>
                      {conn.missing_scopes?.length ? (
                        <p className="text-xs text-amber-400">Missing scopes: {conn.missing_scopes.join(", ")}</p>
                      ) : (
                        <p className="text-xs text-emerald-400">All required scopes granted</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => router.back()}
              className="w-full text-sm text-gray-500 hover:text-white hover:underline"
            >
              Back to onboarding
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (integration === "gmail") {
    const GMAIL_FILTERS_URL = "https://mail.google.com/mail/u/0/#settings/filters"
    const GMAIL_FWD_URL = "https://mail.google.com/mail/u/0/#settings/fwdandpop"
    const FORWARD_EMAIL = "invoice@profitwise.app"
    const SUBJECT_FILTER = "invoice OR payment OR bill"
  return (
      <div className="min-h-screen bg-black flex flex-col items-center px-6 py-10">
        <div className="w-full max-w-7xl">
          <div className="text-center mb-10">
          <Image
              src="/profitwise-logo.png"
            alt="ProfitWise"
              width={220}
              height={60}
              className="object-contain mx-auto mb-6"
            />
            <h1 className="text-2xl font-semibold text-white mb-1">Set up Gmail forwarding</h1>
            <p className="text-gray-400 text-sm">
              Forward invoices, payments, and bills to ProfitWise so we can extract and track them.
            </p>
          </div>

          {/* Single system inbox: receives all forwards; only admin can connect (once) */}
          <div className="mb-10 pb-10 border-b border-white/10">
            <h2 className="text-lg font-semibold text-white mb-2">System inbox (forwarding)</h2>
            <p className="text-sm text-gray-400 mb-3">
              One Workspace inbox is connected so we receive all forwarded invoices and can read them on this server. Only the admin can connect or change it.
            </p>
            {searchParams.get("connected") === "1" && (
              <p className="text-sm text-emerald-400 mb-3">Inbox connected successfully.</p>
            )}
            {searchParams.get("error") === "admin_only" && (
              <p className="text-sm text-amber-400 mb-3">Only the admin can connect the inbox.</p>
            )}
            {searchParams.get("error") && searchParams.get("error") !== "admin_only" && (
              <p className="text-sm text-amber-400 mb-3">
                Connection failed: {searchParams.get("error")}. Try again or check Gmail OAuth config.
              </p>
            )}
            {gmailConnected === null ? (
              <p className="text-sm text-gray-500">Checking connection…</p>
            ) : gmailConnected && gmailConnectedEmail ? (
              <p className="text-sm text-emerald-400">
                Connected as {gmailConnectedEmail}
                {!gmailCanConnect && " (only admin can reconnect)."}
              </p>
            ) : !gmailCanConnect ? (
              <p className="text-sm text-gray-500">Inbox connection is managed by admin.</p>
            ) : (
              <Button
                type="button"
                onClick={() => {
                  window.location.href = "/api/gmail/oauth/authorize"
                }}
                className="bg-white/10 text-white hover:bg-white/20 border border-white/20"
              >
                Connect inbox
              </Button>
            )}
          </div>

          <div className="mb-10 pb-10 border-b border-white/10">
            <h2 className="text-lg font-semibold text-white mb-3">Emails we&apos;ll be receiving your invoices from</h2>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm text-gray-400 mb-1">
                List the sender addresses. Click Save to store in your account.
              </p>
              <p className="text-sm text-gray-500 mb-3 italic">
                Note: We recommend adding all addresses that might receive invoices, bills, or payments.
              </p>
              <div className="flex flex-wrap gap-2 mb-3">
                {gmailInvoiceSenders.map((email) => (
                  <div
                    key={email}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white"
                  >
                    <span className="font-mono">{email}</span>
                    <button
                      type="button"
                      onClick={() => setGmailInvoiceSenders((prev) => prev.filter((e) => e !== email))}
                      className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-red-400"
                      title="Remove"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                <Input
                  type="email"
                  placeholder="billing@example.com or @vendor.com"
                  value={gmailNewEmail}
                  onChange={(e) => setGmailNewEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      const v = gmailNewEmail.trim().toLowerCase()
                      if (v && !gmailInvoiceSenders.includes(v)) {
                        setGmailInvoiceSenders((prev) => [...prev, v])
                        setGmailNewEmail("")
                      }
                    }
                  }}
                  className="bg-white/5 border-white/20 text-white placeholder:text-gray-500 max-w-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const v = gmailNewEmail.trim().toLowerCase()
                    if (v && !gmailInvoiceSenders.includes(v)) {
                      setGmailInvoiceSenders((prev) => [...prev, v])
                      setGmailNewEmail("")
                    }
                  }}
                  className="bg-white/10 text-white hover:bg-white/20 border border-white/20"
                >
                  <Plus className="w-4 h-4 mr-1 inline" />
                  Add
                </Button>
                <Button
                  type="button"
                  disabled={gmailSaveLoading}
                  onClick={async () => {
                    setGmailSaveMessage(null)
                    setGmailSaveLoading(true)
                    try {
                      const res = await fetch("/api/gmail/invoice-senders", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ emails: gmailInvoiceSenders }),
                      })
                      const data = await res.json().catch(() => ({}))
                      if (res.ok) {
                        setGmailSaveMessage("Saved to your account.")
                        setTimeout(() => setGmailSaveMessage(null), 4000)
                      } else {
                        setGmailSaveMessage(data.error || "Failed to save")
                      }
                    } catch {
                      setGmailSaveMessage("Failed to save")
                    } finally {
                      setGmailSaveLoading(false)
                    }
                  }}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white"
                >
                  {gmailSaveLoading ? "Saving…" : "Save"}
                </Button>
                {gmailSaveMessage && (
                  <span className={gmailSaveMessage.startsWith("Saved") ? "text-emerald-400 text-sm" : "text-amber-400 text-sm"}>
                    {gmailSaveMessage}
                  </span>
                )}
              </div>
            </div>
        </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-start">
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-white">Step 1 — Set a filter</h2>
              <a
                href={GMAIL_FILTERS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-400 hover:underline block mb-2"
              >
                Open Gmail filters →
              </a>
              <div className="rounded-lg overflow-hidden border border-white/10 bg-white/5 aspect-video w-full min-h-[320px]">
                <video
                  src="/gmail-filter-setup.mp4"
                  controls
                  className="w-full h-full object-contain"
                  playsInline
                  autoPlay
                  muted
                  loop
                >
                  Your browser does not support the video tag.
                </video>
              </div>
              <div className="border-t border-white/10 pt-4 mt-4">
                <p className="text-sm text-gray-400 mb-3">
                  In the filter, set &quot;Subject&quot; to the text below so only invoice, payment, and bill emails are forwarded.
                </p>
                <CopyableRow
                  label="Subject contains (for filter)"
                  value={SUBJECT_FILTER}
                  size="large"
                />
              </div>
            </div>

            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-white">Step 2 — Set forwarding address</h2>
              <a
                href={GMAIL_FWD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-400 hover:underline block mb-2"
              >
                Open Gmail forwarding →
              </a>
              <div className="rounded-lg overflow-hidden border border-white/10 bg-white/5 aspect-video w-full min-h-[320px]">
                <video
                  src="/gmail-forwarding-setup.mp4"
                  controls
                  className="w-full h-full object-contain"
                  playsInline
                  autoPlay
                  muted
                  loop
                >
                  Your browser does not support the video tag.
                </video>
              </div>
              <div className="border-t border-white/10 pt-4 mt-4">
                <p className="text-sm text-gray-400 mb-3">
                  Add this address as the forwarding destination in Gmail. We’ll receive only the emails that match your filter.
                </p>
                <CopyableRow
                  label="Forward to"
                  value={FORWARD_EMAIL}
                  size="large"
                />
              </div>
            </div>
          </div>

          <div className="mt-10 flex justify-center">
            <button
              type="button"
              onClick={() => router.back()}
              className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-white hover:underline"
            >
              <span>←</span>
              <span>Back to onboarding</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (integration === "whatsapp") {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-4xl">
          <div className="text-center mb-12">
            <Image
              src="/profitwise-logo.png"
              alt="ProfitWise"
              width={220}
              height={60}
              className="object-contain mx-auto mb-4"
            />
            <h1 className="text-3xl font-semibold text-white mb-1">Set up WhatsApp</h1>
            <p className="text-gray-400 text-sm mt-2">
              Scan the QR on the left to open WhatsApp, then verify your number on the right.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-start">
            <div className="flex flex-col items-center justify-center">
              <div className="w-48 h-48 mb-5 flex items-center justify-center">
                <Image
                  src={whatsappQr}
                  alt="Scan to open WhatsApp"
                  className="object-contain max-w-full max-h-full rounded-lg"
                />
              </div>
              <p className="text-xs text-gray-300 text-center max-w-sm leading-relaxed">
                Open the camera on your phone, scan this QR, and tap the WhatsApp banner. Then enter your phone and code on
                the right.
              </p>
            </div>

            <div className="flex flex-col items-center justify-center space-y-4">
              <div className="w-16 h-16 flex items-center justify-center">
                <Image
                  src="/whatsapp-logo.png"
                  alt="WhatsApp"
                  width={64}
                  height={64}
                  className="object-contain max-w-full max-h-full"
                />
              </div>
              <h2 className="text-white font-semibold text-base leading-tight">
                Verify your WhatsApp number
              </h2>
              {whatsappStatus === null ? (
                <p className="text-gray-500 text-xs mt-1">Checking status…</p>
              ) : whatsappStatus.verified && whatsappStatus.phone ? (
                <div className="flex flex-col items-center gap-1">
                  <p className="text-emerald-400 text-xs font-medium">Connected as {whatsappStatus.phone}</p>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const res = await fetch("/api/whatsapp/disconnect", { method: "POST" })
                        if (res.ok) {
                          setWhatsappStatus({ phone: null, verified: false })
                          setWhatsappOtpSent(false)
                          setWhatsappCodeInput("")
                          setWhatsappPhoneInput("")
                        }
                      } catch {
                        // ignore
                      }
                    }}
                    className="text-xs text-gray-400 hover:text-red-400 underline"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <div className="w-full max-w-sm space-y-4 mt-2">
                  {!whatsappOtpSent ? (
                    <>
                      <Input
                        placeholder="+1 555 123 4567"
                        value={whatsappPhoneInput}
                        onChange={(e) => setWhatsappPhoneInput(e.target.value)}
                        className="bg-white/5 border-white/20 text-white text-sm h-10"
                      />
                      <Button
                        size="sm"
                        className="w-full h-10"
                        disabled={whatsappSendLoading || !whatsappPhoneInput.trim()}
                        onClick={async () => {
                          setWhatsappSendLoading(true)
                          try {
                            const res = await fetch("/api/whatsapp/request-otp", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ phone: whatsappPhoneInput.trim() }),
                            })
                            const data = await res.json().catch(() => ({}))
                            if (res.ok) setWhatsappOtpSent(true)
                            else alert([data.error || "Could not send code", data.hint].filter(Boolean).join("\n"))
                          } finally {
                            setWhatsappSendLoading(false)
                          }
                        }}
                      >
                        {whatsappSendLoading ? "Sending…" : "Send code"}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Input
                        placeholder="6-digit code"
                        value={whatsappCodeInput}
                        onChange={(e) => setWhatsappCodeInput(e.target.value)}
                        className="bg-white/5 border-white/20 text-white text-sm h-10"
                        maxLength={6}
                      />
                      <Button
                        size="sm"
                        className="w-full h-10"
                        disabled={whatsappVerifyLoading || whatsappCodeInput.replace(/\D/g, "").length !== 6}
                        onClick={async () => {
                          setWhatsappVerifyLoading(true)
                          try {
                            const res = await fetch("/api/whatsapp/verify", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ code: whatsappCodeInput.replace(/\D/g, "") }),
                            })
                            const data = await res.json().catch(() => ({}))
                            if (res.ok) {
                              setWhatsappStatus({ phone: data.phone ?? null, verified: true })
                              setWhatsappOtpSent(false)
                              setWhatsappCodeInput("")
                              setWhatsappPhoneInput("")
                            } else alert(data.error || "Invalid code")
                          } finally {
                            setWhatsappVerifyLoading(false)
                          }
                        }}
                      >
                        {whatsappVerifyLoading ? "Verifying…" : "Verify"}
                      </Button>
                    </>
                  )}
                    <p className="text-[11px] text-gray-500 leading-relaxed text-center mt-1">
                    We use your number only to send messages related to ProfitWise. You can disconnect at any time.
              </p>
            </div>
              )}
          </div>
        </div>

          <div className="mt-10 flex justify-center">
          <button
            type="button"
            onClick={() => router.back()}
              className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-white hover:underline"
          >
              <span>←</span>
              <span>Back to onboarding</span>
          </button>
        </div>
      </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6 py-10">
      <Image
        src="/profitwise-logo.png"
        alt="ProfitWise"
        width={320}
        height={88}
        className="object-contain mb-10"
      />
      <div className="w-16 h-16 rounded-full border-2 border-white/30 border-t-white animate-spin" />
    </div>
  )
}

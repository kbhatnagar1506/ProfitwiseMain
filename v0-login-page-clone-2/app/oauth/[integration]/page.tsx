"use client"

import { useParams, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import Image from "next/image"
import { Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

function normalizeShopInput(value: string): string {
  const s = value.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]
  if (!s) return ""
  return s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`
}

export default function OAuthConnectorPage() {
  const params = useParams()
  const router = useRouter()
  const integration = params.integration as string
  const [shopifyStore, setShopifyStore] = useState("")

  const integrationName = integration?.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())

  useEffect(() => {
    if (integration === "shopify") return
    if (integration === "quickbooks-online") {
      window.location.href = "/api/quickbooks/oauth/authorize"
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
    console.log("[v0] OAuth page loaded for:", integrationName)
  }, [integration, integrationName])

  if (integration === "shopify") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-black via-emerald-950/60 via-30% via-emerald-900/40 via-70% to-black flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <Image
              src="/images/profitwise-logo.png"
              alt="ProfitWise"
              width={180}
              height={45}
              className="object-contain mx-auto mb-12"
            />
          </div>
          <div className="bg-white/5 border border-white/10 rounded-lg p-8 backdrop-blur-sm">
            <h1 className="text-2xl font-semibold text-white mb-3 text-center">Connect Shopify</h1>
            <p className="text-gray-400 text-sm text-center mb-6">
              Enter your Shopify store domain. We’ll redirect you to Shopify to authorize the connection.
            </p>
            <label htmlFor="shopify-store" className="block text-sm font-medium text-gray-300 mb-2">
              Store domain
            </label>
            <Input
              id="shopify-store"
              placeholder="e.g. mystore or mystore.myshopify.com"
              value={shopifyStore}
              onChange={(e) => setShopifyStore(e.target.value)}
              className="bg-white/5 border-white/20 text-white mb-2"
            />
            <p className="text-xs text-gray-500 mb-4">You can find this in your Shopify admin URL.</p>
            <Button
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white"
              disabled={!shopifyStore.trim()}
              onClick={() => {
                const shop = normalizeShopInput(shopifyStore)
                if (shop) window.location.href = `/api/shopify/oauth/authorize?shop=${encodeURIComponent(shop)}`
              }}
            >
              Continue to Shopify
            </Button>
          </div>
          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={() => router.back()}
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              ← Back to onboarding
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-black via-emerald-950/60 via-30% via-emerald-900/40 via-70% to-black flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Image
            src="/images/profitwise-logo.png"
            alt="ProfitWise"
            width={180}
            height={45}
            className="object-contain mx-auto mb-12"
          />
        </div>

        <div className="bg-white/5 border border-white/10 rounded-lg p-8 backdrop-blur-sm">
          <div className="text-center space-y-6">
            <div className="w-20 h-20 bg-white/10 rounded-2xl flex items-center justify-center mx-auto border border-white/20">
              <Loader2 className="w-10 h-10 text-white animate-spin" />
            </div>

            <div>
              <h1 className="text-2xl font-semibold text-white mb-3">Connecting to {integrationName}</h1>
              <p className="text-gray-400 text-sm">
                Please wait while we securely connect your {integrationName} account to ProfitWise...
              </p>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-lg p-4">
              <p className="text-xs text-gray-400 leading-relaxed">
                You will be redirected to {integrationName} to authorize the connection. Your data is encrypted and
                secured with industry-standard protocols.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => router.back()}
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            ← Back to onboarding
          </button>
        </div>
      </div>
    </div>
  )
}

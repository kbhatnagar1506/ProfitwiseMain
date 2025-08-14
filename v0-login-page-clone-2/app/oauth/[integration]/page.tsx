"use client"

import { useParams, useRouter } from "next/navigation"
import { useEffect } from "react"
import Image from "next/image"
import { Loader2 } from "lucide-react"

export default function OAuthConnectorPage() {
  const params = useParams()
  const router = useRouter()
  const integration = params.integration as string

  // Format integration name for display
  const integrationName = integration?.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())

  useEffect(() => {
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

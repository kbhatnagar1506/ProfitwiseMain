"use client"

import { useParams, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import Image from "next/image"
import { Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import whatsappQr from "../../../Screenshot 2026-03-08 at 03.57.15.png"

export default function OAuthConnectorPage() {
  const params = useParams()
  const router = useRouter()
  const integration = params.integration as string

  // WhatsApp-specific state
  const [whatsappStatus, setWhatsappStatus] = useState<{ phone: string | null; verified: boolean } | null>(null)
  const [whatsappPhoneInput, setWhatsappPhoneInput] = useState("")
  const [whatsappOtpSent, setWhatsappOtpSent] = useState(false)
  const [whatsappCodeInput, setWhatsappCodeInput] = useState("")
  const [whatsappSendLoading, setWhatsappSendLoading] = useState(false)
  const [whatsappVerifyLoading, setWhatsappVerifyLoading] = useState(false)

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
    console.log("[v0] OAuth page loaded for:", integrationName)
  }, [integration, integrationName])

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

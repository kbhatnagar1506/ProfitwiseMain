"use client"

import { useState, useEffect, useCallback, useRef, Fragment } from "react"
import { usePlaidLink } from "react-plaid-link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import Image from "next/image"
import whatsappQr from "../Screenshot 2026-03-08 at 03.57.15.png"
import { useRouter } from "next/navigation"
interface Integration {
  name: string
  description: string
  category: string
  logo: string
}

const integrations: Integration[] = [
  {
    name: "QuickBooks Online",
    description: "Cloud accounting for growing businesses",
    category: "Accounting",
    logo: "/quickbooks-logo.png",
  },
  {
    name: "Xero",
    description: "Modern accounting for SMEs",
    category: "Accounting",
    logo: "/xero-logo.png",
  },
  {
    name: "Stripe",
    description: "Revenue, invoices, and subscriptions",
    category: "Revenue",
    logo: "/stripe-logo.png",
  },
  {
    name: "FreshBooks",
    description: "Simple accounting for small businesses",
    category: "Accounting",
    logo: "/freshbooks-logo.png",
  },
  {
    name: "Ramp",
    description: "Spend management and corporate cards",
    category: "Spend Management",
    logo: "/ramp-logo.png",
  },
  {
    name: "Brex",
    description: "Corporate card and spend platform",
    category: "Spend Management",
    logo: "/brex-logo.png",
  },
  {
    name: "Mercury",
    description: "Modern banking for startups and SMBs",
    category: "Business Banking",
    logo: "/mercury-logo.png",
  },
]

const steps = [
  { id: 1, title: "Connect your bank", description: "Securely link your first bank account." },
  { id: 2, title: "Review bank accounts", description: "See balances and add more accounts." },
  { id: 3, title: "Connect accounting tools", description: "Link the accounting and spend tools you already use." },
  {
    id: 4,
    title: "Connect documents & drives",
    description: "Link where your invoices and financial documents live.",
  },
  {
    id: 5,
    title: "Choose communication channels",
    description: "Pick where you want to talk to ProfitWise and receive updates.",
  },
  { id: 6, title: "Company & financial context", description: "Review and refine how we describe your business." },
  { id: 7, title: "Company profile", description: "Fill in key details about how your business is set up." },
  {
    id: 8,
    title: "Review your data",
    description: "Inspect the raw data we’ve pulled in from your banks, accounting tools, and Gmail.",
  },
  {
    id: 9,
    title: "Identity graph",
    description: "See every vendor, customer, and entity we’ve resolved across all your connected sources.",
  },
  {
    id: 10,
    title: "Money movements",
    description: "Every transaction classified: what it is, whether it hits the P&L, and which accounts are involved.",
  },
]

const PLAID_INTEGRATIONS = ["Ramp", "Brex", "Mercury"]

function formatBalance(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

const QBO_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "QuickBooks connection was cancelled. You can try again when you're ready.",
  missing_params: "QuickBooks connection didn't complete. Please try connecting again.",
  state_mismatch: "QuickBooks security check failed. Please try again.",
  config: "QuickBooks isn't configured yet. Please try again later.",
  token_exchange: "QuickBooks connection failed. Please try again.",
}

export function OnboardingFlow({
  qboError,
  initialStep = 1,
}: {
  qboError?: string | null
  initialStep?: number
}) {
  const [currentStep, setCurrentStep] = useState(
    Math.min(Math.max(initialStep, 1), steps.length)
  )
  const [bankConnected, setBankConnected] = useState(false)
  const [dismissedError, setDismissedError] = useState(false)
  const [plaidLinkToken, setPlaidLinkToken] = useState<string | null>(null)
  const [plaidLinkLoading, setPlaidLinkLoading] = useState(false)
  const [plaidLinkError, setPlaidLinkError] = useState<string | null>(null)
  const [connectedItemIds, setConnectedItemIds] = useState<string[]>([])
  const [connectedAccounts, setConnectedAccounts] = useState<
    { name: string; mask: string | null; type: string; current_balance: number | null; available_balance: number | null }[]
  >([])
  const [addAccountLinkToken, setAddAccountLinkToken] = useState<string | null>(null)
  const [addAccountLinkLoading, setAddAccountLinkLoading] = useState(false)
  const [accountingStepLinkToken, setAccountingStepLinkToken] = useState<string | null>(null)
  const [accountingStepLinkLoading, setAccountingStepLinkLoading] = useState(false)
  const [connectedIntegrations, setConnectedIntegrations] = useState<string[]>([])
  const [accountingSyncLoading, setAccountingSyncLoading] = useState(false)
  const [disconnectAccountingLoading, setDisconnectAccountingLoading] = useState(false)
  const [connectedContextIntegrations, setConnectedContextIntegrations] = useState<string[]>([])
  const [companyContextLoading, setCompanyContextLoading] = useState(false)
  const [companyContext, setCompanyContext] = useState<string | null>(null)
  const [companyContextError, setCompanyContextError] = useState<string | null>(null)
  const [refineInput, setRefineInput] = useState("")
  const [refineLoading, setRefineLoading] = useState(false)
  const [editedContext, setEditedContext] = useState<string | null>(null)
  const [contextSelection, setContextSelection] = useState({ start: 0, end: 0, text: "" })
  const [companyForm, setCompanyForm] = useState<Record<string, string>>({})
  const [companyFormLoading, setCompanyFormLoading] = useState(false)
  const [companyFormSaveLoading, setCompanyFormSaveLoading] = useState(false)
  const [companyFormAutofillLoading, setCompanyFormAutofillLoading] = useState(false)
  const [step7BankAccounts, setStep7BankAccounts] = useState<{ name: string; mask: string | null }[]>([])
  type RawDataResponse = {
    plaid: {
      items: string[]
      accounts: { item_id: string; account_id: string; name: string; type: string; subtype: string | null; mask: string | null; current_balance: number | null; available_balance: number | null; currency_code: string | null }[]
      transactions: { item_id: string; account_id: string; transaction_id: string; amount: number; date: string; name: string; merchant_name: string | null; category: string[] | null; pending: boolean }[]
    }
    qbo: Record<string, unknown[]>
    xero: Record<string, unknown[]>
    stripe: Record<string, unknown[]>
    gmail: { extracted: { message_id: string; from_email: string | null; to_emails: string | null; subject: string | null; date_sent: string | null; snippet: string | null; extracted_invoice: unknown }[] }
  }
  const [rawData, setRawData] = useState<RawDataResponse | null>(null)
  const [rawDataLoading, setRawDataLoading] = useState(false)
  const [rawDataError, setRawDataError] = useState<string | null>(null)
  const [whatsappStatus, setWhatsappStatus] = useState<{ phone: string | null; verified: boolean } | null>(null)
  const [whatsappPhoneInput, setWhatsappPhoneInput] = useState("")
  const [whatsappOtpSent, setWhatsappOtpSent] = useState(false)
  const [whatsappCodeInput, setWhatsappCodeInput] = useState("")
  const [whatsappSendLoading, setWhatsappSendLoading] = useState(false)
  const [whatsappVerifyLoading, setWhatsappVerifyLoading] = useState(false)
  type IdentityEntity = { id: string; entity_type: string; canonical_name: string; display_name: string | null; domain: string | null; confidence: number; metadata: Record<string, unknown>; created_at: string; source_count: number; evidence_count: number; sources: string[] }
  type IdentityAlias = { id: string; entity_id: string; alias: string; alias_type: string; source: string; source_id: string | null; confidence: number }
  type IdentityAssertionCount = { entity_id: string; assertion_type: string; source: string; count: number; avg_score: number }
  type IdentityData = { entities: IdentityEntity[]; aliases: IdentityAlias[]; relationships: unknown[]; assertionCounts: IdentityAssertionCount[] }
  const [identityData, setIdentityData] = useState<IdentityData | null>(null)
  const [identityLoading, setIdentityLoading] = useState(false)
  const [identitySeeding, setIdentitySeeding] = useState(false)
  const [identityError, setIdentityError] = useState<string | null>(null)
  const [identityExpandedEntity, setIdentityExpandedEntity] = useState<string | null>(null)
  type MovementRow = { id: string; event_id?: string | null; source: string; source_type: string; source_id: string; entity_id: string | null; date: string; amount: string; raw_description: string | null; counterparty: string | null; movement_class: string; pnl_eligible: boolean; statement_impact?: string | null; movement_subclass?: string | null; from_account: string | null; to_account: string | null; confidence: number; metadata: Record<string, unknown>; created_at: string }
  type EventRow = { id: string; event_id: string | null; date: string; amount: string; counterparty: string | null; raw_description: string | null; movement_class: string; statement_impact: string | null; movement_subclass: string | null; confidence: number; source: string; evidence_count: number }
  type MovementSummary = { movement_class: string; pnl_eligible: boolean; count: number; total_amount: string }
  type MovementsData = { movements: MovementRow[]; events?: EventRow[]; summary: MovementSummary[] }
  const [movementsData, setMovementsData] = useState<MovementsData | null>(null)
  const [movementsLoading, setMovementsLoading] = useState(false)
  const [movementsClassifying, setMovementsClassifying] = useState(false)
  const [movementsError, setMovementsError] = useState<string | null>(null)
  const [movementsExpandedEvent, setMovementsExpandedEvent] = useState<string | null>(null)
  const router = useRouter()

  const COMPANY_FORM_FIELDS: { key: string; label: string; placeholder: string }[] = [
    { key: "companyName", label: "Company name", placeholder: "e.g. Acme Inc." },
    { key: "legalName", label: "Legal name", placeholder: "Registered legal name" },
    { key: "industry", label: "Industry", placeholder: "e.g. Technology, Retail" },
    { key: "businessModel", label: "Business model", placeholder: "e.g. B2B SaaS, Marketplace" },
    { key: "productsServices", label: "Products / Services", placeholder: "What you sell or offer" },
    { key: "annualRevenue", label: "Annual revenue", placeholder: "e.g. $2M, Series A" },
    { key: "teamSize", label: "Team size", placeholder: "e.g. 15, 10-20" },
    { key: "fiscalYearEnd", label: "Fiscal year end", placeholder: "e.g. December, March 31" },
    { key: "hqLocation", label: "HQ location", placeholder: "City, State / Country" },
    { key: "fundingStage", label: "Funding stage", placeholder: "e.g. Bootstrapped, Seed, Series A" },
    { key: "primaryBanks", label: "Primary bank(s)", placeholder: "e.g. Mercury, Brex, Chase" },
    { key: "accountingSystem", label: "Accounting system", placeholder: "e.g. QuickBooks, Xero, NetSuite" },
    { key: "monthlyBurnRunway", label: "Monthly burn / runway", placeholder: "e.g. $50k burn, 18 months runway" },
    { key: "currency", label: "Currency", placeholder: "e.g. USD, EUR" },
    { key: "financeOwnerContact", label: "Key contact / finance owner", placeholder: "Name or title" },
    { key: "departmentsCostCenters", label: "Departments or cost centers", placeholder: "e.g. Engineering, Sales, G&A" },
    { key: "auditFiscalCalendar", label: "Audit / fiscal calendar", placeholder: "e.g. Audit in Q2, Board in March" },
    { key: "keyReportingDates", label: "Key reporting dates", placeholder: "e.g. Board pack by 5th, Close by 10th" },
    { key: "website", label: "Website", placeholder: "https://..." },
    { key: "yearFounded", label: "Year founded", placeholder: "e.g. 2020" },
    { key: "primaryCustomerType", label: "Primary customer type", placeholder: "e.g. SMB, Enterprise, Consumer" },
  ]

  const showQboError = qboError && QBO_ERROR_MESSAGES[qboError] && !dismissedError

  useEffect(() => {
    if (qboError) setDismissedError(false)
  }, [qboError])

  useEffect(() => {
    fetch("/api/onboarding/progress", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: currentStep }),
    }).catch(() => {})
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 1 || bankConnected || plaidLinkToken) return
    setPlaidLinkLoading(true)
    setPlaidLinkError(null)
    fetch("/api/plaid/link-token", { method: "POST" })
      .then((res) => {
        if (!res.ok) throw new Error("Could not start bank connection")
        return res.json()
      })
      .then((data) => {
        if (data.link_token) setPlaidLinkToken(data.link_token)
        else throw new Error("No link token")
      })
      .catch(() => setPlaidLinkError("Bank connection is not available right now. Please try again later."))
      .finally(() => setPlaidLinkLoading(false))
  }, [currentStep, bankConnected, plaidLinkToken])

  const fetchConnectedItems = useCallback(() => {
    fetch("/api/plaid/items")
      .then((res) => (res.ok ? res.json() : { item_ids: [] }))
      .then((data: { item_ids?: string[] }) => setConnectedItemIds(data.item_ids ?? []))
      .catch(() => setConnectedItemIds([]))
    fetch("/api/plaid/balances?refresh=1")
      .then((res) => (res.ok ? res.json() : { accounts: [] }))
      .then(
        (data: {
          accounts?: {
            name: string
            mask?: string | null
            type?: string
            current_balance?: number | string | null
            available_balance?: number | string | null
          }[]
        }) =>
          setConnectedAccounts(
            (data.accounts ?? []).map((a) => ({
              name: a.name ?? "",
              mask: a.mask ?? null,
              type: a.type ?? "account",
              current_balance: a.current_balance != null ? Number(a.current_balance) : null,
              available_balance: a.available_balance != null ? Number(a.available_balance) : null,
            }))
          )
      )
      .catch(() => setConnectedAccounts([]))
  }, [])

  useEffect(() => {
    if (currentStep !== 2) return
    fetchConnectedItems()
    setAddAccountLinkLoading(true)
    setPlaidLinkError(null)
    fetch("/api/plaid/link-token", { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data?.link_token ? setAddAccountLinkToken(data.link_token) : null))
      .finally(() => setAddAccountLinkLoading(false))
  }, [currentStep, fetchConnectedItems])

  const lastAccountingSyncRef = useRef<number>(0)
  const lastRealmCountRef = useRef<number>(0)
  const lastTenantCountRef = useRef<number>(0)
  const SYNC_COOLDOWN_MS = 60_000 // 1 minute: avoid duplicate syncs and QBO 429

  const triggerAccountingSyncIfNeeded = useCallback(
    (realmIds: string[], tenantIds: string[], forceIfNewConnections: boolean) => {
      const now = Date.now()
      const cooldownOk = now - lastAccountingSyncRef.current >= SYNC_COOLDOWN_MS
      const newConnections =
        realmIds.length > lastRealmCountRef.current || tenantIds.length > lastTenantCountRef.current
      if (!cooldownOk && !(forceIfNewConnections && newConnections)) return
      lastAccountingSyncRef.current = now
      lastRealmCountRef.current = realmIds.length
      lastTenantCountRef.current = tenantIds.length
      realmIds.forEach((realmId) => {
        fetch("/api/quickbooks/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ realmId }),
        }).catch(() => {})
      })
      if (tenantIds.length > 0) {
        fetch("/api/xero/sync", { method: "POST" }).catch(() => {})
      }
    },
    []
  )

  useEffect(() => {
    if (currentStep !== 3) return
    setAccountingStepLinkLoading(true)
    setPlaidLinkError(null)
    fetch("/api/plaid/link-token", { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data?.link_token ? setAccountingStepLinkToken(data.link_token) : null))
      .finally(() => setAccountingStepLinkLoading(false))
    fetch("/api/connections")
      .then((res) => (res.ok ? res.json() : { connected: [], realmIds: [], tenantIds: [] }))
      .then((data: { connected?: string[]; realmIds?: string[]; tenantIds?: string[] }) => {
        setConnectedIntegrations(data.connected ?? [])
      })
      .catch(() => setConnectedIntegrations([]))
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 3) return
    const onFocus = () => {
      fetch("/api/connections")
        .then((res) => (res.ok ? res.json() : { connected: [], realmIds: [], tenantIds: [] }))
        .then((data: { connected?: string[]; realmIds?: string[]; tenantIds?: string[] }) => {
          setConnectedIntegrations(data.connected ?? [])
        })
        .catch(() => {})
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") onFocus()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 4) return
    fetch("/api/supermemory/status")
      .then((res) => (res.ok ? res.json() : { connected: [] }))
      .then((data: { connected?: string[] }) => setConnectedContextIntegrations(data.connected ?? []))
      .catch(() => setConnectedContextIntegrations([]))
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 4) return
    const onFocus = () => {
      fetch("/api/supermemory/status")
        .then((res) => (res.ok ? res.json() : { connected: [] }))
        .then((data: { connected?: string[] }) => setConnectedContextIntegrations(data.connected ?? []))
        .catch(() => {})
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") onFocus()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 5) return
    setWhatsappStatus(null)
    fetch("/api/whatsapp/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { phone: string | null; verified: boolean } | null) => {
        if (data) setWhatsappStatus({ phone: data.phone ?? null, verified: data.verified })
        else setWhatsappStatus({ phone: null, verified: false })
      })
      .catch(() => setWhatsappStatus({ phone: null, verified: false }))
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 6) return
    setCompanyContextError(null)
    setCompanyContextLoading(true)

    let pollInterval: ReturnType<typeof setInterval> | null = null

    const stopPolling = () => {
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }
      setCompanyContextLoading(false)
    }

    fetch("/api/context/save")
      .then(async (res) => {
        if (!res.ok) return { ok: false as const, data: { finalContext: null as string | null } }
        const data = (await res.json()) as { finalContext?: string | null }
        return { ok: true as const, data }
      })
      .then((result) => {
        if (result.ok && result.data.finalContext && String(result.data.finalContext).trim()) {
          setCompanyContext(String(result.data.finalContext).trim())
          setEditedContext(null)
          stopPolling()
          return
        }
        if (!result.ok) {
          stopPolling()
          return
        }
        setCompanyContext(null)
        // No saved context: start async build and poll until ready; user gets WhatsApp when done
        return fetch("/api/context/build-and-notify", { method: "POST" })
          .then((res) => {
            if (!res.ok) throw new Error("Failed to start context build")
            return res.json()
          })
          .then(() => {
            const poll = () => {
              fetch("/api/context/save")
                .then((res) => (res.ok ? res.json() : { finalContext: null }))
                .then((data: { finalContext?: string | null }) => {
                  const ctx = data.finalContext && String(data.finalContext).trim()
                  if (ctx) {
                    setCompanyContext(ctx)
                    setEditedContext(null)
                    stopPolling()
                  }
                })
                .catch(() => {})
            }
            poll()
            pollInterval = setInterval(poll, 5000)
          })
      })
      .catch((err) => {
        if (err?.message) setCompanyContextError("We couldn't start building your context. You can try again or continue.")
        stopPolling()
      })
      .finally(() => {
        if (!pollInterval) setCompanyContextLoading(false)
      })

    return () => {
      if (pollInterval) clearInterval(pollInterval)
    }
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 7) return
    setCompanyFormLoading(true)
    fetch("/api/plaid/balances?refresh=1")
      .then((res) => (res.ok ? res.json() : { accounts: [] }))
      .then((data: { accounts?: { name?: string; mask?: string | null }[] }) => {
        const list = (data.accounts ?? []).map((a) => ({
          name: a.name ?? "Unknown",
          mask: a.mask ?? null,
        }))
        setStep7BankAccounts(list)
      })
      .catch(() => setStep7BankAccounts([]))
    fetch("/api/onboarding/company-form")
      .then((res) => (res.ok ? res.json() : { form: {} }) as Promise<{ form?: Record<string, string> }>)
      .then((savedData) => {
        const saved = savedData.form ?? {}
        const hasSaved = Object.keys(saved).some((k) => String(saved[k] ?? "").trim())
        if (hasSaved) {
          setCompanyForm(saved)
          setCompanyFormLoading(false)
          return
        }
        return fetch("/api/onboarding/company-form/autofill", { method: "POST" })
          .then((res) => res.json())
          .then((data: { form?: Record<string, string> }) => {
            const autofillForm = data.form ?? {}
            setCompanyForm({ ...autofillForm, ...saved })
          })
          .catch(() => setCompanyForm(saved))
      })
      .finally(() => setCompanyFormLoading(false))
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 8) return
    setRawDataLoading(true)
    setRawDataError(null)
    fetch("/api/raw-data")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then((data: RawDataResponse) => setRawData(data))
      .catch((err) => {
        setRawData(null)
        setRawDataError(err instanceof Error ? err.message : "Failed to load raw data")
      })
      .finally(() => setRawDataLoading(false))
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 9) return
    let cancelled = false

    setIdentityLoading(true)
    setIdentityError(null)

    // Try loading existing identity data first
    fetch("/api/identity")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then((data: IdentityData) => {
        if (cancelled) return
        if (data.entities.length > 0) {
          setIdentityData(data)
          setIdentityLoading(false)
          setIdentitySeeding(false)
          return
        }

        // No entities yet — trigger seed and poll
        setIdentitySeeding(true)
        setIdentityLoading(false)
        fetch("/api/identity/seed", { method: "POST" }).catch(() => {})

        let attempts = 0
        const maxAttempts = 30
        const poll = () => {
          if (cancelled) return
          attempts++
          fetch("/api/identity")
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
            .then((d: IdentityData) => {
              if (cancelled) return
              if (d.entities.length > 0) {
                setIdentityData(d)
                setIdentitySeeding(false)
              } else if (attempts < maxAttempts) {
                setTimeout(poll, 3000)
              } else {
                setIdentitySeeding(false)
              }
            })
            .catch(() => { if (!cancelled && attempts < maxAttempts) setTimeout(poll, 3000) })
        }
        setTimeout(poll, 2000)
      })
      .catch((err) => {
        if (cancelled) return
        setIdentityError(err instanceof Error ? err.message : "Failed to load identity graph")
        setIdentityLoading(false)
      })

    return () => { cancelled = true }
  }, [currentStep])

  // Step 10: Money movements
  useEffect(() => {
    if (currentStep !== 10) return
    let cancelled = false

    setMovementsLoading(true)
    setMovementsError(null)

    fetch("/api/movements")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then((data: MovementsData) => {
        if (cancelled) return
        if (data.movements.length > 0) {
          setMovementsData(data)
          setMovementsLoading(false)
          setMovementsClassifying(false)
          return
        }

        setMovementsClassifying(true)
        setMovementsLoading(false)
        fetch("/api/movements/classify", { method: "POST" }).catch(() => {})

        let attempts = 0
        const maxAttempts = 40
        const poll = () => {
          if (cancelled) return
          attempts++
          fetch("/api/movements")
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
            .then((d: MovementsData) => {
              if (cancelled) return
              if (d.movements.length > 0) {
                setMovementsData(d)
                setMovementsClassifying(false)
              } else if (attempts < maxAttempts) {
                setTimeout(poll, 3000)
              } else {
                setMovementsClassifying(false)
              }
            })
            .catch(() => { if (!cancelled && attempts < maxAttempts) setTimeout(poll, 3000) })
        }
        setTimeout(poll, 3000)
      })
      .catch((err) => {
        if (cancelled) return
        setMovementsError(err instanceof Error ? err.message : "Failed to load movements")
        setMovementsLoading(false)
      })

    return () => { cancelled = true }
  }, [currentStep])

  const onPlaidSuccess = useCallback(
    async (publicToken: string) => {
      try {
        const res = await fetch("/api/plaid/exchange-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_token: publicToken }),
        })
        if (!res.ok) throw new Error("Exchange failed")
        const data = (await res.json()) as { item_id?: string }
        if (data.item_id) {
          fetch("/api/plaid/transactions-sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ item_id: data.item_id }),
          }).catch(() => {})
        }
        setBankConnected(true)
        if (currentStep === 1) {
          setCurrentStep(2)
        }
        fetchConnectedItems()
      } catch {
        setPlaidLinkError("Connection succeeded but we couldn't save it. Please try again.")
      }
    },
    [currentStep, fetchConnectedItems]
  )

  const plaidToken =
    currentStep === 1
      ? plaidLinkToken
      : currentStep === 2
        ? addAccountLinkToken
        : accountingStepLinkToken
  const { open: openPlaidLink, ready: plaidReady } = usePlaidLink({
    token: plaidToken,
    onSuccess: onPlaidSuccess,
    onExit: (err) => {
      if (err) setPlaidLinkError(err?.error_message ?? "Connection was cancelled.")
    },
  })

  const handleConnectBank = () => {
    if (bankConnected || !plaidReady) return
    openPlaidLink()
  }

  const handleAddAnotherAccount = () => {
    if (!plaidReady) return
    openPlaidLink()
  }

  const handleNext = () => {
    if (currentStep < steps.length) {
      setCurrentStep(currentStep + 1)
    }
  }

  const handleNextOrFinish = () => {
    if (currentStep === 6) {
      const toSave = (editedContext ?? companyContext ?? "").trim()
      if (toSave) {
        fetch("/api/context/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ finalContext: toSave }),
        }).finally(() => handleNext())
      } else {
        handleNext()
      }
    } else if (currentStep === 7) {
      fetch("/api/onboarding/company-form", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ form: companyForm }),
      }).finally(() => handleNext())
    } else if (currentStep >= steps.length) {
      router.push("/dashboard")
    } else {
      handleNext()
    }
  }

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1)
    }
  }

  const toggleIntegration = (name: string) => {
    const integrationSlug = name.toLowerCase().replace(/\s+/g, "-")
    router.push(`/oauth/${integrationSlug}`)
  }

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="my-0 py-9">
            <div className="flex flex-col items-center">
              <h2 className="text-3xl font-bold text-white mb-2 text-center">Connect Your Bank Account</h2>
              <p className="text-gray-300 text-center max-w-lg">{""}</p>
            </div>

            <div>
              <h3 className="text-center text-sm font-semibold text-gray-300 uppercase tracking-wider my-0 py-1.5">
                Trusted by users from leading financial institutions
              </h3>

              <div className="relative overflow-hidden py-3 my-9">
                <style jsx>{`
                  @keyframes scroll {
                    0% {
                      transform: translateX(0);
                    }
                    100% {
                      transform: translateX(-50%);
                    }
                  }
                  .animate-scroll {
                    animation: scroll 14s linear infinite;
                  }
                `}</style>
                <div className="flex animate-scroll">
                  {/* First set of banks */}
                  {[
                    { name: "Chase", logo: "/chase-logo.png" },
                    { name: "Bank of America", logo: "/bofa-logo.png" },
                    { name: "Wells Fargo", logo: "/wells-fargo-logo.png" },
                    { name: "Citibank", logo: "/citibank-logo.png" },
                    { name: "Capital One", logo: "/capital-one-logo.png" },
                    { name: "PNC Bank", logo: "/pnc-logo.png" },
                    { name: "US Bank", logo: "/us-bank-logo.png" },
                    { name: "TD Bank", logo: "/td-bank-logo.png" },
                    { name: "Truist Bank", logo: "/truist-logo.png" },
                    { name: "HSBC", logo: "/hsbc-logo.png" },
                    { name: "Goldman Sachs", logo: "/goldman-sachs-logo.jpg" },
                    { name: "Morgan Stanley", logo: "/morgan-stanley-logo.jpg" },
                    { name: "American Express", logo: "/amex-logo.jpg" },
                    { name: "Discover", logo: "/discover-logo.jpg" },
                    { name: "Ally Bank", logo: "/ally-logo.jpg" },
                    { name: "Charles Schwab", logo: "/schwab-logo.jpg" },
                    { name: "Barclays", logo: "/barclays-logo.jpg" },
                    { name: "Santander", logo: "/santander-logo.jpg" },
                    { name: "Citizens Bank", logo: "/citizens-logo.jpg" },
                    { name: "Fifth Third Bank", logo: "/fifth-third-logo.jpg" },
                    { name: "KeyBank", logo: "/keybank-logo.jpg" },
                    { name: "Regions Bank", logo: "/regions-logo.jpg" },
                    { name: "M&T Bank", logo: "/mt-bank-logo.jpg" },
                    { name: "Navy Federal Credit Union", logo: "/navy-federal-logo.jpg" },
                    { name: "BMO Harris", logo: "/bmo-logo.jpg" },
                    { name: "USAA", logo: "/usaa-logo.jpg" },
                    { name: "SunTrust", logo: "/suntrust-logo.jpg" },
                    { name: "Huntington Bank", logo: "/huntington-logo.jpg" },
                  ].map((bank, index) => (
                    <div
                      key={`${bank.name}-1-${index}`}
                      className="bg-white/5 backdrop-blur-sm border-white/10 p-5 transition-all duration-300 flex-shrink-0 w-36 h-36 flex items-center justify-center group shadow-none opacity-100 mx-2.5 gap-0 flex-col border-0 rounded-lg"
                    >
                      <div className="w-24 h-24 mb-2 flex items-center justify-center">
                        <Image
                          src={bank.logo || "/placeholder.svg"}
                          alt={`${bank.name} logo`}
                          width={96}
                          height={96}
                          className="object-contain max-w-full max-h-full"
                        />
                      </div>
                      <span className="text-white text-xs font-medium text-center leading-tight">{bank.name}</span>
                    </div>
                  ))}
                  {/* Duplicate set for seamless loop */}
                  {[
                    { name: "Chase", logo: "/chase-logo.png" },
                    { name: "Bank of America", logo: "/bofa-logo.png" },
                    { name: "Wells Fargo", logo: "/wells-fargo-logo.png" },
                    { name: "Citibank", logo: "/citibank-logo.png" },
                    { name: "Capital One", logo: "/capital-one-logo.png" },
                    { name: "PNC Bank", logo: "/pnc-logo.png" },
                    { name: "US Bank", logo: "/us-bank-logo.png" },
                    { name: "TD Bank", logo: "/td-bank-logo.png" },
                    { name: "Truist Bank", logo: "/truist-logo.png" },
                    { name: "HSBC", logo: "/hsbc-logo.png" },
                    { name: "Goldman Sachs", logo: "/goldman-sachs-logo.jpg" },
                    { name: "Morgan Stanley", logo: "/morgan-stanley-logo.jpg" },
                    { name: "American Express", logo: "/amex-logo.jpg" },
                    { name: "Discover", logo: "/discover-logo.jpg" },
                    { name: "Ally Bank", logo: "/ally-logo.jpg" },
                    { name: "Charles Schwab", logo: "/schwab-logo.jpg" },
                    { name: "Barclays", logo: "/barclays-logo.jpg" },
                    { name: "Santander", logo: "/santander-logo.jpg" },
                    { name: "Citizens Bank", logo: "/citizens-logo.jpg" },
                    { name: "Fifth Third Bank", logo: "/fifth-third-logo.jpg" },
                    { name: "KeyBank", logo: "/keybank-logo.jpg" },
                    { name: "Regions Bank", logo: "/regions-logo.jpg" },
                    { name: "M&T Bank", logo: "/mt-bank-logo.jpg" },
                    { name: "Navy Federal Credit Union", logo: "/navy-federal-logo.jpg" },
                    { name: "BMO Harris", logo: "/bmo-logo.jpg" },
                    { name: "USAA", logo: "/usaa-logo.jpg" },
                    { name: "SunTrust", logo: "/suntrust-logo.jpg" },
                    { name: "Huntington Bank", logo: "/huntington-logo.jpg" },
                  ].map((bank, index) => (
                    <div
                      key={`${bank.name}-2-${index}`}
                      className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl p-5 transition-all duration-300 flex-shrink-0 w-36 h-36 flex flex-col items-center justify-center mx-3 group"
                    >
                      <div className="w-24 h-24 mb-2 flex items-center justify-center">
                        <Image
                          src={bank.logo || "/placeholder.svg"}
                          alt={`${bank.name} logo`}
                          width={96}
                          height={96}
                          className="object-contain max-w-full max-h-full"
                        />
                      </div>
                      <span className="text-white text-xs font-medium text-center leading-tight">{bank.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="max-w-md mx-auto">
              {plaidLinkError && (
                <p className="text-sm text-red-400 text-center mb-3">{plaidLinkError}</p>
              )}
              <Button
                type="button"
                onClick={handleConnectBank}
                disabled={bankConnected || plaidLinkLoading || !plaidReady}
                className="w-full bg-white hover:bg-gray-100 text-black font-semibold text-base shadow-lg shadow-white/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none transition-all h-14"
              >
                {bankConnected ? (
                  <span className="flex items-center gap-2">
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Connected Successfully
                  </span>
                ) : plaidLinkLoading ? (
                  "Loading..."
                ) : (
                  "Connect Your Bank Securely"
                )}
              </Button>
              <p className="text-xs text-center text-gray-500 leading-relaxed my-3.5 mt-6 mb-7">
                By connecting, you agree to our{" "}
                <a href="#" className="hover:text-emerald-300 underline text-foreground">
                  Terms of Service
                </a>{" "}
                and{" "}
                <a href="#" className="hover:text-emerald-300 underline text-foreground">
                  Privacy Policy
                </a>
                . Your data is always encrypted and secure.
              </p>
            </div>
          </div>
        )

      case 2: {
        const totalBalance = connectedAccounts.reduce(
          (sum, a) => sum + (a.current_balance != null && !Number.isNaN(a.current_balance) ? a.current_balance : 0),
          0
        )
        const hasAccounts = connectedAccounts.length > 0
        const hasItemsOnly = !hasAccounts && connectedItemIds.length > 0
        return (
          <div className="my-0 py-9">
            <div className="flex flex-col items-center mb-6">
              <h2 className="text-3xl font-bold text-white mb-2 text-center tracking-tight">
                Your bank accounts
              </h2>
              <p className="text-gray-400 text-center max-w-lg text-base">
                View balances in the table below. Add more accounts or continue when you’re ready.
              </p>
            </div>
            <div className="max-w-4xl mx-auto space-y-4">
              {hasAccounts ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {connectedAccounts.map((acc, i) => (
                      <div
                        key={`${acc.name}-${acc.mask ?? i}`}
                        className="rounded-2xl border border-white/15 bg-white/5 p-4 flex flex-col justify-between h-40"
                      >
                        <div>
                          <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                            Bank account
                          </p>
                          <p className="text-white font-semibold text-base truncate">
                            {acc.name}
                          </p>
                          <p className="text-gray-400 text-xs mt-1">
                            {acc.type || "—"} {acc.mask ? `•••• ${acc.mask}` : ""}
                          </p>
                        </div>
                        <div className="mt-3 flex items-end justify-between">
                          <div>
                            <p className="text-xs text-gray-400">Current balance</p>
                            <p className="text-white font-semibold text-lg">
                              {formatBalance(acc.current_balance)}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-gray-500">Available</p>
                            <p className="text-gray-300 text-sm">
                              {formatBalance(acc.available_balance)}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={handleAddAnotherAccount}
                      disabled={addAccountLinkLoading || !plaidReady}
                      className="rounded-2xl border border-dashed border-white/25 text-gray-300 hover:border-white/60 hover:bg-white/5 transition-colors flex flex-col items-center justify-center h-40"
                    >
                      <div className="w-12 h-12 rounded-2xl border border-white/40 flex items-center justify-center text-2xl font-semibold mb-2">
                        +
                      </div>
                      <span className="text-sm font-medium text-white">
                        Add another bank account
                      </span>
                      <span className="text-xs text-gray-400 mt-1">
                        Link a new account with Plaid
                      </span>
                    </button>
                  </div>
                  {hasAccounts && (
                    <div className="mt-2 flex justify-end">
                      <p className="text-sm text-gray-300">
                        Total across connected accounts:{" "}
                        <span className="font-semibold text-white">
                          {formatBalance(totalBalance)}
                        </span>
                      </p>
                    </div>
                  )}
                </>
              ) : hasItemsOnly ? (
                <div className="rounded-lg border border-white/20 bg-white/5 p-4">
                  <p className="text-sm font-medium text-white mb-2">Connected</p>
                  <p className="text-gray-400 text-sm">
                    {connectedItemIds.length} account{connectedItemIds.length !== 1 ? "s" : ""} linked. Balances will appear in the table once synced.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-6">No accounts loaded yet.</p>
              )}
              {plaidLinkError && (
                <p className="text-sm text-red-400 rounded-lg bg-red-500/10 px-3 py-2">
                  {plaidLinkError}
                </p>
              )}
            </div>
          </div>
        )
      }

      case 3:
        return (
          <div>
            <div className="text-center mb-8">
              <h2 className="text-2xl font-semibold text-white mb-3">
                Connect your accounting institution
              </h2>
              <p className="text-gray-400 text-base">
                Choose the accounting or spend platform you currently use with your business.
              </p>
            </div>

            {plaidLinkError && (
              <p className="text-sm text-red-400 text-center mb-4">{plaidLinkError}</p>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-8 max-w-2xl mx-auto">
              {integrations.map((integration) => {
                const usePlaid = PLAID_INTEGRATIONS.includes(integration.name)
                const isStripe = integration.name === "Stripe"
                const plaidDisabled = usePlaid && (accountingStepLinkLoading || !plaidReady)
                const isConnected = connectedIntegrations.includes(integration.name)
                return (
                  <button
                    key={integration.name}
                    type="button"
                    onClick={() => {
                      if (usePlaid) {
                        openPlaidLink()
                      } else if (isStripe) {
                        window.location.href = "/oauth/stripe"
                      } else {
                        toggleIntegration(integration.name)
                      }
                    }}
                    disabled={plaidDisabled}
                    className={`relative rounded-lg p-5 text-center transition-all flex flex-col items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed ${
                      isConnected
                        ? "bg-emerald-500/10 border-2 border-emerald-500/50 hover:border-emerald-500/70 hover:bg-emerald-500/15"
                        : "bg-white/5 border border-white/10 hover:border-white/30 hover:bg-white/10"
                    }`}
                  >
                    {isConnected && (
                      <span className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </span>
                    )}
                    <div className="w-28 h-28 mb-4 flex items-center justify-center">
                      <Image
                        src={integration.logo || "/placeholder.svg"}
                        alt={`${integration.name} logo`}
                        width={120}
                        height={120}
                        className="object-contain max-w-full max-h-full"
              />
            </div>
                    <h3 className="text-white font-semibold text-sm leading-tight">
                      {integration.name}
                    </h3>
                    {integration.description && (
                      <p className="text-[11px] text-gray-400 mt-1">{integration.description}</p>
                    )}
                    {isConnected ? (
                      <span className="text-xs font-medium text-emerald-400 mt-1">Connected</span>
                    ) : usePlaid && accountingStepLinkLoading ? (
                      <span className="text-xs text-gray-400 mt-1">Loading...</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        )

      case 4:
        return (
          <div>
            <div className="text-center mb-8">
              <h2 className="text-2xl font-semibold text-white mb-3">Connect documents & drives</h2>
              <p className="text-gray-400 text-base">
                Link where your contracts, invoices, and docs live so we can better understand your business.
              </p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-8 max-w-2xl mx-auto">
              {[
                { name: "Google Drive", logo: "/google-drive-logo.png" },
                { name: "OneDrive", logo: "/onedrive-logo.png" },
                { name: "Notion", logo: "/notion-logo.png" },
              ].map((integration) => {
                const isConnected = connectedContextIntegrations.includes(integration.name)
                return (
                  <button
                    key={integration.name}
                    type="button"
                    onClick={() => toggleIntegration(integration.name)}
                    className={`relative rounded-lg p-5 text-center transition-all flex flex-col items-center justify-center hover:border-white/30 hover:bg-white/10 ${
                      isConnected
                        ? "bg-emerald-500/10 border-2 border-emerald-500/50 hover:border-emerald-500/70 hover:bg-emerald-500/15"
                        : "bg-white/5 border border-white/10"
                    }`}
                  >
                    {isConnected && (
                      <span className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </span>
                    )}
                  <div className="w-28 h-28 mb-4 flex items-center justify-center">
                      <Image
                        src={integration.logo || "/placeholder.svg"}
                        alt={`${integration.name} logo`}
                      width={120}
                      height={120}
                        className="object-contain max-w-full max-h-full"
                      />
                    </div>
                    <h3 className="text-white font-semibold text-sm leading-tight">{integration.name}</h3>
                    {isConnected && (
                      <span className="text-xs font-medium text-emerald-400 mt-1">Connected</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )

      case 5:
        return (
              <div>
            <div className="text-center mb-6">
              <h2 className="text-2xl font-semibold text-white mb-3">Choose your communication channels</h2>
              <p className="text-gray-400 text-base">
                Add your WhatsApp number to chat with ProfitWise and get answers using your company context. We’ll send a code to verify it.
              </p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-10 max-w-2xl mx-auto">
              {/* WhatsApp now opens dedicated setup page */}
              <button
                type="button"
                onClick={() => toggleIntegration("WhatsApp")}
                className="bg-white/5 border border-white/10 rounded-lg p-5 text-center transition-all flex flex-col items-center justify-center hover:border-white/30 hover:bg-white/10 min-h-[200px]"
              >
                <div className="w-20 h-20 mb-3 flex items-center justify-center">
                  <Image
                    src="/whatsapp-logo.png"
                    alt="WhatsApp"
                    width={80}
                    height={80}
                    className="object-contain max-w-full max-h-full"
                />
              </div>
                <h3 className="text-white font-semibold text-sm leading-tight mb-1">WhatsApp</h3>
                {whatsappStatus?.verified && whatsappStatus.phone ? null : null}
              </button>

              {[
                { name: "Slack", logo: "/slack-logo.png" },
                { name: "Gmail", logo: "/gmail-logo.png" },
              ].map((channel) => (
                <button
                  key={channel.name}
                  type="button"
                  onClick={() => toggleIntegration(channel.name)}
                  className="bg-white/5 border border-white/10 rounded-lg p-5 text-center transition-all flex flex-col items-center justify-center hover:border-white/30 hover:bg-white/10 min-h-[200px]"
                >
                  <div className="w-20 h-20 mb-3 flex items-center justify-center">
                    <Image
                      src={channel.logo || "/placeholder.svg"}
                      alt={`${channel.name} logo`}
                      width={80}
                      height={80}
                      className="object-contain max-w-full max-h-full"
                />
              </div>
                  <h3 className="text-white font-semibold text-sm leading-tight">{channel.name}</h3>
                </button>
              ))}
            </div>
          </div>
        )

      case 6:
        if (companyContextLoading) {
          return (
            <div className="py-12 flex flex-col items-center justify-center text-center max-w-lg mx-auto">
              <h2 className="text-2xl font-semibold text-white mb-3">Building your company and financial context</h2>
              <p className="text-gray-400 text-base mb-8">
                We’re combining your business docs with expenses and vendors from the last 60 days. We’ll notify you on WhatsApp when it’s ready. You can wait here or come back later.
              </p>
              <div className="flex flex-col items-center gap-4">
                <div className="h-10 w-10 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                <p className="text-sm text-gray-500">Mapping business and financial context with AI…</p>
              </div>
            </div>
          )
        }
        if (companyContextError) {
          return (
            <div className="py-12 text-center max-w-lg mx-auto">
              <h2 className="text-2xl font-semibold text-white mb-3">Company and financial context</h2>
              <p className="text-gray-400 text-base mb-4">{steps[5].description}</p>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-200 text-sm mb-6">
                {companyContextError}
              </div>
              <p className="text-gray-500 text-sm">You can continue to the next step.</p>
            </div>
          )
        }
        const currentCtx = companyContext ?? ""
        const editedCtx = editedContext ?? ""
        const hasEdited = editedCtx.length > 0
        const runRefine = () => {
          const base = editedCtx || currentCtx
          if (!refineInput.trim() || !base) return
          const message =
            contextSelection.text.trim()
              ? `Selected text: "${contextSelection.text.slice(0, 500)}${contextSelection.text.length > 500 ? "…" : ""}". User instruction: ${refineInput.trim()}`
              : refineInput.trim()
          setRefineLoading(true)
          fetch("/api/context/final", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentFinalContext: base, userMessage: message }),
          })
            .then((res) => {
              if (!res.ok) throw new Error("Refine failed")
              return res.json()
            })
            .then((data: { finalContext?: string }) => {
              if (data.finalContext != null) setEditedContext(data.finalContext)
              setRefineInput("")
              setContextSelection({ start: 0, end: 0, text: "" })
            })
            .catch(() => {})
            .finally(() => setRefineLoading(false))
        }
        const acceptChanges = () => {
          if (!editedCtx.trim()) return
          setCompanyContext(editedCtx)
          setEditedContext(null)
        }
        return (
          <div className="py-2 flex flex-col w-full">
            <div className="grid grid-cols-2 gap-5 h-[68vh] min-h-[420px]">
              <div className="flex flex-col rounded-2xl border border-white/15 bg-white/[0.07] overflow-hidden shadow-xl min-h-0">
                <div className="px-5 py-3 border-b border-white/15 shrink-0">
                  <h3 className="text-base font-semibold text-white">Your current context</h3>
                    <p className="text-gray-400 text-sm mt-0.5">Saved when you click Finish below</p>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-5">
                  <p className="text-gray-200 text-base leading-relaxed whitespace-pre-wrap font-sans">
                    {currentCtx || "No context yet. Refine below, then Accept changes to move your edit here. Click Finish to save and go to the next step."}
                  </p>
                </div>
              </div>
              <div className="flex flex-col rounded-2xl border border-white/15 bg-white/[0.07] overflow-hidden shadow-xl min-h-0">
                <div className="px-5 py-3 border-b border-white/15 flex items-center justify-between gap-3 shrink-0">
              <div>
                    <h3 className="text-base font-semibold text-white">Edited context</h3>
                    <p className="text-gray-400 text-sm mt-0.5">Appears here after you refine</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={acceptChanges}
                    disabled={!hasEdited}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg px-4 py-2 shrink-0"
                  >
                    Accept changes
                  </Button>
                </div>
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                  {hasEdited ? (
                    <textarea
                      value={editedCtx}
                      onChange={(e) => setEditedContext(e.target.value)}
                      onSelect={(e) => {
                        const ta = e.target as HTMLTextAreaElement
                        setContextSelection({
                          start: ta.selectionStart,
                          end: ta.selectionEnd,
                          text: ta.value.slice(ta.selectionStart, ta.selectionEnd),
                        })
                      }}
                      placeholder="Your edited context appears here after Refine."
                      className="flex-1 w-full min-h-0 p-5 text-base text-gray-200 bg-transparent border-0 resize-none focus:outline-none focus:ring-0 placeholder:text-gray-500 leading-relaxed overflow-y-auto"
                      spellCheck={false}
                    />
                  ) : (
                    <div className="flex-1 flex items-center justify-center p-8 text-center overflow-y-auto min-h-0">
                      <p className="text-gray-500 text-base max-w-sm">
                        Refine with the AI bar below to see your edited version here. Accept changes moves it to the left; Finish saves (one context) and goes to the next step.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-center">
              <div className="flex-1 max-w-2xl flex items-center rounded-full bg-white/[0.07] border border-white/15 px-5 py-3 focus-within:border-white/25 focus-within:ring-1 focus-within:ring-white/20 shadow-lg">
                <input
                  type="text"
                  value={refineInput}
                  onChange={(e) => setRefineInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      runRefine()
                    }
                  }}
                  placeholder={contextSelection.text ? "e.g. Simplify this / Fix typo / Make it shorter" : "e.g. Add that we use NetSuite for ERP"}
                  disabled={refineLoading || !currentCtx}
                  className="flex-1 min-w-0 bg-transparent text-white placeholder:text-gray-500 text-base focus:outline-none"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={refineLoading || !refineInput.trim() || !currentCtx}
                  onClick={runRefine}
                  className="rounded-full bg-white text-black hover:bg-gray-200 font-medium shrink-0 px-5 py-2"
                >
                  {refineLoading ? "Refining…" : "Refine"}
                </Button>
              </div>
            </div>
            {contextSelection.text ? (
              <p className="text-sm text-gray-500 mt-2 text-center">
                Selection will be sent with your instruction so the AI can change text around that region.
              </p>
            ) : null}
          </div>
        )

      case 7: {
        if (companyFormLoading) {
          return (
            <div className="py-12 flex flex-col items-center justify-center text-center max-w-md mx-auto">
              <div className="h-10 w-10 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              <p className="text-white font-medium mt-4">Preparing your company form</p>
              <p className="text-gray-400 text-sm mt-1">Using your connected data to prefill the form…</p>
            </div>
          )
        }
        return (
          <div className="pt-0 pb-2 max-w-2xl mx-auto">
            <h2 className="text-3xl font-bold tracking-tight text-white mb-2">{steps[6].title}</h2>
            <p className="text-gray-400 text-lg mb-5">{steps[6].description}</p>
            <div className="flex flex-wrap gap-3 mb-5">
              <Button
                type="button"
                variant="outline"
                disabled={companyFormAutofillLoading}
                onClick={() => {
                  setCompanyFormAutofillLoading(true)
                  fetch("/api/onboarding/company-form/autofill", { method: "POST" })
                    .then((res) => res.json())
                    .then((data: { form?: Record<string, string>; error?: string }) => {
                      if (data.form) setCompanyForm((prev) => ({ ...prev, ...data.form }))
                    })
                    .catch(() => {})
                    .finally(() => setCompanyFormAutofillLoading(false))
                }}
                className="bg-white/5 border-white/20 text-white hover:bg-white/10 text-base h-10 px-5"
              >
                {companyFormAutofillLoading ? "Filling…" : "Auto-fill from context"}
              </Button>
              <Button
                type="button"
                disabled={companyFormSaveLoading}
                onClick={() => {
                  setCompanyFormSaveLoading(true)
                  fetch("/api/onboarding/company-form", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ form: companyForm }),
                  })
                    .then((res) => res.ok ? res.json() : Promise.reject(new Error("Save failed")))
                    .catch(() => {})
                    .finally(() => setCompanyFormSaveLoading(false))
                }}
                className="bg-white text-black hover:bg-gray-200 text-base font-medium h-10 px-5"
              >
                {companyFormSaveLoading ? "Saving…" : "Save"}
              </Button>
            </div>
            <div className="space-y-5">
              {COMPANY_FORM_FIELDS.map(({ key, label, placeholder }) => {
                if (key === "primaryBanks" && step7BankAccounts.length > 0) {
                  const selected = (companyForm.primaryBanks ?? "").split(",").map((s) => s.trim()).filter(Boolean)
                  const toggle = (accountLabel: string) => {
                    const next = selected.includes(accountLabel)
                      ? selected.filter((s) => s !== accountLabel)
                      : [...selected, accountLabel]
                    setCompanyForm((prev) => ({ ...prev, primaryBanks: next.join(", ") }))
                  }
                  return (
                    <div key={key}>
                      <label className="block text-base font-semibold text-gray-200 mb-2">{label}</label>
                      <div className="flex flex-wrap gap-3">
                        {step7BankAccounts.map((acc) => {
                          const label = acc.mask ? `${acc.name} (••${acc.mask})` : acc.name
                          const checked = selected.includes(label)
                          return (
                            <label
                              key={label}
                              className="flex items-center gap-2.5 cursor-pointer rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 hover:bg-white/10 transition-colors"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggle(label)}
                                className="rounded border-white/30 text-white focus:ring-2 focus:ring-white/40 w-4 h-4"
                              />
                              <span className="text-base text-gray-200">{label}</span>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={key}>
                    <label className="block text-base font-semibold text-gray-200 mb-2">{label}</label>
                <Input
                      value={companyForm[key] ?? ""}
                      onChange={(e) => setCompanyForm((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder={placeholder}
                      className="bg-white/5 border-white/20 text-white placeholder:text-gray-500 text-base h-11 px-4"
                />
              </div>
                )
              })}
            </div>
            <p className="text-base text-gray-500 mt-4">
              Form is prefilled from your connected data and recent activity. Edit any field; click Finish to save the final
              version.
            </p>
          </div>
        )
      }

      case 8: {
        const plaidTxns = Array.isArray(rawData?.plaid.transactions) ? rawData?.plaid.transactions ?? [] : []
        const plaidAccounts = Array.isArray(rawData?.plaid.accounts) ? rawData?.plaid.accounts ?? [] : []
        const qboEntities = rawData?.qbo ?? {}
        const xeroEntities = rawData?.xero ?? {}
        const stripeEntities = rawData?.stripe ?? {}
        const gmailExtracts = rawData?.gmail.extracted ?? []

        // New Step 8: raw data review only. Old tagging UI below is now unreachable.
        if (true) {
          return (
            <div className="pt-0 pb-2 w-full">
              <h2 className="text-3xl font-bold tracking-tight text-white mb-2">{steps[7].title}</h2>
              <p className="text-gray-400 text-lg mb-5">{steps[7].description}</p>

              {rawDataLoading && (
                <div className="flex items-center gap-2 py-6 text-gray-400">
                  <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Loading raw data…
                </div>
              )}

              {rawDataError && !rawDataLoading && (
                <p className="text-red-300 text-sm mb-4">Failed to load raw data: {rawDataError}</p>
              )}

              {!rawDataLoading && !rawData && !rawDataError && (
                <p className="text-gray-400 text-sm mb-4">
                  No raw data found yet. Connect integrations and run syncs to see data here.
                </p>
              )}

              {rawData && (
                <div className="space-y-6">
                  <div className="rounded-xl border border-white/20 bg-white/5 p-4">
                    <h3 className="text-lg font-semibold text-white mb-2">
                      Plaid — Bank transactions (last 2 years)
                    </h3>
                    <p className="text-gray-400 text-sm mb-3">
                      Showing up to 200 most recent transactions from Plaid.
                    </p>
                    {plaidTxns.length === 0 ? (
                      <p className="text-gray-400 text-sm">No Plaid transactions yet.</p>
                    ) : (
                      <div className="rounded-lg border border-white/20 bg-black/40 overflow-x-auto max-h-[40vh]">
                        <Table>
                          <TableHeader>
                            <TableRow className="border-white/20 hover:bg-transparent">
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Date
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Account
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Name
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap text-right">
                                Amount
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Raw JSON
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {plaidTxns.map((tx: any, idx: number) => {
                              const account = plaidAccounts.find((a: any) => a.account_id === tx.account_id)
                              return (
                                <TableRow
                                  key={tx.transaction_id ?? idx}
                                  className="border-white/20 hover:bg-white/5 align-top"
                                >
                                  <TableCell className="text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap text-sm">
                                    {tx.date ?? "—"}
                                  </TableCell>
                                  <TableCell className="text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap text-sm">
                                    {account?.name ?? tx.account_id ?? "—"}
                                  </TableCell>
                                  <TableCell className="text-white border-white/20 px-3 py-2 whitespace-nowrap text-sm">
                                    {tx.name ?? "—"}
                                  </TableCell>
                                  <TableCell className="text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap text-right text-sm">
                                    {typeof tx.amount === "number"
                                      ? formatBalance(tx.amount)
                                      : String(tx.amount ?? "—")}
                                  </TableCell>
                                  <TableCell className="text-gray-400 border-white/20 px-3 py-2 text-xs max-w-[260px]">
                                    <code className="block whitespace-pre overflow-x-auto">
                                      {JSON.stringify(tx, null, 2)}
                                    </code>
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/20 bg-white/5 p-4">
                    <h3 className="text-lg font-semibold text-white mb-2">QuickBooks Online — raw entities</h3>
                    <p className="text-gray-400 text-sm mb-3">
                      Every synced QBO entity type is shown as JSON, grouped by type.
                    </p>
                    {Object.keys(qboEntities).length === 0 ? (
                      <p className="text-gray-400 text-sm">No QBO entities synced yet.</p>
                    ) : (
                      <div className="space-y-3 max-h-[40vh] overflow-y-auto pr-1">
                        {Object.entries(qboEntities).map(([entityType, list]) => (
                          <div
                            key={entityType}
                            className="rounded-lg border border-white/15 bg-black/40 p-3"
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-sm font-medium text-white">{entityType}</span>
                              <span className="text-xs text-gray-400">
                                {Array.isArray(list) ? list.length : 0} records
                              </span>
                            </div>
                            <pre className="text-xs text-gray-300 bg-black/60 rounded-md p-2 overflow-x-auto max-h-40">
                              {JSON.stringify(list, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/20 bg-white/5 p-4">
                    <h3 className="text-lg font-semibold text-white mb-2">Xero — raw entities</h3>
                    <p className="text-gray-400 text-sm mb-3">
                      Raw synced objects from Xero, grouped by type.
                    </p>
                    {Object.keys(xeroEntities).length === 0 ? (
                      <p className="text-gray-400 text-sm">No Xero entities synced yet.</p>
                    ) : (
                      <div className="space-y-3 max-h-[40vh] overflow-y-auto pr-1">
                        {Object.entries(xeroEntities).map(([entityType, list]) => (
                          <div
                            key={entityType}
                            className="rounded-lg border border-white/15 bg-black/40 p-3"
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-sm font-medium text-white">{entityType}</span>
                              <span className="text-xs text-gray-400">
                                {Array.isArray(list) ? list.length : 0} records
                              </span>
                            </div>
                            <pre className="text-xs text-gray-300 bg-black/60 rounded-md p-2 overflow-x-auto max-h-40">
                              {JSON.stringify(list, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/20 bg-white/5 p-4">
                    <h3 className="text-lg font-semibold text-white mb-2">Stripe — raw entities</h3>
                    <p className="text-gray-400 text-sm mb-3">
                      Invoices, customers, payments, and other Stripe records in raw form.
                    </p>
                    {Object.keys(stripeEntities).length === 0 ? (
                      <p className="text-gray-400 text-sm">No Stripe entities synced yet.</p>
                    ) : (
                      <div className="space-y-3 max-h-[40vh] overflow-y-auto pr-1">
                        {Object.entries(stripeEntities).map(([entityType, list]) => (
                          <div
                            key={entityType}
                            className="rounded-lg border border-white/15 bg-black/40 p-3"
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-sm font-medium text-white">{entityType}</span>
                              <span className="text-xs text-gray-400">
                                {Array.isArray(list) ? list.length : 0} records
                              </span>
                            </div>
                            <pre className="text-xs text-gray-300 bg-black/60 rounded-md p-2 overflow-x-auto max-h-40">
                              {JSON.stringify(list, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/20 bg-white/5 p-4">
                    <h3 className="text-lg font-semibold text-white mb-2">
                      Gmail — messages with extracted invoices
                    </h3>
                    <p className="text-gray-400 text-sm mb-3">
                      Raw Gmail metadata plus the LLM-extracted invoice JSON we now store on each
                      message.
                    </p>
                    {gmailExtracts.length === 0 ? (
                      <p className="text-gray-400 text-sm">No Gmail invoice messages yet.</p>
                    ) : (
                      <div className="rounded-lg border border-white/20 bg-black/40 overflow-x-auto max-h-[40vh]">
                        <Table>
                          <TableHeader>
                            <TableRow className="border-white/20 hover:bg-transparent">
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Message ID
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                From
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                To
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Date
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Subject
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Extracted invoice JSON
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {gmailExtracts.map((m: any) => (
                              <TableRow
                                key={m.message_id}
                                className="border-white/20 hover:bg-white/5 align-top"
                              >
                                <TableCell className="text-xs text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap">
                                  {m.message_id}
                                </TableCell>
                                <TableCell className="text-xs text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap">
                                  {m.from_email ?? "—"}
                                </TableCell>
                                <TableCell className="text-xs text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap">
                                  {m.to_emails ?? "—"}
                                </TableCell>
                                <TableCell className="text-xs text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap">
                                  {m.date_sent ?? "—"}
                                </TableCell>
                                <TableCell className="text-xs text-white border-white/20 px-3 py-2 whitespace-nowrap max-w-[220px] truncate">
                                  {m.subject ?? "—"}
                                </TableCell>
                                <TableCell className="text-xs text-gray-300 border-white/20 px-3 py-2 max-w-[260px]">
                                  <code className="block whitespace-pre overflow-x-auto">
                                    {JSON.stringify(m.extracted_invoice, null, 2)}
                                  </code>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        }
      }

      case 9: {
        const idEntities = identityData?.entities ?? []
        const idAliases = identityData?.aliases ?? []
        const idAssertionCounts = identityData?.assertionCounts ?? []
        const aliasesByEntity = new Map<string, IdentityAlias[]>()
        for (const a of idAliases) {
          const list = aliasesByEntity.get(a.entity_id) ?? []
          list.push(a)
          aliasesByEntity.set(a.entity_id, list)
        }
        const assertionsByEntity = new Map<string, IdentityAssertionCount[]>()
        for (const a of idAssertionCounts) {
          const list = assertionsByEntity.get(a.entity_id) ?? []
          list.push(a)
          assertionsByEntity.set(a.entity_id, list)
        }
        const typeCounts: Record<string, number> = {}
        for (const e of idEntities) { typeCounts[e.entity_type] = (typeCounts[e.entity_type] ?? 0) + 1 }
        const confPct = (c: number) => Math.round(c * 100)
        const sourceColor = (s: string) =>
          s === "qbo" ? "bg-blue-500/80 border-blue-400/50" :
          s === "xero" ? "bg-emerald-500/80 border-emerald-400/50" :
          s === "stripe" ? "bg-purple-500/80 border-purple-400/50" :
          s === "plaid" ? "bg-amber-500/80 border-amber-400/50" :
          s === "gmail" ? "bg-red-500/80 border-red-400/50" :
          s === "system" ? "bg-white/30 border-white/20" :
          "bg-zinc-500/80 border-zinc-400/50"
        const typeColor = (t: string) =>
          t === "vendor" ? "bg-orange-500/80 border-orange-400/50" :
          t === "customer" ? "bg-cyan-500/80 border-cyan-400/50" :
          t === "processor" ? "bg-violet-500/80 border-violet-400/50" :
          t === "employee" ? "bg-pink-500/80 border-pink-400/50" :
          t === "internal" ? "bg-yellow-500/80 border-yellow-400/50" :
          t === "owner" ? "bg-rose-500/80 border-rose-400/50" :
          t === "bank_account" ? "bg-slate-500/80 border-slate-400/50" :
          t === "tax_authority" ? "bg-red-700/80 border-red-600/50" :
          t === "lender" ? "bg-indigo-500/80 border-indigo-400/50" :
          "bg-zinc-500/80 border-zinc-400/50"
        const typeLabel = (t: string) =>
          t === "bank_account" ? "bank acct" :
          t === "tax_authority" ? "tax auth" :
          t === "unknown" ? "unclassified" :
          t

        return (
          <div className="pt-0 pb-2 w-full">
            <h2 className="text-3xl font-bold tracking-tight text-white mb-2">{steps[8].title}</h2>
            <p className="text-gray-400 text-lg mb-5">{steps[8].description}</p>

            {(identitySeeding || identityLoading) && (
              <div className="flex items-center gap-2 py-6 text-gray-400">
                <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                {identitySeeding ? "Resolving identities across all sources (this may take a moment)\u2026" : "Loading identity graph\u2026"}
              </div>
            )}

            {identityError && !identityLoading && !identitySeeding && (
              <p className="text-red-300 text-sm mb-4">Failed to load identity graph: {identityError}</p>
            )}

            {!identityLoading && !identitySeeding && identityData && idEntities.length === 0 && (
              <p className="text-gray-400 text-sm mb-4">No entities resolved yet. Connect integrations and sync data first.</p>
            )}

            {!identityLoading && !identitySeeding && idEntities.length > 0 && (
              <div className="space-y-6">
                {/* Summary stats */}
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
                    <div className="text-2xl font-bold text-white">{idEntities.length}</div>
                    <div className="text-xs text-gray-400">Total entities</div>
                  </div>
                  {Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                    <div key={type} className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
                      <div className="text-2xl font-bold text-white">{count}</div>
                      <div className="text-xs text-gray-400 capitalize">{typeLabel(type) + "s"}</div>
                    </div>
                  ))}
                  <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
                    <div className="text-2xl font-bold text-white">{idAliases.length}</div>
                    <div className="text-xs text-gray-400">Aliases</div>
                  </div>
                  <button
                    type="button"
                    disabled={identitySeeding}
                    onClick={() => {
                      setIdentitySeeding(true)
                      setIdentityData(null)
                      fetch("/api/identity/wipe", { method: "POST" })
                        .then(() => fetch("/api/identity/seed?force=true", { method: "POST" }))
                        .catch(() => {})
                      let a = 0
                      const rePoll = () => {
                        a++
                        fetch("/api/identity")
                          .then((r) => r.ok ? r.json() : null)
                          .then((d: IdentityData | null) => {
                            if (d && d.entities.length > 0) { setIdentityData(d); setIdentitySeeding(false) }
                            else if (a < 30) setTimeout(rePoll, 3000)
                            else setIdentitySeeding(false)
                          })
                          .catch(() => { if (a < 30) setTimeout(rePoll, 3000); else setIdentitySeeding(false) })
                      }
                      setTimeout(rePoll, 3000)
                    }}
                    className="rounded-lg border border-white/20 bg-white/5 px-4 py-3 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="text-sm font-medium text-white">{identitySeeding ? "Scanning\u2026" : "Re-scan sources"}</div>
                    <div className="text-xs text-gray-400">Pick up new data</div>
                  </button>
                </div>

                {/* Entity tables by category */}
                {Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => {
                  const categoryEntities = idEntities.filter((e) => e.entity_type === type)
                  return (
                    <div key={type} className="rounded-xl border border-white/20 bg-white/5 overflow-hidden">
                      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/20">
                        <span className={`inline-flex rounded-md border px-2.5 py-1 text-sm font-semibold text-white capitalize ${typeColor(type)}`}>
                          {typeLabel(type)}s
                        </span>
                        <span className="text-sm text-gray-400">{count} entit{count !== 1 ? "ies" : "y"}</span>
                      </div>
                      <div className="max-h-[50vh] overflow-y-auto divide-y divide-white/10">
                        {categoryEntities.map((ent) => {
                          const expanded = identityExpandedEntity === ent.id
                          const entAliases = aliasesByEntity.get(ent.id) ?? []
                          const entAssertions = assertionsByEntity.get(ent.id) ?? []
                          const nameAliases = entAliases.filter((a) => a.alias_type === "name" || a.alias_type === "merchant_string")
                          const emailAliases = entAliases.filter((a) => a.alias_type === "email")
                          const domainAliases = entAliases.filter((a) => a.alias_type === "domain")
                          return (
                            <div key={ent.id}>
                              <button
                                type="button"
                                onClick={() => setIdentityExpandedEntity(expanded ? null : ent.id)}
                                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 transition-colors text-left"
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-white font-semibold truncate">{ent.canonical_name}</span>
                                    {(ent.sources ?? []).map((s: string) => (
                                      <span key={s} className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium text-white uppercase ${sourceColor(s)}`}>
                                        {s}
                                      </span>
                                    ))}
                                  </div>
                                  <span className="text-[10px] text-gray-500">{ent.evidence_count ?? entAliases.length} signals from {ent.source_count ?? new Set(entAliases.map((a) => a.source)).size} source{(ent.source_count ?? 1) !== 1 ? "s" : ""}</span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <div className="flex items-center gap-1.5">
                                    <div className="w-14 h-1.5 rounded-full bg-white/10 overflow-hidden">
                                      <div
                                        className={`h-full rounded-full ${ent.confidence >= 0.9 ? "bg-emerald-400" : ent.confidence >= 0.7 ? "bg-amber-400" : "bg-red-400"}`}
                                        style={{ width: `${confPct(ent.confidence)}%` }}
                                      />
                                    </div>
                                    <span className="text-xs text-gray-400 w-8 text-right">{confPct(ent.confidence)}%</span>
                                  </div>
                                  <svg className={`w-4 h-4 text-gray-500 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                </div>
                              </button>
                              {expanded && (
                                <div className="px-4 pb-3 space-y-2 border-l-2 border-white/10 ml-4">
                                  <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider pt-1">Evidence trail</div>
                                  {nameAliases.length > 0 && (
                                    <div>
                                      <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Names</div>
                                      <div className="flex flex-wrap gap-1.5">
                                        {nameAliases.map((a) => (
                                          <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-white/5 border border-white/10 px-2 py-1 text-xs text-white">
                                            {a.alias}
                                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceColor(a.source)}`} title={a.source} />
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {emailAliases.length > 0 && (
                                    <div>
                                      <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Emails</div>
                                      <div className="flex flex-wrap gap-1.5">
                                        {emailAliases.map((a) => (
                                          <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-white/5 border border-white/10 px-2 py-1 text-xs text-gray-300 font-mono">
                                            {a.alias}
                                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceColor(a.source)}`} title={a.source} />
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {domainAliases.length > 0 && (
                                    <div>
                                      <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Domains</div>
                                      <div className="flex flex-wrap gap-1.5">
                                        {domainAliases.map((a) => (
                                          <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-white/5 border border-white/10 px-2 py-1 text-xs text-gray-400 font-mono">
                                            {a.alias}
                                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceColor(a.source)}`} title={a.source} />
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {entAssertions.length > 0 && (
                                    <div>
                                      <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Assertions</div>
                                      <div className="flex flex-wrap gap-1.5">
                                        {entAssertions.map((a, i) => (
                                          <span key={i} className="inline-flex items-center gap-1 rounded-full bg-white/5 border border-white/10 px-2 py-0.5 text-[11px] text-gray-400">
                                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceColor(a.source)}`} />
                                            {a.assertion_type.replace(/_/g, " ")} via {a.source} ({a.count}x, avg {confPct(a.avg_score)}%)
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      }

      case 10: {
        const PNL_ELIGIBLE_CLASSES_UI = new Set(["operating_revenue", "operating_expense", "payroll", "tax", "other_income"])
        const PNL_STATEMENT_IMPACTS = new Set(["pnl_revenue", "pnl_expense", "pnl_contra_revenue", "pnl_other_income"])
        const UNRESOLVED_CLASSES = new Set(["unresolved_inflow", "unresolved_outflow", "owner_related_candidate", "funding_candidate", "transfer_candidate"])
        const isSystemRow = (r: { statement_impact?: string | null; event_type?: string | null }) =>
          r.statement_impact === "non_posting" || r.event_type === "adjustment" || r.event_type === "verification"
        const mvts = movementsData?.movements ?? []
        const events = movementsData?.events ?? []
        const mvtSummary = movementsData?.summary ?? []
        const rows = events.length > 0 ? events : mvts
        const totalCount = events.length > 0 ? events.length : mvts.length

        const classCounts: Record<string, number> = {}
        const classAmounts: Record<string, number> = {}
        let pnlCount = 0
        let nonPnlCount = 0
        for (const s of mvtSummary) {
          classCounts[s.movement_class] = (classCounts[s.movement_class] ?? 0) + s.count
          classAmounts[s.movement_class] = (classAmounts[s.movement_class] ?? 0) + parseFloat(s.total_amount)
          if (s.pnl_eligible) pnlCount += s.count
          else nonPnlCount += s.count
        }

        const mvtClassColor = (c: string) =>
          c === "operating_revenue" ? "bg-emerald-500/80 border-emerald-400/50" :
          c === "operating_expense" ? "bg-orange-500/80 border-orange-400/50" :
          c === "internal_transfer" ? "bg-slate-500/80 border-slate-400/50" :
          c === "settlement" ? "bg-violet-500/80 border-violet-400/50" :
          c === "fee" ? "bg-red-500/80 border-red-400/50" :
          c === "refund" ? "bg-amber-500/80 border-amber-400/50" :
          c === "financing" ? "bg-indigo-500/80 border-indigo-400/50" :
          c === "payroll" ? "bg-pink-500/80 border-pink-400/50" :
          c === "tax" ? "bg-red-700/80 border-red-600/50" :
          c === "owner_draw" ? "bg-rose-500/80 border-rose-400/50" :
          c === "owner_contribution" ? "bg-teal-500/80 border-teal-400/50" :
          c === "other_income" ? "bg-cyan-500/80 border-cyan-400/50" :
          UNRESOLVED_CLASSES.has(c) ? "bg-amber-700/80 border-amber-600/50" :
          "bg-zinc-500/80 border-zinc-400/50"

        const mvtClassLabel = (c: string) =>
          c === "operating_revenue" ? "Revenue" :
          c === "operating_expense" ? "Expense" :
          c === "internal_transfer" ? "Transfer" :
          c === "settlement" ? "Settlement" :
          c === "fee" ? "Fee" :
          c === "refund" ? "Refund" :
          c === "financing" ? "Financing" :
          c === "payroll" ? "Payroll" :
          c === "tax" ? "Tax" :
          c === "owner_draw" ? "Owner Draw" :
          c === "owner_contribution" ? "Owner Contribution" :
          c === "other_income" ? "Other Income" :
          c === "uncategorized" ? "Uncategorized" :
          c === "unresolved_inflow" ? "Unresolved inflow" :
          c === "unresolved_outflow" ? "Unresolved outflow" :
          c === "owner_related_candidate" ? "Owner-related (review)" :
          c === "funding_candidate" ? "Funding candidate" :
          c === "transfer_candidate" ? "Transfer candidate" :
          c

        const mvtSourceColor = (s: string) =>
          s?.includes("plaid") ? "bg-amber-500/80" :
          s?.includes("qbo") ? "bg-blue-500/80" :
          s?.includes("stripe") ? "bg-purple-500/80" :
          "bg-zinc-500/80"

        const fmtAmt = (a: string | number) => {
          const n = typeof a === "string" ? parseFloat(a) : a
          const abs = Math.abs(n)
          const formatted = abs >= 1000 ? abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : abs.toFixed(2)
          return n >= 0 ? `+$${formatted}` : `-$${formatted}`
        }

        const classOrder = [
          "operating_revenue", "operating_expense", "payroll", "tax", "other_income",
          "internal_transfer", "settlement", "fee", "refund",
          "financing", "owner_draw", "owner_contribution",
          "unresolved_inflow", "unresolved_outflow", "owner_related_candidate", "funding_candidate", "transfer_candidate",
          "uncategorized",
        ]
        const activeClasses = classOrder.filter((c) => (classCounts[c] ?? 0) > 0)
        const systemRows = rows.filter((r) => isSystemRow(r))
        const hasSystemRows = systemRows.length > 0

        return (
          <div className="pt-0 pb-2 w-full">
            <h2 className="text-3xl font-bold tracking-tight text-white mb-2">{steps[9].title}</h2>
            <p className="text-gray-400 text-lg mb-5">{steps[9].description}</p>

            {(movementsClassifying || movementsLoading) && (
              <div className="flex items-center gap-2 py-6 text-gray-400">
                <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                {movementsClassifying ? "Classifying movements across all sources (this may take a moment)\u2026" : "Loading movements\u2026"}
              </div>
            )}

            {movementsError && !movementsLoading && !movementsClassifying && (
              <p className="text-red-300 text-sm mb-4">Failed to load movements: {movementsError}</p>
            )}

            {!movementsLoading && !movementsClassifying && movementsData && totalCount === 0 && (
              <p className="text-gray-400 text-sm mb-4">No movements classified yet. Connect integrations and sync data first.</p>
            )}

            {!movementsLoading && !movementsClassifying && totalCount > 0 && (
              <div className="space-y-6">
                {/* Summary stats */}
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
                    <div className="text-2xl font-bold text-white">{totalCount}</div>
                    <div className="text-xs text-gray-400">{events.length > 0 ? "Events" : "Movements"}</div>
                  </div>
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
                    <div className="text-2xl font-bold text-emerald-400">{pnlCount}</div>
                    <div className="text-xs text-emerald-400/70">P&L eligible</div>
                  </div>
                  <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
                    <div className="text-2xl font-bold text-gray-400">{nonPnlCount}</div>
                    <div className="text-xs text-gray-500">Non-P&L</div>
                  </div>
                  <button
                    type="button"
                    disabled={movementsClassifying}
                    onClick={() => {
                      setMovementsClassifying(true)
                      setMovementsData(null)
                      fetch("/api/movements/wipe", { method: "POST" })
                        .then(() => fetch("/api/movements/classify?force=true", { method: "POST" }))
                        .catch(() => {})
                      let a = 0
                      const rePoll = () => {
                        a++
                        fetch("/api/movements")
                          .then((r) => r.ok ? r.json() : null)
                          .then((d: MovementsData | null) => {
                            if (d && d.movements.length > 0) { setMovementsData(d); setMovementsClassifying(false) }
                            else if (a < 40) setTimeout(rePoll, 3000)
                            else setMovementsClassifying(false)
                          })
                          .catch(() => { if (a < 40) setTimeout(rePoll, 3000); else setMovementsClassifying(false) })
                      }
                      setTimeout(rePoll, 3000)
                    }}
                    className="rounded-lg border border-white/20 bg-white/5 px-4 py-3 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="text-sm font-medium text-white">{movementsClassifying ? "Classifying\u2026" : "Re-classify"}</div>
                    <div className="text-xs text-gray-400">Wipe & re-run</div>
                  </button>
                </div>

                {/* Tables per movement class */}
                {activeClasses.map((cls) => {
                  const clsRows = rows.filter((r) => r.movement_class === cls && !isSystemRow(r))
                  if (clsRows.length === 0) return null
                  const isPnl = PNL_ELIGIBLE_CLASSES_UI.has(cls)
                  const isUnresolved = UNRESOLVED_CLASSES.has(cls)
                  const stmtImpact = clsRows[0] && "statement_impact" in clsRows[0] ? (clsRows[0] as { statement_impact?: string }).statement_impact : null
                  const showPnlBadge = stmtImpact && PNL_STATEMENT_IMPACTS.has(stmtImpact)
                  return (
                    <div key={cls} className={`rounded-xl border overflow-hidden ${isUnresolved ? "border-amber-500/40 bg-amber-950/20" : "border-white/20 bg-white/5"}`}>
                      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/20">
                        <span className={`inline-flex rounded-md border px-2.5 py-1 text-sm font-semibold text-white ${mvtClassColor(cls)}`}>
                          {mvtClassLabel(cls)}
                        </span>
                        <span className="text-sm text-gray-400">{classCounts[cls]} event{classCounts[cls] !== 1 ? "s" : ""}</span>
                        <span className="text-sm text-gray-500">{fmtAmt(classAmounts[cls] ?? 0)} net</span>
                        {isUnresolved ? (
                          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[11px] text-amber-400 font-medium">
                            Needs review
                          </span>
                        ) : showPnlBadge ? (
                          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[11px] text-emerald-400 font-medium">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
                            P&L
                          </span>
                        ) : (
                          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-white/5 border border-white/10 px-2 py-0.5 text-[11px] text-gray-500 font-medium">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-500" />
                            Balance sheet
                          </span>
                        )}
                      </div>
                      <div className="max-h-[40vh] overflow-y-auto overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-black/60 backdrop-blur-sm">
                            <tr className="border-b border-white/15">
                              <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[90px]">Date</th>
                              <th className="text-right text-gray-400 font-medium px-3 py-2 text-xs w-[100px]">Amount</th>
                              <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs">Counterparty</th>
                              <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs">Description</th>
                              <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[80px]">Source</th>
                              <th className="text-right text-gray-400 font-medium px-3 py-2 text-xs w-[55px]">Conf</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/5">
                            {clsRows.slice(0, 200).map((r) => {
                              const eventKey = "event_id" in r && r.event_id ? r.event_id : r.id
                              const evidence = mvts.filter((m: { event_id?: string | null; id: string }) =>
                                m.event_id === eventKey || m.id === r.id
                              )
                              const isExpanded = movementsExpandedEvent === r.id
                              return (
                                <Fragment key={r.id}>
                                  <tr
                                    onClick={() => setMovementsExpandedEvent(isExpanded ? null : r.id)}
                                    className="hover:bg-white/5 cursor-pointer select-none"
                                  >
                                    <td className="text-gray-400 px-3 py-1.5 text-xs whitespace-nowrap w-[90px]">
                                      <span className="inline-flex items-center gap-1">
                                        <span className={`inline-block w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`}>
                                          ▸
                                        </span>
                                        {r.date?.split("T")[0]}
                                      </span>
                                    </td>
                                    <td className={`px-3 py-1.5 text-xs text-right font-mono whitespace-nowrap ${parseFloat(String(r.amount)) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                      {fmtAmt(r.amount)}
                                    </td>
                                    <td className="text-white px-3 py-1.5 text-xs truncate max-w-[200px]">{(r as { display_counterparty?: string | null }).display_counterparty ?? r.counterparty ?? "\u2014"}</td>
                                    <td className="text-gray-400 px-3 py-1.5 text-xs truncate max-w-[250px]">{r.raw_description ?? "\u2014"}</td>
                                    <td className="px-3 py-1.5">
                                      <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium text-white uppercase ${mvtSourceColor(r.source)}`}>
                                        {r.source}
                                        {"evidence_count" in r && r.evidence_count > 1 ? ` (${r.evidence_count})` : ""}
                                      </span>
                                    </td>
                                    <td className="text-gray-500 px-3 py-1.5 text-xs text-right">{Math.round((r.confidence ?? 0.5) * 100)}%</td>
                                  </tr>
                                  {isExpanded && evidence.length > 0 && (
                                    <tr key={`${r.id}-evidence`}>
                                      <td colSpan={6} className="px-3 py-2 bg-black/30 border-b border-white/10">
                                        <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-2">Evidence trail</div>
                                        <div className="rounded-lg border border-white/10 overflow-hidden">
                                          <table className="w-full text-xs">
                                            <thead>
                                              <tr className="bg-white/5 border-b border-white/10">
                                                <th className="text-left text-gray-500 font-medium px-2 py-1.5">Source</th>
                                                <th className="text-left text-gray-500 font-medium px-2 py-1.5">Date</th>
                                                <th className="text-right text-gray-500 font-medium px-2 py-1.5">Amount</th>
                                                <th className="text-left text-gray-500 font-medium px-2 py-1.5">Counterparty</th>
                                                <th className="text-left text-gray-500 font-medium px-2 py-1.5">Description</th>
                                                <th className="text-right text-gray-500 font-medium px-2 py-1.5">Conf</th>
                                              </tr>
                                            </thead>
                                            <tbody className="divide-y divide-white/5">
                                              {evidence.map((m: { id: string; source?: string; date?: string; amount?: string | number; counterparty?: string | null; display_counterparty?: string | null; raw_description?: string | null; confidence?: number }) => (
                                                <tr key={m.id} className="hover:bg-white/5">
                                                  <td className="px-2 py-1.5">
                                                    <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium text-white uppercase ${mvtSourceColor(m.source ?? "")}`}>
                                                      {m.source ?? "\u2014"}
                                                    </span>
                                                  </td>
                                                  <td className="text-gray-400 px-2 py-1.5 whitespace-nowrap">{m.date?.split?.("T")[0] ?? "\u2014"}</td>
                                                  <td className={`px-2 py-1.5 text-right font-mono whitespace-nowrap ${parseFloat(String(m.amount ?? 0)) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                                    {fmtAmt(m.amount ?? 0)}
                                                  </td>
                                                  <td className="text-white px-2 py-1.5 truncate max-w-[180px]">{m.display_counterparty ?? m.counterparty ?? "\u2014"}</td>
                                                  <td className="text-gray-400 px-2 py-1.5 truncate max-w-[220px]" title={m.raw_description ?? undefined}>{m.raw_description ?? "\u2014"}</td>
                                                  <td className="text-gray-500 px-2 py-1.5 text-right">{Math.round((m.confidence ?? 0.5) * 100)}%</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              )
                            })}
                          </tbody>
                        </table>
                        {clsRows.length > 200 && (
                          <div className="px-3 py-2 text-xs text-gray-500 border-t border-white/10">Showing 200 of {clsRows.length} events</div>
                        )}
                      </div>
                    </div>
                  )
                })}

                {/* System / Non-posting section */}
                {hasSystemRows && (
                  <details className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
                    <summary className="px-4 py-3 border-b border-white/20 cursor-pointer list-none flex items-center gap-3">
                      <span className="inline-flex rounded-md border px-2.5 py-1 text-sm font-semibold text-gray-400 bg-zinc-600/50 border-zinc-500/50">
                        System / Non-posting
                      </span>
                      <span className="text-sm text-gray-500">{systemRows.length} event{systemRows.length !== 1 ? "s" : ""}</span>
                    </summary>
                    <div className="max-h-[30vh] overflow-y-auto overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-black/60 backdrop-blur-sm">
                          <tr className="border-b border-white/15">
                            <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[90px]">Date</th>
                            <th className="text-right text-gray-400 font-medium px-3 py-2 text-xs w-[100px]">Amount</th>
                            <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs">Counterparty</th>
                            <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs">Description</th>
                            <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[80px]">Source</th>
                            <th className="text-right text-gray-400 font-medium px-3 py-2 text-xs w-[55px]">Conf</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                          {systemRows.slice(0, 100).map((r) => (
                            <tr key={r.id} className="hover:bg-white/5">
                              <td className="text-gray-400 px-3 py-1.5 text-xs whitespace-nowrap">{r.date?.split?.("T")[0]}</td>
                              <td className={`px-3 py-1.5 text-xs text-right font-mono whitespace-nowrap ${parseFloat(String(r.amount)) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                {fmtAmt(r.amount)}
                              </td>
                              <td className="text-white px-3 py-1.5 text-xs truncate max-w-[200px]">{(r as { display_counterparty?: string | null }).display_counterparty ?? r.counterparty ?? "\u2014"}</td>
                              <td className="text-gray-400 px-3 py-1.5 text-xs truncate max-w-[250px]">{r.raw_description ?? "\u2014"}</td>
                              <td className="px-3 py-1.5">
                                <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium text-white uppercase ${mvtSourceColor(r.source)}`}>
                                  {r.source}
                                  {"evidence_count" in r && r.evidence_count > 1 ? ` (${r.evidence_count})` : ""}
                                </span>
                              </td>
                              <td className="text-gray-500 px-3 py-1.5 text-xs text-right">{Math.round((r.confidence ?? 0.5) * 100)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {systemRows.length > 100 && (
                        <div className="px-3 py-2 text-xs text-gray-500 border-t border-white/10">Showing 100 of {systemRows.length} events</div>
                      )}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        )
      }

      default:
        return (
          <div className="text-center py-12">
            <div>
              <h2 className="text-2xl font-semibold text-white mb-3">{steps[currentStep - 1].title}</h2>
              <p className="text-gray-400 text-base">{steps[currentStep - 1].description}</p>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-lg p-6 max-w-md mx-auto">
              <p className="text-sm text-gray-400">This step will be available soon</p>
            </div>
          </div>
        )
    }
  }

  const isStep6 = currentStep === 6
  const isWideStep = currentStep === 8 || currentStep === 9 || currentStep === 10
  return (
    <div
      className={
        isStep6
          ? "w-full max-w-[96rem] mx-auto px-4 pt-6 pb-8"
          : isWideStep
            ? "w-full max-w-[90vw] mx-auto px-4 pt-10 pb-8 md:pt-16 md:pb-10"
            : "w-full max-w-5xl mx-auto px-4 pt-10 pb-8 md:pt-16 md:pb-10"
      }
    >
      {showQboError && qboError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-amber-200">
          <p className="text-sm">{QBO_ERROR_MESSAGES[qboError]}</p>
          <button
            type="button"
            onClick={() => setDismissedError(true)}
            className="shrink-0 rounded p-1 text-amber-300 hover:bg-amber-500/20"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <div className={isStep6 ? "mb-2" : "mb-8"}>
        <div className="flex items-center flex-col justify-start mb-0">
          <Image
            src="/profitwise-logo.png"
            alt="ProfitWise"
            width={320}
            height={96}
            className="h-20 w-auto object-contain mx-0 px-0 my-0.5"
          />
        </div>
        {!isStep6 && (
        <div className="w-full max-w-2xl mx-auto py-[13px] pt-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-white">
              Step {currentStep} of {steps.length}
            </span>
            <span className="text-sm font-medium text-white">
              {Math.round((currentStep / steps.length) * 100)}% Complete
            </span>
          </div>
          <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
            <div
              className="bg-white h-2 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${(currentStep / steps.length) * 100}%` }}
            />
          </div>
        </div>
        )}
      </div>
      {/* Main step content without extra dark card background */}
      <div className="mb-10">
        {renderStepContent()}
      </div>

      <div className="flex justify-between gap-4">
        <Button
          type="button"
          onClick={handleBack}
          disabled={currentStep === 1}
          variant="outline"
          className="w-32 h-11 bg-white/5 border-white/10 text-white hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={handleNextOrFinish}
          className="w-32 h-11 bg-white hover:bg-white/90 text-black font-medium"
        >
          {currentStep === 6 || currentStep === 7 || currentStep === steps.length ? "Finish" : "Next"}
        </Button>
      </div>
    </div>
  )
}

"use client"

import { useState, useEffect, useCallback, useRef } from "react"
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
  { id: 1, title: "Connect Your Bank Account", description: "Securely link your first bank account" },
  { id: 2, title: "Your Bank Accounts", description: "View balances and add more accounts" },
  { id: 3, title: "Connect Your Accounting Stack", description: "Link the tools you already use" },
  {
    id: 4,
    title: "Connect Your Context Layer",
    description: "Share documents and knowledge so we understand your business",
  },
  {
    id: 5,
    title: "Choose Communication Channels",
    description: "Pick where you want to talk to ProfitWise and receive updates",
  },
  { id: 6, title: "Company and financial context", description: "Review and refine your business context" },
  { id: 7, title: "Revenue Details", description: "Help us understand your financials" },
  { id: 8, title: "Reporting Preferences", description: "Customize your dashboard" },
  { id: 9, title: "Notification Settings", description: "Stay updated with alerts" },
  { id: 10, title: "Security Setup", description: "Enable two-factor authentication" },
  { id: 11, title: "Review & Launch", description: "You're almost ready!" },
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
  const [merchantEditDraft, setMerchantEditDraft] = useState<{ normalized_name: string; tag: string; transaction_type: string }>({
    normalized_name: "",
    tag: "",
    transaction_type: "One-time",
  })
  const [merchantSaveLoading, setMerchantSaveLoading] = useState(false)
  const [merchantsNormalizeError, setMerchantsNormalizeError] = useState<string | null>(null)
  type AccountingTx = {
    transaction_id: string
    account_id: string
    date: string
    created_at: string
    amount: number
    account_name: string
    raw_name: string
    normalized_name: string
    tag: string
    transaction_type: string
    confidence: number
  }
  const [accountingTransactions, setAccountingTransactions] = useState<AccountingTx[]>([])
  const [accountingTransactionsLoading, setAccountingTransactionsLoading] = useState(false)
  const [selectedAccountingTransaction, setSelectedAccountingTransaction] = useState<AccountingTx | null>(null)
  const [accountFilter, setAccountFilter] = useState<string | null>(null)
  const [aiSuggestMessage, setAiSuggestMessage] = useState("")
  const [aiSuggestLoading, setAiSuggestLoading] = useState(false)
  const [rerunAiLoading, setRerunAiLoading] = useState(false)
  const [whatsappStatus, setWhatsappStatus] = useState<{ phone: string | null; verified: boolean } | null>(null)
  const [whatsappPhoneInput, setWhatsappPhoneInput] = useState("")
  const [whatsappOtpSent, setWhatsappOtpSent] = useState(false)
  const [whatsappCodeInput, setWhatsappCodeInput] = useState("")
  const [whatsappSendLoading, setWhatsappSendLoading] = useState(false)
  const [whatsappVerifyLoading, setWhatsappVerifyLoading] = useState(false)
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
    fetch("/api/plaid/balances")
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
        const realmIds = data.realmIds ?? []
        const tenantIds = data.tenantIds ?? []
        triggerAccountingSyncIfNeeded(realmIds, tenantIds, false)
      })
      .catch(() => setConnectedIntegrations([]))
  }, [currentStep, triggerAccountingSyncIfNeeded])

  useEffect(() => {
    if (currentStep !== 3) return
    const onFocus = () => {
      fetch("/api/connections")
        .then((res) => (res.ok ? res.json() : { connected: [], realmIds: [], tenantIds: [] }))
        .then((data: { connected?: string[]; realmIds?: string[]; tenantIds?: string[] }) => {
          setConnectedIntegrations(data.connected ?? [])
          const realmIds = data.realmIds ?? []
          const tenantIds = data.tenantIds ?? []
          triggerAccountingSyncIfNeeded(realmIds, tenantIds, true)
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
  }, [currentStep, triggerAccountingSyncIfNeeded])

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
    // Prefer saved context when coming back from next step; only run AI merge when we have no saved context
    fetch("/api/context/save")
      .then((res) => {
        if (!res.ok) return { ok: false as const }
        return res.json().then((data: { finalContext?: string | null }) => ({ ok: true as const, data }))
      })
      .then((result) => {
        if (result.ok && result.data.finalContext && String(result.data.finalContext).trim()) {
          setCompanyContext(String(result.data.finalContext).trim())
          setEditedContext(null)
          setCompanyContextLoading(false)
          return
        }
        if (!result.ok) {
          setCompanyContextLoading(false)
          return
        }
        setCompanyContext(null)
        let companyContextText = ""
        return fetch("/api/supermemory/company-context")
          .then((res) => (res.ok ? res.json() : { context: "" }) as Promise<{ context?: string }>)
          .then((data) => {
            companyContextText = data.context ?? ""
            return fetch("/api/context/financial")
          })
          .then((res) => {
            if (!res.ok) throw new Error("Failed to load financial context")
            return res.json()
          })
          .then((financialContext) =>
            fetch("/api/context/merge", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ companyContext: companyContextText, financialContext }),
            })
          )
          .then((res) => {
            if (!res.ok) throw new Error("Failed to merge context")
            return res.json() as Promise<{ finalContext?: string }>
          })
          .then((mergeData) => {
            setCompanyContext(mergeData.finalContext ?? null)
            setEditedContext(null)
          })
      })
      .catch((err) => {
        if (err?.message) setCompanyContextError("We couldn't build your company context. You can try again or continue.")
      })
      .finally(() => setCompanyContextLoading(false))
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 7) return
    setCompanyFormLoading(true)
    fetch("/api/plaid/balances")
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
    setMerchantsNormalizeError(null)
    setAccountingTransactionsLoading(true)
    const loadAccounting = () =>
      fetch("/api/onboarding/merchants/transactions?limit=200")
        .then((res) => (res.ok ? res.json() : { transactions: [] }))
        .then((data: { transactions?: AccountingTx[] }) => setAccountingTransactions(data.transactions ?? []))
        .catch(() => setAccountingTransactions([]))
        .finally(() => setAccountingTransactionsLoading(false))
    loadAccounting()
    fetch("/api/onboarding/merchants/normalize-and-tag")
      .then((res) => (res.ok ? res.json() : { rows: [] }))
      .then((data: { rows?: unknown[] }) => {
        const rows = data.rows ?? []
        if (rows.length === 0) {
          return fetch("/api/onboarding/merchants/normalize-and-tag", { method: "POST" })
            .then((r) => (r.ok ? loadAccounting() : Promise.reject(new Error(r.statusText))))
        }
      })
      .catch((err) => setMerchantsNormalizeError(err instanceof Error ? err.message : "Failed to generate tags"))
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
            <div className="max-w-3xl mx-auto space-y-4">
              {hasAccounts ? (
                <div className="rounded-lg border border-white/20 bg-white/5 overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-white/20 hover:bg-transparent">
                        <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-4 py-3">
                          Account name
                        </TableHead>
                        <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-4 py-3">
                          Last 4
                        </TableHead>
                        <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-4 py-3">
                          Type
                        </TableHead>
                        <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-4 py-3 text-right">
                          Current balance
                        </TableHead>
                        <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-4 py-3 text-right">
                          Available balance
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {connectedAccounts.map((acc, i) => (
                        <TableRow
                          key={`${acc.name}-${acc.mask ?? i}`}
                          className="border-white/20 hover:bg-white/5"
                        >
                          <TableCell className="text-white border-white/20 px-4 py-3 font-medium">
                            {acc.name}
                          </TableCell>
                          <TableCell className="text-gray-400 border-white/20 px-4 py-3 tabular-nums">
                            {acc.mask ?? "—"}
                          </TableCell>
                          <TableCell className="text-gray-400 border-white/20 px-4 py-3 capitalize">
                            {acc.type || "—"}
                          </TableCell>
                          <TableCell className="text-white border-white/20 px-4 py-3 text-right tabular-nums font-medium">
                            {formatBalance(acc.current_balance)}
                          </TableCell>
                          <TableCell className="text-gray-400 border-white/20 px-4 py-3 text-right tabular-nums">
                            {formatBalance(acc.available_balance)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                    {hasAccounts && (
                      <TableFooter>
                        <TableRow className="border-white/20 bg-white/10 hover:bg-white/10">
                          <TableCell
                            colSpan={3}
                            className="text-white font-semibold border-white/20 px-4 py-3"
                          >
                            Total
                          </TableCell>
                          <TableCell className="text-white font-semibold border-white/20 px-4 py-3 text-right tabular-nums">
                            {formatBalance(totalBalance)}
                          </TableCell>
                          <TableCell className="border-white/20 px-4 py-3" />
                        </TableRow>
                      </TableFooter>
                    )}
                  </Table>
                </div>
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
              <Button
                type="button"
                onClick={handleAddAnotherAccount}
                disabled={addAccountLinkLoading || !plaidReady}
                variant="outline"
                className="w-full h-12 rounded-xl bg-white/5 border-white/20 text-white hover:bg-white/10 font-medium"
              >
                {addAccountLinkLoading ? "Loading..." : "Add another bank account"}
              </Button>
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
                const plaidDisabled = usePlaid && (accountingStepLinkLoading || !plaidReady)
                const isConnected = connectedIntegrations.includes(integration.name)
                return (
                  <button
                    key={integration.name}
                    type="button"
                    onClick={() =>
                      usePlaid ? openPlaidLink() : toggleIntegration(integration.name)
                    }
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
              <h2 className="text-2xl font-semibold text-white mb-3">Connect your context layer</h2>
              <p className="text-gray-400 text-base">
                Link where your contracts, invoices, and docs live so we can understand your business context.
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
              {/* WhatsApp: phone + OTP connect */}
              <div className="bg-white/5 border border-white/10 rounded-lg p-5 flex flex-col items-center justify-center min-h-[200px]">
                <div className="w-20 h-20 mb-3 flex items-center justify-center">
                  <Image
                    src="/whatsapp-logo.png"
                    alt="WhatsApp"
                    width={80}
                    height={80}
                    className="object-contain max-w-full max-h-full"
                  />
                </div>
                <h3 className="text-white font-semibold text-sm leading-tight mb-3">WhatsApp</h3>
                {whatsappStatus === null ? (
                  <p className="text-gray-500 text-xs">Loading…</p>
                ) : whatsappStatus.verified && whatsappStatus.phone ? (
                  <p className="text-emerald-400 text-xs font-medium">Connected as {whatsappStatus.phone}</p>
                ) : (
                  <div className="w-full space-y-2 mt-1">
                    {!whatsappOtpSent ? (
                      <>
                        <Input
                          placeholder="+1 555 123 4567"
                          value={whatsappPhoneInput}
                          onChange={(e) => setWhatsappPhoneInput(e.target.value)}
                          className="bg-white/5 border-white/20 text-white text-sm h-9"
                        />
                        <Button
                          size="sm"
                          className="w-full"
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
                          className="bg-white/5 border-white/20 text-white text-sm h-9"
                          maxLength={6}
                        />
                        <Button
                          size="sm"
                          className="w-full"
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
                  </div>
                )}
              </div>

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
                We’re combining your business docs with expenses and vendors from the last 60 days. This usually takes a few seconds.
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
              <p className="text-gray-400 text-sm mt-1">Using Supermemory and OpenAI to prefill the form…</p>
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
              Form is prefilled from your connected docs (Supermemory) via OpenAI. Edit any field; click Finish to save the final form.
            </p>
          </div>
        )
      }

      case 8: {
        const reloadTableFromDb = () => {
          setSelectedAccountingTransaction(null)
          setMerchantsNormalizeError(null)
          fetch("/api/onboarding/merchants/transactions?limit=200")
            .then((res) => (res.ok ? res.json() : { transactions: [] }))
            .then((data: { transactions?: AccountingTx[] }) => setAccountingTransactions(data.transactions ?? []))
            .catch(() => {})
        }
        const saveMerchantToMemory = () => {
          if (!selectedAccountingTransaction) return
          setMerchantSaveLoading(true)
          setMerchantsNormalizeError(null)
          const norm = merchantEditDraft.normalized_name.trim() || selectedAccountingTransaction.normalized_name
          const tag = merchantEditDraft.tag.trim() || selectedAccountingTransaction.tag
          const txType = merchantEditDraft.transaction_type
          fetch("/api/onboarding/merchants/update", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              account_id: selectedAccountingTransaction.account_id,
              raw_name: selectedAccountingTransaction.raw_name,
              normalized_name: norm,
              tag,
              transaction_type: txType,
            }),
          })
            .then((res) => (res.ok ? undefined : Promise.reject(new Error("Save failed"))))
            .then(() => {
              setSelectedAccountingTransaction((prev) =>
                prev ? { ...prev, normalized_name: norm, tag, transaction_type: txType, confidence: 1 } : null
              )
              setAccountingTransactions((prev) =>
                prev.map((tx) =>
                  tx.account_id === selectedAccountingTransaction.account_id && tx.raw_name === selectedAccountingTransaction.raw_name
                    ? { ...tx, normalized_name: norm, tag, transaction_type: txType, confidence: 1 }
                    : tx
                )
              )
            })
            .catch(() => setMerchantsNormalizeError("Failed to save to memory"))
            .finally(() => setMerchantSaveLoading(false))
        }
        const TRANSACTION_TYPE_OPTIONS = ["Recurring subscription", "Recurring (other)", "One-time"]
        const TAG_COLORS = [
          "bg-blue-500/80 text-white border-blue-400/50",
          "bg-emerald-500/80 text-white border-emerald-400/50",
          "bg-amber-500/80 text-black border-amber-400/50",
          "bg-violet-500/80 text-white border-violet-400/50",
          "bg-rose-500/80 text-white border-rose-400/50",
          "bg-cyan-500/80 text-black border-cyan-400/50",
          "bg-lime-500/80 text-black border-lime-400/50",
          "bg-orange-500/80 text-black border-orange-400/50",
        ]
        const tagColor = (tag: string) => TAG_COLORS[Math.abs(tag.split("").reduce((a, c) => (a + c.charCodeAt(0)) | 0, 0)) % TAG_COLORS.length]
        const typeColor = (t: string) =>
          t === "Recurring subscription"
            ? "bg-sky-500/80 text-white border-sky-400/50"
            : t === "Recurring (other)"
              ? "bg-amber-500/70 text-black border-amber-400/50"
              : "bg-zinc-500/60 text-white border-zinc-400/50"
        const formatTxDate = (d: string) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—")
        const formatTxTime = (created: string) => (created ? new Date(created).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : "—")
        const confidenceColor = (c: number) =>
          c >= 0.7 ? "text-emerald-400" : c >= 0.4 ? "text-amber-400" : "text-rose-400"
        const formatConfidence = (c: number) => `${Math.round((c ?? 0) * 100)}%`
        const filteredByAccount = accountFilter
          ? accountingTransactions.filter((tx) => tx.account_name === accountFilter)
          : accountingTransactions
        const recurringTxs = filteredByAccount.filter(
          (tx) => tx.transaction_type === "Recurring subscription" || tx.transaction_type === "Recurring (other)"
        )
        const otherTxs = filteredByAccount.filter(
          (tx) => tx.transaction_type !== "Recurring subscription" && tx.transaction_type !== "Recurring (other)"
        )
        const uniqueAccounts = Array.from(
          new Map(accountingTransactions.map((tx) => [tx.account_name, tx.account_name])).values()
        ).sort()
        const renderTxRow = (tx: AccountingTx) => {
          const isSelected = selectedAccountingTransaction?.transaction_id === tx.transaction_id
          return (
            <TableRow
              key={tx.transaction_id}
              className={`border-white/20 cursor-pointer hover:bg-white/10 ${isSelected ? "bg-white/15" : "hover:bg-white/5"}`}
              onClick={() => {
                setSelectedAccountingTransaction(tx)
                setMerchantEditDraft({
                  normalized_name: tx.normalized_name,
                  tag: tx.tag,
                  transaction_type: tx.transaction_type,
                })
                setAiSuggestMessage("")
              }}
            >
              <TableCell className="text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap text-sm">{formatTxDate(tx.date)}</TableCell>
              <TableCell className="text-gray-400 border-white/20 px-3 py-2 whitespace-nowrap text-sm">{formatTxTime(tx.created_at)}</TableCell>
              <TableCell
                className={`border-white/20 px-3 py-2 whitespace-nowrap text-right font-medium text-sm ${
                  tx.amount < 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {formatBalance(tx.amount)}
              </TableCell>
              <TableCell className="text-white border-white/20 px-3 py-2 whitespace-nowrap text-sm">{tx.account_name}</TableCell>
              <TableCell className="text-white border-white/20 px-3 py-2 whitespace-nowrap text-sm">{tx.normalized_name}</TableCell>
              <TableCell className="border-white/20 px-3 py-2 whitespace-nowrap">
                <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium ${tagColor(tx.tag)}`}>{tx.tag}</span>
              </TableCell>
              <TableCell className="border-white/20 px-3 py-2 whitespace-nowrap">
                <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium ${typeColor(tx.transaction_type)}`}>
                  {tx.transaction_type}
                </span>
              </TableCell>
              <TableCell className={`border-white/20 px-3 py-2 whitespace-nowrap text-sm font-medium ${confidenceColor(tx.confidence ?? 0)}`} title="AI confidence">
                {formatConfidence(tx.confidence ?? 0)}
              </TableCell>
            </TableRow>
          )
        }
        const suggestWithAi = () => {
          if (!selectedAccountingTransaction || !aiSuggestMessage.trim()) return
          setAiSuggestLoading(true)
          fetch("/api/onboarding/merchants/suggest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              raw_name: selectedAccountingTransaction.raw_name,
              normalized_name: merchantEditDraft.normalized_name,
              tag: merchantEditDraft.tag,
              transaction_type: merchantEditDraft.transaction_type,
              user_message: aiSuggestMessage.trim(),
            }),
          })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Suggest failed"))))
            .then((data: { normalized_name?: string; tag?: string; transaction_type?: string }) => {
              setMerchantEditDraft((d) => ({
                normalized_name: data.normalized_name ?? d.normalized_name,
                tag: data.tag ?? d.tag,
                transaction_type:
                  (data.transaction_type as "Recurring subscription" | "Recurring (other)" | "One-time") ?? d.transaction_type,
              }))
              setAiSuggestMessage("")
            })
            .catch(() => setMerchantsNormalizeError("AI suggest failed. Try again."))
            .finally(() => setAiSuggestLoading(false))
        }
        return (
          <div className="pt-0 pb-2 w-full">
            <h2 className="text-3xl font-bold tracking-tight text-white mb-2">{steps[7].title}</h2>
            <p className="text-gray-400 text-lg mb-5">{steps[7].description}</p>
            <p className="text-gray-300 text-sm mb-4">
              Normalized merchant names, tags, and transaction types are generated by AI using your company context and Supermemory. Filter by account, edit any row, or type in the chat to let AI update fields.
            </p>
            {merchantsNormalizeError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4">
                <p className="text-red-300 text-sm">{merchantsNormalizeError}</p>
                <Button
                  onClick={() => {
                    setMerchantsNormalizeError(null)
                    fetch("/api/onboarding/merchants/normalize-and-tag", { method: "POST" })
                      .then((r) => (r.ok ? fetch("/api/onboarding/merchants/transactions?limit=200") : Promise.reject(new Error(r.statusText))))
                      .then((r) => (r.ok ? r.json() : { transactions: [] }))
                      .then((data: { transactions?: AccountingTx[] }) => setAccountingTransactions(data.transactions ?? []))
                      .catch(() => setMerchantsNormalizeError("Request failed"))
                  }}
                  variant="outline"
                  className="mt-3 border-white/30 text-white hover:bg-white/10"
                >
                  Try again
                </Button>
              </div>
            )}
            {accountingTransactions.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <span className="text-gray-400 text-sm">Account:</span>
                <button
                  type="button"
                  onClick={() => setAccountFilter(null)}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                    accountFilter === null ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/20"
                  }`}
                >
                  All
                </button>
                {uniqueAccounts.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setAccountFilter(name)}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                      accountFilter === name ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/20"
                    }`}
                  >
                    {name}
                  </button>
                ))}
                <Button
                  type="button"
                  onClick={() => {
                    setRerunAiLoading(true)
                    setMerchantsNormalizeError(null)
                    fetch("/api/onboarding/merchants/normalize-and-tag", { method: "POST" })
                      .then((r) => (r.ok ? fetch("/api/onboarding/merchants/transactions?limit=200") : Promise.reject(new Error(r.statusText))))
                      .then((r) => (r.ok ? r.json() : { transactions: [] }))
                      .then((data: { transactions?: AccountingTx[] }) => setAccountingTransactions(data.transactions ?? []))
                      .catch((err) => setMerchantsNormalizeError(err instanceof Error ? err.message : "Re-run failed"))
                      .finally(() => setRerunAiLoading(false))
                  }}
                  disabled={rerunAiLoading}
                  variant="outline"
                  className="ml-auto border-white/30 text-white hover:bg-white/10"
                >
                  {rerunAiLoading ? "Re-running AI…" : "Reload — Re-run AI (last 2 months)"}
                </Button>
              </div>
            )}
            <div className="mb-6">
              {accountingTransactionsLoading ? (
                <div className="flex items-center gap-2 py-6 text-gray-400">
                  <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Loading transactions…
                </div>
              ) : accountingTransactions.length === 0 ? (
                <p className="text-gray-400 py-4">No transactions in the last 2 months. Connect bank accounts and sync.</p>
              ) : (
                <>
                  <div className="mb-6">
                    <h3 className="text-lg font-semibold text-white mb-2">All transactions</h3>
                    <div className="rounded-lg border border-white/20 bg-white/5 overflow-x-auto overflow-y-auto max-h-[40vh] mb-2">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-white/20 hover:bg-transparent">
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Date</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Time</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap text-right">Amount</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Account</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Merchant</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Tag</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Transaction type</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Confidence</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredByAccount.length === 0 ? (
                            <TableRow className="border-white/20">
                              <TableCell colSpan={8} className="text-gray-400 text-center py-6 border-white/20">
                                No transactions in this view.
                              </TableCell>
                            </TableRow>
                          ) : (
                            filteredByAccount.map((tx) => renderTxRow(tx))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                  <div className="mb-4">
                    <h3 className="text-lg font-semibold text-white mb-2">Recurring & Subscriptions</h3>
                    <div className="rounded-lg border border-white/20 bg-white/5 overflow-x-auto overflow-y-auto max-h-[40vh] mb-2">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-white/20 hover:bg-transparent">
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Date</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Time</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap text-right">Amount</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Account</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Merchant</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Tag</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Transaction type</TableHead>
                            <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">Confidence</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {recurringTxs.length === 0 ? (
                            <TableRow className="border-white/20">
                              <TableCell colSpan={8} className="text-gray-400 text-center py-6 border-white/20">
                                No recurring or subscription transactions in this view.
                              </TableCell>
                            </TableRow>
                          ) : (
                            recurringTxs.map((tx) => renderTxRow(tx))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                  {selectedAccountingTransaction && (
                    <div className="rounded-lg border border-white/20 bg-white/10 p-4 space-y-3">
                      <p className="text-gray-400 text-sm font-medium">Editing: {selectedAccountingTransaction.raw_name}</p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="text-gray-400 text-xs block mb-1">Normalized name</label>
                          <Input
                            className="bg-white/10 border-white/20 text-white"
                            value={merchantEditDraft.normalized_name}
                            onChange={(e) => setMerchantEditDraft((d) => ({ ...d, normalized_name: e.target.value }))}
                            placeholder="Canonical name"
                          />
                        </div>
                        <div>
                          <label className="text-gray-400 text-xs block mb-1">Tag</label>
                          <Input
                            className="bg-white/10 border-white/20 text-white"
                            value={merchantEditDraft.tag}
                            onChange={(e) => setMerchantEditDraft((d) => ({ ...d, tag: e.target.value }))}
                            placeholder="e.g. Software, Subscriptions"
                          />
                        </div>
                        <div>
                          <label className="text-gray-400 text-xs block mb-1">Transaction type</label>
                          <select
                            className="w-full rounded-md border border-white/20 bg-white/10 text-white px-3 py-2 text-sm"
                            value={merchantEditDraft.transaction_type}
                            onChange={(e) =>
                              setMerchantEditDraft((d) => ({ ...d, transaction_type: e.target.value as "Recurring subscription" | "Recurring (other)" | "One-time" }))
                            }
                          >
                            {TRANSACTION_TYPE_OPTIONS.map((opt) => (
                              <option key={opt} value={opt} className="bg-gray-900 text-white">
                                {opt}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="border-t border-white/20 pt-3">
                        <label className="text-gray-400 text-xs block mb-1">Ask AI to update (e.g. &quot;Make it Software, Recurring subscription&quot;)</label>
                        <div className="flex gap-2 flex-wrap">
                          <textarea
                            className="min-h-[80px] w-full max-w-md rounded-md border border-white/20 bg-white/10 text-white px-3 py-2 text-sm placeholder:text-gray-500 resize-y"
                            value={aiSuggestMessage}
                            onChange={(e) => setAiSuggestMessage(e.target.value)}
                            placeholder="Type what you want and AI will update the fields above..."
                            rows={2}
                          />
                          <Button
                            type="button"
                            onClick={suggestWithAi}
                            disabled={aiSuggestLoading || !aiSuggestMessage.trim()}
                            variant="outline"
                            className="border-white/30 text-white hover:bg-white/10 self-end"
                          >
                            {aiSuggestLoading ? "…" : "Suggest with AI"}
                          </Button>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={saveMerchantToMemory}
                          disabled={merchantSaveLoading}
                          className="bg-white text-black hover:bg-gray-200"
                        >
                          {merchantSaveLoading ? "Saving…" : "Save to memory"}
                        </Button>
                        <Button onClick={reloadTableFromDb} variant="outline" className="border-white/30 text-white hover:bg-white/10">
                          Finished (reload from DB)
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
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
  const isStep8 = currentStep === 8
  return (
    <div
      className={
        isStep6
          ? "w-full max-w-[96rem] mx-auto px-4 pt-6 pb-8"
          : isStep8
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

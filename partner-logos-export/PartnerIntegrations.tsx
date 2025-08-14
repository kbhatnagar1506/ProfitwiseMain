"use client"

import React from "react"

/**
 * Partner integrations grid – accounting, payments, payroll, etc.
 * Use in any React/Next app. Put images in your public folder and set imageBasePath.
 */

const INTEGRATIONS = [
  { name: "QuickBooks Online", description: "Core accounting", category: "Accounting", logo: "quickbooks-logo.png" },
  { name: "Stripe", description: "Payments + billing", category: "Payments", logo: "stripe-logo.png" },
  { name: "Gusto", description: "Payroll", category: "Payroll", logo: "gusto-logo.png" },
  { name: "Ramp", description: "Spend + cards", category: "Spend Management", logo: "ramp-logo.png" },
  { name: "Xero", description: "Core accounting", category: "Accounting", logo: "xero-logo.png" },
  { name: "Sage Intacct", description: "Enterprise accounting", category: "Accounting", logo: "sage-logo.png" },
  { name: "NetSuite", description: "Enterprise accounting", category: "Accounting", logo: "netsuite-logo.png" },
  { name: "BILL", description: "AP/AR automation", category: "AP/AR", logo: "bill-logo.png" },
  { name: "Brex", description: "Spend management", category: "Spend Management", logo: "brex-logo.png" },
  { name: "Expensify", description: "Expenses", category: "Expenses", logo: "expensify-logo.png" },
  { name: "Rippling", description: "Payroll + HRIS", category: "Payroll & HRIS", logo: "rippling-logo.png" },
  { name: "ADP", description: "Payroll", category: "Payroll", logo: "adp-logo.png" },
  { name: "Avalara", description: "Sales tax", category: "Tax", logo: "avalara-logo.png" },
  { name: "Tipalti", description: "AP automation", category: "AP Automation", logo: "tipalti-logo.png" },
]

export interface PartnerIntegrationsProps {
  /** Base path for logo images (e.g. "/images"). No trailing slash. */
  imageBasePath?: string
  /** Called when user clicks an integration */
  onSelect?: (name: string) => void
  /** Optional placeholder image if a logo fails to load */
  placeholderSrc?: string
  /** Optional class for the outer container */
  className?: string
}

export function PartnerIntegrations({
  imageBasePath = "/images",
  onSelect,
  placeholderSrc,
  className = "",
}: PartnerIntegrationsProps) {
  const base = imageBasePath.replace(/\/$/, "")

  return (
    <div className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 ${className}`.trim()}>
      {INTEGRATIONS.map((integration) => (
        <button
          key={integration.name}
          type="button"
          onClick={() => onSelect?.(integration.name)}
          className="bg-white/5 border border-white/10 rounded-lg p-4 text-center transition-all aspect-square flex flex-col items-center justify-center hover:border-white/30 hover:bg-white/10"
          style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "0.5rem",
          }}
        >
          <div className="w-20 h-20 mb-3 flex items-center justify-center">
            <img
              src={`${base}/${integration.logo}`}
              alt={`${integration.name} logo`}
              width={80}
              height={80}
              className="object-contain max-w-full max-h-full"
              onError={(e) => {
                if (placeholderSrc) e.currentTarget.src = placeholderSrc
              }}
            />
          </div>
          <span className="text-white font-semibold text-sm leading-tight" style={{ color: "#fff" }}>
            {integration.name}
          </span>
          <span className="text-xs text-gray-400 mt-1" style={{ color: "#9ca3af", marginTop: "0.25rem" }}>
            {integration.category}
          </span>
        </button>
      ))}
    </div>
  )
}

"use client"

import React from "react"

/**
 * Partner bank logos – scrolling strip of bank logos.
 * Use in any React/Next app. Put images in your public folder and set imageBasePath (e.g. "/images").
 */

const PARTNER_BANKS = [
  { name: "Chase", logo: "chase-logo.png" },
  { name: "Bank of America", logo: "bofa-logo.png" },
  { name: "Wells Fargo", logo: "wells-fargo-logo.png" },
  { name: "Citibank", logo: "citibank-logo.png" },
  { name: "Capital One", logo: "capital-one-logo.png" },
  { name: "PNC Bank", logo: "pnc-logo.png" },
  { name: "US Bank", logo: "us-bank-logo.png" },
  { name: "TD Bank", logo: "td-bank-logo.png" },
  { name: "Truist Bank", logo: "truist-logo.png" },
  { name: "HSBC", logo: "hsbc-logo.png" },
  { name: "Goldman Sachs", logo: "goldman-sachs-logo.jpg" },
  { name: "Morgan Stanley", logo: "morgan-stanley-logo.jpg" },
  { name: "American Express", logo: "amex-logo.jpg" },
  { name: "Discover", logo: "discover-logo.jpg" },
  { name: "Ally Bank", logo: "ally-logo.jpg" },
  { name: "Charles Schwab", logo: "schwab-logo.jpg" },
  { name: "Barclays", logo: "barclays-logo.jpg" },
  { name: "Santander", logo: "santander-logo.jpg" },
  { name: "Citizens Bank", logo: "citizens-logo.jpg" },
  { name: "Fifth Third Bank", logo: "fifth-third-logo.jpg" },
  { name: "KeyBank", logo: "keybank-logo.jpg" },
  { name: "Regions Bank", logo: "regions-logo.jpg" },
  { name: "M&T Bank", logo: "mt-bank-logo.jpg" },
  { name: "Navy Federal Credit Union", logo: "navy-federal-logo.jpg" },
  { name: "BMO Harris", logo: "bmo-logo.jpg" },
  { name: "USAA", logo: "usaa-logo.jpg" },
  { name: "SunTrust", logo: "suntrust-logo.jpg" },
  { name: "Huntington Bank", logo: "huntington-logo.jpg" },
]

export interface PartnerBankLogosProps {
  /** Base path for logo images (e.g. "/images" or "/partner-logos/images"). No trailing slash. */
  imageBasePath?: string
  /** Optional placeholder image if a logo fails to load */
  placeholderSrc?: string
  /** Optional class for the outer container */
  className?: string
}

export function PartnerBankLogos({
  imageBasePath = "/images",
  placeholderSrc,
  className = "",
}: PartnerBankLogosProps) {
  const base = imageBasePath.replace(/\/$/, "")

  return (
    <div className={className}>
      <h3
        className="text-center text-sm font-semibold text-gray-300 uppercase tracking-wider my-0 py-1.5"
        style={{ color: "var(--muted-text, #d1d5db)" }}
      >
        Trusted by users from leading financial institutions
      </h3>

      <div className="relative overflow-hidden py-3 my-9">
        <style>{`
          @keyframes partner-logos-scroll {
            0% { transform: translateX(0); }
            100% { transform: translateX(-50%); }
          }
          .partner-logos-scroll {
            animation: partner-logos-scroll 20s linear infinite;
          }
        `}</style>
        <div className="flex partner-logos-scroll gap-2.5">
          {/* First set */}
          {PARTNER_BANKS.map((bank, index) => (
            <div
              key={`${bank.name}-1-${index}`}
              className="bg-white/5 backdrop-blur-sm border border-white/10 p-5 transition-all duration-300 flex-shrink-0 w-36 h-36 flex items-center justify-center flex-col rounded-lg"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "0.5rem",
              }}
            >
              <div className="w-24 h-24 mb-2 flex items-center justify-center">
                <img
                  src={`${base}/${bank.logo}`}
                  alt={`${bank.name} logo`}
                  width={96}
                  height={96}
                  className="object-contain max-w-full max-h-full"
                  onError={(e) => {
                    if (placeholderSrc) e.currentTarget.src = placeholderSrc
                  }}
                />
              </div>
              <span
                className="text-white text-xs font-medium text-center leading-tight"
                style={{ color: "#fff" }}
              >
                {bank.name}
              </span>
            </div>
          ))}
          {/* Duplicate set for seamless loop */}
          {PARTNER_BANKS.map((bank, index) => (
            <div
              key={`${bank.name}-2-${index}`}
              className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl p-5 transition-all duration-300 flex-shrink-0 w-36 h-36 flex flex-col items-center justify-center"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "0.75rem",
              }}
            >
              <div className="w-24 h-24 mb-2 flex items-center justify-center">
                <img
                  src={`${base}/${bank.logo}`}
                  alt={`${bank.name} logo`}
                  width={96}
                  height={96}
                  className="object-contain max-w-full max-h-full"
                  onError={(e) => {
                    if (placeholderSrc) e.currentTarget.src = placeholderSrc
                  }}
                />
              </div>
              <span
                className="text-white text-xs font-medium text-center leading-tight"
                style={{ color: "#fff" }}
              >
                {bank.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

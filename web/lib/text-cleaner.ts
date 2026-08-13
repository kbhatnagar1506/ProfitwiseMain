/**
 * Bank feed text scrubber — strips URLs, order IDs, and ACH/wire boilerplate
 * before classification, alias matching, or LLM. Raw descriptions stay unchanged in DB.
 */

/** Noise phrases removed as whole words / phrases (uppercase match). */
const NOISE_PHRASES: string[] = [
  "PREAUTHORIZED ACH CREDIT",
  "PREAUTHORIZED ACH DEBIT",
  "PREAUTHORIZED ACH",
  "MISCELLANEOUS DEBIT",
  "MISCELLANEOUS CREDIT",
  "ACCT-TO-ACCT TRANSFER",
  "ACCOUNT TO ACCOUNT TRANSFER",
  "INCOMING WIRE TRANSFER",
  "OUTGOING WIRE TRANSFER",
  "INCOMING WIRE",
  "OUTGOING WIRE",
  "WEBPAYMENT",
  "WEB PAYMENT",
  "EPAY",
  "ACH CREDIT",
  "ACH DEBIT",
  "AUTOMATIC TRANSFER",
  "ONLINE TRANSFER",
  "MOBILE TRANSFER",
]

/**
 * Normalize bank description for rule matching: uppercase, strip URLs,
 * order IDs, and common boilerplate so counterparty names remain.
 */
export function scrubBankText(rawDescription: string): string {
  let clean = rawDescription.trim().toUpperCase()

  // URLs
  clean = clean.replace(/HTTPS?:\/\/[^\s]+/gi, " ")
  clean = clean.replace(/WWW\.[^\s]+/gi, " ")

  // Shopify / generic order references
  clean = clean.replace(/ORDER\s*#?\s*[:#]?\s*[\dA-Z-]+/gi, " ")
  clean = clean.replace(/ORDER\s+ID\s*:\s*[\dA-Z-]+/gi, " ")
  clean = clean.replace(/ORDER\s+ID\s*[\dA-Z-]+/gi, " ")

  // Transaction / reference noise (keep short tokens)
  clean = clean.replace(/\bREF\s*#?\s*[\dA-Z]+\b/gi, " ")
  clean = clean.replace(/\bCONF\s*#?\s*[\dA-Z]+\b/gi, " ")

  for (const phrase of NOISE_PHRASES) {
    if (clean.includes(phrase)) {
      clean = clean.split(phrase).join(" ")
    }
  }

  // Collapse whitespace
  clean = clean.replace(/\s+/g, " ").trim()
  return clean
}

/** Combine description + counterparty for scrubbing (bank often puts name in one or the other). */
export function scrubMovementText(rawDescription: string | null, counterparty: string | null): string {
  const combined = [rawDescription ?? "", counterparty ?? ""].filter(Boolean).join(" ")
  return scrubBankText(combined || "")
}

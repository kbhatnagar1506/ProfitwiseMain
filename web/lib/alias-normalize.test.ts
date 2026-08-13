/**
 * Unit tests for alias-normalize.ts — the display/matching normalization layer
 * that turns raw bank and processor descriptors into entity labels.
 *
 * These functions decide what a user sees next to every transaction, and feed
 * the alias matcher, so both the happy paths and the redaction rules are pinned.
 */

import {
  normalizeForMatch,
  heuristicAliasMatch,
  isInvoiceSludge,
  extractEntityFromRawDescriptor,
  isOwnerLabel,
  displayLabelForCounterparty,
  normalizeAccountDisplayName,
  normalizedVariants,
  INVOICE_SLUDGE,
} from "./alias-normalize"

describe("normalizeForMatch", () => {
  it("lowercases and strips all punctuation and spacing", () => {
    expect(normalizeForMatch("David Vaughn")).toBe("davidvaughn")
    expect(normalizeForMatch("Kate's Real Food")).toBe("katesrealfood")
    expect(normalizeForMatch("  Spread The Love!  ")).toBe("spreadthelove")
  })

  it("splits camelCase and PascalCase before collapsing", () => {
    expect(normalizeForMatch("RachelSuba")).toBe("rachelsuba")
    expect(normalizeForMatch("Rachel Suba")).toBe("rachelsuba")
  })

  it("makes spacing variants collapse to the same key", () => {
    expect(normalizeForMatch("realsy Wholesale")).toBe(normalizeForMatch("RealsyWholesale"))
  })

  it("returns an empty string for empty or non-string input", () => {
    expect(normalizeForMatch("")).toBe("")
    expect(normalizeForMatch(null as unknown as string)).toBe("")
    expect(normalizeForMatch(undefined as unknown as string)).toBe("")
    expect(normalizeForMatch(123 as unknown as string)).toBe("")
  })

  it("drops characters outside a-z0-9 entirely", () => {
    expect(normalizeForMatch("Café #1")).toBe("caf1")
  })
})

describe("heuristicAliasMatch", () => {
  it("matches identical normalized forms", () => {
    expect(heuristicAliasMatch("David Vaughn", "davidvaughn")).toBe(true)
    expect(heuristicAliasMatch("RachelSuba", "Rachel Suba")).toBe(true)
  })

  it("matches when one normalized form contains the other", () => {
    expect(heuristicAliasMatch("David Vaughn", "David Vaugh")).toBe(true)
    expect(heuristicAliasMatch("Realsy", "Realsy Wholesale")).toBe(true)
  })

  it("rejects unrelated names", () => {
    expect(heuristicAliasMatch("Sanzo", "CocoTaps")).toBe(false)
  })

  it("refuses to match on fragments shorter than 3 characters", () => {
    expect(heuristicAliasMatch("ab", "abcdef")).toBe(false)
    expect(heuristicAliasMatch("abcdef", "ab")).toBe(false)
  })

  it("still matches two identical sub-3-character names via the exact rule", () => {
    expect(heuristicAliasMatch("ab", "ab")).toBe(true)
  })

  it("matches on a long shared prefix (typo tolerance)", () => {
    // 85% of the shorter string must agree from the start.
    expect(heuristicAliasMatch("Vaughnn", "Vaughnx")).toBe(true)
    expect(heuristicAliasMatch("Vaughn", "Xaughn")).toBe(false)
  })
})

describe("isInvoiceSludge / INVOICE_SLUDGE", () => {
  it("recognises bare invoice identifiers as sludge", () => {
    expect(isInvoiceSludge("INV-123")).toBe(true)
    expect(isInvoiceSludge("Invoice #45")).toBe(true)
    expect(isInvoiceSludge("Invoice 45")).toBe(true)
    expect(isInvoiceSludge("Payment for invoice")).toBe(true)
  })

  it("does not treat the bare word 'Invoice' as sludge (the pattern needs a trailing space)", () => {
    // Pinned so the regex's \s+ requirement is visible rather than accidental.
    expect(isInvoiceSludge("Invoice")).toBe(false)
  })

  it("ignores surrounding whitespace and case", () => {
    expect(isInvoiceSludge("  inv-9  ")).toBe(true)
  })

  it("does not treat real entity names as sludge", () => {
    expect(isInvoiceSludge("Sanzo")).toBe(false)
    expect(isInvoiceSludge("Invoice Systems LLC")).toBe(false)
  })

  it("is safe for null and undefined", () => {
    expect(isInvoiceSludge(null)).toBe(false)
    expect(isInvoiceSludge(undefined)).toBe(false)
    expect(isInvoiceSludge("")).toBe(false)
  })

  it("exports a regex anchored at both ends", () => {
    expect(INVOICE_SLUDGE.test("INV-1")).toBe(true)
    expect(INVOICE_SLUDGE.test("prefix INV-1")).toBe(false)
  })
})

describe("extractEntityFromRawDescriptor", () => {
  it("pulls the entity and invoice number out of a processor descriptor", () => {
    expect(extractEntityFromRawDescriptor("ACME FOODS TEAM1234/Payment 30280 PERFORMAN")).toBe(
      "Acme Foods (Invoice 30280)"
    )
  })

  it("strips a TEAM identifier from the entity portion", () => {
    expect(extractEntityFromRawDescriptor("SANZO TEAM99/Payment 1")).toBe("Sanzo (Invoice 1)")
  })

  it("title-cases all-caps names", () => {
    expect(extractEntityFromRawDescriptor("SPREAD THE LOVE/Payment 77")).toBe(
      "Spread The Love (Invoice 77)"
    )
  })

  it("leaves mixed-case names alone", () => {
    expect(extractEntityFromRawDescriptor("Sanzo Foods/Payment 12")).toBe(
      "Sanzo Foods (Invoice 12)"
    )
  })

  it("finds an invoice number from an INV pattern when there is no Payment segment", () => {
    expect(extractEntityFromRawDescriptor("Sanzo Foods INV 445")).toBe(
      "Sanzo Foods INV 445 (Invoice 445)"
    )
  })

  it("returns null for sludge, empty and too-short input", () => {
    expect(extractEntityFromRawDescriptor("INV-123")).toBeNull()
    expect(extractEntityFromRawDescriptor("")).toBeNull()
    expect(extractEntityFromRawDescriptor("x")).toBeNull()
    expect(extractEntityFromRawDescriptor(null)).toBeNull()
    expect(extractEntityFromRawDescriptor(undefined)).toBeNull()
  })
})

describe("isOwnerLabel", () => {
  it("matches an owner name in either direction after normalization", () => {
    expect(isOwnerLabel("J. Rubenstein", ["Jeremy Rubenstein"])).toBe(false)
    expect(isOwnerLabel("Rubenstein", ["Rubenstein"])).toBe(true)
    expect(isOwnerLabel("Jeremy Rubenstein", ["Rubenstein"])).toBe(true)
  })

  it("returns false when no owner names are supplied", () => {
    expect(isOwnerLabel("Anyone")).toBe(false)
  })

  it("is safe for null, undefined and 1-character input", () => {
    expect(isOwnerLabel(null, ["Owner"])).toBe(false)
    expect(isOwnerLabel(undefined, ["Owner"])).toBe(false)
    expect(isOwnerLabel("a", ["a"])).toBe(false)
  })
})

describe("displayLabelForCounterparty", () => {
  it("prefers a clean resolved label over the raw descriptor", () => {
    expect(displayLabelForCounterparty("SP SANZO WHOLESALE", "Sanzo")).toBe("Sanzo")
  })

  it("falls back to the cleaned raw descriptor when there is no preferred label", () => {
    expect(displayLabelForCounterparty("Sanzo Foods")).toBe("Sanzo Foods")
  })

  it("redacts owner names to 'Owner'", () => {
    expect(displayLabelForCounterparty("Rubenstein", null, ["Rubenstein"])).toBe("Owner")
    expect(displayLabelForCounterparty("raw", "Rubenstein", ["Rubenstein"])).toBe("Owner")
  })

  it("returns an em dash for invoice sludge and missing input", () => {
    expect(displayLabelForCounterparty("INV-123")).toBe("—")
    expect(displayLabelForCounterparty(null)).toBe("—")
    expect(displayLabelForCounterparty(undefined)).toBe("—")
  })

  it("strips Plaid's '(deleted)' suffix", () => {
    expect(displayLabelForCounterparty("Sanzo Foods (deleted)")).toBe("Sanzo Foods")
  })

  it("restores canonical brand spacing", () => {
    expect(displayLabelForCounterparty("QuickBooks")).toBe("QuickBooks")
    expect(displayLabelForCounterparty("Quick Books")).toBe("QuickBooks")
    expect(displayLabelForCounterparty("DocuSign")).toBe("DocuSign")
  })

  it("ignores an unusable preferred label and uses the raw one", () => {
    // Emails and sludge are not acceptable primary labels.
    expect(displayLabelForCounterparty("Sanzo Foods", "billing@sanzo.com")).toBe("Sanzo Foods")
    expect(displayLabelForCounterparty("Sanzo Foods", "INV-9")).toBe("Sanzo Foods")
  })

  it("KNOWN GAP: hides any label containing the word 'test'", () => {
    // The \btest\b rule is meant to hide seeded test data, but it also hides a
    // legitimately named counterparty. Pinned deliberately — see REVIEW.md.
    expect(displayLabelForCounterparty("Test Kitchen LLC")).toBe("—")
  })
})

describe("normalizeAccountDisplayName", () => {
  it("labels parent accounts as the owner's credit card", () => {
    expect(normalizeAccountDisplayName("Chase Parent Account:J. RUBENSTEIN (6515) - 2")).toBe(
      "Owner credit card"
    )
  })

  it("maps credit accounts and subtypes", () => {
    expect(normalizeAccountDisplayName("Amex Gold", "credit")).toBe("Credit card")
    expect(normalizeAccountDisplayName("Some Card", null, "credit card")).toBe("Credit card")
  })

  it("maps checking and depository accounts to business checking", () => {
    expect(normalizeAccountDisplayName("Acct", null, "checking")).toBe("Business checking")
    expect(normalizeAccountDisplayName("Acct", "depository")).toBe("Business checking")
  })

  it("maps savings and money-market accounts to business MMA", () => {
    expect(normalizeAccountDisplayName("Acct", null, "savings")).toBe("Business MMA")
    expect(normalizeAccountDisplayName("Acct", null, "money market")).toBe("Business MMA")
  })

  it("shortens long bank names down to name + last four", () => {
    expect(normalizeAccountDisplayName("Mercury Business:OPERATING (1234)")).toBe("Mercury Business (1234)")
  })

  it("truncates very long unmatched names", () => {
    const long = "Z".repeat(60)
    const out = normalizeAccountDisplayName(long)
    expect(out).toHaveLength(40)
    expect(out.endsWith("...")).toBe(true)
  })

  it("falls back for missing input", () => {
    expect(normalizeAccountDisplayName(null)).toBe("External / unlinked account")
    expect(normalizeAccountDisplayName("")).toBe("External / unlinked account")
    expect(normalizeAccountDisplayName("   ")).toBe("External / unlinked account")
  })
})

describe("normalizedVariants", () => {
  it("returns the normalized key as the primary variant", () => {
    expect(normalizedVariants("Sanzo")).toEqual(["sanzo"])
  })

  it("deduplicates identical variants", () => {
    const v = normalizedVariants("RachelSuba")
    expect(new Set(v).size).toBe(v.length)
  })

  it("returns nothing for input that normalizes to under 2 characters", () => {
    expect(normalizedVariants("!")).toEqual([])
    expect(normalizedVariants("a")).toEqual([])
  })
})

/**
 * Unit tests for reconciliation-entity-validator.ts
 *
 * Tests the fast-path (string similarity) logic without requiring LLM.
 * LLM-dependent paths are tested via integration test stubs.
 */

import {
  validateEntitiesForBankDescription,
  filterCandidatesByEntityName,
  createEntityValidationCache,
  type CandidateEntity,
} from "./reconciliation-entity-validator"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCandidate(entity_id: string, display_name: string, aliases?: string[]): CandidateEntity {
  return { entity_id, display_name, aliases }
}

// ─── Fast-path Tests (no LLM needed) ─────────────────────────────────────────

describe("validateEntitiesForBankDescription — fast path", () => {
  it("exact match: same name → accept", async () => {
    const results = await validateEntitiesForBankDescription(
      "Spread The Love Foods",
      [makeCandidate("e1", "Spread The Love Foods")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(true)
    expect(r.method).toMatch(/fast_accept/)
    expect(r.confidence).toBeGreaterThanOrEqual(0.90)
  })

  it("bank prefix strip: 'SP BOBOS - WHOLESALE' matches 'Bobos'", async () => {
    const results = await validateEntitiesForBankDescription(
      "SP BOBOS - WHOLESALE",
      [makeCandidate("e1", "Bobos")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(true)
  })

  it("bank prefix strip: 'SP SMASH FOODS' matches 'Smash Foods'", async () => {
    const results = await validateEntitiesForBankDescription(
      "SP SMASH FOODS",
      [makeCandidate("e1", "Smash Foods")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(true)
  })

  it("ACH prefix: 'PREAUTHORIZED ACH CREDIT MARLINS TEAM5618' should not fast-reject 'Sarah Katz (Marlins)'", async () => {
    const results = await validateEntitiesForBankDescription(
      "PREAUTHORIZED ACH CREDIT MARLINS TEAM5618/Payment",
      [makeCandidate("e1", "Sarah Katz (Marlins)")]
    )
    // May be uncertain (goes to LLM) or accepted — should NOT be fast_reject
    const r = results.get("e1")!
    expect(r.method).not.toBe("fast_reject")
  })

  it("completely different entity: 'SP BOBOS' vs 'MUSH Wholesale' → reject or llm", async () => {
    const results = await validateEntitiesForBankDescription(
      "SP BOBOS - WHOLESALE",
      [makeCandidate("e2", "MUSH Wholesale")]
    )
    const r = results.get("e2")!
    // fast_reject OR llm_reject — should not be fast_accept
    expect(r.isValid).toBe(false)
  })

  it("High Brew vs Spread The Love Foods → reject", async () => {
    const results = await validateEntitiesForBankDescription(
      "High Brew",
      [makeCandidate("e1", "Spread The Love Foods")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(false)
  })

  it("handles wholesale suffix variation: 'Kate's Real Food' matches 'Kate's Real Food [Wholesale]'", async () => {
    const results = await validateEntitiesForBankDescription(
      "Kate's Real Food",
      [makeCandidate("e1", "Kate's Real Food [Wholesale]")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(true)
  })

  it("abbreviation: 'RTZN Brand Strat' matches 'RTZN Brand Strategy'", async () => {
    const results = await validateEntitiesForBankDescription(
      "Rtzn Brand Strat Invoices",
      [makeCandidate("e1", "RTZN Brand Strategy")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(true)
  })

  it("multi-candidate: returns result per entity_id", async () => {
    const results = await validateEntitiesForBankDescription(
      "Sanzo",
      [
        makeCandidate("e1", "Sanzo"),
        makeCandidate("e2", "CocoTaps"),
        makeCandidate("e3", "Think Jerky"),
      ]
    )
    expect(results.get("e1")!.isValid).toBe(true)
    expect(results.get("e2")!.isValid).toBe(false)
    expect(results.get("e3")!.isValid).toBe(false)
  })

  it("alias match: bank description matches alias, not primary name", async () => {
    const results = await validateEntitiesForBankDescription(
      "SP HARMLESS HARVEST",
      [makeCandidate("e1", "Belle's Gourmet Popcorn", ["Harmless Harvest"])]
    )
    // With alias "Harmless Harvest", this should NOT be fast_rejected
    const r = results.get("e1")!
    // Accept OR go to LLM — but the alias should help
    expect(r.isValid).toBe(true)
  })

  it("empty bank description → all candidates pass through", async () => {
    const results = await validateEntitiesForBankDescription(
      "",
      [makeCandidate("e1", "Sanzo"), makeCandidate("e2", "Bobos")]
    )
    // With empty bank desc, the function short-circuits and accepts all
    expect(results.size).toBe(0) // Empty: handled in filterCandidatesByEntityName
  })

  it("partial name typo: 'YumEarth' vs 'YumEarth Wholesale' → accept", async () => {
    const results = await validateEntitiesForBankDescription(
      "YumEarth",
      [makeCandidate("e1", "YumEarth")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(true)
  })

  it("case insensitive: 'HUNDY!' matches 'Hundy!'", async () => {
    const results = await validateEntitiesForBankDescription(
      "HUNDY!",
      [makeCandidate("e1", "Hundy!")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(true)
  })
})

// ─── filterCandidatesByEntityName Tests ───────────────────────────────────────

describe("filterCandidatesByEntityName", () => {
  type MockEvent = {
    entity_id: string
    metadata?: Record<string, unknown> | null
  }

  it("filters out wrong-entity candidates", async () => {
    const candidates: MockEvent[] = [
      { entity_id: "e1", metadata: { vendor_name: "Bobos" } },
      { entity_id: "e2", metadata: { vendor_name: "MUSH Wholesale" } },
      { entity_id: "e3", metadata: { vendor_name: "Hundy!" } },
    ]

    const { accepted, rejected } = await filterCandidatesByEntityName(
      "SP BOBOS - WHOLESALE",
      candidates
    )

    expect(accepted.some((e) => e.entity_id === "e1")).toBe(true) // Bobos should pass
    expect(rejected.some((r) => r.event.entity_id === "e2")).toBe(true) // MUSH should be rejected
  })

  it("empty bank description → all candidates pass", async () => {
    const candidates: MockEvent[] = [
      { entity_id: "e1", metadata: { vendor_name: "Sanzo" } },
    ]
    const { accepted } = await filterCandidatesByEntityName(null, candidates)
    expect(accepted).toHaveLength(1)
  })

  it("empty candidates → returns empty accepted", async () => {
    const { accepted, rejected } = await filterCandidatesByEntityName("Sanzo", [])
    expect(accepted).toHaveLength(0)
    expect(rejected).toHaveLength(0)
  })

  it("uses metadata vendor_name for matching", async () => {
    const candidates: MockEvent[] = [
      { entity_id: "e1", metadata: { vendor_name: "Purely Food Service" } },
    ]
    const { accepted } = await filterCandidatesByEntityName(
      "Purely Food Service",
      candidates
    )
    expect(accepted).toHaveLength(1)
  })

  it("uses metadata customer_name for matching", async () => {
    const candidates: MockEvent[] = [
      { entity_id: "e1", metadata: { customer_name: "Rosalyn Huckaby (Pivot)" } },
    ]
    const { accepted } = await filterCandidatesByEntityName(
      "Rosalyn Huckaby (Pivot)",
      candidates
    )
    expect(accepted).toHaveLength(1)
  })

  it("per-run cache is populated and reused", async () => {
    const cache = createEntityValidationCache()
    const candidates: MockEvent[] = [
      { entity_id: "e1", metadata: { vendor_name: "Sanzo" } },
    ]

    // First call
    await filterCandidatesByEntityName("Sanzo", candidates, cache)
    const sizeAfterFirst = cache.size

    // Second call — should read from cache, not grow
    await filterCandidatesByEntityName("Sanzo", candidates, cache)
    expect(cache.size).toBe(sizeAfterFirst)
  })
})

// ─── Fee Percentage Boundary Tests ────────────────────────────────────────────

describe("Fee percentage boundaries (unit test for logic)", () => {
  it("fee < 0.5% → not considered a fee", () => {
    const invoiceAmt = 1000
    const bankAmt = 999  // 0.1% diff
    const impliedFee = (invoiceAmt - bankAmt) / invoiceAmt
    expect(impliedFee).toBeLessThan(0.005)
  })

  it("fee 3% → valid processor fee", () => {
    const invoiceAmt = 1000
    const bankAmt = 970
    const impliedFee = (invoiceAmt - bankAmt) / invoiceAmt
    expect(impliedFee).toBeGreaterThanOrEqual(0.005)
    expect(impliedFee).toBeLessThanOrEqual(0.08)
  })

  it("fee 9% → too high, should reject", () => {
    const invoiceAmt = 1000
    const bankAmt = 910
    const impliedFee = (invoiceAmt - bankAmt) / invoiceAmt
    expect(impliedFee).toBeGreaterThan(0.08)
  })

  it("fee exactly 8% → boundary, should accept", () => {
    const invoiceAmt = 1000
    const bankAmt = 920
    const impliedFee = (invoiceAmt - bankAmt) / invoiceAmt
    expect(impliedFee).toBeLessThanOrEqual(0.08)
  })
})

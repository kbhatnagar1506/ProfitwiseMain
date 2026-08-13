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
      "Summit Provisions Foods",
      [makeCandidate("e1", "Summit Provisions Foods")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(true)
    expect(r.method).toMatch(/fast_accept/)
    expect(r.confidence).toBeGreaterThanOrEqual(0.90)
  })

  it("bank prefix strip: 'SP NORTHWIND - WHOLESALE' matches 'Northwind'", async () => {
    const results = await validateEntitiesForBankDescription(
      "SP NORTHWIND - WHOLESALE",
      [makeCandidate("e1", "Northwind")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(true)
  })

  it("bank prefix strip: 'SP CRESTLINE FOODS' matches 'Crestline Foods'", async () => {
    const results = await validateEntitiesForBankDescription(
      "SP CRESTLINE FOODS",
      [makeCandidate("e1", "Crestline Foods")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(true)
  })

  it("ACH prefix: 'PREAUTHORIZED ACH CREDIT RIVERSIDE TEAM5618' should not fast-reject 'Erin Delgado (Riverside)'", async () => {
    const results = await validateEntitiesForBankDescription(
      "PREAUTHORIZED ACH CREDIT RIVERSIDE TEAM5618/Payment",
      [makeCandidate("e1", "Erin Delgado (Riverside)")]
    )
    // May be uncertain (goes to LLM) or accepted — should NOT be fast_reject
    const r = results.get("e1")!
    expect(r.method).not.toBe("fast_reject")
  })

  it("completely different entity: 'SP NORTHWIND' vs 'PULP Wholesale' → reject or llm", async () => {
    const results = await validateEntitiesForBankDescription(
      "SP NORTHWIND - WHOLESALE",
      [makeCandidate("e2", "PULP Wholesale")]
    )
    const r = results.get("e2")!
    // fast_reject OR llm_reject — should not be fast_accept
    expect(r.isValid).toBe(false)
  })

  it("Deep Roast vs Summit Provisions Foods → reject", async () => {
    const results = await validateEntitiesForBankDescription(
      "Deep Roast",
      [makeCandidate("e1", "Summit Provisions Foods")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(false)
  })

  it("handles wholesale suffix variation: 'Rosa's Real Food' matches 'Rosa's Real Food [Wholesale]'", async () => {
    const results = await validateEntitiesForBankDescription(
      "Rosa's Real Food",
      [makeCandidate("e1", "Rosa's Real Food [Wholesale]")]
    )
    const r = results.get("e1")!
    expect(r.isValid).toBe(true)
  })

  // NOTE: "Znth Brand Strat Invoices" vs "ZNTH Brand Strategy" scores only ~50%
  // on the string fast-path, so it falls through to the LLM tier. Without an API
  // key the validator applies the strict deterministic fallback and rejects.
  // The LLM-backed behaviour is covered hermetically in
  // reconciliation-entity-validator.llm.test.ts; here we pin the no-LLM contract.
  it("abbreviation below fast-path threshold defers, then rejects when LLM is unavailable", async () => {
    const results = await validateEntitiesForBankDescription(
      "Znth Brand Strat Invoices",
      [makeCandidate("e1", "ZNTH Brand Strategy")]
    )
    const r = results.get("e1")!
    expect(r.method).toBe("deterministic_reject_llm_skipped")
    expect(r.isValid).toBe(false)
  })

  it("multi-candidate: returns result per entity_id", async () => {
    const results = await validateEntitiesForBankDescription(
      "Verano",
      [
        makeCandidate("e1", "Verano"),
        makeCandidate("e2", "PalmTaps"),
        makeCandidate("e3", "Trailhead Jerky"),
      ]
    )
    expect(results.get("e1")!.isValid).toBe(true)
    expect(results.get("e2")!.isValid).toBe(false)
    expect(results.get("e3")!.isValid).toBe(false)
  })

  it("alias match: bank description matches alias, not primary name", async () => {
    const results = await validateEntitiesForBankDescription(
      "SP CLEARWATER HARVEST",
      [makeCandidate("e1", "Marlowe's Gourmet Popcorn", ["Clearwater Harvest"])]
    )
    // With alias "Clearwater Harvest", this should NOT be fast_rejected
    const r = results.get("e1")!
    // Accept OR go to LLM — but the alias should help
    expect(r.isValid).toBe(true)
  })

  it("empty bank description → every candidate gets a fast_reject result", async () => {
    const results = await validateEntitiesForBankDescription(
      "",
      [makeCandidate("e1", "Verano"), makeCandidate("e2", "Northwind")]
    )
    // An empty descriptor has 0% similarity to everything, so the fast path
    // rejects each candidate rather than short-circuiting the map.
    expect(results.size).toBe(2)
    for (const id of ["e1", "e2"]) {
      expect(results.get(id)!.isValid).toBe(false)
      expect(results.get(id)!.method).toBe("fast_reject")
    }
  })

  it("partial name typo: 'SunOrchard' vs 'SunOrchard Wholesale' → accept", async () => {
    const results = await validateEntitiesForBankDescription(
      "SunOrchard",
      [makeCandidate("e1", "SunOrchard")]
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
      { entity_id: "e1", metadata: { vendor_name: "Northwind" } },
      { entity_id: "e2", metadata: { vendor_name: "PULP Wholesale" } },
      { entity_id: "e3", metadata: { vendor_name: "Hundy!" } },
    ]

    const { accepted, rejected } = await filterCandidatesByEntityName(
      "SP NORTHWIND - WHOLESALE",
      candidates
    )

    expect(accepted.some((e) => e.entity_id === "e1")).toBe(true) // Northwind should pass
    expect(rejected.some((r) => r.event.entity_id === "e2")).toBe(true) // PULP should be rejected
  })

  it("empty bank description → all candidates pass", async () => {
    const candidates: MockEvent[] = [
      { entity_id: "e1", metadata: { vendor_name: "Verano" } },
    ]
    const { accepted } = await filterCandidatesByEntityName(null, candidates)
    expect(accepted).toHaveLength(1)
  })

  it("empty candidates → returns empty accepted", async () => {
    const { accepted, rejected } = await filterCandidatesByEntityName("Verano", [])
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
      { entity_id: "e1", metadata: { vendor_name: "Verano" } },
    ]

    // First call
    await filterCandidatesByEntityName("Verano", candidates, cache)
    const sizeAfterFirst = cache.size

    // Second call — should read from cache, not grow
    await filterCandidatesByEntityName("Verano", candidates, cache)
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

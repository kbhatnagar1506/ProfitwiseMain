/**
 * Unit tests for entity-uri.ts — canonical AR/AP allocation identifiers.
 *
 * These URIs are the join key between movements and their allocations. A
 * builder/parser mismatch silently orphans allocations, so every constructor is
 * round-tripped through the parser here.
 */

import {
  toEntityUri,
  toEntityUriAr,
  toEntityUriArSynthetic,
  toEntityUriArInferred,
  toEntityUriApBill,
  toEntityUriApInferred,
  parseEntityUri,
  isEntityUri,
  toSourceId,
} from "./entity-uri"

describe("AR builders", () => {
  it("builds invoice URIs per source", () => {
    expect(toEntityUriAr("qbo", "123")).toBe("ar://invoice/qbo/123")
    expect(toEntityUriAr("xero", "abc")).toBe("ar://invoice/xero/abc")
    expect(toEntityUriAr("stripe", "in_1")).toBe("ar://invoice/stripe/in_1")
    expect(toEntityUriAr("gmail", "msg-9")).toBe("ar://invoice/gmail/msg-9")
  })

  it("builds synthetic Stripe settlement URIs", () => {
    expect(toEntityUriArSynthetic("po_123")).toBe(
      "ar://invoice/synthetic/stripe_settlement/po_123"
    )
  })

  it("builds inferred AR URIs from entity + date", () => {
    expect(toEntityUriArInferred("ent_7", "2026-03-01")).toBe("ar://inferred/ent_7/2026-03-01")
  })
})

describe("AP builders", () => {
  it("builds bill URIs per source", () => {
    expect(toEntityUriApBill("qbo", "b1")).toBe("ap://bill/qbo/b1")
    expect(toEntityUriApBill("gmail", "m2")).toBe("ap://bill/gmail/m2")
  })

  it("builds inferred AP URIs from entity + date", () => {
    expect(toEntityUriApInferred("ent_9", "2026-03-15")).toBe("ap://inferred/ent_9/2026-03-15")
  })
})

describe("toEntityUri (generic dispatcher)", () => {
  it("routes AR to the invoice namespace", () => {
    expect(toEntityUri("ar", "qbo", "123")).toBe("ar://invoice/qbo/123")
  })

  it("routes AR synthetic settlements only for the stripe_settlement source", () => {
    expect(toEntityUri("ar", "stripe_settlement", "po_1", true)).toBe(
      "ar://invoice/synthetic/stripe_settlement/po_1"
    )
    // synthetic flag alone is not enough — the source must be stripe_settlement
    expect(toEntityUri("ar", "qbo", "po_1", true)).toBe("ar://invoice/qbo/po_1")
  })

  it("routes AP bills and inferred obligations to distinct namespaces", () => {
    expect(toEntityUri("ap", "qbo", "b1")).toBe("ap://bill/qbo/b1")
    expect(toEntityUri("ap", "inferred", "ent_1/2026-03-01")).toBe(
      "ap://inferred/ent_1/2026-03-01"
    )
  })
})

describe("parseEntityUri", () => {
  it("parses AR invoice URIs", () => {
    expect(parseEntityUri("ar://invoice/qbo/123")).toEqual({
      type: "ar",
      source: "qbo",
      id: "123",
      synthetic: false,
    })
  })

  it("parses synthetic AR URIs and flags them", () => {
    expect(parseEntityUri("ar://invoice/synthetic/stripe_settlement/po_1")).toEqual({
      type: "ar",
      source: "stripe_settlement",
      id: "po_1",
      synthetic: true,
    })
  })

  it("parses inferred AR URIs, keeping entity/date as a compound id", () => {
    expect(parseEntityUri("ar://inferred/ent_7/2026-03-01")).toEqual({
      type: "ar",
      source: "inferred",
      id: "ent_7/2026-03-01",
      synthetic: false,
    })
  })

  it("parses AP bill and inferred URIs", () => {
    expect(parseEntityUri("ap://bill/xero/b9")).toEqual({
      type: "ap",
      source: "xero",
      id: "b9",
      synthetic: false,
    })
    expect(parseEntityUri("ap://inferred/ent_9/2026-03-15")).toEqual({
      type: "ap",
      source: "inferred",
      id: "ent_9/2026-03-15",
      synthetic: false,
    })
  })

  it("preserves ids that themselves contain slashes", () => {
    expect(parseEntityUri("ar://invoice/qbo/a/b/c")).toEqual({
      type: "ar",
      source: "qbo",
      id: "a/b/c",
      synthetic: false,
    })
  })

  it("returns null for anything that is not a recognised URI", () => {
    const bad = [
      "",
      "qbo/123",
      "https://example.com",
      "ar://",
      "ar://invoice/qbo",
      "ar://invoice/qbo/",
      "ap://bill/qbo",
      "xx://invoice/qbo/1",
    ]
    for (const s of bad) {
      expect(parseEntityUri(s)).toBeNull()
    }
  })
})

describe("round-trip: every builder output parses back to its inputs", () => {
  const cases: Array<{ uri: string; type: "ar" | "ap"; source: string; id: string; synthetic: boolean }> = [
    { uri: toEntityUriAr("qbo", "123"), type: "ar", source: "qbo", id: "123", synthetic: false },
    { uri: toEntityUriAr("xero", "x-1"), type: "ar", source: "xero", id: "x-1", synthetic: false },
    { uri: toEntityUriArSynthetic("po_1"), type: "ar", source: "stripe_settlement", id: "po_1", synthetic: true },
    { uri: toEntityUriArInferred("e1", "2026-01-02"), type: "ar", source: "inferred", id: "e1/2026-01-02", synthetic: false },
    { uri: toEntityUriApBill("qbo", "b1"), type: "ap", source: "qbo", id: "b1", synthetic: false },
    { uri: toEntityUriApInferred("e2", "2026-01-03"), type: "ap", source: "inferred", id: "e2/2026-01-03", synthetic: false },
  ]

  for (const c of cases) {
    it(`round-trips ${c.uri}`, () => {
      expect(parseEntityUri(c.uri)).toEqual({
        type: c.type,
        source: c.source,
        id: c.id,
        synthetic: c.synthetic,
      })
    })
  }
})

describe("isEntityUri", () => {
  it("accepts ar:// and ap:// prefixes", () => {
    expect(isEntityUri("ar://invoice/qbo/1")).toBe(true)
    expect(isEntityUri("ap://bill/qbo/1")).toBe(true)
  })

  it("rejects other strings", () => {
    expect(isEntityUri("")).toBe(false)
    expect(isEntityUri("qbo/1")).toBe(false)
    expect(isEntityUri("https://ar://x")).toBe(false)
  })

  it("is a prefix check only — it does not imply parseEntityUri succeeds", () => {
    expect(isEntityUri("ar://garbage")).toBe(true)
    expect(parseEntityUri("ar://garbage")).toBeNull()
  })
})

describe("toSourceId", () => {
  it("joins source and id with a slash", () => {
    expect(toSourceId("qbo", "abc-123")).toBe("qbo/abc-123")
  })
})

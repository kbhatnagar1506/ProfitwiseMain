/**
 * Unit tests for levenshtein.ts — the string-similarity primitives that the
 * whole reconciliation waterfall leans on. A regression here silently changes
 * which bank movements get matched to which invoices, so the thresholds and
 * normalization rules are pinned explicitly.
 */

import {
  levenshteinDistance,
  levenshteinSimilarity,
  tokenSimilarity,
  entityNameSimilarity,
  areSameEntity,
  matchEntityName,
} from "./levenshtein"

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("Verano", "Verano")).toBe(0)
  })

  it("returns the other string's length when one side is empty", () => {
    expect(levenshteinDistance("", "Northwind")).toBe(9)
    expect(levenshteinDistance("Northwind", "")).toBe(9)
    expect(levenshteinDistance("", "")).toBe(0)
  })

  it("counts a single substitution, insertion and deletion as 1 each", () => {
    expect(levenshteinDistance("kitten", "kitteb")).toBe(1) // substitution
    expect(levenshteinDistance("kitten", "kittens")).toBe(1) // insertion
    expect(levenshteinDistance("kittens", "kitten")).toBe(1) // deletion
  })

  it("computes the classic kitten→sitting distance of 3", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3)
  })

  it("is symmetric regardless of argument order", () => {
    const pairs: Array<[string, string]> = [
      ["Whitfield", "Whitfiel"],
      ["a", "abcdefgh"],
      ["Summit Provisions", "Summit Provisions Foods"],
    ]
    for (const [a, b] of pairs) {
      expect(levenshteinDistance(a, b)).toBe(levenshteinDistance(b, a))
    }
  })

  it("is case-sensitive (normalization is the caller's job)", () => {
    expect(levenshteinDistance("NORTHWIND", "northwind")).toBe(9)
  })
})

describe("levenshteinSimilarity", () => {
  it("scores identical strings 1.0 and treats case as equal", () => {
    expect(levenshteinSimilarity("Verano", "Verano")).toBe(1)
    expect(levenshteinSimilarity("NORTHWIND", "northwind")).toBe(1)
  })

  it("scores two empty strings as identical, one empty as completely different", () => {
    expect(levenshteinSimilarity("", "")).toBe(1)
    expect(levenshteinSimilarity("", "Northwind")).toBe(0)
    expect(levenshteinSimilarity("Northwind", "")).toBe(0)
  })

  it("degrades proportionally to edit distance", () => {
    // "Whitfield" vs "Whitfiel": 1 edit over 9 chars
    expect(levenshteinSimilarity("Whitfield", "Whitfiel")).toBeCloseTo(1 - 1 / 9, 5)
  })

  it("never exceeds 1.0 or drops below 0 for realistic inputs", () => {
    const samples = ["Verano", "PalmTaps", "Trailhead Jerky", "SP NORTHWIND - WHOLESALE", "x"]
    for (const a of samples) {
      for (const b of samples) {
        const s = levenshteinSimilarity(a, b)
        expect(s).toBeGreaterThanOrEqual(0)
        expect(s).toBeLessThanOrEqual(1)
      }
    }
  })

  it("normalizes surrounding whitespace consistently between distance and length", () => {
    // Regression: distance was computed on the trimmed strings while the length
    // denominator used the raw strings, so padding inflated the score.
    // "hello" vs "world" is 4 edits over 5 chars => 0.2, and padding one side
    // must not change that.
    expect(levenshteinSimilarity("hello", "world")).toBeCloseTo(0.2, 5)
    expect(levenshteinSimilarity("hello   ", "world")).toBeCloseTo(0.2, 5)
    expect(levenshteinSimilarity("  hello  ", "  world  ")).toBeCloseTo(0.2, 5)
  })
})

describe("tokenSimilarity", () => {
  it("is 1.0 for the same token set in a different order or case", () => {
    expect(tokenSimilarity("Summit Provisions", "provisions summit")).toBe(1)
  })

  it("is 0 when no tokens overlap", () => {
    expect(tokenSimilarity("Verano", "PalmTaps")).toBe(0)
  })

  it("computes Jaccard overlap for partial matches", () => {
    // {summit, provisions} vs {summit, provisions, foods}
    // intersection 2, union 3 => 0.667
    expect(tokenSimilarity("Summit Provisions", "Summit Provisions Foods")).toBeCloseTo(2 / 3, 5)
  })

  it("drops single-character tokens so initials do not inflate overlap", () => {
    // "a" is filtered out on both sides, leaving {northwind} vs {northwind}
    expect(tokenSimilarity("a Northwind", "Northwind a")).toBe(1)
  })

  it("treats punctuation as a separator", () => {
    expect(tokenSimilarity("Rosa's Real Food", "Rosa s Real Food")).toBe(1)
  })

  it("returns 0 when only one side tokenizes to nothing", () => {
    expect(tokenSimilarity("!!!", "Northwind")).toBe(0)
  })

  it("returns 1.0 when neither side has usable tokens", () => {
    expect(tokenSimilarity("!!!", "???")).toBe(1)
  })
})

describe("entityNameSimilarity", () => {
  it("blends edit distance (40%) and token overlap (60%)", () => {
    const a = "Summit Provisions"
    const b = "Summit Provisions Foods"
    const expected = 0.4 * levenshteinSimilarity(a, b) + 0.6 * tokenSimilarity(a, b)
    expect(entityNameSimilarity(a, b)).toBeCloseTo(expected, 10)
  })

  it("scores identical names 1.0", () => {
    expect(entityNameSimilarity("Verano", "Verano")).toBeCloseTo(1, 10)
  })

  it("scores unrelated names near zero", () => {
    expect(entityNameSimilarity("Verano", "PalmTaps")).toBeLessThan(0.2)
  })
})

describe("areSameEntity", () => {
  it("matches case-insensitively on exact names", () => {
    expect(areSameEntity("NORTHWIND", "northwind")).toBe(true)
  })

  it("returns false when either name is empty", () => {
    expect(areSameEntity("", "Northwind")).toBe(false)
    expect(areSameEntity("Northwind", "")).toBe(false)
  })

  it("matches when one name fully contains the other", () => {
    expect(areSameEntity("Rosa's Real Food", "Rosa's Real Food [Wholesale]")).toBe(true)
  })

  it("respects a custom threshold", () => {
    // Unrelated names are rejected at the default threshold but accepted at 0.
    expect(areSameEntity("Verano", "PalmTaps")).toBe(false)
    expect(areSameEntity("Verano", "PalmTaps", 0)).toBe(true)
  })

  it("KNOWN PRECISION GAP: bare substring rule matches short generic tokens", () => {
    // The `includes` fast-path has no minimum length, so a 3-character generic
    // word is treated as the same entity as any name containing it. This is
    // pinned deliberately — see REVIEW.md. Tightening it changes match rates.
    expect(areSameEntity("Inc", "Incredible Foods")).toBe(true)
  })
})

describe("matchEntityName", () => {
  it("reports a direct match with method 'direct'", () => {
    const r = matchEntityName("Verano", "Verano")
    expect(r.match).toBe(true)
    expect(r.method).toBe("direct")
    expect(r.score).toBeCloseTo(1, 10)
  })

  it("falls back to aliases when the primary name does not match", () => {
    const r = matchEntityName("Clearwater Harvest", "Marlowe's Gourmet Popcorn", ["Clearwater Harvest"])
    expect(r.match).toBe(true)
    expect(r.method).toBe("alias")
  })

  it("uses the contains rule for names of at least 4 characters", () => {
    const r = matchEntityName("ACH CREDIT ACMEFOODS LLC", "ACMEFOODS")
    expect(r.match).toBe(true)
    expect(r.method).toBe("contains")
    expect(r.score).toBeCloseTo(0.88, 10)
  })

  it("reports contains_reverse when the entity name holds the descriptor", () => {
    const r = matchEntityName("ACMEFOODS", "ACMEFOODS WHOLESALE LLC")
    expect(r.match).toBe(true)
    expect(r.method).toBe("contains_reverse")
    expect(r.score).toBeCloseTo(0.85, 10)
  })

  it("does not apply the contains rule to entity names shorter than 4 chars", () => {
    const r = matchEntityName("ACH CREDIT ABC", "ABC")
    expect(r.method).toBe("none")
    expect(r.match).toBe(false)
  })

  it("returns no match with the direct score when nothing matches", () => {
    const r = matchEntityName("Verano", "PalmTaps")
    expect(r.match).toBe(false)
    expect(r.method).toBe("none")
    expect(r.score).toBeCloseTo(entityNameSimilarity("Verano", "PalmTaps"), 10)
  })

  it("honours a custom threshold on the direct/alias tiers", () => {
    // Raising the bar past the blended score demotes it off the direct tier.
    const r = matchEntityName("Whitfield Holdings", "Whitfiel Holding", [], 0.99)
    expect(r.match).toBe(false)
    expect(r.method).toBe("none")
  })

  it("KNOWN GAP: the contains fallback ignores the caller's threshold", () => {
    // Even at threshold 0.99 the substring rule still returns a 0.85 match,
    // so a caller asking for near-exact precision does not get it.
    // Pinned deliberately — see REVIEW.md.
    const r = matchEntityName("Summit Provisions", "Summit Provisions Foods", [], 0.99)
    expect(r.match).toBe(true)
    expect(r.method).toBe("contains_reverse")
    expect(r.score).toBeCloseTo(0.85, 10)
  })
})

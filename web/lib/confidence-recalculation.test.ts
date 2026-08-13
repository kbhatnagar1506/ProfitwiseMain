/**
 * Unit tests for the amount and date scoring primitives in
 * confidence-recalculation.ts.
 *
 * Every reconciliation confidence score is built on these two functions, and
 * the band edges decide whether a match auto-confirms or lands in the review
 * queue — so each threshold is pinned on both sides.
 */

import { computeAmountScore, computeDateProximityScore } from "./confidence-recalculation"

describe("computeAmountScore", () => {
  it("scores an exact match 1.0", () => {
    expect(computeAmountScore(100, 100)).toBe(1)
  })

  it("treats a sub-0.1% difference as exact", () => {
    expect(computeAmountScore(100.05, 100)).toBe(1)
  })

  it("walks down the tolerance bands as the gap widens", () => {
    expect(computeAmountScore(100.5, 100)).toBe(0.97) // within 1%
    expect(computeAmountScore(102, 100)).toBe(0.92) // within 3%
    expect(computeAmountScore(104, 100)).toBe(0.88) // within 5%
    expect(computeAmountScore(109, 100)).toBe(0.8) // within 10%
    expect(computeAmountScore(115, 100)).toBe(0.65) // within 20%
  })

  it("is symmetric about the target inside the tolerance bands", () => {
    expect(computeAmountScore(98, 100)).toBe(computeAmountScore(102, 100))
    expect(computeAmountScore(96, 100)).toBe(computeAmountScore(104, 100))
  })

  it("scores an underpayment above an overpayment once outside the bands", () => {
    // An underpayment is a plausible partial settlement; an overpayment past
    // 20% is far more likely to be the wrong invoice entirely.
    expect(computeAmountScore(50, 100)).toBe(0.6)
    expect(computeAmountScore(200, 100)).toBe(0.4)
    expect(computeAmountScore(50, 100)).toBeGreaterThan(computeAmountScore(200, 100))
  })

  it("returns 0 for a non-positive target rather than dividing by zero", () => {
    expect(computeAmountScore(100, 0)).toBe(0)
    expect(computeAmountScore(100, -5)).toBe(0)
    expect(Number.isNaN(computeAmountScore(100, 0))).toBe(false)
  })

  it("never returns a score outside 0..1", () => {
    const samples = [-500, -1, 0, 0.01, 1, 99, 100, 101, 1e6]
    for (const m of samples) {
      for (const t of samples) {
        const s = computeAmountScore(m, t)
        expect(s).toBeGreaterThanOrEqual(0)
        expect(s).toBeLessThanOrEqual(1)
      }
    }
  })

  it("is monotonically non-increasing as the gap grows", () => {
    const gaps = [100, 100.5, 102, 104, 109, 115, 200]
    const scores = gaps.map((m) => computeAmountScore(m, 100))
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1])
    }
  })
})

describe("computeDateProximityScore", () => {
  it("returns the neutral 0.75 when either date is missing", () => {
    expect(computeDateProximityScore(null, "2026-03-01")).toBe(0.75)
    expect(computeDateProximityScore("2026-03-01", null)).toBe(0.75)
    expect(computeDateProximityScore(null, null)).toBe(0.75)
  })

  it("returns the neutral 0.75 for unparseable dates", () => {
    expect(computeDateProximityScore("not-a-date", "2026-03-01")).toBe(0.75)
    expect(computeDateProximityScore("2026-03-01", "garbage")).toBe(0.75)
  })

  it("scores same-day and next-day as a perfect 1.0", () => {
    expect(computeDateProximityScore("2026-03-01", "2026-03-01")).toBe(1)
    expect(computeDateProximityScore("2026-03-02", "2026-03-01")).toBe(1)
  })

  it("walks down the proximity bands", () => {
    expect(computeDateProximityScore("2026-03-08", "2026-03-01")).toBe(0.93) // 7 days
    expect(computeDateProximityScore("2026-03-15", "2026-03-01")).toBe(0.87) // 14 days
    expect(computeDateProximityScore("2026-03-31", "2026-03-01")).toBe(0.8) // 30 days
    expect(computeDateProximityScore("2026-04-30", "2026-03-01")).toBe(0.72) // 60 days
    expect(computeDateProximityScore("2026-05-30", "2026-03-01")).toBe(0.65) // 90 days
    expect(computeDateProximityScore("2026-09-01", "2026-03-01")).toBe(0.5) // stale
  })

  it("is symmetric — paying early scores the same as paying late", () => {
    expect(computeDateProximityScore("2026-03-08", "2026-03-01")).toBe(
      computeDateProximityScore("2026-03-01", "2026-03-08")
    )
    // Equidistant by day count, not by calendar month: 2026-03-01 ± 10 days.
    expect(computeDateProximityScore("2026-02-19", "2026-03-01")).toBe(
      computeDateProximityScore("2026-03-11", "2026-03-01")
    )
  })

  it("accepts full ISO timestamps as well as plain dates", () => {
    expect(computeDateProximityScore("2026-03-01T12:00:00Z", "2026-03-01T00:00:00Z")).toBe(1)
  })

  it("is monotonically non-increasing with distance", () => {
    const dates = [
      "2026-03-01",
      "2026-03-08",
      "2026-03-15",
      "2026-03-31",
      "2026-04-30",
      "2026-05-30",
      "2026-09-01",
    ]
    const scores = dates.map((d) => computeDateProximityScore(d, "2026-03-01"))
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1])
    }
  })

  it("never returns a score outside 0..1", () => {
    const s = computeDateProximityScore("1999-01-01", "2030-12-31")
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(1)
  })
})

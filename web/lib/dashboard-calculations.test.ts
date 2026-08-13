/**
 * Unit tests for dashboard-calculations.ts — peer statistics, percentile
 * ranking, data-quality scoring and recommendation thresholds surfaced on the
 * entity dashboard.
 */

import {
  calculatePercentile,
  generatePriorityRecommendations,
  calculateDataQuality,
  calculateTrendVelocity,
  calculatePeerStatistics,
  type EntityMetrics,
} from "./dashboard-calculations"

function makeEntity(overrides: Partial<EntityMetrics> = {}): EntityMetrics {
  return {
    id: "e1",
    archetype: "steady",
    reliability_score: 80,
    risk_score: 20,
    avg_days_to_pay: 30,
    transactions_per_month: 4,
    on_time_payment_rate: 90,
    early_payment_rate: 10,
    amount_trend: "stable",
    risk_factors: [],
    transaction_count: 24,
    avg_interval_days: 7,
    interval_cv: 20,
    ...overrides,
  }
}

describe("calculatePercentile", () => {
  it("returns the neutral 50 for a null or undefined value", () => {
    expect(calculatePercentile(null, [1, 2, 3])).toBe(50)
    expect(calculatePercentile(undefined as unknown as number, [1, 2, 3])).toBe(50)
  })

  it("returns the neutral 50 when there is no comparable data", () => {
    expect(calculatePercentile(5, [])).toBe(50)
    expect(calculatePercentile(5, [null, null])).toBe(50)
  })

  it("ignores null entries in the peer set", () => {
    expect(calculatePercentile(2, [null, 1, null, 3])).toBe(50) // 1 of 2 peers below
  })

  it("ranks by the share of peers strictly below the value", () => {
    expect(calculatePercentile(1, [1, 2, 3])).toBeCloseTo(0, 5)
    expect(calculatePercentile(2, [1, 2, 3])).toBeCloseTo(100 / 3, 5)
    expect(calculatePercentile(3, [1, 2, 3])).toBeCloseTo(200 / 3, 5)
  })

  it("returns 100 when the value exceeds every peer", () => {
    expect(calculatePercentile(4, [1, 2, 3])).toBe(100)
  })

  it("is order-independent (it sorts internally)", () => {
    expect(calculatePercentile(2, [3, 1, 2])).toBeCloseTo(calculatePercentile(2, [1, 2, 3]), 10)
  })

  it("KNOWN QUIRK: the largest value present ranks below 100, with a jump just above it", () => {
    // Because the rank counts peers strictly below, a value equal to the max
    // scores (n-1)/n while any value above it scores a full 100. Documented in
    // REVIEW.md — changing it shifts every percentile shown on the dashboard.
    expect(calculatePercentile(10, [10])).toBe(0)
    expect(calculatePercentile(10.0001, [10])).toBe(100)
  })
})

describe("generatePriorityRecommendations", () => {
  it("returns nothing for a healthy entity", () => {
    expect(generatePriorityRecommendations(makeEntity())).toEqual([])
  })

  it("flags critical risk at a score of 70 and above", () => {
    expect(generatePriorityRecommendations(makeEntity({ risk_score: 69 }))).toEqual([])
    const recs = generatePriorityRecommendations(makeEntity({ risk_score: 70 }))
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ priority: "critical", title: "High Risk Alert" })
  })

  it("flags payment slowing only when both slow payment AND poor on-time rate hold", () => {
    // Slow but reliable → no flag
    expect(
      generatePriorityRecommendations(makeEntity({ avg_days_to_pay: 60, on_time_payment_rate: 90 }))
    ).toEqual([])
    // Fast but unreliable → no flag
    expect(
      generatePriorityRecommendations(makeEntity({ avg_days_to_pay: 20, on_time_payment_rate: 50 }))
    ).toEqual([])
    // Both → flag
    const recs = generatePriorityRecommendations(
      makeEntity({ avg_days_to_pay: 60, on_time_payment_rate: 50 })
    )
    expect(recs.map((r) => r.title)).toContain("Payment Slowing")
  })

  it("flags dropping frequency only once there is enough history", () => {
    // Low frequency but only 5 transactions → not enough signal
    expect(
      generatePriorityRecommendations(
        makeEntity({ transactions_per_month: 0.2, transaction_count: 5 })
      )
    ).toEqual([])
    const recs = generatePriorityRecommendations(
      makeEntity({ transactions_per_month: 0.2, transaction_count: 6 })
    )
    expect(recs.map((r) => r.title)).toContain("Frequency Dropping")
  })

  it("flags unpredictable timing above a 100 coefficient of variation", () => {
    expect(generatePriorityRecommendations(makeEntity({ interval_cv: 100 }))).toEqual([])
    const recs = generatePriorityRecommendations(makeEntity({ interval_cv: 101 }))
    expect(recs.map((r) => r.title)).toContain("Unpredictable Timing")
  })

  it("flags declining and growing activity from the amount trend", () => {
    expect(
      generatePriorityRecommendations(makeEntity({ amount_trend: "decreasing" })).map((r) => r.title)
    ).toContain("Declining Activity")

    expect(
      generatePriorityRecommendations(
        makeEntity({ amount_trend: "increasing", transactions_per_month: 5 })
      ).map((r) => r.title)
    ).toContain("Growing Opportunity")
  })

  it("flags the early-payer opportunity only for entities that pay ahead of terms", () => {
    const recs = generatePriorityRecommendations(
      makeEntity({ early_payment_rate: 40, avg_days_to_pay: -25 })
    )
    expect(recs.map((r) => r.title)).toContain("Early Payer Opportunity")
    expect(recs[recs.length - 1].priority).toBe("low")
  })

  it("can return several recommendations ordered critical → low", () => {
    const recs = generatePriorityRecommendations(
      makeEntity({
        risk_score: 90,
        avg_days_to_pay: 60,
        on_time_payment_rate: 40,
        interval_cv: 150,
        amount_trend: "decreasing",
      })
    )
    expect(recs.length).toBeGreaterThan(2)
    expect(recs[0].priority).toBe("critical")
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const
    const ranks = recs.map((r) => rank[r.priority])
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })
})

describe("calculateDataQuality", () => {
  it("caps each component at 1.0 so a rich history cannot exceed 100", () => {
    const q = calculateDataQuality(
      makeEntity({ transaction_count: 500, avg_interval_days: 30, interval_cv: 0 })
    )
    expect(q.components.transactionCount).toBe(1)
    expect(q.components.dataSpan).toBe(1)
    expect(q.score).toBeLessThanOrEqual(100)
    expect(q.level).toBe("High")
  })

  it("floors the consistency component at 0 for wildly irregular intervals", () => {
    const q = calculateDataQuality(makeEntity({ interval_cv: 500 }))
    expect(q.components.consistency).toBe(0)
  })

  it("scores an entity with no due-date coverage lower", () => {
    const withCoverage = calculateDataQuality(makeEntity({ on_time_payment_rate: 90 }))
    const without = calculateDataQuality(makeEntity({ on_time_payment_rate: 0 }))
    expect(without.components.dueDateCoverage).toBe(0)
    expect(without.score).toBeCloseTo(withCoverage.score - 20, 5)
  })

  it("labels the score band at the 70 / 40 boundaries", () => {
    const bands = [
      { interval_cv: 0, transaction_count: 500, avg_interval_days: 30, expected: "High" },
      { interval_cv: 100, transaction_count: 0, avg_interval_days: 0, expected: "Low" },
    ] as const
    for (const b of bands) {
      const q = calculateDataQuality(
        makeEntity({
          interval_cv: b.interval_cv,
          transaction_count: b.transaction_count,
          avg_interval_days: b.avg_interval_days,
        })
      )
      expect(q.level).toBe(b.expected)
    }
  })

  it("weights the four components 30/30/20/20", () => {
    const e = makeEntity({ transaction_count: 25, avg_interval_days: 0, interval_cv: 50 })
    const q = calculateDataQuality(e)
    const expected =
      (q.components.transactionCount * 0.3 +
        q.components.dataSpan * 0.3 +
        q.components.dueDateCoverage * 0.2 +
        q.components.consistency * 0.2) *
      100
    expect(q.score).toBeCloseTo(expected, 10)
  })
})

describe("calculateTrendVelocity", () => {
  it("is stable when the trend has not changed", () => {
    expect(calculateTrendVelocity("increasing", "increasing")).toBe("stable")
    expect(calculateTrendVelocity("decreasing", "decreasing")).toBe("stable")
    expect(calculateTrendVelocity("stable", "stable")).toBe("stable")
  })

  it("accelerates when the trend moves upward", () => {
    expect(calculateTrendVelocity("increasing", "stable")).toBe("accelerating")
    expect(calculateTrendVelocity("increasing", "decreasing")).toBe("accelerating")
    expect(calculateTrendVelocity("stable", "decreasing")).toBe("accelerating")
  })

  it("decelerates when the trend moves downward", () => {
    // Regression: increasing→decreasing previously reported "accelerating",
    // because both direction branches returned the same label.
    expect(calculateTrendVelocity("decreasing", "increasing")).toBe("decelerating")
    expect(calculateTrendVelocity("decreasing", "stable")).toBe("decelerating")
    expect(calculateTrendVelocity("stable", "increasing")).toBe("decelerating")
  })

  it("is antisymmetric: swapping the arguments flips accelerating and decelerating", () => {
    const trends = ["increasing", "decreasing", "stable"] as const
    for (const a of trends) {
      for (const b of trends) {
        const forward = calculateTrendVelocity(a, b)
        const backward = calculateTrendVelocity(b, a)
        if (forward === "stable") expect(backward).toBe("stable")
        if (forward === "accelerating") expect(backward).toBe("decelerating")
        if (forward === "decelerating") expect(backward).toBe("accelerating")
      }
    }
  })
})

describe("calculatePeerStatistics", () => {
  it("returns an empty map for no entities", () => {
    expect(calculatePeerStatistics([])).toEqual({})
  })

  it("groups by archetype and averages each metric", () => {
    const stats = calculatePeerStatistics([
      makeEntity({ id: "a", archetype: "steady", reliability_score: 80, risk_score: 10, avg_days_to_pay: 20, transactions_per_month: 2 }),
      makeEntity({ id: "b", archetype: "steady", reliability_score: 60, risk_score: 30, avg_days_to_pay: 40, transactions_per_month: 4 }),
      makeEntity({ id: "c", archetype: "erratic", reliability_score: 50, risk_score: 70, avg_days_to_pay: 90, transactions_per_month: 1 }),
    ])

    expect(Object.keys(stats).sort()).toEqual(["erratic", "steady"])
    expect(stats.steady).toEqual({
      count: 2,
      avgReliability: 70,
      avgRisk: 20,
      avgDaysToPay: 30,
      avgFrequency: 3,
    })
    expect(stats.erratic.count).toBe(1)
    expect(stats.erratic.avgRisk).toBe(70)
  })

  it("keeps archetypes separate even when one has a single member", () => {
    const stats = calculatePeerStatistics([makeEntity({ archetype: "solo", reliability_score: 42 })])
    expect(stats.solo.count).toBe(1)
    expect(stats.solo.avgReliability).toBe(42)
  })
})

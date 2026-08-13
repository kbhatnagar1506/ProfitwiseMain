/**
 * Unit tests for confidence-scoring.ts — the component breakdown attached to
 * every reconciliation attribution.
 *
 * The async (LLM stage) and sync (FIFO hot path) builders are supposed to be
 * two implementations of one scoring model. They are not, and the divergence is
 * characterised at the bottom of this file. The Supermemory history lookup is
 * mocked so these tests stay hermetic.
 */

import { vi } from "vitest"

vi.mock("./supermemory-decision-history", () => ({
  getHistoryConfidenceAdjustment: vi.fn(async () => 0),
}))

import {
  confidenceLabel,
  buildConfidenceBreakdown,
  buildSyncConfidenceBreakdown,
  breakdownToEnvelope,
} from "./confidence-scoring"
import { getHistoryConfidenceAdjustment } from "./supermemory-decision-history"

const baseParams = {
  movementAmount: 1000,
  targetAmount: 1000,
  bankDescription: "Sanzo",
  entityName: "Sanzo",
  movementDate: "2026-03-01",
  invoiceDueDate: "2026-03-01",
}

describe("confidenceLabel", () => {
  it("maps each band, inclusive at the lower edge", () => {
    expect(confidenceLabel(1)).toBe("high")
    expect(confidenceLabel(0.88)).toBe("high")
    expect(confidenceLabel(0.8799)).toBe("medium")
    expect(confidenceLabel(0.75)).toBe("medium")
    expect(confidenceLabel(0.7499)).toBe("low")
    expect(confidenceLabel(0.6)).toBe("low")
    expect(confidenceLabel(0.5999)).toBe("very_low")
    expect(confidenceLabel(0)).toBe("very_low")
  })
})

describe("buildSyncConfidenceBreakdown", () => {
  it("returns a perfect-signal match in the high band", () => {
    const b = buildSyncConfidenceBreakdown(baseParams)
    expect(b.components.amount.score).toBe(1)
    expect(b.components.date_proximity.score).toBe(1)
    expect(b.components.entity_name.score).toBeCloseTo(1, 5)
    expect(confidenceLabel(b.score)).toBe("high")
  })

  it("clamps the final score to the 0.40 – 0.99 envelope", () => {
    const worst = buildSyncConfidenceBreakdown({
      ...baseParams,
      movementAmount: 5,
      targetAmount: 100000,
      bankDescription: "zzzz",
      entityName: "Sanzo",
      movementDate: "1999-01-01",
      invoiceDueDate: "2030-01-01",
    })
    expect(worst.score).toBeGreaterThanOrEqual(0.4)

    const best = buildSyncConfidenceBreakdown({ ...baseParams, entityValidationConfidence: 1 })
    expect(best.score).toBeLessThanOrEqual(0.99)
  })

  it("uses the supplied AI validation score in place of the heuristic", () => {
    const withAi = buildSyncConfidenceBreakdown({ ...baseParams, entityValidationConfidence: 0.2 })
    expect(withAi.components.entity_name_validation.score).toBe(0.2)
    expect(withAi.components.entity_name_validation.reasoning).toMatch(/AI entity validation score/)
  })

  it("falls back to the heuristic and says so when no AI score is given", () => {
    const b = buildSyncConfidenceBreakdown(baseParams)
    expect(b.components.entity_name_validation.score).toBe(b.components.entity_name.score)
    expect(b.components.entity_name_validation.reasoning).toMatch(/AI validation not run/)
  })

  it("penalises each additional match on the same movement", () => {
    const first = buildSyncConfidenceBreakdown({ ...baseParams, matchSequenceIndex: 0 })
    const second = buildSyncConfidenceBreakdown({ ...baseParams, matchSequenceIndex: 1 })
    const third = buildSyncConfidenceBreakdown({ ...baseParams, matchSequenceIndex: 2 })
    expect(first.components.match_sequence.score).toBe(1)
    expect(second.components.match_sequence.score).toBe(0.8)
    expect(third.components.match_sequence.score).toBe(0.6)
    expect(second.score).toBeLessThan(first.score)
  })

  it("reports history as un-evaluated on the sync path", () => {
    const b = buildSyncConfidenceBreakdown(baseParams)
    expect(b.components.history.score).toBe(0.5)
    expect(b.components.history.reasoning).toMatch(/not evaluated/i)
  })

  it("weights sum to 1.0 across the seven components", () => {
    const b = buildSyncConfidenceBreakdown(baseParams)
    const total = Object.values(b.components).reduce((s, c) => s + c.weight, 0)
    expect(total).toBeCloseTo(1, 10)
  })

  it("computes the score as the plain weighted sum of its components", () => {
    const b = buildSyncConfidenceBreakdown({ ...baseParams, categoryAdjustment: 0.1, matchSequenceIndex: 1 })
    const expected = Object.values(b.components).reduce((s, c) => s + c.score * c.weight, 0)
    expect(b.score).toBeCloseTo(Math.min(0.99, Math.max(0.4, expected)), 10)
  })

  it("carries the waterfall stage and match method through to the summary", () => {
    const b = buildSyncConfidenceBreakdown({
      ...baseParams,
      waterfallStage: "stage_3_fifo",
      matchMethod: "fifo_exact",
    })
    expect(b.waterfall_stage).toBe("stage_3_fifo")
    expect(b.match_method).toBe("fifo_exact")
    expect(b.summary).toContain("fifo_exact")
    expect(b.summary).toMatch(/^HIGH confidence/)
  })

  it("describes the amount gap in the reasoning text", () => {
    expect(buildSyncConfidenceBreakdown(baseParams).components.amount.reasoning).toBe(
      "Exact amount match"
    )
    expect(
      buildSyncConfidenceBreakdown({ ...baseParams, movementAmount: 980 }).components.amount.reasoning
    ).toMatch(/likely processor fee/)
  })
})

describe("buildConfidenceBreakdown (async path)", () => {
  beforeEach(() => {
    vi.mocked(getHistoryConfidenceAdjustment).mockResolvedValue(0)
  })

  it("produces a high-confidence breakdown for a perfect match", async () => {
    const b = await buildConfidenceBreakdown({ ...baseParams, userId: "u1", entityId: "e1" })
    expect(confidenceLabel(b.score)).toBe("high")
    expect(b.components.amount.score).toBe(1)
  })

  it("consults the history signal for the given user and entity", async () => {
    await buildConfidenceBreakdown({ ...baseParams, userId: "u7", entityId: "e9" })
    expect(getHistoryConfidenceAdjustment).toHaveBeenCalledWith("u7", "e9", 1000)
  })

  it("raises the score on a positive history adjustment and lowers it on a negative one", async () => {
    vi.mocked(getHistoryConfidenceAdjustment).mockResolvedValue(0)
    const neutral = await buildConfidenceBreakdown({ ...baseParams, userId: "u1", entityId: "e1", movementAmount: 900 })

    vi.mocked(getHistoryConfidenceAdjustment).mockResolvedValue(0.15)
    const boosted = await buildConfidenceBreakdown({ ...baseParams, userId: "u1", entityId: "e1", movementAmount: 900 })

    vi.mocked(getHistoryConfidenceAdjustment).mockResolvedValue(-0.15)
    const penalised = await buildConfidenceBreakdown({ ...baseParams, userId: "u1", entityId: "e1", movementAmount: 900 })

    expect(boosted.score).toBeGreaterThan(neutral.score)
    expect(penalised.score).toBeLessThan(neutral.score)
    expect(boosted.components.history.reasoning).toMatch(/boost/i)
    expect(penalised.components.history.reasoning).toMatch(/penalty/i)
  })

  it("clamps to the same 0.40 – 0.99 envelope as the sync path", async () => {
    vi.mocked(getHistoryConfidenceAdjustment).mockResolvedValue(0.15)
    const b = await buildConfidenceBreakdown({ ...baseParams, userId: "u1", entityId: "e1", entityValidationConfidence: 1 })
    expect(b.score).toBeLessThanOrEqual(0.99)

    vi.mocked(getHistoryConfidenceAdjustment).mockResolvedValue(-0.15)
    const worst = await buildConfidenceBreakdown({
      ...baseParams,
      userId: "u1",
      entityId: "e1",
      movementAmount: 5,
      targetAmount: 100000,
      bankDescription: "zzzz",
    })
    expect(worst.score).toBeGreaterThanOrEqual(0.4)
  })
})

/**
 * CHARACTERISATION — NOT a specification.
 *
 * These tests document a real defect rather than desired behaviour: the sync
 * and async builders disagree for identical inputs. The async path adds
 * `historyAdj`, `categoryAdjustment` and the sequence penalty as RAW offsets
 * after the weighted sum, while the sync path folds the same signals in through
 * their declared weights.
 *
 * Confidence drives auto-confirmation of financial matches, so whichever path
 * scored a movement changes whether it lands in the review queue. Fixing this
 * shifts live match rates and needs a deliberate call on the target semantics —
 * see REVIEW.md. Until then these tests fail loudly if the gap changes shape.
 */
describe("CHARACTERISATION: sync and async paths disagree", () => {
  beforeEach(() => {
    vi.mocked(getHistoryConfidenceAdjustment).mockResolvedValue(0)
  })

  it("differ by a constant 0.01 even with every signal neutral", async () => {
    const sync = buildSyncConfidenceBreakdown(baseParams)
    const async_ = await buildConfidenceBreakdown({ ...baseParams, userId: "u1", entityId: "e1" })

    // async tail: (0.05 + 0.03 + 0.02) * 0.5            = 0.050
    // sync  tail: 0.05*0.5 + 0.03*(0.5) + 0.02*1.0      = 0.060
    expect(sync.score - async_.score).toBeCloseTo(0.01, 10)
  })

  it("apply categoryAdjustment on wildly different scales (~33x apart)", async () => {
    // A mid-range match, chosen so neither result runs into the 0.40/0.99 clamp
    // (a perfect match saturates the ceiling and hides the divergence).
    const midParams = {
      ...baseParams,
      entityValidationConfidence: 0.2,
      movementDate: "2026-03-31",
      invoiceDueDate: "2026-03-01",
    }

    const syncBase = buildSyncConfidenceBreakdown(midParams).score
    const syncAdj = buildSyncConfidenceBreakdown({ ...midParams, categoryAdjustment: 0.2 }).score

    const asyncBase = (await buildConfidenceBreakdown({ ...midParams, userId: "u1", entityId: "e1" })).score
    const asyncAdj = (
      await buildConfidenceBreakdown({ ...midParams, userId: "u1", entityId: "e1", categoryAdjustment: 0.2 })
    ).score

    expect(syncBase).toBeGreaterThan(0.4)
    expect(asyncAdj).toBeLessThan(0.99)

    // Sync routes it through the 0.03 category weight; async adds it raw.
    expect(syncAdj - syncBase).toBeCloseTo(0.006, 10)
    expect(asyncAdj - asyncBase).toBeCloseTo(0.2, 10)
  })

  it("apply the match-sequence penalty on different scales", async () => {
    const syncDelta =
      buildSyncConfidenceBreakdown({ ...baseParams, matchSequenceIndex: 1 }).score -
      buildSyncConfidenceBreakdown({ ...baseParams, matchSequenceIndex: 0 }).score

    const asyncDelta =
      (await buildConfidenceBreakdown({ ...baseParams, userId: "u1", entityId: "e1", matchSequenceIndex: 1 })).score -
      (await buildConfidenceBreakdown({ ...baseParams, userId: "u1", entityId: "e1", matchSequenceIndex: 0 })).score

    expect(syncDelta).toBeCloseTo(-0.004, 10) // 0.02 weight * 0.2 score drop
    expect(asyncDelta).toBeCloseTo(-0.05, 10) // raw -0.05 offset
  })
})

describe("breakdownToEnvelope", () => {
  it("flattens the breakdown into the legacy JSONB envelope", () => {
    const b = buildSyncConfidenceBreakdown(baseParams)
    const env = breakdownToEnvelope(b)

    expect(env.score).toBe(b.score)
    expect(env.kind).toBe("probabilistic")
    expect(env.components.amount).toBe(b.components.amount.score)
    expect(env.components.date).toBe(b.components.date_proximity.score)
    expect(env.components.entity).toBe(b.components.entity_name.score)
    expect(env.components.entity_validation).toBe(b.components.entity_name_validation.score)
    expect(env.components.history).toBe(b.components.history.score)
    expect(env.components.category).toBe(b.components.category.score)
    expect(env.components.match_sequence).toBe(b.components.match_sequence.score)
  })

  it("nests the full breakdown for audit replay", () => {
    const b = buildSyncConfidenceBreakdown({ ...baseParams, waterfallStage: "stage_4_llm" })
    expect(breakdownToEnvelope(b).components.breakdown).toBe(b)
    expect(breakdownToEnvelope(b).components.breakdown?.waterfall_stage).toBe("stage_4_llm")
  })

  it("survives a JSON round-trip (it is persisted as JSONB)", () => {
    const env = breakdownToEnvelope(buildSyncConfidenceBreakdown(baseParams))
    expect(JSON.parse(JSON.stringify(env))).toEqual(JSON.parse(JSON.stringify(env)))
    expect(JSON.parse(JSON.stringify(env)).score).toBe(env.score)
  })
})

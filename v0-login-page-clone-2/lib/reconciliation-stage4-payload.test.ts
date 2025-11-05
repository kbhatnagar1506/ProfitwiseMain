import test from "node:test"
import assert from "node:assert/strict"
import { buildStage4CandidatePayload } from "./reconciliation-stage4-payload"

test("stage4 payload marks big-rock and candidate deltas", () => {
  const payload = buildStage4CandidatePayload({
    movement: {
      id: "m-1",
      date: "2026-03-01",
      direction: "inflow",
      movement_type: "processor_payout",
      counterparty: "Katz Holdings LLC",
      counterparty_entity_id: null,
      raw_description: "Katz Holdings payout",
    },
    remainingCash: 12000,
    targetType: "ar",
    candidates: [
      {
        id: "ce-1",
        entity_id: "ent-1",
        event_type: "ar",
        canonical_name: "Sarah Katz",
        expected_date: "2026-02-28",
        outstanding_num: 11800,
      },
    ],
    entityMap: new Map([
      [
        "ent-1",
        {
          entity_id: "ent-1",
          canonical_name: "Sarah Katz",
          aliases: ["Katz Holdings LLC", "Katz Holdings"],
        },
      ],
    ]),
    ghostByEventId: new Map(),
    velocityByEntityEvent: new Map(),
  })

  assert.equal(payload.movement.is_big_rock, true)
  assert.equal(payload.candidates.length, 1)
  assert.equal(payload.candidates[0].alias_match, true)
  assert.equal(payload.candidates[0].amount_delta, 200)
})

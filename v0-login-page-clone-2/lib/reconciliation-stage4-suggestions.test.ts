import test from "node:test"
import assert from "node:assert/strict"
import { buildAllocationPlanForTest, scoreCandidateForTest } from "./reconciliation-stage4-suggestions"
import { isTerminalReviewQueueStatus } from "./reconciliation-review-queue"

test("stage4 scoring rewards close amount + alias + near date", () => {
  const strong = scoreCandidateForTest(1000, {
    event_id: "e1",
    entity_id: "ent-1",
    canonical_name: "Katz Holdings",
    event_type: "ar",
    expected_date: "2026-03-10",
    outstanding_amount: 1010,
    amount_delta: 10,
    date_delta_days: 5,
    alias_match: true,
  })
  const weak = scoreCandidateForTest(1000, {
    event_id: "e2",
    entity_id: "ent-2",
    canonical_name: "Random Vendor",
    event_type: "ar",
    expected_date: "2026-05-10",
    outstanding_amount: 1800,
    amount_delta: 800,
    date_delta_days: 60,
    alias_match: false,
  })
  assert.ok(strong.confidence > weak.confidence)
})

test("allocation plan preserves gross = net + fee", () => {
  const plan = buildAllocationPlanForTest(
    {
      movement_id: "m1",
      amount: 97,
      target_type: "ar",
      counterparty: "Stripe payout",
      raw_description: null,
    },
    {
      event_id: "e1",
      entity_id: "ent-1",
      canonical_name: "Client A",
      event_type: "ar",
      expected_date: "2026-03-01",
      outstanding_amount: 100,
      amount_delta: 3,
      date_delta_days: 1,
      alias_match: true,
    },
  )
  assert.equal(Number((plan.gross_amount - (plan.net_amount + plan.fee_amount)).toFixed(2)), 0)
})

test("terminal statuses are idempotent no-op targets", () => {
  assert.equal(isTerminalReviewQueueStatus("pending"), false)
  assert.equal(isTerminalReviewQueueStatus("resolved"), true)
  assert.equal(isTerminalReviewQueueStatus("rejected"), true)
})

/**
 * Seeds the reconciliation_test_cases table with golden "nightmare" test cases.
 *
 * These are the known failure modes that we need to fix:
 * - Cross-vendor greedy sweeping (Tyler Hines, Sarah Katz)
 * - Name mismatch (Spread The Love Foods vs High Brew)
 * - Processor aggregate payouts
 * - Vendor credits / negative amounts
 *
 * Usage:
 *   npx tsx scripts/seed-reconciliation-test-cases.ts <userId>
 */

import { query, ensureMovementsSchema } from "../lib/db"

const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"

const TEST_CASES = [
  // ── Category 1: Cross-entity greedy sweeping (should REJECT cross-entity) ──
  {
    description: "Tyler Hines payout should NOT split across multiple unrelated teams",
    expected_match: true,
    failure_mode: "greedy_sweep",
    notes: "Tyler Hines is an aggregate sender. System currently slices across Clemson, USC, Bay FC etc.",
  },
  {
    description: "Spread The Love Foods deposit should NOT match High Brew invoice",
    expected_match: true,
    failure_mode: "cross_entity_name_mismatch",
    notes: "Bank desc says 'Spread The Love Foods' but system greedily matched to High Brew bill",
  },
  {
    description: "Sarah Katz Marlins payment should NOT match Jack (owner) partial",
    expected_match: true,
    failure_mode: "contact_vs_owner_confusion",
    notes: "Sarah Katz is a customer. System matched $294.68 partial to Jack (owner)",
  },
  // ── Category 2: Correct same-entity multi-invoice matching (should PASS) ──
  {
    description: "Single BPN Wholesale payment covering 2 BPN invoices is valid",
    expected_match: true,
    failure_mode: null,
    notes: "Multiple invoices from same vendor — this is correct FIFO behavior",
  },
  {
    description: "Single customer payment covering 3 invoices from same customer is valid",
    expected_match: true,
    failure_mode: null,
    notes: "Multi-invoice from same AR entity — should pass with Stage 3",
  },
  // ── Category 3: Processor payouts (should match as settlement, not AR) ──
  {
    description: "Shopify payout should be classified as settlement, not customer AR",
    expected_match: true,
    failure_mode: "processor_payout_misclass",
    notes: "Aggregate Shopify payout should not be matched to individual customer invoices",
  },
  {
    description: "Stripe payout net of fees should create fee attribution",
    expected_match: true,
    failure_mode: null,
    notes: "Stripe payout: gross=1000, fee=29, net=971 — should create fee component",
  },
  // ── Category 4: Vendor credits (negative outstanding_amount) ──
  {
    description: "Vendor credit from Cooper Street should get credit status, not open",
    expected_match: true,
    failure_mode: "polarity_credit_misclass",
    notes: "Bill with negative amount_due was left as open instead of credit",
  },
  {
    description: "Customer overpayment should get credit status",
    expected_match: true,
    failure_mode: "polarity_credit_misclass",
    notes: "Invoice where customer paid more than owed — outstanding should be negative and status=credit",
  },
  // ── Category 5: No-match cases (system should NOT match these) ──
  {
    description: "Generic bank fee should NOT match any AR/AP invoice",
    expected_match: false,
    failure_mode: null,
    notes: "Bank fee with economic_class=bank_fee should be excluded from reconciliation",
  },
  {
    description: "Internal transfer should NOT match any invoice",
    expected_match: false,
    failure_mode: null,
    notes: "Transfer between own accounts should be excluded",
  },
  // ── Category 6: Amount tolerance ──
  {
    description: "Invoice $1000 matched by $971 movement (3% processor fee) is valid",
    expected_match: true,
    failure_mode: null,
    notes: "Stage 2 processor fee band: amount within 1-5% should match",
  },
  {
    description: "Amount mismatch >10% with no entity match should NOT match",
    expected_match: false,
    failure_mode: "amount_mismatch",
    notes: "Movement $500 vs invoice $1000 for unrelated entity — should be unmatched",
  },
]

async function main() {
  const userId = process.argv[2]
  if (!userId) {
    console.error(`${RED}Usage: npx tsx scripts/seed-reconciliation-test-cases.ts <userId>${RESET}`)
    process.exit(1)
  }

  console.log(`\n${BOLD}${CYAN}╔════════════════════════════════════════╗${RESET}`)
  console.log(`${BOLD}${CYAN}║  Seeding Golden Test Cases             ║${RESET}`)
  console.log(`${BOLD}${CYAN}╚════════════════════════════════════════╝${RESET}\n`)

  try {
    await ensureMovementsSchema()

    // Clear existing test cases for this user
    await query(`DELETE FROM reconciliation_test_cases WHERE user_id = $1`, [userId])
    console.log(`  Cleared existing test cases for user ${userId}`)

    let inserted = 0
    for (const tc of TEST_CASES) {
      await query(
        `INSERT INTO reconciliation_test_cases
           (user_id, description, expected_match, failure_mode, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, tc.description, tc.expected_match, tc.failure_mode ?? null, tc.notes ?? null]
      )
      inserted++
    }

    console.log(`  ${GREEN}✓ Inserted ${inserted} test cases.${RESET}`)
    console.log(`\n  Link movements to test cases by updating the movement_id column:`)
    console.log(`  ${CYAN}UPDATE reconciliation_test_cases SET movement_id = '<uuid>' WHERE description LIKE '%Tyler Hines%';${RESET}`)
    console.log(`\n  Then run the test harness:`)
    console.log(`  ${CYAN}npx tsx scripts/test-reconciliation.ts ${userId}${RESET}\n`)
  } catch (err) {
    console.error(`${RED}Error seeding test cases:${RESET}`, err)
    process.exit(1)
  }
}

main()

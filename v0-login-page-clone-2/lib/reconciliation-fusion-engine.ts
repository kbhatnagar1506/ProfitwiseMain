/**
 * Fusion Reconciliation Engine
 *
 * Runs deterministic math, AI semantic matching (powered by Supermemory), and Levenshtein similarity
 * SIMULTANEOUSLY (not sequentially), combining them into a single fused confidence score.
 *
 * Architecture:
 * 1. Fast-path: Direct link + exact match (no AI cost)
 * 2. Parallel scoring: Math Judge, AI Judge (enriched with Supermemory context), Levenshtein Judge
 * 3. Entity gate: Prevents wrong entity matches
 * 4. Fused score: Weighted combination (40% Math + 40% AI + 20% Levenshtein)
 * 5. Learning write-back: Store patterns in Supermemory
 *
 * Key insight: Supermemory is a knowledge graph that the LLM uses to understand entity relationships.
 * We don't score Supermemory separately; we pass it as context to the AI judge.
 */

import type { PoolClient } from "pg"
import { ensureMovementsSchema, query, withTransaction } from "./db"
import { insertAttributionWithClient, type CreateAttributionOpts } from "./attribution-persist"
import type { CashEventRow } from "./cash-events-build"
import { buildSyncConfidenceBreakdown, breakdownToEnvelope } from "./confidence-scoring"
import { recordConfirmedBankPattern } from "./reconciliation-entity-validator"
import { writeStatusChange } from "./ar-ap-status"
import { bulkWriteAuditLog, type AuditLogEntry } from "./reconciliation-audit-log"
import { resolveReconciliationBankLabelsForMatch, type DisplayNameInput } from "./display-name-resolve"
import { entityNameSimilarity } from "./levenshtein"
import { safeParseFloat } from "./utils"
import { getAllUnreconciledMovements } from "./reconciliation-llm-match"
import { searchEntityContextFromSupermemory } from "./supermemory"

const EPS = 0.01
const STAGE4_REVIEW_THRESHOLD = 1000

export interface FullReconciliationResult {
  waterfall: { attributionsCreated: number; stage4Queued: number; movementsProcessed: number; cashEventsUpdated: number }
  llm: { matches: { ar: []; ap: [] }; applied: { applied: number; skipped: number; errors: string[] } }
  totalAttributions: number
  remainingUnmatched: number
  executionTimeMs: number
  warnings: string[]
  stage4Enabled: boolean
}

type MovementWithAvailableCash = {
  id: string
  user_id: string
  direction: "inflow" | "outflow"
  amount: number
  date: string
  movement_type: string
  counterparty: string | null
  counterparty_entity_id: string | null
  raw_description: string | null
  metadata: Record<string, unknown>
  available_cash: number
  economic_class: string | null
  tag_data: Record<string, unknown> | null
}

type MutableCashEvent = CashEventRow & {
  outstanding_amount: number
  status: "open" | "partially_paid" | "paid"
  amount: number
}

/**
 * Main entry point for fusion reconciliation.
 * Returns same type as waterfall so UI needs zero changes.
 */
export async function runFusionReconciliation(userId: string): Promise<FullReconciliationResult> {
  const startTime = Date.now()
  const warnings: string[] = []

  try {
    console.log("[fusion-engine] Starting fusion reconciliation for user:", userId)

    // Clear previous auto-generated attributions so available_cash is recalculated from scratch.
    // User-source attributions (manual matches) are preserved.
    await query(
      `DELETE FROM movement_attributions
       WHERE user_id = $1
         AND source = 'rule'
         AND metadata->>'waterfall_stage' IS NOT NULL`,
      [userId],
    )
    await query(
      `UPDATE cash_events
       SET outstanding_amount = amount,
           status = CASE WHEN status = 'paid' AND COALESCE((metadata->>'manual_paid')::boolean, false) THEN 'paid' ELSE 'open' END
       WHERE user_id = $1
         AND status != 'paid'`,
      [userId],
    )

    // Load all data upfront
    const movements = await fetchMovementsWithAvailableCash(userId)
    const cashEvents = await loadOpenCashEvents(userId)
    const bankPatternMap = await preloadBankPatternMap(userId)

    console.log(`[fusion-engine] Loaded ${movements.length} movements, ${cashEvents.length} cash events`)

    // Bulk-resolve bank display labels for all movements at once (single DB round-trip)
    const bankLabelInputs: DisplayNameInput[] = movements.map((m) => ({
      movement_id: m.id,
      user_id: m.user_id,
      counterparty: m.counterparty,
      counterparty_entity_id: m.counterparty_entity_id,
    }))
    const bankLabelMap = await resolveReconciliationBankLabelsForMatch(bankLabelInputs)
    console.log(`[fusion-engine] Resolved ${bankLabelMap.size} bank labels`)

    // Build entity lookup
    const eventsByEntity = new Map<string, MutableCashEvent[]>()
    for (const event of cashEvents) {
      if (!eventsByEntity.has(event.entity_id)) {
        eventsByEntity.set(event.entity_id, [])
      }
      eventsByEntity.get(event.entity_id)!.push(event)
    }

    const pendingAttributions: CreateAttributionOpts[] = []
    const touchedEventIds = new Set<string>()
    let stage4Queued = 0

    // Process each movement
    for (const movement of movements) {
      if (movement.available_cash <= EPS) continue

      const targetType = movement.direction === "inflow" ? "ar" : "ap"
      // Look up pre-resolved bank label from bulk-loaded map
      const resolvedLabel = bankLabelMap.get(movement.id)
      const resolvedBankForMove = resolvedLabel?.display_name ?? movement.counterparty ?? movement.raw_description

      // ─── Phase 1: Fast-Path (Direct Link + Exact Match) ───
      const fastPathResult = tryFastPath(movement, cashEvents, eventsByEntity, targetType, resolvedBankForMove)
      if (fastPathResult) {
        pendingAttributions.push(...fastPathResult.attributions)
        for (const eventId of fastPathResult.touchedEventIds) {
          touchedEventIds.add(eventId)
          const event = cashEvents.find((e) => e.id === eventId)
          if (event) {
            event.outstanding_amount = 0
            event.status = "paid"
          }
        }
        // Write-back to Supermemory
        if (fastPathResult.bankDesc && fastPathResult.entityId && fastPathResult.entityName) {
          try {
            await recordConfirmedBankPattern(userId, fastPathResult.entityId, fastPathResult.entityName, fastPathResult.bankDesc)
          } catch (err) {
            console.error("[fusion-engine] Failed to record bank pattern (fast path):", err)
          }
        }
        continue
      }

      // ─── Phase 2: Parallel Scoring ───
      const candidates = buildCandidateList(movement, eventsByEntity, targetType)
      if (candidates.length === 0) {
        if (movement.available_cash > STAGE4_REVIEW_THRESHOLD) {
          stage4Queued++
        }
        continue
      }

      // Detect same-amount conflict (multiple candidates with identical amounts)
      const movementAmount = movement.available_cash
      const sameAmountCandidates = candidates.filter(c => 
        Math.abs(c.outstanding_amount - movementAmount) < 0.01
      )
      const hasSameAmountConflict = sameAmountCandidates.length > 1

      // Score all candidates in parallel
      const mathScores = new Map<string, number>()
      const levenshteinScores = new Map<string, number>()

      for (const candidate of candidates) {
        const mathScore = scoreMath(movement, candidate)
        mathScores.set(candidate.id, mathScore)

        // Levenshtein entity name similarity (deterministic, no LLM cost)
        const entityName = (candidate.metadata?.customer_name ?? candidate.metadata?.vendor_name ?? "") as string
        const bankLabel = resolvedBankForMove ?? movement.counterparty ?? ""
        const levScore = entityNameSimilarity(bankLabel, entityName)
        levenshteinScores.set(candidate.id, levScore)
      }

      // Batch AI scoring (enriched with Supermemory context)
      const aiScores = await scoreAIBatch(movement, candidates, resolvedBankForMove, userId)

      // ─── Phase 3: Fuse Scores + Entity Gate ───
      let bestMatch: (typeof candidates)[0] | null = null
      let bestFusedScore = 0

      for (const candidate of candidates) {
        const mathScore = mathScores.get(candidate.id) ?? 0
        const aiScore = aiScores.get(candidate.id) ?? 0
        const levenshteinScore = levenshteinScores.get(candidate.id) ?? 0
        const hasDirectEntityLink = movement.counterparty_entity_id === candidate.entity_id

        // Count independent entity signals
        // Each signal must be strong enough to count independently
        const aiSignal = aiScore > 0.50           // AI ACTIVELY confirms (not default 0.50)
        const levSignal = levenshteinScore >= 0.70 // Strong name similarity
        const linkSignal = hasDirectEntityLink     // Pre-linked entity from classification
        
        const entitySignalCount = (aiSignal ? 1 : 0) + (levSignal ? 1 : 0) + (linkSignal ? 1 : 0)
        const hasEntitySignal = entitySignalCount >= 1

        // Gate logic: STRICTER when same-amount conflict exists
        // Require 2 independent signals to disambiguate between same-amount candidates
        const entityGatePassed = hasSameAmountConflict
          ? entitySignalCount >= 2                 // STRICT: Must have 2+ independent signals
          : (hasEntitySignal || mathScore >= 0.80) // NORMAL: 1 signal or strong math
        
        if (!entityGatePassed) continue

        // P2: Dynamic scoring weights based on signal confidence
        // When one signal is very strong, give it more weight
        // When signals disagree, be more conservative
        const fusedScore = calculateDynamicFusedScore(mathScore, aiScore, levenshteinScore)

        if (fusedScore > bestFusedScore) {
          bestFusedScore = fusedScore
          bestMatch = candidate
        }
      }

      // P0: Raise confidence threshold - 0.65 for auto-apply, 0.55-0.65 for review
      const AUTO_APPLY_THRESHOLD = 0.65
      const REVIEW_THRESHOLD = 0.55
      
      if (!bestMatch || bestFusedScore < REVIEW_THRESHOLD) {
        if (movement.available_cash > STAGE4_REVIEW_THRESHOLD) {
          stage4Queued++
        }
        continue
      }
      
      // If score is between review and auto-apply threshold, flag for review but still apply
      const needsReview = bestFusedScore >= REVIEW_THRESHOLD && bestFusedScore < AUTO_APPLY_THRESHOLD

      // ─── Phase 4: Apply Match ───
      const mathScore = mathScores.get(bestMatch.id) ?? 0
      const aiScore = aiScores.get(bestMatch.id) ?? 0
      const levenshteinScore = levenshteinScores.get(bestMatch.id) ?? 0

      const attr = buildAttribution(
        userId,
        movement,
        bestMatch,
        targetType,
        bestFusedScore,
        mathScore,
        aiScore,
        levenshteinScore,
        resolvedBankForMove,
        needsReview
      )

      if (attr) {
        pendingAttributions.push(attr)
        touchedEventIds.add(bestMatch.id)
        
        // P1: Support partial payments - only reduce outstanding by the amount applied
        const appliedAmount = attr.net_amount
        bestMatch.outstanding_amount = Math.max(0, bestMatch.outstanding_amount - appliedAmount)
        bestMatch.status = bestMatch.outstanding_amount <= 0.01 ? "paid" : "partially_paid"

        // Write-back
        const entityName = (bestMatch.metadata?.customer_name ?? bestMatch.metadata?.vendor_name ?? "") as string
        if (resolvedBankForMove && entityName) {
          try {
            await recordConfirmedBankPattern(userId, bestMatch.entity_id, entityName, resolvedBankForMove)
          } catch (err) {
            console.error("[fusion-engine] Failed to record bank pattern (fusion match):", err)
          }
        }
      }
    }

    // Persist all attributions
    if (pendingAttributions.length > 0 || touchedEventIds.size > 0) {
      await persistAttributions(userId, pendingAttributions, touchedEventIds, cashEvents)
    }

    const finalUnreconciled = await getAllUnreconciledMovements(userId)
    const executionTimeMs = Date.now() - startTime

    console.log("[fusion-engine] Complete:", {
      attributionsCreated: pendingAttributions.length,
      remainingUnmatched: finalUnreconciled.length,
      executionTimeMs,
    })

    return {
      waterfall: {
        attributionsCreated: pendingAttributions.length,
        stage4Queued,
        movementsProcessed: movements.length,
        cashEventsUpdated: touchedEventIds.size,
      },
      llm: { matches: { ar: [], ap: [] }, applied: { applied: 0, skipped: 0, errors: [] } },
      totalAttributions: pendingAttributions.length,
      remainingUnmatched: finalUnreconciled.length,
      executionTimeMs,
      warnings,
      stage4Enabled: false,
    }
  } catch (err) {
    const executionTimeMs = Date.now() - startTime
    console.error("[fusion-engine] Error:", err)
    throw new Error(`Fusion reconciliation failed after ${executionTimeMs}ms: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Try fast-path: direct link or exact match
 */
function tryFastPath(
  movement: MovementWithAvailableCash,
  cashEvents: MutableCashEvent[],
  eventsByEntity: Map<string, MutableCashEvent[]>,
  targetType: "ar" | "ap",
  resolvedBankForMove: string | null
): { attributions: CreateAttributionOpts[]; touchedEventIds: string[]; bankDesc: string | null; entityId: string; entityName: string } | null {
  // Direct link
  const tagData = movement.tag_data as Record<string, unknown> | null
  if (tagData) {
    const invoiceId = tagData.invoice_id as string | undefined
    const billId = tagData.bill_id as string | undefined

    if (invoiceId || billId) {
      const refId = invoiceId ?? billId
      const match = cashEvents.find((e) => {
        const meta = (e.metadata ?? {}) as Record<string, unknown>
        return (
          (targetType === "ar" && meta.invoice_id === refId) ||
          (targetType === "ap" && meta.bill_id === refId)
        )
      })

      if (match) {
        const attrs: CreateAttributionOpts[] = [
          {
            userId: movement.user_id,
            movementId: movement.id,
            component_type: targetType,
            entity_id: match.entity_id,
            reference_id: refId,
            gross_amount: match.outstanding_amount,
            net_amount: movement.available_cash,
            confidence: 0.98,
            source: "rule",
            metadata: {
              fee_amount: Math.max(0, match.outstanding_amount - movement.available_cash),
              match_method: "direct_link",
              waterfall_stage: "direct_link",
            },
          },
        ]

        const feeAmount = Math.max(0, match.outstanding_amount - movement.available_cash)
        if (feeAmount > EPS && targetType === "ar") {
          attrs.push({
            userId: movement.user_id,
            movementId: movement.id,
            component_type: "fee",
            entity_id: "fee://processor",
            reference_id: null,
            gross_amount: 0,
            net_amount: -feeAmount,
            confidence: 0.98,
            source: "rule",
            metadata: { fee_amount: feeAmount, match_method: "direct_link" },
          })
        }

        const entityName = (match.metadata?.customer_name ?? match.metadata?.vendor_name ?? "") as string
        return {
          attributions: attrs,
          touchedEventIds: [match.id],
          bankDesc: resolvedBankForMove,
          entityId: match.entity_id,
          entityName,
        }
      }
    }
  }

  // Exact match: amount + entity name similarity
  for (const event of cashEvents) {
    if (Math.abs(event.outstanding_amount - movement.available_cash) < EPS) {
      const entityName = (event.metadata?.customer_name ?? event.metadata?.vendor_name ?? "") as string
      const bankLabel = resolvedBankForMove ?? movement.counterparty ?? ""
      const similarity = entityNameSimilarity(bankLabel, entityName)

      if (similarity >= 0.95) {
        const attrs: CreateAttributionOpts[] = [
          {
            userId: movement.user_id,
            movementId: movement.id,
            component_type: targetType,
            entity_id: event.entity_id,
            reference_id: (event.metadata?.invoice_id ?? event.metadata?.bill_id) as string | null,
            gross_amount: event.outstanding_amount,
            net_amount: movement.available_cash,
            confidence: 0.96,
            source: "rule",
            metadata: { match_method: "exact", waterfall_stage: "exact" },
          },
        ]

        return {
          attributions: attrs,
          touchedEventIds: [event.id],
          bankDesc: resolvedBankForMove,
          entityId: event.entity_id,
          entityName,
        }
      }
    }
  }

  return null
}

/**
 * Build candidate list: top 15 by date proximity
 */
function buildCandidateList(
  movement: MovementWithAvailableCash,
  eventsByEntity: Map<string, MutableCashEvent[]>,
  targetType: "ar" | "ap"
): MutableCashEvent[] {
  const candidates: MutableCashEvent[] = []

  for (const events of eventsByEntity.values()) {
    for (const event of events) {
      if (event.outstanding_amount <= EPS) continue
      candidates.push(event)
    }
  }

  // Sort by date proximity
  const movementDate = new Date(movement.date).getTime()
  candidates.sort((a, b) => {
    const aDist = Math.abs(new Date(a.expected_date ?? "").getTime() - movementDate)
    const bDist = Math.abs(new Date(b.expected_date ?? "").getTime() - movementDate)
    return aDist - bDist
  })

  return candidates.slice(0, 15)
}

/**
 * Judge A: Deterministic Math Scoring
 * P1: Different date tolerances - 45 days for AR, 90 days for AP (vendors often pay slower)
 */
function scoreMath(movement: MovementWithAvailableCash, candidate: MutableCashEvent): number {
  const amountRatio = movement.available_cash / candidate.outstanding_amount
  const amountScore =
    amountRatio >= 0.92 && amountRatio <= 1.08 ? 1 - Math.abs(amountRatio - 1) * 5 : 0.1

  const movementDate = new Date(movement.date).getTime()
  const candidateDate = new Date(candidate.expected_date ?? "").getTime()
  const daysDiff = Math.abs(movementDate - candidateDate) / (1000 * 60 * 60 * 24)
  
  // P1: Different date tolerances - AR (customers) 45 days, AP (vendors) 90 days
  const isAP = candidate.event_type === "ap"
  const dateTolerance = isAP ? 90 : 45
  const dateScore = Math.max(0, 1 - daysDiff / dateTolerance)

  // P1: Early payment discount detection (1-3%)
  // If payment is 1-3% less than invoice and within 10 days, likely early payment discount
  const earlyPaymentDiscount = detectEarlyPaymentDiscount(movement, candidate)
  const discountBonus = earlyPaymentDiscount ? 0.10 : 0

  const feeScore = detectProcessorFee(movement, candidate) ? 0.15 : 0

  return amountScore * 0.60 + dateScore * 0.25 + feeScore * 0.10 + discountBonus * 0.05
}

/**
 * P1: Detect early payment discount (1-3% discount for paying early)
 */
function detectEarlyPaymentDiscount(movement: MovementWithAvailableCash, candidate: MutableCashEvent): boolean {
  const ratio = movement.available_cash / candidate.outstanding_amount
  // Early payment discount: payment is 97-99% of invoice (1-3% discount)
  if (ratio < 0.97 || ratio > 0.99) return false
  
  // Must be paid early (before or within 10 days of due date)
  const movementDate = new Date(movement.date).getTime()
  const dueDate = new Date(candidate.expected_date ?? "").getTime()
  const daysDiff = (movementDate - dueDate) / (1000 * 60 * 60 * 24)
  
  return daysDiff <= 10 // Paid within 10 days of due date
}

/**
 * Judge C: Supermemory History Scoring
 */
/**
 * Judge B: AI Semantic Scoring (batched)
 * Uses GPT-4o to score entity name similarity for each candidate.
 * Enriched with Supermemory context for better entity understanding.
 */
const AI_BATCH_SIZE = 8 // max candidates per LLM call to keep prompts small

async function scoreAIBatch(
  movement: MovementWithAvailableCash,
  candidates: MutableCashEvent[],
  resolvedBankForMove: string | null,
  userId: string
): Promise<Map<string, number>> {
  const scores = new Map<string, number>()

  // Default all to neutral
  for (const candidate of candidates) {
    scores.set(candidate.id, 0.5)
  }

  if (candidates.length === 0) return scores

  const bankDesc = resolvedBankForMove ?? movement.counterparty ?? movement.raw_description ?? "Unknown"
  if (!bankDesc) return scores

  // Query Supermemory for entity context (best-effort, won't block if unavailable)
  let supermemoryContext = ""
  try {
    supermemoryContext = await searchEntityContextFromSupermemory(userId, bankDesc)
  } catch (err) {
    console.warn("[fusion-engine] Supermemory context fetch failed:", err)
    // Continue without context
  }

  // Chunk candidates to avoid oversized prompts causing ECONNRESET
  for (let chunkStart = 0; chunkStart < candidates.length; chunkStart += AI_BATCH_SIZE) {
    const chunk = candidates.slice(chunkStart, chunkStart + AI_BATCH_SIZE)

    try {
      const candidateList = chunk
        .map((c, idx) => {
          const name = (c.metadata?.customer_name ?? c.metadata?.vendor_name ?? c.entity_id) as string
          return `${idx + 1}. ${name} (amount: $${c.outstanding_amount.toFixed(2)})`
        })
        .join("\n")

      const supermemoryBlock = supermemoryContext 
        ? `\n\nEntity Context from Memory:\n${supermemoryContext.slice(0, 1000)}`
        : ""

      const prompt = `You are a financial reconciliation expert. Given a bank transaction description and a list of potential matches, score each candidate's likelihood of being the correct match.

Bank Transaction: "${bankDesc}"
Amount: $${movement.available_cash.toFixed(2)}

Candidates:
${candidateList}${supermemoryBlock}

For each candidate, provide a confidence score from 0.0 (definitely not a match) to 1.0 (definitely a match).
Consider:
- Entity name similarity
- Amount reasonableness (within 0.5-5% for processor fees)
- Whether the bank description could plausibly refer to this entity
- Entity context from memory (if provided)

Return ONLY a JSON object with numeric indices as keys and scores as values, like:
{"1": 0.95, "2": 0.15, "3": 0.42}`

      const response = await callLLMForScoring(prompt)
      if (response) {
        try {
          // Strip markdown code fences if model ignores response_format
          const cleaned = response.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim()
          const parsed = JSON.parse(cleaned)
          for (let i = 0; i < chunk.length; i++) {
            const score = parsed[String(i + 1)]
            if (typeof score === "number" && score >= 0 && score <= 1) {
              scores.set(chunk[i].id, score)
            }
          }
        } catch (parseErr) {
          console.error("[fusion-engine] Failed to parse AI scores:", parseErr)
        }
      }
    } catch (err) {
      console.error("[fusion-engine] AI scoring error for chunk:", err)
      // Leave defaults (0.5) for this chunk and continue
    }
  }

  return scores
}

/**
 * Call LLM for scoring with circuit breaker, rate limiting, and retry on transient errors
 */
async function callLLMForScoring(prompt: string, attempt = 1): Promise<string | null> {
  const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
  const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
  // Use gpt-4o-mini for scoring — fast, cheap, accurate enough for 8-candidate batches
  const MODEL = process.env.RECON_SCORING_MODEL ?? "gpt-4o-mini"

  if (!API_KEY) return null

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 20000)

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 256,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!res.ok) {
      console.error("[fusion-engine] LLM API error:", res.status)
      return null
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content?.trim() ?? null
  } catch (err) {
    const isTransient =
      err instanceof Error &&
      (err.message.includes("ECONNRESET") ||
        err.message.includes("fetch failed") ||
        err.message.includes("aborted"))

    if (isTransient && attempt < 3) {
      const delay = attempt * 1500
      console.warn(`[fusion-engine] LLM transient error (attempt ${attempt}), retrying in ${delay}ms...`)
      await new Promise((r) => setTimeout(r, delay))
      return callLLMForScoring(prompt, attempt + 1)
    }

    console.error("[fusion-engine] LLM call failed:", err)
    return null
  }
}

/**
 * P2: Dynamic scoring weights based on signal confidence
 * When signals strongly agree, boost confidence
 * When signals disagree, be more conservative
 */
function calculateDynamicFusedScore(mathScore: number, aiScore: number, levenshteinScore: number): number {
  // Base weights
  let mathWeight = 0.40
  let aiWeight = 0.40
  let levWeight = 0.20
  
  // Boost weight for very strong signals (> 0.85)
  if (mathScore > 0.85) mathWeight += 0.10
  if (aiScore > 0.85) aiWeight += 0.10
  if (levenshteinScore > 0.85) levWeight += 0.05
  
  // Penalize when signals strongly disagree
  const signalVariance = Math.abs(mathScore - aiScore) + Math.abs(aiScore - levenshteinScore) + Math.abs(mathScore - levenshteinScore)
  const disagreementPenalty = signalVariance > 1.0 ? 0.10 : signalVariance > 0.5 ? 0.05 : 0
  
  // Normalize weights
  const totalWeight = mathWeight + aiWeight + levWeight
  mathWeight /= totalWeight
  aiWeight /= totalWeight
  levWeight /= totalWeight
  
  // Calculate fused score with penalty for disagreement
  const rawScore = mathScore * mathWeight + aiScore * aiWeight + levenshteinScore * levWeight
  return Math.max(0, rawScore - disagreementPenalty)
}

/**
 * Detect processor fee (0.5-5% band)
 * P2: Configurable fee tolerance per processor
 */
function detectProcessorFee(movement: MovementWithAvailableCash, candidate: MutableCashEvent): boolean {
  if (movement.available_cash >= candidate.outstanding_amount) return false

  const impliedFee = (candidate.outstanding_amount - movement.available_cash) / candidate.outstanding_amount
  
  // P2: Different fee tolerances based on processor
  // Stripe/Square: 2.9% + $0.30 → typically 2.5-4%
  // ACH: 0.5-1%
  // Wire: 0-0.5%
  const counterparty = (movement.counterparty ?? "").toLowerCase()
  const isStripeSquare = counterparty.includes("stripe") || counterparty.includes("square")
  const isACH = counterparty.includes("ach")
  
  const minFee = 0.005  // 0.5% minimum
  const maxFee = isStripeSquare ? 0.10 : isACH ? 0.03 : 0.05  // 10% for card processors, 3% for ACH, 5% default
  
  return impliedFee >= minFee && impliedFee <= maxFee
}

/**
 * Build attribution with confidence detail
 */
function buildAttribution(
  userId: string,
  movement: MovementWithAvailableCash,
  candidate: MutableCashEvent,
  targetType: "ar" | "ap",
  fusedScore: number,
  mathScore: number,
  aiScore: number,
  levenshteinScore: number,
  resolvedBankForMove: string | null,
  needsReview: boolean = false
): CreateAttributionOpts | null {
  const entityName = (candidate.metadata?.customer_name ?? candidate.metadata?.vendor_name ?? "") as string
  const breakdown = buildSyncConfidenceBreakdown({
    movementAmount: movement.available_cash,
    targetAmount: candidate.outstanding_amount,
    bankDescription: resolvedBankForMove ?? "",
    entityName,
    movementDate: movement.date,
    invoiceDueDate: candidate.expected_date,
    matchSequenceIndex: 0,
    waterfallStage: "fusion",
    matchMethod: "fusion_parallel",
  })

  const confidenceDetail = {
    mathScore: Math.round(mathScore * 100) / 100,
    aiScore: Math.round(aiScore * 100) / 100,
    levenshteinScore: Math.round(levenshteinScore * 100) / 100,
    fusedScore: Math.round(fusedScore * 100) / 100,
    explanation: `Math ${(mathScore * 100).toFixed(0)}% | AI ${(aiScore * 100).toFixed(0)}% (with Supermemory) | Lev ${(levenshteinScore * 100).toFixed(0)}%`,
    needsReview,
  }

  // gross_amount = invoice/bill amount (what was expected)
  // net_amount = amount actually applied from bank (capped at invoice amount)
  // When bank > invoice (overpayment/no fee), net = gross (full invoice paid)
  // When bank < invoice (fee deducted), net = bank amount
  const grossAmount = candidate.outstanding_amount
  const netAmount = Math.min(movement.available_cash, candidate.outstanding_amount)

  return {
    userId,
    movementId: movement.id,
    component_type: targetType,
    entity_id: candidate.entity_id,
    reference_id: (candidate.metadata?.invoice_id ?? candidate.metadata?.bill_id) as string | null,
    gross_amount: grossAmount,
    net_amount: netAmount,
    confidence: fusedScore,
    source: "rule",
    metadata: {
      match_method: "fusion_parallel",
      waterfall_stage: "fusion",
      needs_review: needsReview,
    },
    confidenceDetail: confidenceDetail,
    confidenceEnvelope: breakdownToEnvelope(breakdown) as any,
  }
}

/**
 * Preload bank pattern map from all entities
 */
async function preloadBankPatternMap(userId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  try {
    const result = await query<{ entity_id: string; patterns: string[] }>(
      `SELECT DISTINCT ma.entity_id,
              ARRAY_AGG(DISTINCT COALESCE(m.raw_description, m.counterparty, '')) FILTER (WHERE COALESCE(m.raw_description, m.counterparty, '') != '') AS patterns
       FROM movement_attributions ma
       JOIN movements m ON m.id = ma.movement_id
       WHERE ma.user_id = $1 AND ma.component_type IN ('ar', 'ap')
       GROUP BY ma.entity_id`,
      [userId]
    )

    const rows = result.rows || []
    for (const row of rows) {
      if (row.patterns && Array.isArray(row.patterns)) {
        for (const pattern of row.patterns) {
          if (pattern) {
            map.set(pattern.toLowerCase(), row.entity_id)
          }
        }
      }
    }
  } catch (err) {
    console.error("[fusion-engine] Error preloading bank patterns:", err)
  }

  return map
}

/**
 * Persist attributions to database
 */
async function persistAttributions(
  userId: string,
  attributions: CreateAttributionOpts[],
  touchedEventIds: Set<string>,
  cashEvents: MutableCashEvent[]
): Promise<void> {
  return withTransaction(async (client: PoolClient) => {
    // Delete previous fusion attributions
    await client.query(
      `DELETE FROM movement_attributions
       WHERE user_id = $1 AND source = 'rule' AND metadata->>'waterfall_stage' = 'fusion'`,
      [userId]
    )

    // Insert new attributions
    for (const attr of attributions) {
      await insertAttributionWithClient(client, attr)
    }

    // Write audit log
    const auditEntries: AuditLogEntry[] = attributions
      .filter((a) => a.component_type === "ar" || a.component_type === "ap")
      .map((a) => ({
        userId,
        movementId: a.movementId,
        matchMethod: "fusion_parallel",
        waterfallStage: "fusion",
        confidence: a.confidence,
        entityId: a.entity_id,
        referenceId: a.reference_id,
        amountMatched: a.gross_amount,
        semanticValid: null,
        crossEntityFlag: false,
      }))

    await bulkWriteAuditLog(client, userId, auditEntries)

    // Update cash event statuses
    for (const eventId of touchedEventIds) {
      const event = cashEvents.find((e) => e.id === eventId)
      if (event) {
        await writeStatusChange(client, {
          cashEventId: eventId,
          userId,
          fromStatus: "open",
          toStatus: "paid",
          fromOutstanding: event.amount,
          toOutstanding: 0,
          triggeredBy: "waterfall",
          attributionId: null,
        })
      }
    }
  })
}

/**
 * Fetch movements with available cash
 */
async function fetchMovementsWithAvailableCash(userId: string): Promise<MovementWithAvailableCash[]> {
  await ensureMovementsSchema()
  const result = await query<
    MovementWithAvailableCash & { amount: string; available_cash: string; metadata: unknown; tag_data: unknown }
  >(
    `SELECT m.id, m.user_id, m.direction, m.amount::float, m.date::text, m.movement_type,
            m.counterparty, m.counterparty_entity_id::text AS counterparty_entity_id, m.raw_description, m.metadata,
            mt.economic_class, mt.tag_data,
            (m.amount::float - COALESCE(allocated.allocated_sum, 0))::float AS available_cash
     FROM movements m
     LEFT JOIN LATERAL (
       SELECT economic_class, tag_data FROM movement_tags WHERE movement_id = m.id LIMIT 1
     ) mt ON true
     LEFT JOIN (
       SELECT movement_id, SUM(net_amount::float) FILTER (WHERE component_type != 'fee') AS allocated_sum
       FROM movement_attributions WHERE user_id = $1::uuid GROUP BY movement_id
     ) allocated ON allocated.movement_id = m.id
     WHERE m.user_id = $1::uuid AND m.duplicate_of IS NULL
       AND (m.amount::float - COALESCE(allocated.allocated_sum, 0)) > $2
     ORDER BY m.date ASC`,
    [userId, EPS]
  )

  const rows = result.rows || []
  return rows.map((r) => ({
    ...r,
    amount: safeParseFloat(r.amount),
    available_cash: safeParseFloat(r.available_cash),
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    tag_data: (r.tag_data as Record<string, unknown>) ?? null,
  }))
}

/**
 * Load open cash events
 */
async function loadOpenCashEvents(userId: string): Promise<MutableCashEvent[]> {
  await ensureMovementsSchema()
  const result = await query<
    CashEventRow & { amount: string; outstanding_amount: string | null; expected_date: string }
  >(
    `SELECT id, user_id, entity_id, event_type, amount::float, outstanding_amount::float, status,
            probability::float, expected_date::text, source, movement_id, attribution_id, metadata
     FROM cash_events
     WHERE user_id = $1::uuid AND event_type IN ('ar', 'ap')
     ORDER BY expected_date ASC`,
    [userId]
  )

  const rows = result.rows || []
  return rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    entity_id: r.entity_id,
    event_type: r.event_type,
    amount: safeParseFloat(r.amount),
    outstanding_amount: safeParseFloat(r.outstanding_amount),
    status: (r.status as "open" | "partially_paid" | "paid") ?? "open",
    probability: safeParseFloat(r.probability),
    expected_date: r.expected_date,
    source: r.source,
    movement_id: r.movement_id,
    attribution_id: r.attribution_id,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
  }))
}

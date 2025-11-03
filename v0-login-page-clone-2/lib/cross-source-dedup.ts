/**
 * Cross-Source Deduplication
 * 
 * Handles deduplication when the same transaction appears in multiple sources:
 * - Shopify orders vs QBO invoices
 * - Stripe charges vs QBO invoices
 * - Bank deposits vs accounting system receipts
 * 
 * Strategy:
 * 1. Bank movements are the "source of truth" for cash
 * 2. Shopify/Stripe/QBO provide context and metadata
 * 3. When duplicates are detected, we link them rather than double-count
 */

import { query, ensureMovementsSchema } from "./db"
import { log } from "./logger"

type MovementRow = {
  id: string
  direction: string
  amount: number
  date: string
  counterparty: string | null
  provenance: string
  movement_type: string
  metadata: Record<string, unknown>
  duplicate_of: string | null
}

type DuplicateCandidate = {
  sourceMovementId: string
  targetMovementId: string
  confidence: number
  reason: string
}

/**
 * Find potential duplicates between Shopify orders and QBO invoices
 * Matching criteria:
 * - Same amount (within tolerance)
 * - Same date (within 3 days)
 * - Similar customer name (fuzzy match)
 */
export async function findCrossSourceDuplicates(userId: string): Promise<DuplicateCandidate[]> {
  await ensureMovementsSchema()
  
  const candidates: DuplicateCandidate[] = []
  
  // Get all movements by provenance
  const { rows } = await query<MovementRow>(
    `SELECT id, direction, amount::float as amount, date::text, counterparty, 
            provenance, movement_type, metadata, duplicate_of
     FROM movements 
     WHERE user_id = $1 AND duplicate_of IS NULL
     ORDER BY date DESC`,
    [userId]
  )
  
  const shopifyMovements = rows.filter(m => m.provenance === "shopify" && m.direction === "inflow")
  const qboMovements = rows.filter(m => m.provenance === "qbo" && m.direction === "inflow")
  const stripeMovements = rows.filter(m => m.provenance === "stripe" && m.direction === "inflow")
  const plaidMovements = rows.filter(m => m.provenance === "plaid")
  
  // Shopify vs QBO: Same sale recorded in both systems
  for (const shopify of shopifyMovements) {
    for (const qbo of qboMovements) {
      const match = matchMovements(shopify, qbo)
      if (match.isMatch) {
        candidates.push({
          sourceMovementId: shopify.id,
          targetMovementId: qbo.id,
          confidence: match.confidence,
          reason: `Shopify order matches QBO invoice: ${match.reason}`,
        })
      }
    }
  }
  
  // Stripe vs QBO: Same payment recorded in both systems
  for (const stripe of stripeMovements) {
    for (const qbo of qboMovements) {
      const match = matchMovements(stripe, qbo)
      if (match.isMatch) {
        candidates.push({
          sourceMovementId: stripe.id,
          targetMovementId: qbo.id,
          confidence: match.confidence,
          reason: `Stripe charge matches QBO invoice: ${match.reason}`,
        })
      }
    }
  }
  
  // Shopify vs Bank: Order payment deposited to bank
  for (const shopify of shopifyMovements) {
    for (const bank of plaidMovements.filter(m => m.direction === "inflow")) {
      const match = matchMovements(shopify, bank, { dateTolerance: 5 })
      if (match.isMatch) {
        candidates.push({
          sourceMovementId: shopify.id,
          targetMovementId: bank.id,
          confidence: match.confidence,
          reason: `Shopify order matches bank deposit: ${match.reason}`,
        })
      }
    }
  }
  
  return candidates
}

function matchMovements(
  a: MovementRow, 
  b: MovementRow,
  options: { dateTolerance?: number; amountTolerance?: number } = {}
): { isMatch: boolean; confidence: number; reason: string } {
  const dateTolerance = options.dateTolerance ?? 3 // days
  const amountTolerance = options.amountTolerance ?? 0.01 // dollars
  
  // Amount must match (within tolerance)
  const amountDiff = Math.abs(a.amount - b.amount)
  if (amountDiff > amountTolerance) {
    return { isMatch: false, confidence: 0, reason: "Amount mismatch" }
  }
  
  // Date must be within tolerance
  const dateA = new Date(a.date).getTime()
  const dateB = new Date(b.date).getTime()
  const daysDiff = Math.abs(dateA - dateB) / (1000 * 60 * 60 * 24)
  if (daysDiff > dateTolerance) {
    return { isMatch: false, confidence: 0, reason: "Date too far apart" }
  }
  
  // Calculate confidence based on how close the match is
  let confidence = 0.5
  
  // Exact amount match
  if (amountDiff < 0.01) confidence += 0.2
  
  // Same day
  if (daysDiff < 1) confidence += 0.15
  else if (daysDiff < 2) confidence += 0.1
  
  // Customer name similarity
  const nameA = normalizeCounterparty(a.counterparty)
  const nameB = normalizeCounterparty(b.counterparty)
  if (nameA && nameB) {
    if (nameA === nameB) confidence += 0.15
    else if (nameA.includes(nameB) || nameB.includes(nameA)) confidence += 0.1
  }
  
  // Check for linking metadata
  const metaA = a.metadata || {}
  const metaB = b.metadata || {}
  
  // If they reference the same external ID
  if (metaA.order_id && metaA.order_id === metaB.order_id) confidence += 0.2
  if (metaA.invoice_id && metaA.invoice_id === metaB.invoice_id) confidence += 0.2
  if (metaA.customer_email && metaA.customer_email === metaB.customer_email) confidence += 0.1
  
  const isMatch = confidence >= 0.7
  const reason = `Amount: $${a.amount.toFixed(2)}, Date diff: ${daysDiff.toFixed(1)}d, Confidence: ${(confidence * 100).toFixed(0)}%`
  
  return { isMatch, confidence, reason }
}

function normalizeCounterparty(name: string | null): string {
  if (!name) return ""
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").trim()
}

/**
 * Mark a movement as a duplicate of another
 * The source movement will be hidden from financial calculations
 */
export async function markAsDuplicate(
  userId: string,
  sourceMovementId: string,
  targetMovementId: string,
  reason: string
): Promise<void> {
  await ensureMovementsSchema()
  
  // Verify both movements belong to the user
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM movements WHERE user_id = $1 AND id IN ($2, $3)`,
    [userId, sourceMovementId, targetMovementId]
  )
  
  if (rows.length !== 2) {
    throw new Error("One or both movements not found")
  }
  
  // Mark source as duplicate of target
  await query(
    `UPDATE movements 
     SET duplicate_of = $1, 
         metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{duplicate_reason}', $2::jsonb)
     WHERE id = $3 AND user_id = $4`,
    [targetMovementId, JSON.stringify(reason), sourceMovementId, userId]
  )
  
  log("dedup.marked", { userId, sourceMovementId, targetMovementId, reason }, "dedup")
}

/**
 * Unmark a movement as duplicate (restore it)
 */
export async function unmarkDuplicate(userId: string, movementId: string): Promise<void> {
  await ensureMovementsSchema()
  
  await query(
    `UPDATE movements 
     SET duplicate_of = NULL,
         metadata = metadata - 'duplicate_reason'
     WHERE id = $1 AND user_id = $2`,
    [movementId, userId]
  )
  
  log("dedup.unmarked", { userId, movementId }, "dedup")
}

/**
 * Get all duplicate relationships for a user
 */
export async function getDuplicateRelationships(userId: string): Promise<Array<{
  duplicateId: string
  canonicalId: string
  reason: string | null
}>> {
  await ensureMovementsSchema()
  
  const { rows } = await query<{
    id: string
    duplicate_of: string
    metadata: Record<string, unknown>
  }>(
    `SELECT id, duplicate_of, metadata 
     FROM movements 
     WHERE user_id = $1 AND duplicate_of IS NOT NULL`,
    [userId]
  )
  
  return rows.map(r => ({
    duplicateId: r.id,
    canonicalId: r.duplicate_of,
    reason: (r.metadata?.duplicate_reason as string) ?? null,
  }))
}

/**
 * Determine the canonical source priority
 * When the same transaction appears in multiple sources, which one should be the "truth"?
 * 
 * Priority (highest to lowest):
 * 1. Bank (Plaid) - actual cash movement
 * 2. Accounting (QBO/Xero) - official books
 * 3. Payment processor (Stripe) - payment details
 * 4. E-commerce (Shopify) - order details
 */
export function getSourcePriority(provenance: string): number {
  const priorities: Record<string, number> = {
    plaid: 100,
    qbo: 80,
    xero: 80,
    stripe: 60,
    shopify: 40,
    manual: 20,
  }
  return priorities[provenance] ?? 10
}

/**
 * Auto-resolve duplicates based on source priority
 * The lower-priority source becomes the duplicate
 */
export async function autoResolveDuplicates(userId: string): Promise<{
  resolved: number
  candidates: DuplicateCandidate[]
}> {
  const candidates = await findCrossSourceDuplicates(userId)
  let resolved = 0
  
  for (const candidate of candidates) {
    if (candidate.confidence < 0.85) continue // Only auto-resolve high-confidence matches
    
    // Get provenance for both movements
    const { rows } = await query<{ id: string; provenance: string }>(
      `SELECT id, provenance FROM movements WHERE id IN ($1, $2)`,
      [candidate.sourceMovementId, candidate.targetMovementId]
    )
    
    const sourceRow = rows.find(r => r.id === candidate.sourceMovementId)
    const targetRow = rows.find(r => r.id === candidate.targetMovementId)
    
    if (!sourceRow || !targetRow) continue
    
    const sourcePriority = getSourcePriority(sourceRow.provenance)
    const targetPriority = getSourcePriority(targetRow.provenance)
    
    // Mark the lower-priority one as duplicate
    const [duplicateId, canonicalId] = sourcePriority < targetPriority
      ? [candidate.sourceMovementId, candidate.targetMovementId]
      : [candidate.targetMovementId, candidate.sourceMovementId]
    
    await markAsDuplicate(userId, duplicateId, canonicalId, candidate.reason)
    resolved++
  }
  
  return { resolved, candidates }
}

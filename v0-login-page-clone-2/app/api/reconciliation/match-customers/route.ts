import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/require-session'
import { query } from '@/lib/db'
import { matchCustomersWithLLM } from '@/lib/reconciliation-customer-matcher'

// Simple in-memory job tracking (per-user)
const jobStatus = new Map<string, { status: 'processing' | 'complete' | 'failed'; matchCount: number; error?: string }>()

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.id
    
    // Mark as processing
    jobStatus.set(userId, { status: 'processing', matchCount: 0 })

    // Run customer matching directly (non-blocking response)
    runCustomerMatching(userId).catch(err => {
      console.error('[match-customers] Background job failed:', err)
      jobStatus.set(userId, { status: 'failed', matchCount: 0, error: err.message })
    })

    return NextResponse.json({
      status: 'processing',
      message: 'Customer matching started',
    })
  } catch (error) {
    console.error('[match-customers] Error:', error)
    return NextResponse.json(
      { error: 'Failed to start customer matching' },
      { status: 500 }
    )
  }
}

async function runCustomerMatching(userId: string) {
  try {
    // Fetch AR movements
    const movementsResult = await query(
      `SELECT m.id, m.counterparty
       FROM movements m
       LEFT JOIN movement_tags mt ON mt.movement_id = m.id
       WHERE m.user_id = $1
         AND m.direction = 'inflow'
       ORDER BY m.date DESC`,
      [userId]
    )
    const movements = movementsResult.rows

    // Fetch known customers from invoices
    const customersResult = await query(
      `SELECT DISTINCT metadata->>'customer_name' as customer_name
       FROM cash_events
       WHERE user_id = $1
         AND event_type = 'ar'
         AND metadata->>'customer_name' IS NOT NULL
       ORDER BY customer_name`,
      [userId]
    )
    const knownCustomers = customersResult.rows.map((r: { customer_name: string }) => r.customer_name).filter(Boolean)

    console.log(`[match-customers] Processing ${movements.length} movements with ${knownCustomers.length} known customers`)

    if (movements.length === 0 || knownCustomers.length === 0) {
      console.log(`[match-customers] Skipping: no movements or customers`)
      jobStatus.set(userId, { status: 'complete', matchCount: 0 })
      return
    }

    // Run customer matching
    const customerMatches = await matchCustomersWithLLM(
      movements.map((m: { id: string; counterparty: string | null }) => ({ id: m.id, counterparty: m.counterparty })),
      knownCustomers
    )

    // Store results
    let storedCount = 0
    for (const [movementId, matchedCustomer] of customerMatches.entries()) {
      if (matchedCustomer) {
        await query(
          `INSERT INTO movement_customer_matches (user_id, movement_id, matched_customer, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (movement_id) DO UPDATE SET
             matched_customer = $3,
             created_at = NOW()`,
          [userId, movementId, matchedCustomer]
        )
        storedCount++
      }
    }

    console.log(`[match-customers] Complete: stored ${storedCount} customer matches`)
    jobStatus.set(userId, { status: 'complete', matchCount: storedCount })
  } catch (error) {
    console.error('[match-customers] Job failed:', error)
    jobStatus.set(userId, { status: 'failed', matchCount: 0, error: error instanceof Error ? error.message : String(error) })
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.id
    
    // Check in-memory status first
    const status = jobStatus.get(userId)
    
    if (status) {
      // Get total match count from DB
      const { rows: matchRows } = await query(
        `SELECT COUNT(*) as count FROM movement_customer_matches WHERE user_id = $1`,
        [userId]
      )
      const totalMatchCount = parseInt(matchRows[0]?.count || '0')
      
      return NextResponse.json({
        status: status.status,
        matchCount: totalMatchCount,
        error: status.error,
      })
    }

    // No job running, return current match count
    const { rows: matchRows } = await query(
      `SELECT COUNT(*) as count FROM movement_customer_matches WHERE user_id = $1`,
      [userId]
    )
    const matchCount = parseInt(matchRows[0]?.count || '0')

    return NextResponse.json({
      status: 'idle',
      matchCount,
    })
  } catch (error) {
    console.error('[match-customers] Error:', error)
    return NextResponse.json(
      { error: 'Failed to get match status' },
      { status: 500 }
    )
  }
}

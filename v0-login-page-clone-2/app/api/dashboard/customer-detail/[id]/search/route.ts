import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/require-session"
import { query } from "@/lib/db"
import { searchEntityContextFromSupermemory } from "@/lib/supermemory"

interface SearchResult {
  type: "transaction" | "invoice" | "document"
  id: string
  title: string
  snippet: string
  date: string
  amount?: number
  relevanceScore: number
  source?: string
}

interface SearchResponse {
  results: SearchResult[]
  totalCount: number
  searchTime: number
}

function calculateRelevance(text: string, query: string): number {
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const words = lowerQuery.split(/\s+/)

  let score = 0
  for (const word of words) {
    if (lowerText.includes(word)) {
      score += 1
    }
  }

  return Math.min(100, (score / words.length) * 100)
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = session.id
    const entityId = params.id
    const searchQuery = request.nextUrl.searchParams.get("q") || ""
    const startTime = Date.now()

    if (!searchQuery || searchQuery.length < 2) {
      return NextResponse.json({
        results: [],
        totalCount: 0,
        searchTime: 0,
      })
    }

    const results: SearchResult[] = []

    // Search transactions
    const transactionsResult = await query<{
      id: string
      date: string
      amount: number
      description: string | null
    }>(
      `SELECT 
        m.id,
        m.date::text,
        ABS(m.amount)::numeric as amount,
        m.description
       FROM movements m
       WHERE m.counterparty_entity_id = $1::uuid 
         AND m.user_id = $2::uuid
         AND (
           m.description ILIKE $3
           OR m.amount::text ILIKE $3
           OR m.date::text ILIKE $3
         )
       ORDER BY m.date DESC
       LIMIT 10`,
      [entityId, userId, `%${searchQuery}%`]
    )

    for (const t of transactionsResult.rows) {
      const relevance = calculateRelevance(
        `${t.description || ""} ${t.amount}`,
        searchQuery
      )
      results.push({
        type: "transaction",
        id: t.id,
        title: `Transaction - ${t.date}`,
        snippet: `${t.description || "No description"} - $${t.amount.toFixed(2)}`,
        date: t.date,
        amount: t.amount,
        relevanceScore: relevance,
        source: "Transactions",
      })
    }

    // Search invoices (if available)
    try {
      const invoicesResult = await query<{
        id: string
        invoice_number: string
        date: string
        amount: number
        description: string | null
      }>(
        `SELECT 
          id,
          invoice_number,
          date::text,
          amount::numeric,
          description
         FROM qbo_entities
         WHERE entity_id = $1::uuid 
           AND user_id = $2::uuid
           AND entity_type = 'Invoice'
           AND (
             invoice_number ILIKE $3
             OR description ILIKE $3
             OR amount::text ILIKE $3
           )
         LIMIT 10`,
        [entityId, userId, `%${searchQuery}%`]
      )

      for (const inv of invoicesResult.rows) {
        const relevance = calculateRelevance(
          `${inv.invoice_number} ${inv.description || ""} ${inv.amount}`,
          searchQuery
        )
        results.push({
          type: "invoice",
          id: inv.id,
          title: `Invoice ${inv.invoice_number}`,
          snippet: `${inv.description || "No description"} - $${inv.amount.toFixed(2)}`,
          date: inv.date,
          amount: inv.amount,
          relevanceScore: relevance,
          source: "Invoices",
        })
      }
    } catch (err) {
      console.warn("[customer-search] Invoice search failed:", err)
    }

    // Search Supermemory documents
    try {
      const entityResult = await query<{ canonical_name: string }>(
        `SELECT canonical_name FROM entities WHERE id = $1::uuid AND user_id = $2::uuid`,
        [entityId, userId]
      )

      if (entityResult.rows.length > 0) {
        const entityName = entityResult.rows[0].canonical_name
        const smResults = await searchEntityContextFromSupermemory(
          userId,
          `${entityName} ${searchQuery}`
        )

        if (smResults && smResults.length > 0) {
          for (const doc of smResults.slice(0, 5)) {
            results.push({
              type: "document",
              id: doc.id || `doc-${Math.random()}`,
              title: doc.title || "Document",
              snippet: doc.snippet || "",
              date: new Date().toISOString().split("T")[0],
              relevanceScore: doc.relevanceScore || 75,
              source: doc.source || "Supermemory",
            })
          }
        }
      }
    } catch (err) {
      console.warn("[customer-search] Supermemory search failed:", err)
    }

    // Sort by relevance score
    results.sort((a, b) => b.relevanceScore - a.relevanceScore)

    const searchTime = Date.now() - startTime

    return NextResponse.json({
      results: results.slice(0, 20),
      totalCount: results.length,
      searchTime,
    })
  } catch (error) {
    console.error("[customer-search] Error:", error)
    return NextResponse.json(
      { error: "Failed to search" },
      { status: 500 }
    )
  }
}

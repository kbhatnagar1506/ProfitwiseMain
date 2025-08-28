import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getAppBaseUrl } from "@/lib/supermemory"
import { buildFinancialContext, type FinancialContext } from "@/lib/financial-context"
import { ensureAuthSchema, query } from "@/lib/db"
import { addFinalContextToSupermemory } from "@/lib/supermemory"
import { getWhatsAppStatusByUserId } from "@/lib/whatsapp-user"
import { getTwilio, getWhatsAppFrom, getTwilioConfigHint } from "@/lib/twilio"
import { log } from "@/lib/logger"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

async function callOpenAI(
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  temperature = 0.2
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set")
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI error: ${res.status} ${err}`)
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content?.trim()
  return content ?? "Unable to generate."
}

const SYSTEM_MERGE = `You will receive:
1. **Business context** — what the company does, how it operates, who they are, products, org, processes, etc. (from their docs).
2. **Financial context** — cash flow and spending data: major expenses, vendors, inflows, payments (last 90 days).

Your job: Produce a single "Final Context" document that combines business and financial information as **context only**. Do NOT add analysis, interpretation, or recommendations.

- Include: what the company does (from business context); what money came in and went out (amounts, vendor/source names, categories); how expenses and inflows are labeled or categorized. State facts only.
- Do NOT include: what the numbers "mean" or "suggest," implications for scale/stage/operations, opinions, or advice. No "this indicates…," "this implies…," or similar.

OUTPUT FORMAT: Flowing prose only. No markdown headings (#, ##, ###), no bullet or numbered lists. Use paragraphs. Preserve specifics (names, amounts, categories). Do not include sensitive info (EIN, addresses, account numbers).`

async function buildFinalContextForUser(
  userId: string,
  cookieHeader: string
): Promise<{ finalContext: string; companyContext: string; financialContext: FinancialContext }> {
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? getAppBaseUrl()).replace(
    /\/$/,
    ""
  )

  let companyContext = ""
  let financialContext: FinancialContext

  const [companyRes, fc] = await Promise.all([
    fetch(`${base}/api/supermemory/company-context`, {
      headers: { Cookie: cookieHeader },
    }),
    buildFinancialContext(userId),
  ])

  financialContext = fc
  if (companyRes.ok) {
    try {
      const data = (await companyRes.json()) as { context?: string }
      companyContext = data.context ?? ""
    } catch {
      // ignore parse error, treat as no company context
    }
  } else {
    const body = await companyRes.text()
    log(
      "context.build_async.company_context_failed",
      { status: companyRes.status, body: body.slice(0, 200) },
      "system"
    )
  }

  if (!companyContext) {
    const finalContext = financialContext.summary
      ? `No business context found yet. Connect Google Drive, OneDrive, or Notion in the previous step. Financial summary (last 90 days): ${financialContext.summary}`
      : "No company or financial context found yet. Connect your bank accounts and context layer (Drive, OneDrive, Notion) in the previous steps."
    return { finalContext, companyContext: "", financialContext }
  }

  const financialSummary = [
    `Total outflows (90 days): $${financialContext.totalOutflows60Days.toLocaleString("en-US", {
      minimumFractionDigits: 2,
    })}`,
    `Total inflows: $${(financialContext.totalInflows60Days ?? 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
    })}`,
    `Top expenses: ${(financialContext.majorExpenses as {
      vendor: string
      amount: number
      tag?: string
    }[])
      .slice(0, 30)
      .map((e) => `${e.vendor} $${e.amount.toLocaleString()}${e.tag ? ` [${e.tag}]` : ""}`)
      .join("; ")}`,
    `Top money received from: ${((financialContext.majorInflows ?? []) as {
      source: string
      amount: number
      tag?: string
    }[])
      .slice(0, 30)
      .map((e) => `${e.source} $${e.amount.toLocaleString()}${e.tag ? ` [${e.tag}]` : ""}`)
      .join("; ") || "None"}`,
    `Payments out: ${(financialContext.paymentsLast60Days as unknown[]).length}, payments in: ${
      (financialContext.paymentsReceivedLast60Days ?? []).length
    }`,
  ].join(". ")

  const financialNarrative = financialContext.narrative
    ? `\n\nFinancial narrative (pre-generated):\n${financialContext.narrative}\n\n`
    : ""

  const userContent = `Business context:\n\n${companyContext}\n\n---\n\nFinancial context (last 90 days):${financialNarrative}Summary: ${financialSummary}\n\nStructured financial data:\n${JSON.stringify(
    financialContext,
    null,
    2
  )}`

  const finalContext = await callOpenAI(SYSTEM_MERGE, userContent, 16384)
  return { finalContext, companyContext, financialContext }
}

/** POST /api/context/build-and-notify — build final context asynchronously and notify via WhatsApp when done. */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const cookieHeader = req.cookies
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ")

  // Fire-and-forget background task; this request returns immediately.
  void (async () => {
    let buildSucceeded = false
    try {
      const { finalContext } = await buildFinalContextForUser(user.id, cookieHeader)
      if (finalContext && finalContext.trim()) {
        try {
          await ensureAuthSchema()
          await query("UPDATE users SET final_context = $1, updated_at = NOW() WHERE id = $2", [
            finalContext.trim(),
            user.id,
          ])
          log("context.build_async.saved", { userId: user.id }, "db")
          buildSucceeded = true
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          log("context.build_async.save_failed", { userId: user.id, error: msg }, "db")
        }
        if (buildSucceeded) {
          try {
            await addFinalContextToSupermemory(
              finalContext.trim(),
              `final_context_${user.id}`,
              user.id
            )
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            log("context.build_async.supermemory_failed", { userId: user.id, error: msg }, "supermemory")
          }
        }
      } else {
        buildSucceeded = true // we still "finished" (e.g. no docs case)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log("context.build_async.failed", { userId: user.id, error: msg }, "system")
    }

    // Always try to send WhatsApp when the job is done (success or no-context)
    try {
      const { phoneE164, verified } = await getWhatsAppStatusByUserId(user.id)
      if (!phoneE164 || !verified) {
        log(
          "context.build_async.whatsapp_skipped",
          { userId: user.id, hasPhone: !!phoneE164, verified },
          "system"
        )
        return
      }
      const client = getTwilio()
      const from = getWhatsAppFrom()
      if (!client || !from) {
        log(
          "context.build_async.whatsapp_not_configured",
          { userId: user.id, hint: getTwilioConfigHint() },
          "system"
        )
        return
      }
      const toFormatted = phoneE164.startsWith("whatsapp:")
        ? phoneE164
        : `whatsapp:${phoneE164}`
      const body = buildSucceeded
        ? "Your ProfitWise company context is ready. You can review and refine it in the onboarding flow."
        : "ProfitWise context build had an issue. Please try again from the Company & financial context step."
      await client.messages.create({
        from,
        to: toFormatted,
        body,
      })
      log("context.build_async.whatsapp_sent", { userId: user.id, to: phoneE164 }, "system")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log("context.build_async.whatsapp_failed", { userId: user.id, error: msg }, "system")
    }
  })()

  return NextResponse.json({
    ok: true,
    message: "Final context build started. You will receive a WhatsApp message when it is ready.",
  })
}


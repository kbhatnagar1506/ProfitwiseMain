/**
 * Hermetic tests for the LLM tier of reconciliation-entity-validator.ts.
 *
 * The module reads its API key into a module-level const at import time, so
 * each test stubs the environment and then dynamically imports a fresh copy.
 * `fetch` is replaced outright — no test in this file touches the network.
 */

import { vi, beforeEach, afterEach } from "vitest"
import type { CandidateEntity } from "./reconciliation-entity-validator"

const CANDIDATE: CandidateEntity = { entity_id: "e1", display_name: "RTZN Brand Strategy" }
const DESCRIPTOR = "Rtzn Brand Strat Invoices"

/** Load the module with an API key present so the LLM tier is reachable. */
async function importWithLlm() {
  vi.resetModules()
  vi.stubEnv("OPENAI_API_KEY", "test-key")
  vi.stubEnv("FORECAST_LLM_API_KEY", "test-key")
  vi.stubEnv("SUPERMEMORY_API_KEY", "")
  return import("./reconciliation-entity-validator")
}

/** Build an OpenAI chat-completion envelope carrying `matches`. */
function llmResponse(matches: Record<string, boolean>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ matches }) } }] }),
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("LLM acceptance and rejection", () => {
  it("accepts an abbreviation the fast path could not resolve", async () => {
    fetchMock.mockResolvedValue(llmResponse({ e1: true }))
    const { validateEntitiesForBankDescription } = await importWithLlm()

    const r = (await validateEntitiesForBankDescription(DESCRIPTOR, [CANDIDATE])).get("e1")!

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.isValid).toBe(true)
    expect(r.method).toBe("llm_accept")
  })

  it("rejects when the LLM says the entities differ", async () => {
    fetchMock.mockResolvedValue(llmResponse({ e1: false }))
    const { validateEntitiesForBankDescription } = await importWithLlm()

    const r = (await validateEntitiesForBankDescription(DESCRIPTOR, [CANDIDATE])).get("e1")!

    expect(r.isValid).toBe(false)
    expect(r.method).toBe("llm_reject")
    expect(r.reason).toMatch(/LLM rejected/)
  })

  it("sends the bank description and every candidate name in the prompt", async () => {
    fetchMock.mockResolvedValue(llmResponse({ e1: true }))
    const { validateEntitiesForBankDescription } = await importWithLlm()

    await validateEntitiesForBankDescription(DESCRIPTOR, [CANDIDATE])

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const prompt = body.messages[0].content as string
    expect(prompt).toContain(DESCRIPTOR)
    expect(prompt).toContain("RTZN Brand Strategy")
    expect(prompt).toContain("e1")
    expect(body.temperature).toBe(0) // deterministic classification
  })

  it("authenticates with the configured key", async () => {
    fetchMock.mockResolvedValue(llmResponse({ e1: true }))
    const { validateEntitiesForBankDescription } = await importWithLlm()

    await validateEntitiesForBankDescription(DESCRIPTOR, [CANDIDATE])

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer test-key")
  })
})

describe("LLM failure handling falls back to deterministic thresholds", () => {
  const expectDeterministicReject = (r: { isValid: boolean; method: string }) => {
    expect(r.isValid).toBe(false)
    expect(r.method).toBe("deterministic_reject_llm_skipped")
  }

  it("falls back on a non-2xx response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const { validateEntitiesForBankDescription } = await importWithLlm()

    expectDeterministicReject((await validateEntitiesForBankDescription(DESCRIPTOR, [CANDIDATE])).get("e1")!)
  })

  it("falls back on a rate-limit response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    const { validateEntitiesForBankDescription } = await importWithLlm()

    expectDeterministicReject((await validateEntitiesForBankDescription(DESCRIPTOR, [CANDIDATE])).get("e1")!)
  })

  it("falls back when the network call throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"))
    const { validateEntitiesForBankDescription } = await importWithLlm()

    expectDeterministicReject((await validateEntitiesForBankDescription(DESCRIPTOR, [CANDIDATE])).get("e1")!)
  })

  it("falls back when the response body is not valid JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "I think they match!" } }] }),
    })
    const { validateEntitiesForBankDescription } = await importWithLlm()

    expectDeterministicReject((await validateEntitiesForBankDescription(DESCRIPTOR, [CANDIDATE])).get("e1")!)
  })

  it("accepts on the deterministic path when similarity clears 0.70 without an LLM", async () => {
    fetchMock.mockRejectedValue(new Error("offline"))
    const { validateEntitiesForBankDescription } = await importWithLlm()

    // "Bobos Wholesale" vs "Bobos Wholesale Co" scores above the 0.70 fallback bar
    // but below the fast-path accept bar, so it reaches the LLM tier and then
    // falls back to the deterministic rule.
    const r = (
      await validateEntitiesForBankDescription("Bobos Oat Bar Wholesale", [
        { entity_id: "e2", display_name: "Bobos Oat Bars Wholesale" },
      ])
    ).get("e2")!

    expect(r.isValid).toBe(true)
  })
})

describe("KNOWN GAP: candidates omitted by the LLM default to accepted", () => {
  it("accepts an entity the LLM never mentioned", async () => {
    // `parsed.matches?.[id] ?? true` fails OPEN: a well-formed response that
    // simply omits a candidate silently approves that financial match.
    // Pinned deliberately — see REVIEW.md.
    fetchMock.mockResolvedValue(llmResponse({})) // valid JSON, no verdicts
    const { validateEntitiesForBankDescription } = await importWithLlm()

    const r = (await validateEntitiesForBankDescription(DESCRIPTOR, [CANDIDATE])).get("e1")!

    expect(r.isValid).toBe(true)
    expect(r.method).toBe("llm_accept")
  })

  it("accepts the omitted candidate even while rejecting a named one", async () => {
    fetchMock.mockResolvedValue(llmResponse({ e1: false })) // e3 omitted
    const { validateEntitiesForBankDescription } = await importWithLlm()

    const results = await validateEntitiesForBankDescription(DESCRIPTOR, [
      CANDIDATE,
      { entity_id: "e3", display_name: "Completely Different Vendor" },
    ])

    expect(results.get("e1")!.isValid).toBe(false)
    expect(results.get("e3")!.isValid).toBe(true)
  })
})

describe("LLM tier is skipped when the fast path already decided", () => {
  it("does not call the LLM for an exact name match", async () => {
    fetchMock.mockResolvedValue(llmResponse({ e1: true }))
    const { validateEntitiesForBankDescription } = await importWithLlm()

    const r = (
      await validateEntitiesForBankDescription("Sanzo", [{ entity_id: "e1", display_name: "Sanzo" }])
    ).get("e1")!

    expect(r.method).toBe("fast_accept")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not call the LLM for an obviously unrelated short name", async () => {
    fetchMock.mockResolvedValue(llmResponse({ e1: true }))
    const { validateEntitiesForBankDescription } = await importWithLlm()

    const r = (
      await validateEntitiesForBankDescription("Sanzo", [{ entity_id: "e1", display_name: "CocoTaps" }])
    ).get("e1")!

    expect(r.method).toBe("fast_reject")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("COST NOTE: a longer unrelated name still escalates to the LLM", async () => {
    // The fast-reject bar is conservative, so most non-obvious pairs pay for an
    // LLM round-trip. Pinned to make the cost profile visible — see REVIEW.md.
    fetchMock.mockResolvedValue(llmResponse({ e1: false }))
    const { validateEntitiesForBankDescription } = await importWithLlm()

    await validateEntitiesForBankDescription("Sanzo", [
      { entity_id: "e1", display_name: "Completely Unrelated Vendor Inc" },
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

import type { HarnessAdapter } from "./ports.ts"

/**
 * Single source of truth for "what a harness adapter must do". Every frontend
 * (this CLI, the Android app, a web dashboard) is written against this list, so
 * feature parity is: implement this, prove it, and every FE inherits it.
 */
export const HARNESS_ADAPTER_METHODS = [
  "health",
  "createSession",
  "getSession",
  "listSessions",
  "prompt",
  "messages",
  "deleteSession",
  "abort",
  "respondApproval",
  "events",
  "close",
] as const

export function assertAdapterImplements(adapter: unknown): void {
  const missing = HARNESS_ADAPTER_METHODS.filter((m) => {
    const value = (adapter as Record<string, unknown>)[m]
    return typeof value !== "function"
  })
  if (missing.length) {
    throw new Error(
      `[compliance] adapter does not implement required methods: ${missing.join(", ")}`,
    )
  }
}

export interface ComplianceRow {
  method: string
  ok: boolean | "manual"
  note: string
}

/**
 * Live feature-parity matrix. Runs each port method against a real harness
 * (with a throwaway session it cleans up) and reports ok / manual per method.
 * It hard-fails first if the adapter is missing any required method.
 */
export async function runComplianceSuite(adapter: HarnessAdapter): Promise<ComplianceRow[]> {
  assertAdapterImplements(adapter)

  const rows: ComplianceRow[] = []
  const step = async (method: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
      rows.push({ method, ok: true, note: "" })
    } catch (err) {
      rows.push({ method, ok: false, note: (err as Error).message })
    }
  }

  let sessionId = ""

  await step("health", async () => {
    const h = await adapter.health()
    if (!h.healthy) throw new Error("server reported not healthy")
  })

  await step("createSession", async () => {
    sessionId = (await adapter.createSession("compliance-check")).id
  })

  await step("getSession", async () => {
    const s = await adapter.getSession(sessionId)
    if (!s) throw new Error("created session not found")
  })

  await step("listSessions", async () => {
    const all = await adapter.listSessions()
    if (!all.some((s) => s.id === sessionId)) throw new Error("created session missing from list")
  })

  await step("prompt", async () => {
    const reply = await adapter.prompt(sessionId, "Reply with the single word: ok", { timeoutMs: 90_000 })
    if (!reply.id) throw new Error("no reply message returned")
  })

  await step("messages", async () => {
    const msgs = await adapter.messages(sessionId)
    if (!msgs.length) throw new Error("empty history after reply")
  })

  await step("events", async () => {
    for await (const evt of adapter.events()) {
      if (evt.type === "server.connected") return
      throw new Error(`first /event frame was ${evt.type}`)
    }
    throw new Error("event stream ended without server.connected")
  })

  // Interaction-shaped methods: correct by construction if present; proven live
  // when you exercise tool gating (approval) or an in-flight turn (abort).
  rows.push({ method: "abort", ok: "manual", note: "run via CLI `abort` during a live turn" })
  rows.push({ method: "respondApproval", ok: "manual", note: "requires a real permission request (tool gating)" })

  await step("deleteSession", async () => {
    if (!(await adapter.deleteSession(sessionId))) throw new Error("deleteSession returned false")
  })

  return rows
}
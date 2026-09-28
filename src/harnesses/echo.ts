import type { HarnessAdapter } from "../core/ports.ts"
import type { DomainEvent, Message, SessionSummary } from "../core/types.ts"

/**
 * A harness with no harness behind it: every prompt is answered with its own
 * text, streamed through events() like a real turn. It needs nothing
 * installed, so `JEP_HARNESS=echo` gives a cold clone a working daemon (mock
 * mode, the gateway, the phone apps) and the port a deterministic reference.
 */
export function startEchoAdapter(workspace: string): HarnessAdapter {
  const sessions = new Map<string, SessionSummary>()
  const history = new Map<string, Message[]>()
  const listeners = new Set<(evt: DomainEvent) => void>()
  let seq = 0
  const next = (prefix: string) => `${prefix}${++seq}`
  const emit = (evt: DomainEvent) => {
    for (const l of listeners) l(evt)
  }

  return {
    id: "echo",
    workspace,
    endpoint: "",
    async health() {
      return { healthy: true, version: "echo" }
    },
    async createSession(title?: string) {
      const now = Date.now()
      const s: SessionSummary = { id: next("ses_echo_"), title: title ?? "New conversation", workspace, createdAt: now, updatedAt: now }
      sessions.set(s.id, s)
      history.set(s.id, [])
      return s
    },
    async getSession(id: string) {
      return sessions.get(id) ?? null
    },
    async listSessions() {
      return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    },
    async prompt(sessionID, text, opts) {
      const s = sessions.get(sessionID)
      if (!s) throw new Error(`no session ${sessionID}`)
      const log = history.get(sessionID)!
      const now = Date.now()
      const user: Message = { id: next("msg_"), sessionID, role: "user", time: now, parts: [{ kind: "text", text }] }
      if (opts?.quote) user.parts.unshift({ kind: "quote", text: opts.quote })
      const reply: Message = { id: next("msg_"), sessionID, role: "assistant", time: now, parts: [{ kind: "text", text: `echo: ${text}` }] }
      log.push(user)
      emit({ type: "message.created", sessionID, messageID: reply.id, role: "assistant" })
      emit({ type: "part.delta", sessionID, messageID: reply.id, partID: next("prt_"), text: `echo: ${text}`, partType: "text" })
      log.push(reply)
      s.updatedAt = now
      emit({ type: "session.idle", sessionID })
      return reply
    },
    async messages(sessionID, opts) {
      const log = history.get(sessionID) ?? []
      return opts?.limit ? log.slice(-opts.limit) : [...log]
    },
    async deleteSession(id: string) {
      history.delete(id)
      return sessions.delete(id)
    },
    async abort() {
      return true
    },
    async respondAsk() {
      return false
    },
    async rejectAsk() {
      return false
    },
    async *events(signal?: AbortSignal): AsyncIterable<DomainEvent> {
      const queue: DomainEvent[] = [{ type: "server.connected" }]
      let wake: (() => void) | null = null
      const push = (evt: DomainEvent) => {
        queue.push(evt)
        wake?.()
      }
      const onAbort = () => wake?.()
      listeners.add(push)
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        while (!signal?.aborted) {
          const evt = queue.shift()
          if (evt) {
            yield evt
            continue
          }
          await new Promise<void>((r) => (wake = r))
          wake = null
        }
      } finally {
        listeners.delete(push)
        signal?.removeEventListener("abort", onAbort)
      }
    },
    async close() {
      listeners.clear()
    },
  }
}

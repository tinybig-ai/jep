import assert from "node:assert/strict"
import { startGateway, type GatewayHandle } from "../../src/clients/gateway/index.ts"
import type { HarnessAdapter } from "../../src/core/ports.ts"
import type { DomainEvent, Message, SessionSummary } from "../../src/core/types.ts"
import { TurnAbortedError } from "../../src/core/types.ts"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Fakes shared by the gateway and continuity tests.

// A fake driven adapter: enough of the port for the gateway's surface —
// listings, history, one streamed turn, an ask to answer. No network, no
// harness, so the tests run in milliseconds.
export function fakeAdapter(): HarnessAdapter {
  const session: SessionSummary = { id: "s1", title: "Test", workspace: "/tmp/ws", createdAt: 1, updatedAt: 2 }
  return {
    id: "fake",
    workspace: "/tmp/ws",
    endpoint: "",
    async health() {
      return { healthy: true, version: "0" }
    },
    async createSession() {
      return session
    },
    async getSession(id: string) {
      return id === "s1" ? session : null
    },
    async listSessions() {
      return [session]
    },
async prompt(_sessionID, text) {
      const message: Message = {
        id: "m1",
        sessionID: "s1",
        role: "assistant",
        time: 2,
        parts: [{ kind: "text", text: `echo: ${text}` }],
      }
      return message
    },
    async deleteSession() {
      return true
    },
    async messages() {
      return [{ id: "m0", sessionID: "s1", role: "user", time: 1, parts: [{ kind: "text", text: "hi" }] }]
    },
    async abort() {
      return true
    },
    async respondAsk() {
      return true
    },
    async rejectAsk() {
      return true
    },
    async *events() {
      yield { type: "message.created", sessionID: "s1", messageID: "m1", role: "assistant" } as DomainEvent
      yield { type: "part.delta", sessionID: "s1", messageID: "m1", partID: "p1", text: "hel" } as DomainEvent
    },
    async close() {},
  }
}

export function spawnGateway(): { gw: Promise<GatewayHandle> } {
  const adapter = fakeAdapter()
  return {
    gw: startGateway({
      adapters: () => [{ name: "fake-ws", adapter }],
      dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
      port: 0,
      pairCode: "TESTCODE",
      pairLimit: 100,
    }),
  }
}

export async function pair(base: string, code: string): Promise<string> {
  const res = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
  assert.equal(res.status, 200)
  const { token } = (await res.json()) as { token: string }
  return token
}

// A turn that stays in flight until released or aborted, and an event feed a
// test can push into — enough to exercise the queue, steering and force.
export function stallable(opts: { hold?: (text: string) => boolean } = {}) {
  const releases = new Map<string, () => void>()
  const pendingEvents: DomainEvent[] = []
  let wakeFeed: (() => void) | null = null
  const calls: string[] = []
  const base = fakeAdapter()
  const feed = (e: DomainEvent) => {
    pendingEvents.push(e)
    wakeFeed?.()
    wakeFeed = null
  }
  const hold = opts.hold ?? ((text: string) => text === "first")
  const adapter: HarnessAdapter = {
    ...base,
    async prompt(_id, text, opts) {
      calls.push(text)
      // only the turn that is meant to stay in flight waits; the rest answer at once
      if (hold(text)) {
        await new Promise<void>((resolve, reject) => {
          releases.set(text, resolve)
          opts?.signal?.addEventListener("abort", () => {
            // like opencode: a stop is announced, then the session goes idle
            feed({ type: "turn.aborted", sessionID: "s1" })
            feed({ type: "session.idle", sessionID: "s1" })
            reject(new TurnAbortedError())
          }, { once: true })
        })
      }
      feed({ type: "session.idle", sessionID: "s1" })
      return {
        id: `m-${text}`,
        sessionID: "s1",
        role: "assistant",
        time: 2,
        parts: [{ kind: "text", text: `echo: ${text}` }],
      } as Message
    },
    async *events(signal?: AbortSignal) {
      while (!signal?.aborted) {
        if (pendingEvents.length === 0) {
          await Promise.race([
            new Promise<void>((r) => { wakeFeed = r }),
            new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true })),
          ])
        }
        if (signal?.aborted) return
        while (pendingEvents.length) yield pendingEvents.shift()!
      }
    },
  }
  return {
    adapter,
    calls,
    release: (text: string) => releases.get(text)?.(),
    feed,
  }
}


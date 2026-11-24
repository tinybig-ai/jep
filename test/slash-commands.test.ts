// core — a slash command must reach every harness as the first thing in its
// prompt. The rule lives in the core (contextFor, the turn engine), not in any
// adapter, so these tests use no harness at all.

import test from "node:test"
import assert from "node:assert/strict"
import { contextFor, isSlashCommand } from "../src/core/transcript.ts"
import { TurnEngine, type PendingTurn, type TurnEnv, type TurnResult } from "../src/core/turn-engine.ts"
import { LIVENESS } from "../src/core/liveness.ts"
import { fakeAdapter } from "./support/gateway.ts"
import type { LoopState } from "../src/core/loops.ts"

test("what counts as a slash command", () => {
  for (const t of ["/compact", "/skill:automate go", "/a.b", "/x-y"]) assert.equal(isSlashCommand(t), true, t)
  for (const t of ["/ nothing", "see /etc/hosts", "//", "/", "hello", " /compact"]) assert.equal(isSlashCommand(t), false, t)
})

test("a command gets no header and does not spend it", () => {
  const briefed = new Map<string, number>()
  assert.equal(contextFor("/compact", briefed, "s1"), "")
  assert.equal(briefed.has("s1"), false)
  assert.notEqual(contextFor("hello", briefed, "s1"), "")
  assert.equal(briefed.has("s1"), true)
})

test("ordinary text is unchanged by the rule", () => {
  const briefed = new Map<string, number>()
  const first = contextFor("hello", briefed, "s2")
  assert.notEqual(first, "")
  assert.equal(contextFor("hello again", briefed, "s2"), "")
})

function engineWith(brief?: (id: string) => Promise<boolean>) {
  const order: string[] = []
  const base = fakeAdapter()
  const adapter = {
    ...base,
    ...(brief ? { async brief(id: string) { order.push("brief"); return brief(id) } } : {}),
    async prompt(sessionID: string, text: string) {
      order.push(`prompt:${text}`)
      return { id: "m", sessionID, role: "assistant" as const, time: 1, parts: [{ kind: "text" as const, text: "ok" }] }
    },
  }
  const env: TurnEnv = {
    adapterOf: () => adapter,
    find: async () => adapter,
    settingsOf: () => undefined,
    openAsks: () => 0,
    recordChanged: () => {},
    loopChanged: () => {},
  }
  const engine = new TurnEngine(env, { liveness: { ...LIVENESS, settleMs: 20 }, loops: new Map<string, LoopState>() })
  const run = async (text: string) => {
    let resolve!: (r: TurnResult) => void
    const done = new Promise<TurnResult>((r) => (resolve = r))
    const turn: PendingTurn = { text, filePaths: [], steer: false, resolve }
    engine.submit("s1", turn)
    return done
  }
  return { engine, order, run }
}

test("the engine records the header before a command, and only then", async () => {
  const { engine, order, run } = engineWith(async () => true)
  await run("/compact")
  await run("hello")
  assert.deepEqual(order, ["brief", "prompt:/compact", "prompt:hello"])
  engine.close()
})

test("a harness without brief() still gets the command", async () => {
  const { engine, order, run } = engineWith()
  const r = await run("/compact")
  assert.equal(r.status, 200)
  assert.deepEqual(order, ["prompt:/compact"])
  engine.close()
})

test("a brief() that throws does not stop the command", async () => {
  const { engine, order, run } = engineWith(async () => { throw new Error("boom") })
  const r = await run("/compact")
  assert.equal(r.status, 200)
  assert.deepEqual(order, ["brief", "prompt:/compact"])
  engine.close()
})

// ── claude: whose description is it? ─────────────────────────────────────

import { claudeCommandsFromInit } from "../src/harnesses/claude.ts"

test("a built-in command is not given a skill's description because their names match", () => {
  // /goal is Claude's own command; a Codex skill of the same name sits in a shared skills folder
  const out = claudeCommandsFromInit(
    { commands: ["goal", "compact", "session-vault"], skills: ["session-vault"] },
    new Map([["goal", "Set a goal that Codex will pursue to completion."], ["session-vault", "Capture sessions"]]),
  )
  assert.deepEqual(out.find((c) => c.name === "goal"), { name: "goal", source: "command" })
  assert.deepEqual(out.find((c) => c.name === "compact"), { name: "compact", source: "command" })
  assert.deepEqual(out.find((c) => c.name === "session-vault"), { name: "session-vault", description: "Capture sessions", source: "skill" })
})

test("a skill Claude does not report is not offered at all", () => {
  const out = claudeCommandsFromInit({ commands: ["compact"], skills: [] }, new Map([["subscribe", "Subscribe to a thing"]]))
  assert.deepEqual(out.map((c) => c.name), ["compact"])
})

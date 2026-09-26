import { test } from "node:test"
import assert from "node:assert/strict"
import { judgeTurn, type LivenessConfig } from "../src/core/liveness.ts"

const cfg: LivenessConfig = { turnIdleMs: 100, toolIdleMs: 1000, wildernessMs: 300, idleGraceMs: 5, tickMs: 10 }

test("a quiet turn waiting on tokens stalls at the turn ceiling", () => {
  assert.equal(judgeTurn({ now: 99, lastActivity: 0, waitingOnHuman: false, tools: [], config: cfg }).stalled, false)
  const v = judgeTurn({ now: 100, lastActivity: 0, waitingOnHuman: false, tools: [], config: cfg })
  assert.deepEqual(v, { stalled: true, elapsedMs: 100, ceilingMs: 100 })
})

test("a running tool gets the longer ceiling, and is named", () => {
  const tools = [{ name: "bash" }]
  assert.equal(judgeTurn({ now: 500, lastActivity: 0, waitingOnHuman: false, tools, config: cfg }).stalled, false)
  const v = judgeTurn({ now: 1000, lastActivity: 0, waitingOnHuman: false, tools, config: cfg })
  assert.equal(v.stalled && v.tool, "bash")
})

test("a tool old and perfectly silent is wedged, and given up on early", () => {
  const v = judgeTurn({ now: 300, lastActivity: 0, waitingOnHuman: false, tools: [{ name: "read" }, { name: "bash", startedAt: 0 }], config: cfg })
  assert.ok(v.stalled)
  assert.equal(v.ceilingMs, 300)
  assert.equal(v.tool, "bash")
  assert.equal(v.wedgedMs, 300)
})

test("an old tool that is still talking is not wedged", () => {
  // started long ago, but an event came 50ms ago: the idle clock is what counts
  const v = judgeTurn({ now: 5000, lastActivity: 4950, waitingOnHuman: false, tools: [{ name: "bash", startedAt: 0 }], config: cfg })
  assert.equal(v.stalled, false)
})

test("a turn parked on a question is never stalled", () => {
  assert.equal(judgeTurn({ now: 1e9, lastActivity: 0, waitingOnHuman: true, tools: [], config: cfg }).stalled, false)
})

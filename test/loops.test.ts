// core/loops.ts — the decisions a loop makes between turns. The rules are
// small and worth pinning: a verifier that passes ends it, a failing verifier
// continues while turns remain, and the cap ends it no matter what the model
// says. The marker is how the next session still knows a turn was not typed.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  continuationText,
  evaluateLoop,
  loopMarker,
  readLoopMarker,
  runVerifier,
  type LoopState,
} from "../src/core/loops.ts"
import { transcriptText } from "../src/core/transcript.ts"

const state = (over: Partial<LoopState> = {}): LoopState => ({
  sessionID: "s",
  workspace: "/tmp",
  spec: { goal: "make the tests pass", max: 8 },
  iteration: 1,
  status: "running",
  startedAt: 0,
  updatedAt: 0,
  ...over,
})

test("a loop marker survives the round trip, and only at the start", () => {
  const marker = loopMarker(3, 8)
  assert.deepEqual(readLoopMarker(`${marker}\ncontinue`), { iteration: 3, max: 8 })
  assert.equal(readLoopMarker("hello"), null)
  assert.equal(readLoopMarker(`hi ${marker}`), null)
})

test("a continuation is hidden from every transcript, whole", () => {
  const text = `${loopMarker(2, 5)}\nContinue the loop. This is turn 2 of 5.`
  assert.equal(transcriptText(text), "")
})

test("a passing verifier ends the loop wherever the turn counter is", () => {
  const v = evaluateLoop({
    iteration: 2,
    spec: { goal: "g", max: 8, verify: "npm test" },
    lastText: "still here",
    verify: { ok: true, code: 0, output: "" },
  })
  assert.deepEqual(v, { done: true, reason: "verified" })
})

test("a failing verifier continues until the cap, then is exhausted", () => {
  const spec = { goal: "g", max: 3, verify: "npm test" }
  const verify = { ok: false, code: 1, output: "1 failing" }
  assert.deepEqual(evaluateLoop({ iteration: 1, spec, lastText: "", verify }), { done: false, reason: "continue" })
  assert.deepEqual(evaluateLoop({ iteration: 3, spec, lastText: "", verify }), { done: true, reason: "exhausted" })
})

test("a stop marker in the reply ends it, and its absence does not", () => {
  const spec = { goal: "g", max: 5, until: "LOOP_DONE" }
  assert.deepEqual(evaluateLoop({ iteration: 1, spec, lastText: "all good\nLOOP_DONE" }), { done: true, reason: "marker" })
  assert.deepEqual(evaluateLoop({ iteration: 1, spec, lastText: "not yet" }), { done: false, reason: "continue" })
})

test("an empty reply with no verifier is not done early", () => {
  const spec = { goal: "g", max: 2 }
  assert.deepEqual(evaluateLoop({ iteration: 1, spec, lastText: "" }), { done: false, reason: "continue" })
  assert.deepEqual(evaluateLoop({ iteration: 2, spec, lastText: "" }), { done: true, reason: "exhausted" })
})

test("the next turn carries the goal, the count and the verifier's own words", () => {
  const text = continuationText(state({ iteration: 3 }), { ok: false, code: 1, output: "2 failing: a, b" })
  assert.match(text, /^<!-- jep:loop 3\/8 -->/)
  assert.match(text, /turn 3 of 8/)
  assert.match(text, /Goal: make the tests pass/)
  assert.match(text, /exit 1/)
  assert.match(text, /2 failing: a, b/)
})

test("the verifier runs where it was told and reports exit and output", async () => {
  const ok = await runVerifier("printf 'passed'", "/tmp", 5_000)
  assert.deepEqual(ok, { ok: true, code: 0, output: "passed" })

  const bad = await runVerifier("printf 'nope' >&2; exit 3", "/tmp", 5_000)
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 3)
  assert.match(bad.output, /nope/)

  const color = await runVerifier("printf '\\033[31mred\\033[0m'", "/tmp", 5_000)
  assert.equal(color.output, "red")
})

test("the verifier's output is cut to the tail the next turn can use", async () => {
  const out = await runVerifier("printf 'x%.0s' $(seq 1 3000)", "/tmp", 5_000)
  assert.equal(out.ok, true)
  assert.equal(out.output.startsWith("…"), true)
  assert.equal(out.output.length, 2001)
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { parseJournal, parseSavedWatches, restartWaitMs, toResume, RESTART_CAP_WAIT_MS, RESTART_DEFAULT_WAIT_MS } from "../src/core/restarts.ts"

test("a restart waits ten minutes by default and never more than an hour", () => {
  assert.equal(restartWaitMs({}), RESTART_DEFAULT_WAIT_MS)
  assert.equal(restartWaitMs({ wait_minutes: "x" }), RESTART_DEFAULT_WAIT_MS)
  assert.equal(restartWaitMs({ wait_minutes: 2 }), 120_000)
  assert.equal(restartWaitMs({ wait_minutes: 9999 }), RESTART_CAP_WAIT_MS)
})

test("only turns that were not already a pick-up are picked up", () => {
  const entries = parseJournal(JSON.stringify([{ key: "a", resume: false }, { key: "b", resume: true }, { key: "a" }, { nope: 1 }, "x"]))
  assert.deepEqual(entries.map((e) => e.key), ["a", "b", "a"])
  assert.deepEqual(toResume(entries), ["a"])
  assert.deepEqual(parseJournal("not json"), [])
  assert.deepEqual(parseJournal("{}"), [])
})

test("saved watches read back whole, and a broken row is dropped", () => {
  const good = { key: "s1", startedAt: 5, spec: { check: "test -f x", note: "x", everyMs: 5000, maxMs: 60000 } }
  assert.deepEqual(parseSavedWatches(JSON.stringify([good, { key: "s2", startedAt: 1, spec: { note: "no check" } }, null])), [good])
  assert.deepEqual(parseSavedWatches("oops"), [])
})

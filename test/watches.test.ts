import test from "node:test"
import assert from "node:assert/strict"
import { lookAtWatch, parseWatch, watchText, WATCH_DEFAULT_EVERY_MS, WATCH_MIN_EVERY_MS } from "../src/core/watches.ts"

test("a watch request without a check is refused", () => {
  assert.equal(parseWatch({}), null)
  assert.equal(parseWatch({ check: "   " }), null)
})

test("a check that is really a flag is refused, not shelled out", () => {
  // `jep-watch --help` and `jep-watch --list` used to become checks named
  // "--help"/"--list"; `sh -c --help` then exited non-zero for an hour while the
  // operator waited on a watch that could never pass.
  assert.equal(parseWatch({ check: "--help" }), null)
  assert.equal(parseWatch({ check: "--list" }), null)
  assert.equal(parseWatch({ check: "-v" }), null)
  assert.ok(parseWatch({ check: "python3 bin/vault.py check bugcrowd --quiet" }))
})

test("the note falls back to the check and the timings are clamped", () => {
  const w = parseWatch({ check: "test -f /tmp/x", every_seconds: 1, max_minutes: 5 })!
  assert.equal(w.note, "test -f /tmp/x")
  assert.equal(w.everyMs, WATCH_MIN_EVERY_MS)
  assert.equal(w.maxMs, 5 * 60_000)
  assert.equal(parseWatch({ check: "true" })!.everyMs, WATCH_DEFAULT_EVERY_MS)
})

test("the check runs in the workspace and its exit code is the verdict", async () => {
  const spec = parseWatch({ check: "echo hi; exit 0" })!
  assert.equal((await lookAtWatch(spec, "/tmp")).ok, true)
  assert.equal((await lookAtWatch({ ...spec, check: "exit 3" }, "/tmp")).code, 3)
})

test("the new turn names the thing and carries the output", () => {
  const spec = parseWatch({ check: "true", note: "the VAE test" })!
  const done = watchText(spec, { kind: "done", verify: { ok: true, code: 0, output: "all good" } })
  assert.ok(done.includes("the VAE test") && done.includes("all good"))
  assert.ok(watchText(spec, { kind: "timeout" }).includes("not finished"))
})

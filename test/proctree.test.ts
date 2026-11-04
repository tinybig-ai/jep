import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { descendants, killStuckTools, parseElapsed } from "../src/core/proctree.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("ps elapsed times read as seconds", () => {
  assert.equal(parseElapsed("45"), 45)
  assert.equal(parseElapsed("03:21"), 201)
  assert.equal(parseElapsed("2:10:05"), 7805)
  assert.equal(parseElapsed("1-02:10:05"), 86_400 + 7805)
})

test("a stuck tool is killed and a helper the harness started earlier is left alone", { timeout: 20_000 }, async () => {
  // the "harness": a shell that starts a long-lived helper now, and a tool a few seconds later
  const harness = spawn("sh", ["-c", "sleep 600 & sleep 3; sleep 600 & wait"], { stdio: "ignore" })
  try {
    await sleep(4_500)
    const kids = descendants(harness.pid!).filter((p) => p.pid !== harness.pid)
    const sleeps = kids.sort((a, b) => b.ageS - a.ageS)
    assert.equal(sleeps.length, 2, "helper and tool are both under the harness")
    const [helper, tool] = sleeps as [typeof kids[0], typeof kids[0]]
    assert.ok(helper.ageS > tool.ageS)
    // silent for about two seconds: only what started since then is the stuck tool
    assert.equal(killStuckTools(harness, 2_500, 0), true)
    await sleep(300)
    assert.ok(!alive(tool.pid), "the tool is gone")
    assert.ok(alive(helper.pid), "the helper is not")
    assert.ok(alive(harness.pid!), "and neither is the harness")
    assert.equal(killStuckTools(harness, 2_500, 0), false, "nothing young is left to kill")
  } finally {
    for (const p of descendants(harness.pid!)) try { process.kill(p.pid, "SIGKILL") } catch {}
    harness.kill("SIGKILL")
  }
})

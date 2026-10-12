// app/lock.ts — one daemon per data home. The cases that matter are a live
// owner (refuse), a dead owner (take over), and a release that must not
// delete a lock some newer daemon already holds.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireDaemonLock, isJepDaemon, LOCK_FILE } from "../src/app/lock.ts"

function withHome(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "jep-lock-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("an empty data home is claimed and released", () =>
  withHome((dir) => {
    const lock = acquireDaemonLock(dir, () => false)
    assert.ok(lock.ok)
    assert.equal(readFileSync(join(dir, LOCK_FILE), "utf8").trim(), String(process.pid))
    lock.release()
    assert.equal(existsSync(join(dir, LOCK_FILE)), false)
  }))

test("a live daemon keeps its data home", () =>
  withHome((dir) => {
    writeFileSync(join(dir, LOCK_FILE), "424242\n")
    const lock = acquireDaemonLock(dir, (pid) => pid === 424242)
    assert.deepEqual(lock, { ok: false, holder: 424242 })
    assert.equal(readFileSync(join(dir, LOCK_FILE), "utf8").trim(), "424242")
  }))

test("a lock left by a dead daemon, or garbage, is taken over", () =>
  withHome((dir) => {
    for (const left of ["424242\n", "", "not a pid"]) {
      writeFileSync(join(dir, LOCK_FILE), left)
      const lock = acquireDaemonLock(dir, () => false)
      assert.ok(lock.ok, `took over from ${JSON.stringify(left)}`)
      lock.release()
    }
  }))

test("release leaves a lock that another daemon owns", () =>
  withHome((dir) => {
    const lock = acquireDaemonLock(dir, () => false)
    assert.ok(lock.ok)
    writeFileSync(join(dir, LOCK_FILE), "424242\n")
    lock.release()
    assert.equal(readFileSync(join(dir, LOCK_FILE), "utf8").trim(), "424242")
  }))

test("a pid that is alive but not jep does not count as a daemon", () => {
  // this test runner is alive, but it is not app/tg.ts
  assert.equal(isJepDaemon(process.pid), false)
  assert.equal(isJepDaemon(2 ** 22 + 7), false)
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { pickRecycle, quietEnough, type RecycleConfig, type ServerLoad } from "../src/core/recycle.ts"

const cfg: RecycleConfig = { maxMB: 500, minAgeMs: 1000, quietMs: 100, tickMs: 10 }
const big: ServerLoad = { pid: 7, ageMs: 5000, rssMB: 800, busy: false }

test("an old, big, idle server is recycled once every client has been quiet", () => {
  assert.equal(pickRecycle([big], 0, 100, cfg), big)
})

test("not while any client was active within the quiet window", () => {
  assert.equal(quietEnough(0, 99, cfg), false)
  assert.equal(pickRecycle([big], 0, 99, cfg), null)
})

test("not while the harness says a turn runs on it", () => {
  assert.equal(pickRecycle([{ ...big, busy: true }], 0, 100, cfg), null)
})

test("a small server, or a young one, is left alone", () => {
  assert.equal(pickRecycle([{ ...big, rssMB: 499 }], 0, 100, cfg), null)
  // a server that is big from birth must not restart in a loop
  assert.equal(pickRecycle([{ ...big, ageMs: 999 }], 0, 100, cfg), null)
})

test("a limit of 0 turns recycling off", () => {
  const off = { ...cfg, maxMB: 0 }
  assert.equal(quietEnough(0, 10_000, off), false)
  assert.equal(pickRecycle([big], 0, 10_000, off), null)
})

test("the first server over the line is the one picked", () => {
  const small = { ...big, pid: 1, rssMB: 100 }
  assert.equal(pickRecycle([small, big], 0, 100, cfg)?.pid, 7)
})

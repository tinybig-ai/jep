// core/usage.ts — what a conversation has spent. The distinction that matters
// here is "priced at zero" (a free model) versus "not priced at all" (a
// harness that doesn't say): rendering the second as free would be a lie.

import { test } from "node:test"
import assert from "node:assert/strict"
import { addUsage, emptyUsage, fmtMoney, usageChip, usageOf } from "../src/core/usage.ts"
import type { Message } from "../src/core/types.ts"

const assistant = (over: Partial<Message> = {}): Message => ({
  id: "m",
  sessionID: "s",
  role: "assistant",
  time: 0,
  parts: [],
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } },
  ...over,
})

const user = (): Message => ({ id: "u", sessionID: "s", role: "user", time: 0, parts: [] })

test("tokens are summed by kind, and the total includes cache", () => {
  const u = usageOf([assistant(), assistant()])
  assert.equal(u.input, 200)
  assert.equal(u.output, 40)
  assert.equal(u.reasoning, 10)
  assert.equal(u.cacheRead, 20)
  assert.equal(u.cacheWrite, 4)
  assert.equal(u.total, 274)
  assert.equal(u.turns, 2)
})

test("user messages contribute nothing", () => {
  assert.deepEqual(usageOf([user(), user()]), emptyUsage())
})

test("cost is summed only over the turns that reported one", () => {
  const u = usageOf([assistant({ cost: 0.002 }), assistant({ cost: 0.004 }), assistant()])
  assert.equal(Math.round(u.cost * 1000) / 1000, 0.006)
  assert.equal(u.priced, 2)
  assert.equal(u.unpriced, 1, "the third has to be visible as unknown")
})

test("priced at zero is not the same as unpriced", () => {
  const free = usageOf([assistant({ cost: 0 })])
  assert.equal(free.priced, 1)
  assert.equal(usageChip(free), "", "a free model earns no chip on the pin")

  const silent = usageOf([assistant()])
  assert.equal(silent.unpriced, 1)
  assert.equal(usageChip(silent), "$?", "but 'nobody said' must not read as free")
})

test("a failed turn still cost what it cost", () => {
  const u = usageOf([assistant({ cost: 0.01, error: { name: "Err", message: "quota" } })])
  assert.equal(u.turns, 1)
  assert.equal(u.cost, 0.01)
})

test("a turn that reported only a price still counts", () => {
  const u = usageOf([{ ...user(), role: "assistant", cost: 0.5 }])
  assert.equal(u.turns, 1)
  assert.equal(u.cost, 0.5)
  assert.equal(u.total, 0)
})

test("models are listed most recent first, without repeats", () => {
  const u = usageOf([assistant({ model: "a/one" }), assistant({ model: "a/one" }), assistant({ model: "b/two" })])
  assert.deepEqual(u.models, ["b/two", "a/one"])
})

test("usages add up, including their model lists", () => {
  const a = usageOf([assistant({ cost: 1, model: "a/one" })])
  const b = usageOf([assistant({ cost: 2, model: "b/two" })])
  const sum = addUsage(a, b)
  assert.equal(sum.cost, 3)
  assert.equal(sum.turns, 2)
  assert.equal(sum.total, a.total + b.total)
  assert.deepEqual(sum.models.sort(), ["a/one", "b/two"])
})

test("money is shown at the precision the number deserves", () => {
  assert.equal(fmtMoney(0), "$0")
  assert.equal(fmtMoney(0.0004), "$0.0004", "a fraction of a cent rounded to $0.00 is the same as not reporting it")
  assert.equal(fmtMoney(0.42), "$0.42")
  assert.equal(fmtMoney(12.345), "$12.35")
  assert.equal(fmtMoney(1234.5), "$1235")
})

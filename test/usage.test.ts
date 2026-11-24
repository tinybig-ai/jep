// core/usage.ts — what a conversation has spent. The distinction that matters
// here is "priced at zero" (a free model) versus "not priced at all" (a
// harness that doesn't say): rendering the second as free would be a lie.

import { test } from "node:test"
import assert from "node:assert/strict"
import { addUsage, emptyUsage, fmtMoney, statsOf, usageChip, usageOf } from "../src/core/usage.ts"
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

test("stats roll up by day, model and harness, and keep empty days", () => {
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime() // local noon, Fri Nov 6 2026
  const at = (daysAgo: number, hour = 9) => {
    const d = new Date(now)
    d.setDate(d.getDate() - daysAgo)
    d.setHours(hour, 0, 0, 0)
    return d.getTime()
  }
  const stats = statsOf(
    [
      {
        harness: "opencode",
        messages: [
          assistant({ time: at(0), model: "a/one" }),
          assistant({ time: at(1), model: "a/one", cost: 0.5 }),
        ],
      },
      {
        harness: "claude",
        messages: [
          assistant({ time: at(10), model: "b/two" }),
          user(),
        ],
      },
    ],
    { days: 30, now },
  )

  assert.equal(stats.days.length, 30, "the chart gets a full window, empty days included")
  assert.equal(stats.days[29]!.day, "2026-11-06")
  assert.equal(stats.today.total, 137)
  assert.equal(stats.week.total, 274, "today and yesterday, not the turn ten days ago")
  assert.equal(stats.all.total, 411, "every counted turn, however old")
  assert.equal(stats.sessions, 2, "the user-only conversation is not a session with usage")
  assert.equal(stats.scanned, 2)
  assert.deepEqual(stats.models.map((m) => m.key), ["a/one", "b/two"])
  assert.deepEqual(stats.harnesses.map((h) => h.key), ["opencode", "claude"])
  assert.equal(stats.harnesses[0]!.turns, 2)
  assert.equal(stats.busiest?.day, "2026-11-06")
  assert.equal(stats.first, at(10))
  assert.equal(stats.last, at(0))
})

test("stats keep a priced-at-zero turn distinct from an unreported price", () => {
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime()
  const stats = statsOf([{ harness: "goose", messages: [assistant({ cost: 0, model: "free/one" }), assistant()] }], { days: 7, now })
  assert.equal(stats.all.priced, 1)
  assert.equal(stats.all.unpriced, 1)
  assert.equal(stats.all.cost, 0)
  assert.equal(stats.models.find((m) => m.key === "free/one")!.priced, 1)
  assert.equal(stats.models.find((m) => m.key === "unreported")!.unpriced, 1)
})

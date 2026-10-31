import test from "node:test"
import assert from "node:assert/strict"
import { TurnLedger } from "../src/core/ledger.ts"

test("a conversation counts once, however many clients report it", () => {
  const ledger = new TurnLedger()
  const events: string[] = []
  ledger.observe({ started: (k, r) => events.push(`start ${k} ${r}`), ended: (k, c) => events.push(`end ${k} ${c}`) })
  const a = ledger.begin("s1")
  const b = ledger.begin("s1")
  assert.equal(ledger.running(), 1)
  a()
  assert.equal(ledger.running(), 1, "the second client is still running it")
  a() // ending twice is harmless
  b()
  assert.equal(ledger.running(), 0)
  assert.deepEqual(events, ["start s1 false", "end s1 false"])
})

test("a turn that ends once the ledger is closing was cut off", () => {
  const ledger = new TurnLedger()
  const ended: boolean[] = []
  ledger.observe({ ended: (_k, cutOff) => ended.push(cutOff) })
  const done = ledger.begin("s1", true)
  ledger.close()
  done()
  assert.deepEqual(ended, [true])
  assert.equal(ledger.closing(), true)
})

test("a listener that throws does not stop the others", () => {
  const ledger = new TurnLedger()
  const seen: string[] = []
  ledger.observe({ started: () => { throw new Error("boom") } })
  ledger.observe({ started: (k) => seen.push(k) })
  ledger.begin("s1")
  assert.deepEqual(seen, ["s1"])
})

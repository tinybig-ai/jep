// Pi restamps `message.timestamp` on every update. Keying a message id on it
// gave each streamed chunk its own message — and so its own part, which a client
// drew as one block per few words instead of one growing paragraph. Every event
// of one reply must share one id, however many updates carry it.
import test from "node:test"
import assert from "node:assert/strict"
import { messageIdFor } from "../src/harnesses/pi.ts"

const start = (ts: number) => ({ type: "message_start", message: { timestamp: ts } })
const update = (ts: number) => ({ type: "message_update", message: { timestamp: ts }, assistantMessageEvent: { type: "text_delta", delta: "more" } })
const end = (ts: number) => ({ type: "message_end", message: { timestamp: ts } })

test("every update of one reply keeps the id it opened with", () => {
  const first = messageIdFor(start(1000), "s1")
  // three later restamps: the id must not move with them
  assert.equal(messageIdFor(update(1001), "s1"), first)
  assert.equal(messageIdFor(update(1002), "s1"), first)
  assert.equal(messageIdFor(end(1003), "s1"), first)
})

test("the next reply gets an id of its own", () => {
  const first = messageIdFor(start(1000), "s1")
  messageIdFor(update(1001), "s1")
  messageIdFor(end(1002), "s1")
  const second = messageIdFor(start(2000), "s1")
  assert.notEqual(second, first)
  assert.equal(messageIdFor(update(2001), "s1"), second)
})

test("two conversations never share an id", () => {
  assert.notEqual(messageIdFor(start(1000), "s1"), messageIdFor(start(1000), "s2"))
})

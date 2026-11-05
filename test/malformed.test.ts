import test from "node:test"
import assert from "node:assert/strict"
import { malformedToolCall } from "../src/core/malformed.ts"
import { startGateway } from "../src/clients/gateway/index.ts"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "../src/core/types.ts"
import { pair, stallable } from "./support/gateway.ts"

const msg = (parts: Message["parts"]): Message => ({ id: "m", sessionID: "s1", role: "assistant", time: 1, parts })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("a tool call written as text is told apart from a real one and from talk about tags", () => {
  const dots = `<dots_function_call>\n<invoke name="shell">\n<parameter name="command">ls</parameter>\n</invoke>\n</dots_function_call>`
  assert.equal(malformedToolCall(msg([{ kind: "reasoning", text: dots }])), true, "in the thinking")
  assert.equal(malformedToolCall(msg([{ kind: "text", text: `Let me run it:\n<invoke name="bash"><parameter name="command">ls</parameter></invoke>` }])), true, "in the reply")
  assert.equal(malformedToolCall(msg([{ kind: "text", text: `<tool_call>{"name": "shell", "arguments": {}}</tool_call>` }])), true, "the JSON form")
  assert.equal(malformedToolCall(msg([{ kind: "reasoning", text: dots }, { kind: "tool", id: "t", name: "shell", input: {}, output: "x" }])), false, "a real call beside it means it ran")
  assert.equal(malformedToolCall(msg([{ kind: "text", text: "XML like <invoke> is how some models write calls." }])), false, "talk about the tag is not a call")
  assert.equal(malformedToolCall(msg([{ kind: "text", text: "Done. All 15 zones render." }])), false)
  assert.equal(malformedToolCall(undefined), false)
})

const BAD = `<dots_function_call>\n<invoke name="shell">\n<parameter name="command">ls</parameter>\n</invoke>\n</dots_function_call>`

test("a turn that ends on a tool call written as text is asked again, a few times and no more", { timeout: 20_000 }, async () => {
  const a = stallable({ hold: () => false })
  const base = a.adapter.prompt
  const asked: string[] = []
  a.adapter.prompt = async (id, text, opts) => {
    asked.push(text)
    const real = await base.call(a.adapter, id, text, opts)
    // the model keeps writing its call as text, whatever it is told
    return { ...real, parts: [{ kind: "reasoning", text: BAD }] } as Message
  }
  const g = await startGateway({ adapters: () => [{ name: "fake-ws", adapter: { ...a.adapter, workspace: tmpdir() } }], dataHome: mkdtempSync(join(tmpdir(), "mf-")), port: 0, pairCode: "TESTCODE", pairLimit: 100 })
  try {
    const url = `http://127.0.0.1:${g.port}`
    const headers = { authorization: `Bearer ${await pair(url, "TESTCODE")}`, "content-type": "application/json" }
    await fetch(`${url}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "go" }) })
    for (let i = 0; i < 100 && asked.length < 4; i++) await sleep(50)
    await sleep(400)
    assert.equal(asked.length, 4, `the turn plus three corrections, then it is left: ${asked.length}`)
    assert.match(asked[1]!, /wrote a tool call out as text/)
    assert.match(asked[1]!, /jep:notice retry/, "the note is jep's own, drawn as a divider")
  } finally {
    await g.close()
  }
})

test("a good turn after a bad one is left alone", { timeout: 20_000 }, async () => {
  const a = stallable({ hold: () => false })
  const base = a.adapter.prompt
  const asked: string[] = []
  a.adapter.prompt = async (id, text, opts) => {
    asked.push(text)
    const real = await base.call(a.adapter, id, text, opts)
    return asked.length === 1 ? ({ ...real, parts: [{ kind: "reasoning", text: BAD }] } as Message) : real
  }
  const g = await startGateway({ adapters: () => [{ name: "fake-ws", adapter: { ...a.adapter, workspace: tmpdir() } }], dataHome: mkdtempSync(join(tmpdir(), "mf-")), port: 0, pairCode: "TESTCODE", pairLimit: 100 })
  try {
    const url = `http://127.0.0.1:${g.port}`
    const headers = { authorization: `Bearer ${await pair(url, "TESTCODE")}`, "content-type": "application/json" }
    await fetch(`${url}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "go" }) })
    for (let i = 0; i < 100 && asked.length < 2; i++) await sleep(50)
    await sleep(400)
    assert.equal(asked.length, 2, "one correction, and it worked")
  } finally {
    await g.close()
  }
})

test("in a loop the bad turn is retried as the same turn, so it does not use one of the loop's turns up", { timeout: 25_000 }, async () => {
  const a = stallable({ hold: () => false })
  const base = a.adapter.prompt
  const asked: string[] = []
  let iterationWhenRetried = -1
  let gateway: { turns: unknown } | undefined
  a.adapter.prompt = async (id, text, opts) => {
    asked.push(text)
    // what the loop had counted at the moment it asked again
    if (asked.length === 2) iterationWhenRetried = (gateway!.turns as { loopOf(id: string): { iteration: number } | null }).loopOf("s1")?.iteration ?? -1
    const real = await base.call(a.adapter, id, text, opts)
    return asked.length === 1 ? ({ ...real, parts: [{ kind: "reasoning", text: BAD }] } as Message) : real
  }
  const g = await startGateway({ adapters: () => [{ name: "fake-ws", adapter: { ...a.adapter, workspace: tmpdir() } }], dataHome: mkdtempSync(join(tmpdir(), "mf-")), port: 0, pairCode: "TESTCODE", pairLimit: 100 })
  gateway = g
  try {
    const url = `http://127.0.0.1:${g.port}`
    const headers = { authorization: `Bearer ${await pair(url, "TESTCODE")}`, "content-type": "application/json" }
    await fetch(`${url}/loop`, { method: "POST", headers, body: JSON.stringify({ id: "s1", goal: "make it green", max: 3 }) })
    // the retry waits out a short backoff, then asks again with the note
    for (let i = 0; i < 300 && asked.length < 2; i++) await sleep(50)
    assert.ok(asked[1], "the loop asked again")
    assert.match(asked[1]!, /wrote a tool call out as text/)
    assert.equal(iterationWhenRetried, 0, "the bad turn did not count as a finished turn")
    await fetch(`${url}/loop/stop`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
  } finally {
    await g.close()
  }
})

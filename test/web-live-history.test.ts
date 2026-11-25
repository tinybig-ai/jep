import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createContext, runInContext, runInNewContext } from "node:vm"

const source = readFileSync(new URL("../web/live-history.js", import.meta.url), "utf8")
const history = runInNewContext(source + "; JepTranscript")
const text = (id: string, words: string) => ({ id, kind: "text", text: words })
const message = (id: string, parts: object[], time = 1) => ({ id, role: "assistant", parts, time })
const words = (rows: any[]): string[] => Array.from(rows).flatMap((m) => m.parts.filter((p: any) => p.kind === "text").map((p: any) => p.text))
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
const update = (rows: any[], live: Map<string, any>, messageID: string, partID: string, part: object) =>
  history.update(rows, live, { type: "part.updated", messageID, partID, part })

test("a parent message or empty saved part is not proof that streamed text was saved", () => {
  const live = new Map()
  update([], live, "m1", "p1", text("p1", "First complete paragraph."))
  let rows = history.reconcile([], live, [message("m1", [])])
  assert.equal(live.size, 1)
  assert.deepEqual(words(history.withLive(rows, live)), ["First complete paragraph."])
  rows = history.reconcile(rows, live, [message("m1", [text("p1", "")])])
  assert.equal(live.size, 1)
  assert.deepEqual(words(history.withLive(rows, live)), ["First complete paragraph."])
})

test("partial and late snapshots never shrink visible text or restart a delta from empty", () => {
  const live = new Map()
  update([], live, "m1", "p1", text("p1", "First complete paragraph."))
  let rows = history.reconcile([], live, [message("m1", [text("p1", "First")])])
  rows = history.reconcile(rows, live, [message("m1", [text("p1", "First complete paragraph.")])])
  assert.equal(live.size, 0, "only the matching contents retire the live part")
  rows = history.reconcile(rows, live, [message("m1", [text("p1", "First")])])
  assert.deepEqual(words(rows), ["First complete paragraph."])
  history.update(rows, live, { type: "part.delta", messageID: "m1", partID: "p1", text: " More." })
  assert.deepEqual(words(history.withLive(rows, live)), ["First complete paragraph. More."])
  update(rows, live, "m1", "p1", text("p1", ""))
  assert.deepEqual(words(history.withLive(rows, live)), ["First complete paragraph. More."])
})

test("multiple assistant steps retain their message identities and appear exactly once", () => {
  const live = new Map()
  update([], live, "m1", "p1", text("p1", "Step one."))
  let rows = history.reconcile([], live, [message("m1", [])])
  update(rows, live, "m2", "p2", text("p2", "Step two."))
  rows = history.reconcile(rows, live, [message("m1", [text("p1", "Step one.")]), message("m2", [])])
  assert.deepEqual(words(history.withLive(rows, live)), ["Step one.", "Step two."])
  assert.deepEqual(plain(history.withLive(rows, live).map((m: any) => m.id)), ["m1", "m2"])
  rows = history.reconcile(rows, live, [message("m1", [text("p1", "Step one.")]), message("m2", [text("p2", "Step two.")])])
  assert.equal(live.size, 0)
  assert.deepEqual(words(history.withLive(rows, live)), ["Step one.", "Step two."])
  rows = history.reconcile(rows, live, [message("m1", [])])
  assert.deepEqual(words(rows), ["Step one.", "Step two."])
})

test("finished tool output is not replaced by a stale running frame", () => {
  const live = new Map()
  update([], live, "m1", "t1", { id: "t1", kind: "tool", status: "completed", output: "All tests passed" })
  const rows = history.reconcile([], live, [message("m1", [{ id: "t1", kind: "tool", status: "running", output: "All" }])])
  const part = history.withLive(rows, live)[0].parts[0]
  assert.equal(part.status, "completed")
  assert.equal(part.output, "All tests passed")
})

test("equal words in separate identified parts are separate replies", () => {
  const live = new Map()
  update([], live, "m2", "p2", text("p2", "Done."))
  const saved = [message("m1", [text("p1", "Done.")])]
  const rows = history.reconcile([], live, saved)
  assert.equal(live.size, 1)
  assert.deepEqual(words(history.withLive(rows, live)), ["Done.", "Done."])
})

test("print-mode text can hand off to a transcript without event ids", () => {
  const live = new Map()
  update([], live, "event-id", "p1", text("p1", "The final answer."))
  let rows = history.reconcile([], live, [])
  rows = history.reconcile(rows, live, [message("native-id", [{ kind: "text", text: "The final answer." }])])
  assert.equal(live.size, 0)
  assert.deepEqual(words(rows), ["The final answer."])
  assert.equal(rows[0].id, "native-id")
})

test("a saved answer retires independently of an unmatched streamed tool", () => {
  const live = new Map()
  update([], live, "event-thread", "item_0", { kind: "tool", name: "shell", status: "completed", output: "ok" })
  update([], live, "event-thread", "item_1", text("item_1", "The latest release is v0.3.1."))
  let rows = history.reconcile([], live, [])
  const snapshot = [
    message("native-tool", [{ id: "call-id", kind: "tool", name: "exec", status: "completed", output: "ok" }]),
    message("native-answer", [{ kind: "text", text: "The latest release is v0.3.1." }], 2),
  ]
  rows = history.reconcile(rows, live, snapshot)
  assert.deepEqual(words(history.withLive(rows, live)), ["The latest release is v0.3.1."])
  assert.equal(live.size, 1, "unmatched tool does not hold the answer hostage")
  rows = history.reconcile(rows, live, snapshot)
  assert.deepEqual(words(history.withLive(rows, live)), ["The latest release is v0.3.1."])
})

test("a saved print-mode step does not duplicate or hide a later unsaved step", () => {
  const live = new Map()
  update([], live, "event-thread", "item_0", text("item_0", "First step."))
  update([], live, "event-thread", "item_1", text("item_1", "Second step."))
  let rows = history.reconcile([], live, [])
  rows = history.reconcile(rows, live, [message("native-first", [{ kind: "text", text: "First step." }])])
  assert.deepEqual(words(history.withLive(rows, live)).sort(), ["First step.", "Second step."])
  assert.equal(live.size, 1)
  rows = history.reconcile(rows, live, [
    message("native-first", [{ kind: "text", text: "First step." }]),
    message("native-second", [{ kind: "text", text: "Second step." }], 2),
  ])
  assert.deepEqual(words(history.withLive(rows, live)), ["First step.", "Second step."])
  assert.equal(live.size, 0)
})

test("a live part added to an existing history message retires before an id-less saved copy is merged", () => {
  const live = new Map()
  let rows = [message("same-parent", [])]
  update(rows, live, "same-parent", "event-part", text("event-part", "The final answer."))
  rows = history.reconcile(rows, live, [message("same-parent", [])])
  rows = history.reconcile(rows, live, [message("same-parent", [{ kind: "text", text: "The final answer." }])])
  assert.deepEqual(words(history.withLive(rows, live)), ["The final answer."])
  assert.equal(live.size, 0)
})

// Run the page's real refresh and idle handlers as well as its pure helper.
// This guards their wiring: restoring live.clear() would otherwise leave all
// of the helper tests green while bringing the disappearance back.
const page = readFileSync(new URL("../web/index.html", import.meta.url), "utf8")
function pageHarness() {
  const context = createContext({
    current: "s1", messages: [], live: new Map(), liveActive: true, liveRevision: 0,
    sessions: [{ id: "s1", active: true }], sending: new Map(), historyRead: 0,
    pendingText: [], queue: [], asks: [], loop: null, etag: null, hasMore: false,
    catchupTimer: null, catchupTries: 0, PAGE: 60,
    call: async () => ({ messages: [message("m1", [])], asks: [], busy: false }),
    setTimeout: () => 1, clearTimeout: () => {}, render: () => {},
    renderLoop: () => {}, fillScreen: () => {}, loadGit: () => {},
    textOf: () => "", noteTurnError: () => {},
  })
  const refresh = page.slice(page.indexOf("function catchUpHistory(id)"), page.indexOf("// A page counts messages"))
  const settle = page.slice(page.indexOf("function settle(id)"), page.indexOf("function render(follow"))
  const busy = page.match(/^const busy = .*$/m)![0]
  runInContext(source + "\n" + busy + "\n" + refresh + "\n" + settle, context)
  runInContext('JepTranscript.update(messages, live, {type:"part.updated", messageID:"m1", partID:"p1", part:{kind:"text", text:"Completed step."}})', context)
  return context
}

test("the page retains completed text through idle and incomplete history refreshes", async () => {
  const context = pageHarness()
  runInContext('settle("s1")', context)
  assert.equal(context.live.size, 1, "idle ends activity, not visibility")
  assert.equal(context.liveActive, false)
  await runInContext("readHistory()", context)
  assert.deepEqual(words(context.messages), ["Completed step."])
  assert.equal(context.live.size, 1)
  assert.equal(context.liveActive, false)
  assert.equal(context.catchupTries, 1, "a quiet delayed write still gets another read")
  context.call = async () => ({ unchanged: true })
  await runInContext("readHistory()", context)
  assert.equal(context.catchupTries, 2, "unchanged snapshots do not end catch-up prematurely")
  context.call = async () => ({ messages: [message("m1", [text("p1", "Completed step.")])], asks: [], busy: false })
  await runInContext("readHistory()", context)
  assert.equal(context.live.size, 0)
  assert.deepEqual(words(context.messages), ["Completed step."])
})

test("a history request started before idle cannot turn activity back on", async () => {
  const context = pageHarness()
  let resolve!: (value: any) => void
  context.call = () => new Promise<any>((r) => { resolve = r })
  const pending = runInContext("readHistory()", context)
  runInContext('settle("s1")', context)
  resolve({ messages: [message("m1", [])], asks: [], busy: true })
  await pending
  assert.equal(context.liveActive, false)
  assert.equal(context.sessions[0].active, false)
  assert.deepEqual(words(context.messages), ["Completed step."])
})

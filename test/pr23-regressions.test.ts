import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ingressIdentity } from "../src/clients/gateway/ingress.ts"
import { TelegramBot } from "../src/clients/telegram/bot.ts"
import { createTelegramApi, type TelegramApi } from "../src/clients/telegram/api.ts"
import { ChatStore } from "../src/clients/telegram/store.ts"
import { ReminderStore } from "../src/clients/telegram/reminders.ts"
import { sentFrom, withSentFiles } from "../src/core/send.ts"
import { fakeAdapter } from "./support/gateway.ts"
import { TurnAbortedError } from "../src/core/types.ts"
import { startGateway } from "../src/clients/gateway/index.ts"
import { pair } from "./support/gateway.ts"

test("HA identity requires both Supervisor's socket address and the opt-in", () => {
  assert.equal(ingressIdentity(true, "172.30.32.2", "ha-user"), "ha-user")
  assert.equal(ingressIdentity(true, "::ffff:172.30.32.2", "ha-user"), "ha-user")
  for (const peer of ["127.0.0.1", "172.30.33.5", undefined]) assert.equal(ingressIdentity(true, peer, "ha-user"), null)
  assert.equal(ingressIdentity(false, "172.30.32.2", "ha-user"), null)
  assert.equal(ingressIdentity(true, "172.30.32.2", ["ha-user", "forged"]), null)
  assert.equal(ingressIdentity(true, "172.30.32.2", "  "), null)
})

test("Telegram topic creation uses the real Bot API field", async (t) => {
  const bodies: Record<string, unknown>[] = []
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    bodies.push(body)
    return new Response(JSON.stringify({ ok: true, result: { message_thread_id: 901 } }))
  })
  const topic = await createTelegramApi("fake").createForumTopic({ chatID: 42, title: "A topic" })
  assert.deepEqual(topic, { threadID: 901 })
  assert.deepEqual(bodies[0], { chat_id: 42, name: "A topic" })
})

test("deleted topic addresses remain retired across restart and migration", () => {
  const file = join(mkdtempSync(join(tmpdir(), "forum-store-")), "store.json")
  writeFileSync(file, JSON.stringify({ chatContext: { "9000000012": { dir: "/tmp", sessionID: "old" } } }))
  let store = ChatStore.load(file)
  const first = store.allocateForumID()
  assert.ok(first > 9_000_000_012)
  store.rememberForumPeer(first, { chatID: 42, threadID: 901 })
  store.forgetForumPeer(first)
  store = ChatStore.load(file)
  assert.ok(store.allocateForumID() > first)
})

test("file delivery supports Codex, shell and MCP output, with stable shared file parts", () => {
  const output = "sending /tmp/a.pdf (4 bytes)\n"
  assert.deepEqual(sentFrom("command_execution", "jep-send /tmp/a.pdf", output), ["/tmp/a.pdf"])
  assert.deepEqual(sentFrom("exec", { cmd: "jep-send /tmp/a.pdf" }, output), ["/tmp/a.pdf"])
  assert.deepEqual(sentFrom("mcp__jep__jep_send", { paths: ["/tmp/a.pdf"] }, { content: [{ type: "text", text: output }] }), ["/tmp/a.pdf"])
  const tool = { kind: "tool" as const, id: "t1", name: "bash", input: { command: "jep-send /tmp/a.pdf" }, output, status: "completed" as const }
  const live = withSentFiles([tool])[1]!
  const history = withSentFiles([{ kind: "text", text: "hello" }, tool])[2]!
  assert.deepEqual(live, history)
})

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "forum-bot-"))
  const store = ChatStore.load(null)
  const adapter = fakeAdapter()
  const calls: Array<{ method: string; chatID?: number; threadID?: number; draftID?: number }> = []
  const faults = { photo: false }
  let message = 1
  let topic = 903
  const tg = new Proxy({}, { get: (_target, name: string) => async (args: Record<string, unknown>) => {
    calls.push({ method: name, ...args })
    if (name === "sendPhoto" && faults.photo) throw new Error("invalid photo dimensions")
    if (name === "createForumTopic") return { threadID: topic++ }
    return { message_id: message++ }
  } }) as TelegramApi
  const paired = { isPaired: () => true, owner: 42 }
  const ws = { name: "selected", dir: workspace, adapter }
  const bot = () => new TelegramBot(tg, [ws], "selected", paired as never, store, [], workspace, async () => ws, [], ReminderStore.load(null))
  const say = (b: TelegramBot, text: string, threadID: number) => b.handleUpdate({ update_id: 1, message: { message_id: message++, chat: { id: 42, type: "private" }, text, message_thread_id: threadID } })
  return { store, adapter, calls, bot, say, workspace, faults }
}

test("/new and a command in an unfamiliar topic preserve existing history", async () => {
  const r = setup()
  r.store.rememberForumPeer(9_000_000_001, { chatID: 42, threadID: 901 })
  r.store.setChatContext(9_000_000_001, r.workspace, "s1", "fake")
  r.store.setModel(9_000_000_001, "fake", "chosen/model")
  const b = r.bot()
  await r.say(b, "/new", 901)
  await r.say(b, "/help", 999)
  await b.drain()
  assert.equal(r.calls.some((c) => c.method === "deleteForumTopic"), false)
  assert.equal(r.store.chatContext(9_000_000_001)?.sessionID, "s1")
  const fresh = r.store.allForumPeers().find((p) => p.threadID === 903)!
  assert.equal(r.store.model(fresh.syn, "fake"), "chosen/model")
  assert.equal(r.store.chatContext(fresh.syn)?.dir, r.workspace)
})

test("threadless Stop selects its draft when two topics run at once", async () => {
  const r = setup()
  for (const [syn, thread, session] of [[9_000_000_001, 901, "s1"], [9_000_000_002, 902, "s2"]] as const) {
    r.store.rememberForumPeer(syn, { chatID: 42, threadID: thread })
    r.store.setChatContext(syn, r.workspace, session, "fake")
  }
  r.adapter.prompt = (_id, _text, opts) => new Promise((_resolve, reject) => {
    if (opts?.signal?.aborted) { reject(new TurnAbortedError()); return }
    opts?.signal?.addEventListener("abort", () => reject(new TurnAbortedError()), { once: true })
  })
  const aborted: string[] = []
  r.adapter.abort = async (id) => { aborted.push(id); return true }
  const b = r.bot()
  await r.say(b, "first", 901)
  await r.say(b, "second", 902)
  for (let i = 0; i < 100 && r.calls.filter((c) => c.method === "sendRichMessageDraft").length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  const drafts = r.calls.filter((c) => c.method === "sendRichMessageDraft")
  assert.equal(drafts.length, 2)
  assert.notEqual(drafts[0]!.draftID, drafts[1]!.draftID)
  await b.handleUpdate({ update_id: 3, stopped_message_generation: { chat: { id: 42 }, draft_id: drafts[1]!.draftID } })
  await b.handleUpdate({ update_id: 4, stopped_message_generation: { chat: { id: 42 }, draft_id: drafts[0]!.draftID } })
  await b.drain()
  assert.deepEqual(aborted, ["s2", "s1"])
  assert.ok(r.calls.every((c) => c.chatID === undefined || c.chatID === 42), "wire calls never leak synthetic addresses")
})

test("jep-send uploads the file into the topic and falls back from photo to document", async () => {
  const r = setup()
  const file = join(r.workspace, "picture.png")
  writeFileSync(file, "image bytes")
  r.faults.photo = true
  r.store.rememberForumPeer(9_000_000_001, { chatID: 42, threadID: 901 })
  r.store.setChatContext(9_000_000_001, r.workspace, "s1", "fake")
  const tool = { kind: "tool" as const, id: "upload", name: "bash", input: { command: `jep-send ${file}` }, output: `sending ${file} (11 bytes)`, status: "completed" as const }
  r.adapter.events = async function* () {
    yield { type: "part.updated", sessionID: "s1", messageID: "m1", partID: "upload", partType: "tool", part: tool }
  }
  const prompt = r.adapter.prompt.bind(r.adapter)
  r.adapter.prompt = async (id, text, opts) => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    return prompt(id, text, opts)
  }
  const b = r.bot()
  await r.say(b, "send the picture", 901)
  await b.drain()
  const uploads = r.calls.filter((c) => c.method === "sendPhoto" || c.method === "sendDocument")
  assert.deepEqual(uploads.map((c) => c.method), ["sendPhoto", "sendDocument"])
  assert.ok(uploads.every((c) => c.chatID === 42 && c.threadID === 901))
})

test("gateway clients receive sent documents as file parts and can retrieve them", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "jep-send-file-")), "result.pdf")
  writeFileSync(file, "document bytes")
  const adapter = fakeAdapter()
  adapter.messages = async () => [{ id: "m1", sessionID: "s1", role: "assistant", time: 1, parts: [
    { kind: "tool", id: "t1", name: "command_execution", input: `jep-send ${file}`, output: `sending ${file} (14 bytes)`, status: "completed" },
  ] }]
  const g = await startGateway({ adapters: () => [{ name: "ws", adapter }], dataHome: mkdtempSync(join(tmpdir(), "jep-send-gw-")), port: 0, pairCode: "CODE" })
  const base = `http://127.0.0.1:${g.port}`
  try {
    const token = await pair(base, "CODE")
    const headers = { authorization: `Bearer ${token}` }
    const history = await fetch(`${base}/history`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
    const body = await history.json() as { messages: Array<{ parts: Array<{ kind: string; filePath?: string }> }> }
    assert.ok(body.messages[0]!.parts.some((p) => p.kind === "file" && p.filePath === file))
    const result = await fetch(`${base}/file?p=${Buffer.from(file).toString("base64url")}&id=s1`, { headers })
    assert.equal(result.status, 200)
    assert.equal(await result.text(), "document bytes")
  } finally { await g.close() }
})

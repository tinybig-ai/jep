import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTelegramApi } from "../src/clients/telegram/api.ts"
import { TelegramBot } from "../src/clients/telegram/bot.ts"
import { ChatStore } from "../src/clients/telegram/store.ts"
import { ReminderStore } from "../src/clients/telegram/reminders.ts"
import { startEchoAdapter } from "../src/harnesses/echo.ts"
import type { AskRequest } from "../src/core/types.ts"
import { startGateway } from "../src/clients/gateway/index.ts"
import { ConversationDeletions } from "../src/core/conversation-deletions.ts"

test("private Telegram topics keep replies, drafts and permission cards in their topic across restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jep-topic-routing-"))
  const originalFetch = globalThis.fetch
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  let nextMessage = 100
  let nextTopic = 1000
  let failNextPin = false
  let failNextTopicDeletion = false
  let topicsEnabled = true
  // Drive the real Telegram serializer without sending any network requests.
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").at(-1)!
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ method, body })
    if (method === "deleteForumTopic" && failNextTopicDeletion) {
      failNextTopicDeletion = false
      return new Response(JSON.stringify({ ok: false, description: "Telegram temporarily unavailable" }), { status: 400 })
    }
    if (method === "pinChatMessage" && failNextPin) {
      failNextPin = false
      return new Response(JSON.stringify({ ok: false, description: "pin temporarily unavailable" }), { status: 400 })
    }
    const result = method === "createForumTopic"
      ? { message_thread_id: ++nextTopic, name: body.name }
      : method === "getMe" ? { username: "jep_test_bot", has_topics_enabled: topicsEnabled } : { message_id: ++nextMessage }
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } })
  }
  const adapter = startEchoAdapter(dir)
  t.after(async () => {
    globalThis.fetch = originalFetch
    await adapter.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const storePath = join(dir, "store.json")
  ChatStore.load(storePath).setModel(42, "echo", "provider/nested/model")
  const makeBot = () => {
    const store = ChatStore.load(storePath)
    const bot = new TelegramBot(
      createTelegramApi("test-token"),
      [{ name: "ws", dir, adapter }],
      "ws",
      { owner: 42, isPaired: (id: number) => id === 42, count: () => 1 } as never,
      store,
      [],
      dir,
      (async () => { throw new Error("not used") }) as never,
      [],
      ReminderStore.load(join(dir, "reminders.json")),
    )
    return { bot, store }
  }
  let updateID = 0
  const send = async (bot: TelegramBot, topic: number | undefined, text: string) => {
    const start = calls.length
    await bot.handleUpdate({
      update_id: ++updateID,
      message: {
        message_id: updateID,
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Test" },
        text,
        // Private topics may omit is_topic_message entirely.
        ...(topic === undefined ? {} : { message_thread_id: topic }),
      },
    })
    await bot.drain()
    return calls.slice(start)
  }
  const assertReplies = (turn: typeof calls, topic: number, text: string) => {
    const replies = turn.filter((c) => c.method === "sendRichMessage" || c.method === "sendMessage")
    assert.ok(replies.some((c) => JSON.stringify(c.body).includes(text)), "a final reply was delivered")
    const addressed = turn.filter((c) => /^(send|edit|pin|unpin|setMessageReaction)/.test(c.method))
    assert.ok(addressed.some((c) => /Draft$/.test(c.method)), "streaming was delivered too")
    for (const c of addressed) {
      assert.equal(c.body.chat_id, 42, `${c.method} must use the real chat id`)
      assert.equal(c.body.message_thread_id, topic, `${c.method} must stay in its topic`)
    }
  }

  const first = makeBot()
  const a = await send(first.bot, 901, "first topic")
  assertReplies(a, 901, "first topic")
  const b = await send(first.bot, 902, "second topic")
  assertReplies(b, 902, "second topic")
  const sessionIn = (store: ChatStore, topic: number) => {
    const peer = store.allForumPeers().find((p) => p.threadID === topic)!
    return store.chatContext(peer.syn)!.sessionID!
  }
  const sessionA = sessionIn(first.store, 901)
  const sessionB = sessionIn(first.store, 902)
  const peerA = first.store.allForumPeers().find((p) => p.threadID === 901)!

  await t.test("compaction uses the current topic and reports the harness outcome", async () => {
    const unsupported = await send(first.bot, 901, "/compact")
    assert.ok(unsupported.some((c) => String(c.body.text).includes("does not support compaction")))
    const compacted: string[] = []
    const compactModels: unknown[] = []
    adapter.compact = async (id, opts) => { compacted.push(id); compactModels.push(opts?.model); return { ok: true } }
    try {
      const settings = await send(first.bot, 901, "/settings")
      assert.ok(settings.some((c) => JSON.stringify(c.body).includes("set:compact")))
      const result = await send(first.bot, 901, "/compact")
      assert.deepEqual(compacted, [sessionA])
      assert.deepEqual(compactModels, [{ providerID: "provider", modelID: "nested/model" }])
      const completed = result.find((c) => c.method === "editMessageText" && String(c.body.text).includes("Context compacted."))
      assert.equal(completed?.body.chat_id, 42)
      assert.equal(completed?.body.message_thread_id, 901)
      adapter.compact = async () => ({ ok: false, error: "provider unavailable" })
      const start = calls.length
      await first.bot.handleUpdate({
        update_id: ++updateID,
        callback_query: { id: "compact", data: "set:compact", message: { message_id: 200, chat: { id: 42 }, message_thread_id: 901 } },
      })
      await first.bot.drain()
      assert.ok(calls.slice(start).some((c) => String(c.body.text).includes("provider unavailable")))
    } finally {
      delete adapter.compact
    }
  })
  assert.equal(first.store.model(peerA.syn, "echo"), "provider/nested/model", "an adopted topic keeps the selected model")
  first.store.setModel(peerA.syn, "echo", "provider/topic-choice")
  assert.notEqual(sessionA, sessionB, "each topic owns a distinct conversation")
  assertReplies(await send(first.bot, 901, "follow up"), 901, "follow up")
  assert.equal(first.store.model(peerA.syn, "echo"), "provider/topic-choice", "existing topics keep their own model choice")
  assert.equal(sessionIn(first.store, 901), sessionA, "a follow-up reuses that topic's conversation")

  const rebooted = makeBot()
  const resumed = await send(rebooted.bot, 901, "after restart")
  assertReplies(resumed, 901, "after restart")
  assert.equal(sessionIn(rebooted.store, 901), sessionA, "the mapping survives restart")
  const firstDraft = a.find((c) => /Draft$/.test(c.method))!.body.draft_id as number
  const nextDraft = resumed.find((c) => /Draft$/.test(c.method))!.body.draft_id as number
  assert.ok(nextDraft > firstDraft, "draft ids must not repeat after restart")

  const ask: AskRequest = {
    id: "topic-permission",
    sessionID: sessionA,
    title: "Read another conversation?",
    options: [{ id: "allow", label: "Allow once" }, { id: "reject", label: "Deny" }],
    kind: "permission",
  }
  const start = calls.length
  await rebooted.bot.showDaemonAsk(ask, () => true)
  const card = calls.slice(start).find((c) => c.method === "sendMessage")!
  assert.equal(card.body.message_thread_id, 901, "daemon permission cards follow the conversation into its topic")
  await rebooted.bot.closeDaemonAsk(ask.id, "allow")
  assert.equal(calls.at(-1)!.body.message_thread_id, 901, "the resolved card is edited in the same topic")

  const general = await send(rebooted.bot, undefined, "new from All")
  assert.equal(general.filter((c) => c.method === "createForumTopic").length, 1)
  assertReplies(general, 1001, "new from All")

  const createTopic = async (topic: number, name: string) => {
    const start = calls.length
    await rebooted.bot.handleUpdate({
      update_id: ++updateID,
      message: {
        message_id: updateID,
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Test" },
        message_thread_id: topic,
        forum_topic_created: { name },
      },
    })
    return calls.slice(start)
  }
  const beforeCreation = (await adapter.listSessions()).length
  const created = await createTopic(903, "New project")
  const emptySession = sessionIn(rebooted.store, 903)
  assert.equal((await adapter.listSessions()).length, beforeCreation + 1, "an empty topic immediately creates a new Jep chat")
  assert.equal((await adapter.getSession(emptySession))!.title, "New project")
  assert.deepEqual(await adapter.messages(emptySession), [], "topic creation sends no model prompt")
  const initialStatus = created.find((c) => c.method === "sendMessage")!
  const initialPin = created.find((c) => c.method === "pinChatMessage")!
  assert.ok(initialStatus, "context status is sent before the first prompt")
  assert.ok(initialPin, "context status is automatically pinned")
  assert.equal(initialPin.body.message_thread_id, 903)
  const peer = rebooted.store.allForumPeers().find((p) => p.threadID === 903)!
  assert.equal(initialPin.body.message_id, rebooted.store.statusMsg(peer.syn))
  assertReplies(await send(rebooted.bot, 903, "first prompt"), 903, "first prompt")
  assert.equal(sessionIn(rebooted.store, 903), emptySession, "the first prompt reuses the chat created for the topic")
  assert.equal((await adapter.listSessions()).length, beforeCreation + 1)

  failNextPin = true
  await createTopic(904, "Retry pin")
  const retryPeer = rebooted.store.allForumPeers().find((p) => p.threadID === 904)!
  const statusID = rebooted.store.statusMsg(retryPeer.syn)
  const retried = await send(rebooted.bot, 904, "retry status")
  assert.ok(retried.some((c) => c.method === "pinChatMessage" && c.body.message_id === statusID), "a failed pin is retried on the next update")
  assert.equal(rebooted.store.statusMsg(retryPeer.syn), statusID, "retry reuses the existing status message")
  assert.equal(retried.filter((c) => c.method === "sendMessage").length, 0, "retry does not create duplicate status messages")

  const createSession = adapter.createSession.bind(adapter)
  let releaseCreation!: () => void
  let creationStarted!: () => void
  const started = new Promise<void>((resolve) => { creationStarted = resolve })
  const release = new Promise<void>((resolve) => { releaseCreation = resolve })
  adapter.createSession = async (title) => {
    if (title === "Concurrent topic") {
      creationStarted()
      await release
    }
    return createSession(title)
  }
  const beforeRace = (await adapter.listSessions()).length
  const creation = createTopic(905, "Concurrent topic")
  await started
  const firstPrompt = send(rebooted.bot, 905, "arrived during creation")
  await new Promise<void>((resolve) => setImmediate(resolve))
  releaseCreation()
  await Promise.all([creation, firstPrompt])
  assert.equal((await adapter.listSessions()).length, beforeRace + 1, "topic creation racing its first prompt still creates exactly one chat")
  const raceSession = sessionIn(rebooted.store, 905)
  assert.equal((await adapter.getSession(raceSession))!.title, "Concurrent topic")
  assert.ok((await adapter.messages(raceSession)).length > 0, "the first prompt reached that chat")

  const beforeNew = (await adapter.listSessions()).length
  const opened = await send(rebooted.bot, 901, "/new Fresh project")
  const originConfirmation = opened.find((c) => c.method === "sendMessage" && c.body.message_thread_id === 901)!
  assert.match(String(originConfirmation.body.text), /Telegram’s New Topic/)
  assert.equal(originConfirmation.body.reply_markup, undefined, "no broken topic link is offered")
  assert.equal(opened.filter((c) => c.method === "createForumTopic").length, 0)
  assert.equal((await adapter.listSessions()).length, beforeNew, "/new in topic mode does not create an unreachable chat")
  assert.equal(sessionIn(rebooted.store, 901), sessionA, "the old topic keeps its conversation")
  assert.ok((await adapter.messages(sessionA)).length > 0, "the old conversation's history is preserved")
  const fromAll = await send(rebooted.bot, undefined, "/new")
  assert.ok(fromAll.some((c) => c.method === "sendMessage" && String(c.body.text).includes("New Topic")))
  assert.equal(fromAll.filter((c) => c.method === "createForumTopic").length, 0)
  topicsEnabled = false
  const plain = await send(rebooted.bot, undefined, "/new Plain chat")
  assert.equal((await adapter.listSessions()).length, beforeNew + 1, "/new still creates a fresh conversation in plain-chat mode")
  assert.ok(plain.some((c) => c.method === "sendMessage" && String(c.body.text).includes("Plain chat")))
  topicsEnabled = true

  // Exercise the actual route used by web, Android and iOS, after a bot restart.
  const fresh = makeBot()
  const deletionFile = join(dir, "pending-deletions.json")
  const deletions = new ConversationDeletions(deletionFile)
  deletions.onDeleted((id) => fresh.bot.conversationDeleted(id))
  const gateway = await startGateway({
    adapters: () => [{ name: "ws", adapter }], dataHome: dir, port: 0, pairCode: "TESTCODE", deletions,
  })
  t.after(() => gateway.close())
  const base = `http://127.0.0.1:${gateway.port}`
  const paired = await originalFetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ code: "TESTCODE" }) })
  const { token } = await paired.json() as { token: string }
  const remove = (id: string) => originalFetch(`${base}/delete`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ id }),
  })
  const beforeDelete = calls.length
  assert.equal((await remove(sessionA)).status, 200)
  assert.ok(calls.slice(beforeDelete).some((c) => c.method === "deleteForumTopic" && c.body.message_thread_id === 901))
  assert.equal(fresh.store.forumPeer(peerA.syn), null, "web deletion removes the saved Telegram address")
  assert.equal(fresh.store.chatContext(peerA.syn), null, "deleted topic state cannot be restored on restart")
  assert.ok(fresh.store.allForumPeers().some((p) => p.threadID === 902), "other topics remain intact")
  const realDelete = adapter.deleteSession.bind(adapter)
  adapter.deleteSession = async (id) => id === sessionB ? false : realDelete(id)
  const beforeFailedDelete = calls.length
  assert.equal((await remove(sessionB)).status, 404)
  assert.equal(calls.slice(beforeFailedDelete).filter((c) => c.method === "deleteForumTopic").length, 0, "a failed conversation deletion never deletes its topic")

  failNextTopicDeletion = true
  assert.equal((await remove(emptySession)).status, 200)
  assert.deepEqual(JSON.parse(readFileSync(deletionFile, "utf8")), [emptySession], "failed Telegram cleanup is saved for retry")
  assert.ok(fresh.store.allForumPeers().some((p) => p.threadID === 903), "failed cleanup retains the topic mapping")
  const retriedDeletions = new ConversationDeletions(deletionFile)
  retriedDeletions.onDeleted((id) => fresh.bot.conversationDeleted(id))
  await retriedDeletions.retryPending()
  assert.ok(!fresh.store.allForumPeers().some((p) => p.threadID === 903), "restart retries only the confirmed deletion")
  assert.deepEqual(JSON.parse(readFileSync(deletionFile, "utf8")), [])
})

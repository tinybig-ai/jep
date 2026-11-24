import test from "node:test"
import assert from "node:assert/strict"
import { TelegramBot } from "../src/clients/telegram/bot.ts"
import type { AskRequest } from "../src/core/types.ts"

// The bot, with a Telegram that only records what it is asked to send. A card the daemon raises
// itself used to reach web and never Telegram, because only a harness's own event stream was
// wired to the bot's card. These pin that the bot now shows and stands down such a card.

type Sent = { chatID: number; text?: string; replyMarkup?: unknown; messageID?: number }

function botWithRecordingTelegram(opts: { paired?: number[]; owner?: number | null } = {}) {
  const sent: Sent[] = []
  const edited: Sent[] = []
  const calls = new Map<string, unknown[]>()
  // every Telegram method answers; the ones this test reads also record
  const tg = new Proxy(
    {},
    {
      get: (_t, name: string) => async (p: Sent) => {
        calls.set(name, [...(calls.get(name) ?? []), p])
        if (name === "sendMessage") {
          sent.push(p)
          return { message_id: 100 + sent.length }
        }
        if (name === "editMessageText") edited.push(p)
        return {}
      },
    },
  )
  const owner = opts.owner === undefined ? 42 : opts.owner
  const paired = new Set(opts.paired ?? (owner === null ? [] : [owner]))
  const pairing = { owner, isPaired: (id: number) => paired.has(id), count: () => paired.size }
  const store = new Proxy({ allPending: () => [], allForumPeers: () => [] }, { get: (t, name: string) => (name in t ? (t as Record<string, unknown>)[name] : () => undefined) })
  const bot = new TelegramBot(
    tg as never,
    [] as never,
    "ws",
    pairing as never,
    store as never,
    [],
    "/tmp/uploads",
    (async () => {
      throw new Error("not used")
    }) as never,
    [],
    { list: () => [] } as never,
  )
  return { bot, sent, edited }
}

const ask: AskRequest = {
  id: "jep-ask-abc123",
  sessionID: "claude://a",
  title: "Read another conversation?",
  detail: "A wants to read B.",
  options: [
    { id: "allow", label: "Allow once", style: "success" },
    { id: "reject", label: "Deny", style: "danger" },
  ],
  kind: "permission",
}

test("a card the daemon raises is shown in Telegram, with the buttons that answer it", async () => {
  const { bot, sent } = botWithRecordingTelegram()
  await bot.showDaemonAsk(ask, () => true)
  assert.equal(sent.length, 1, "the owner's chat got the card")
  assert.equal(sent[0]!.chatID, 42)
  assert.match(sent[0]!.text ?? "", /Read another conversation\?/)
  const buttons = JSON.stringify(sent[0]!.replyMarkup)
  assert.ok(buttons.includes("ask:jep-ask-abc123#allow"), "a tap on Allow carries this card's id and that option")
  assert.ok(buttons.includes("ask:jep-ask-abc123#reject"))
})

test("a card nobody is paired to see goes nowhere, and says nothing rather than throwing", async () => {
  const { bot, sent } = botWithRecordingTelegram({ paired: [], owner: null })
  await bot.showDaemonAsk(ask, () => true)
  assert.equal(sent.length, 0)
})

test("when another client answers first, the card in Telegram is struck out with the answer", async () => {
  const { bot, sent, edited } = botWithRecordingTelegram()
  await bot.showDaemonAsk(ask, () => true)
  await bot.closeDaemonAsk(ask.id, "allow")
  assert.equal(edited.length, 1)
  assert.equal(edited[0]!.messageID, 101, "the same message that carried the buttons")
  assert.match(edited[0]!.text ?? "", /Allow once.*answered elsewhere/)
  assert.equal(edited[0]!.replyMarkup, null, "its buttons are gone")
  assert.equal(sent.length, 1)
  // it is closed once: a second end finds nothing to edit
  await bot.closeDaemonAsk(ask.id, "allow")
  assert.equal(edited.length, 1)
})

test("a card nobody answered says it was denied for want of an answer", async () => {
  const { bot, edited } = botWithRecordingTelegram()
  await bot.showDaemonAsk(ask, () => true)
  await bot.closeDaemonAsk(ask.id, null)
  assert.match(edited[0]!.text ?? "", /no answer in time/)
})

// ── a card a harness raises, ended on another client ────────────────────────────────────────
// A permission ask raised inside a Telegram turn is cleared by the harness's own `ask.resolved`
// (the person answered on web, or the turn ended). Telegram ignored that event, so the card kept
// offering buttons for something that was over. This drives a real turn through the bot.

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChatStore } from "../src/clients/telegram/store.ts"
import { ReminderStore } from "../src/clients/telegram/reminders.ts"
import { stallable } from "./support/gateway.ts"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function turnInProgress() {
  const harness = stallable({ hold: () => true })
  const sent: Array<{ chatID: number; text?: string; replyMarkup?: unknown; messageID?: number }> = []
  const edited: Array<{ chatID: number; text?: string; messageID?: number; replyMarkup?: unknown }> = []
  let next = 500
  const tg = new Proxy(
    {},
    {
      get: (_t, name: string) => async (p: { chatID: number; text?: string; replyMarkup?: unknown; messageID?: number }) => {
        if (name === "createForumTopic") throw new Error("Threaded mode is off in this fixture")
        if (name === "sendMessage") {
          sent.push(p)
          return { message_id: ++next }
        }
        if (name === "editMessageText") edited.push(p)
        if (name === "getUpdates") return []
        return { message_id: ++next }
      },
    },
  )
  const dir = mkdtempSync(join(tmpdir(), "tg-ws-"))
  const pairing = { owner: 42, isPaired: (id: number) => id === 42, count: () => 1 }
  const bot = new TelegramBot(
    tg as never,
    [{ name: "ws", dir, adapter: harness.adapter }] as never,
    "ws",
    pairing as never,
    ChatStore.load(null),
    [],
    dir,
    (async () => {
      throw new Error("not used")
    }) as never,
    [],
    ReminderStore.load(join(dir, "reminders.json")),
  )
  await bot.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "p" }, text: "do the thing" } } as never)
  await wait(300)
  return { bot, harness, sent, edited }
}

const harnessAsk = {
  id: "perm-1",
  sessionID: "s1",
  title: "Run npm test?",
  detail: "npm test",
  options: [{ id: "once", label: "Allow once" }, { id: "reject", label: "Deny" }],
  kind: "permission" as const,
}

test("a card a harness raised in a Telegram turn is struck out when the ask ends elsewhere", async () => {
  const { harness, sent, edited } = await turnInProgress()
  harness.feed({ type: "ask.requested", sessionID: "s1", ask: harnessAsk })
  await wait(300)
  const card = sent.find((m) => (m.text ?? "").includes("Run npm test"))
  assert.ok(card, "the card was shown in Telegram")
  harness.feed({ type: "ask.resolved", sessionID: "s1", askID: "perm-1" })
  await wait(300)
  const struck = edited.find((m) => m.replyMarkup === null)
  assert.ok(struck, "the card's buttons were taken away when the ask ended")
  assert.match(struck!.text ?? "", /no longer waiting/)
  harness.release(harness.calls[0]!)
})

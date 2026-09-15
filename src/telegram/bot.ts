import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { HarnessAdapter, ModelCaps, ModelRef } from "../core/ports.ts"
import type { FilePart } from "../core/types.ts"
import { mdToHtml } from "./html.ts"
import { mdToRich } from "./rich.ts"
import type { TelegramApi, TgMessage, TgUpdate, InlineButton, ReplyMarkup } from "./api.ts"
import { runComplianceSuite } from "../core/compliance.ts"
import type { Pairing } from "./pair.ts"
import type { ChatStore } from "./store.ts"

interface Ws {
  name: string
  dir: string
  adapter: HarnessAdapter
}

type Awaiting = { kind: "pair" } | { kind: "use" } | { kind: "rename"; sessionID: string }

interface ChatState {
  workspace: string
  sessionID: string | null
  harness: string | null
  inflight: AbortController | null
  // permissionID -> { sessionID, messageID } for in-flight keyboard prompts
  pending: Map<string, { sessionID: string; messageID: number }>
  // snapshot behind the /ls, /del and settings pickers
  picker: { messageID: number; ws: string; sessions: string[] } | null
  del: { messageID: number; i: number } | null
  // an arg-taking command was sent bare; next plain text is the answer
  awaiting: Awaiting | null
  // message ids (own + user's) so /wipe can clear this chat; page = wipe picker page
  msgs: Set<number>
  page: number
  // the message the settings menu tree is currently drawn on
  settingsMsg: number | null
  // the model/rename picker page shown now
  settingsPage: number
  // the model that already got the "switch to a vision model" suggestion
  suggestedImage: string | null
  // last draft_id used for streaming previews (Bot API 9.4+), per chat
  draft: number
}

const MAX_MSG = 4000
const MAX_LIST = 10
const WIPE_PAGE = 4
const WIPE_DELETE_CAP = 30

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const kin = (rows: InlineButton[][]): ReplyMarkup => ({ inline_keyboard: rows })
const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data })

const HELP = [
  "jep — your coding agent, on the go.",
  "",
  "💬 Just type what you want done.",
  "",
  "/new · start fresh",
  "/ls · switch chats",
  "/settings · model & cleanup",
  "",
  "Everything else lives in the ☰ menu.",
].join("\n")

const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg)$/i
const imageExt = (mime?: string): string | null => {
  const m = (mime ?? "").split(";")[0]?.trim()
  const byMime: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
  }
  return byMime[m ?? ""] ?? null
}

export class TelegramBot {
  #tg: TelegramApi
  #workspaces: Ws[]
  #activeWsName: string
  #pairing: Pairing
  #store: ChatStore
  #extraModels: string[]
  #uploadsDir: string
  #chats = new Map<number, ChatState>()

  static commands = [
    { command: "status", description: "what am I connected to" },
    { command: "new", description: "start a fresh conversation" },
    { command: "ls", description: "your conversations" },
    { command: "log", description: "this conversation's history" },
    { command: "del", description: "delete a conversation" },
    { command: "ws", description: "switch workspace" },
    { command: "settings", description: "model · rename · wipe" },
    { command: "wipe", description: "clear this chat's messages" },
    { command: "abort", description: "stop the current turn" },
    { command: "cancel", description: "give up on the current prompt" },
  ]

  constructor(tg: TelegramApi, workspaces: Ws[], activeWsName: string, pairing: Pairing, store: ChatStore, extraModels: string[], uploadsDir: string) {
    this.#tg = this.#recording(tg)
    this.#workspaces = workspaces
    this.#activeWsName = activeWsName
    this.#pairing = pairing
    this.#store = store
    this.#extraModels = extraModels
    this.#uploadsDir = uploadsDir
  }

  // records every bot-sent message id per chat so /wipe can clear them, and
  // renders every outgoing text through markdown → Telegram HTML
  #recording(tg: TelegramApi): TelegramApi {
    const md = (text: string) => mdToHtml(text)
    return {
      getUpdates: (p) => tg.getUpdates(p),
      setMyCommands: (c) => tg.setMyCommands(c),
      sendChatAction: (p) => tg.sendChatAction(p),
      answerCallbackQuery: (p) => tg.answerCallbackQuery(p),
      deleteMessage: (p) => tg.deleteMessage(p),
      sendRichMessage: (p) => tg.sendRichMessage(p),
      sendMessageDraft: (p) => tg.sendMessageDraft(p),
      sendRichMessageDraft: (p) => tg.sendRichMessageDraft(p),
      getFileContent: (f) => tg.getFileContent(f),
      editMessageText: (p) => tg.editMessageText({ ...p, text: md(p.text), parseMode: "HTML" }),
      sendMessage: async (p) => {
        const r = await tg.sendMessage({ ...p, text: md(p.text), parseMode: "HTML" })
        this.#chat(p.chatID).msgs.add(r.message_id)
        return r
      },
      sendPhoto: async (p) => {
        const r = await tg.sendPhoto(p)
        this.#chat(p.chatID).msgs.add(r.message_id)
        return r
      },
      sendDocument: async (p) => {
        const r = await tg.sendDocument(p)
        this.#chat(p.chatID).msgs.add(r.message_id)
        return r
      },
    }
  }

  #ws(name: string): Ws {
    return this.#workspaces.find((w) => w.name === name) ?? this.#workspaces[0]!
  }

  #wsFor(harness: string): Ws | null {
    return this.#workspaces.find((w) => w.adapter.id === harness) ?? null
  }

  #harnesses(): string[] {
    return [...new Set(this.#workspaces.map((w) => w.adapter.id))]
  }

  #chat(id: number): ChatState {
    let c = this.#chats.get(id)
    if (!c) {
      c = {
        workspace: this.#activeWsName,
        sessionID: null,
        harness: null,
        inflight: null,
        pending: new Map(),
        picker: null,
        del: null,
        awaiting: null,
        msgs: new Set(),
        page: 0,
        settingsMsg: null,
        settingsPage: 0,
        suggestedImage: null,
        draft: 0,
      }
      this.#chats.set(id, c)
    }
    return c
  }

  #displayTitle(id: string, fallback: string): string {
    return this.#store.title(id) ?? (fallback || id.slice(-8))
  }

  // one persistent conversation per chat: resume the newest session if any,
  // otherwise create one (title = first message snippet).
  async #ensureSession(chatID: number, firstText?: string): Promise<string> {
    const c = this.#chat(chatID)
    if (c.sessionID) return c.sessionID
    const ws = this.#ws(c.workspace)
    const list = await ws.adapter.listSessions()
    const newest = list
      .map((s) => ({ s, t: s.time?.updated ?? 0 }))
      .sort((a, b) => b.t - a.t)[0]
    if (newest) {
      c.sessionID = newest.s.id
      return newest.s.id
    }
    const title = (firstText ?? "").slice(0, 40) || "My chat"
    const s = await ws.adapter.createSession(title)
    c.sessionID = s.id
    return s.id
  }

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.message) await this.#gatedMessage(update.message)
    else if (update.callback_query) await this.#gatedCallback(update.callback_query)
    else if (update.stopped_message_generation) await this.#onStopGeneration(update.stopped_message_generation)
  }

  // the user tapped the native "stop" button on a streaming draft — stop the turn
  async #onStopGeneration(stop: NonNullable<TgUpdate["stopped_message_generation"]>): Promise<void> {
    const chatID = stop?.chat?.id
    if (chatID == null) return
    const c = this.#chat(chatID)
    if (!c.inflight) return
    try {
      await this.#ws(c.workspace).adapter.abort(c.sessionID ?? "")
    } catch {
      /* the turn may have ended on its own already */
    }
    c.inflight.abort()
  }

  async #gatedMessage(m: TgMessage): Promise<void> {
    const chatID = m.chat.id
    const text = (m.text ?? m.caption ?? "").trim()
    const mediaFileID = this.#mediaFileID(m)
    if (!text && !mediaFileID) return
    const c = this.#chat(chatID)
    const [cmd, ...rest] = text.split(/\s+/)

    if (!this.#pairing.isPaired(chatID)) {
      if (c.awaiting?.kind === "pair") {
        if (cmd === "/cancel") {
          c.awaiting = null
          return this.#tg.sendMessage({ chatID, text: "canceled." })
        }
        if (!text.startsWith("/")) return this.#attemptPair(chatID, text)
      }
      if (cmd === "/pair") {
        const code = rest.join(" ")
        if (!code) {
          c.awaiting = { kind: "pair" }
          return this.#tg.sendMessage({
            chatID,
            text: "🔐 Please enter the pairing code.\n\nJust paste the code and hit send (/cancel to give up).",
          })
        }
        return this.#attemptPair(chatID, code)
      }
      if (cmd === "start") {
        return this.#tg.sendMessage({
          chatID,
          text: "This bot is locked. Tap /pair, then enter the code to authorize this chat.",
        })
      }
      return this.#tg.sendMessage({ chatID, text: "🔒 Not paired. Tap /pair and enter the code." })
    }

    console.error(`[tg] message from chat=${chatID} (${m.chat.type}) from=${m.from?.username ?? m.from?.id ?? "?"}`)
    c.msgs.add(m.message_id)
    if (text.startsWith("/")) {
      if (cmd === "/cancel") {
        if (c.awaiting) {
          c.awaiting = null
          return this.#tg.sendMessage({ chatID, text: "canceled." })
        }
        return this.#tg.sendMessage({ chatID, text: "(nothing to cancel)" })
      }
      if (c.awaiting) c.awaiting = null
      await this.#command(chatID, cmd.slice(1), rest.join(" "))
    } else if (c.awaiting) {
      await this.#resolveAwaiting(chatID, text)
    } else {
      let filePaths: string[] | undefined
      if (mediaFileID) {
        try {
          filePaths = [await this.#ingestMedia(chatID, m)]
        } catch (err) {
          await this.#tg.sendMessage({ chatID, text: `⚠️ couldn't read the image: ${(err as Error).message}` })
        }
      }
      await this.#freeText(chatID, text, { filePaths })
      if (mediaFileID) await this.#suggestImageModel(chatID)
    }
  }

  #mediaFileID(m: TgMessage): string | null {
    if (m.photo?.length) return m.photo[m.photo.length - 1]!.file_id // biggest variant
    if (m.document?.file_id) return m.document.file_id
    return null
  }

  // download a message's attachment into the uploads dir so the harness can
  // read it as a file part (absolute path).
  async #ingestMedia(chatID: number, m: TgMessage): Promise<string> {
    const fileID = this.#mediaFileID(m)
    if (!fileID) throw new Error("no attachment")
    const docName = m.document?.file_name
    const docMime = m.document?.mime_type
    const ext = docName?.slice(docName.lastIndexOf(".")).toLowerCase() || imageExt(docMime) || ".jpg"
    const bytes = await this.#tg.getFileContent(fileID)
    const name = `upl-${chatID}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
    await mkdir(this.#uploadsDir, { recursive: true })
    const filePath = join(this.#uploadsDir, name)
    await writeFile(filePath, bytes)
    return filePath
  }

  async #gatedCallback(cq: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
    if (!cq.message) return this.#tg.answerCallbackQuery({ id: cq.id })
    const chatID = cq.message.chat.id
    if (!this.#pairing.isPaired(chatID)) return this.#tg.answerCallbackQuery({ id: cq.id, text: "not paired" })
    await this.#onCallback(cq)
  }

  async #attemptPair(chatID: number, code: string): Promise<void> {
    const res = this.#pairing.attempt(chatID, code.trim())
    if (res.status === "blocked") {
      const when = res.retryIn >= 60 ? `${Math.ceil(res.retryIn / 60)} min` : `~${res.retryIn}s`
      return this.#tg.sendMessage({ chatID, text: `🛑 Too many wrong codes. Try again in ${when}.` })
    }
    this.#chat(chatID).awaiting = null
    if (res.status === "bad") {
      if (res.rotated) {
        console.error(`[pair] code rotated after repeated failures. new code: ${this.#pairing.code}`)
        const owner = this.#pairing.owner
        if (owner !== null) {
          await this.#tg.sendMessage({ chatID: owner, text: `🔐 Pairing code was rotated: ${this.#pairing.code}` })
        }
      }
      return this.#tg.sendMessage({ chatID, text: "✗ Wrong pairing code." })
    }
    if (res.pairing === "owner")
      return this.#tg.sendMessage({ chatID, text: "🔐 Paired. You are the **owner** — the bot is now locked to you." })
    return this.#tg.sendMessage({ chatID, text: "🔐 Paired. Welcome — you can use the agent now." })
  }

  async #resolveAwaiting(chatID: number, text: string): Promise<void> {
    const a = this.#chat(chatID).awaiting
    if (!a) return this.#freeText(chatID, text)
    this.#chat(chatID).awaiting = null
    if (a.kind === "pair") return this.#attemptPair(chatID, text)
    if (a.kind === "use") return this.#resolveUse(chatID, text)
    const t = text.trim()
    this.#store.setTitle(a.sessionID, t)
    await this.#tg.sendMessage({ chatID, text: `✏️ renamed to "${this.#store.title(a.sessionID) ?? t}"` })
  }

  async #resolveUse(chatID: number, term: string): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#ws(c.workspace)
    const list = await ws.adapter.listSessions()
    const byTitle = list.find((s) => this.#displayTitle(s.id, s.title).toLowerCase().includes(term.toLowerCase()))
    const exact = byTitle ?? (term.includes("://") ? await ws.adapter.getSession(term) : null)
    if (!exact) {
      await this.#tg.sendMessage({ chatID, text: "no conversation found — try /ls" })
      return
    }
    c.sessionID = exact.id
    await this.#tg.sendMessage({ chatID, text: `▶ "${this.#displayTitle(exact.id, exact.title)}"` })
  }

  async #command(chatID: number, cmd: string, arg: string): Promise<void> {
    const tg = this.#tg
    const c = this.#chat(chatID)
    const ws = this.#ws(c.workspace)
    switch (cmd) {
      case "start":
      case "help":
        await tg.sendMessage({ chatID, text: HELP })
        break
      case "new":
        await this.#newConversation(chatID, null, arg)
        break
      case "settings":
        await this.#settingsRoot(chatID, null)
        break
      case "wipe":
        await this.#wipe(chatID)
        break
      case "ls": {
        await this.#listPicker(chatID, "Conversations:")
        break
      }
      case "status": {
        const sessions = await ws.adapter.listSessions()
        const active = c.sessionID ? await ws.adapter.getSession(c.sessionID) : null
        const label = active ? this.#displayTitle(active.id, active.title) : "(none)"
        await tg.sendMessage({
          chatID,
          text: [
            `workspace: ${c.workspace}`,
            `engine: ${c.harness ?? ws.adapter.id}`,
            `model: ${this.#store.model(chatID) ?? "default"}`,
            `conversation: "${label}"`,
            `total conversations: ${sessions.length}`,
          ].join("\n"),
        })
        break
      }
      case "log": {
        const sessionID = await this.#ensureSession(chatID)
        const msgs = await ws.adapter.messages(sessionID)
        if (!msgs.length) {
          await tg.sendMessage({ chatID, text: "(empty — send a message to start)" })
          return
        }
        const text = msgs
          .map((m) => {
            const t = m.parts.map((p) => (p.kind === "text" || p.kind === "reasoning" ? p.text : `[${p.kind}]`)).join(" ")
            return `${m.role === "user" ? "👤" : "🤖"} ${t}`
          })
          .join("\n")
        await tg.sendMessage({ chatID, text: text.length > MAX_MSG ? text.slice(-MAX_MSG) : text })
        break
      }
      case "use": {
        if (!arg) {
          c.awaiting = { kind: "use" }
          await this.#listPicker(chatID, "Which conversation? (tap one, or type a title / paste an ID · /cancel to stop)")
          break
        }
        await this.#resolveUse(chatID, arg)
        break
      }
      case "del": {
        await this.#listPicker(chatID, "Delete which conversation?", "del")
        break
      }
      case "abort": {
        if (!c.inflight) return tg.sendMessage({ chatID, text: "(no turn in flight)" })
        await ws.adapter.abort(c.sessionID ?? "")
        c.inflight.abort()
        c.inflight = null
        await tg.sendMessage({ chatID, text: "⏹ stopped" })
        break
      }
      case "ws": {
        const names = this.#workspaces.map((w) => w.name)
        if (arg) {
          if (!names.includes(arg)) return tg.sendMessage({ chatID, text: `no workspace '${arg}'` })
          c.workspace = arg
          c.sessionID = null
          c.picker = null
          c.del = null
          c.page = 0
          await tg.sendMessage({ chatID, text: `workspace: ${arg}` })
          break
        }
        const current = c.workspace
        const rows = names.map((n) => [btn(n, `wsw:${n}`)])
        await tg.sendMessage({ chatID, text: `Workspaces (current: ${current}):`, replyMarkup: kin(rows) })
        break
      }
      case "ver": {
        await tg.sendMessage({ chatID, text: "running compliance suite…" })
        const rows = await runComplianceSuite(ws.adapter)
        await tg.sendMessage({
          chatID,
          text: rows.map((r) => `  ${r.ok === true ? "✓" : r.ok === "manual" ? "~" : "✗"} ${r.method}`).join("\n"),
        })
        break
      }
      case "pair": {
        if (this.#pairing.isPaired(chatID))
          return tg.sendMessage({ chatID, text: "already paired: share the code from /pair_status to authorize someone else." })
        await this.#attemptPair(chatID, arg)
        break
      }
      case "pair_status":
      case "pair-status": {
        const owner = this.#pairing.owner
        await tg.sendMessage({
          chatID,
          text: `owner: ${owner ?? "(none)"}\npaired chats: ${this.#pairing.count()}\ncode: ${this.#pairing.code}${owner === chatID ? "  (you)" : ""}`,
        })
        break
      }
      default:
        await tg.sendMessage({ chatID, text: `unknown command /${cmd} (try /help)` })
    }
  }

  // create a fresh conversation; when exactly one harness exists it is chosen
  // automatically (TODO(harness-picker): surface multi-harness choice as
  // buttons instead of silently preferring the active workspace's engine)
  async #newConversation(chatID: number, replyId: number | null, title?: string): Promise<void> {
    const c = this.#chat(chatID)
    const harnesses = this.#harnesses()
    let ws = this.#ws(c.workspace)
    if (c.harness && this.#wsFor(c.harness)) {
      ws = this.#wsFor(c.harness)!
    } else if (harnesses.length === 1) {
      c.harness = harnesses[0]!
    }
    const s = await ws.adapter.createSession(title || "New conversation")
    c.sessionID = s.id
    c.picker = null
    c.del = null
    c.page = 0
    if (replyId === null) await this.#tg.sendMessage({ chatID, text: "💬 new conversation" })
    else await this.#tg.editMessageText({ chatID, messageID: replyId, text: "💬 new conversation", replyMarkup: null })
  }

  // list sessions as tappable title buttons; callback snapshots into c.picker
  async #listPicker(chatID: number, caption: string, kind: "del" | "ls" = "ls"): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#ws(c.workspace)
    const sessions = await ws.adapter.listSessions()
    if (!sessions.length) {
      await this.#tg.sendMessage({ chatID, text: "(no conversations yet — just send a message)" })
      return
    }
    const sorted = [...sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    const shown = sorted.slice(0, MAX_LIST)
    const prefix = kind === "del" ? "deld" : "open"
    const list = shown.map((s) => {
      const marker = s.id === c.sessionID ? "  ◀" : ""
      const title = this.#displayTitle(s.id, s.title)
      return `${shown.indexOf(s) + 1}. "${title}"${marker}`
    })
    const msg = await this.#tg.sendMessage({
      chatID,
      text: [caption, "", ...list, ...(sorted.length > MAX_LIST ? [`… and ${sorted.length - MAX_LIST} more`] : [])].join("\n"),
      replyMarkup: kin(shown.map((s, i) => [btn(`${i + 1}. ${this.#displayTitle(s.id, s.title)}`, `${prefix}:${i}`)])),
    })
    c.picker = { messageID: msg.message_id, ws: c.workspace, sessions: shown.map((s) => s.id) }
    c.del = null
    c.page = 0
  }

  async #freeText(chatID: number, text: string, opts?: { filePaths?: string[] }): Promise<void> {
    const c = this.#chat(chatID)
    const promptText = text || (opts?.filePaths?.length ? "see the attached file" : "")
    const sessionID = await this.#ensureSession(chatID, promptText)
    const ws = this.#ws(c.workspace)

    const ac = new AbortController()
    c.inflight = ac

    // Streaming drafts (Bot API 9.4+): an animated ephemeral preview that also
    // carries a native stop button. Falls back to the placeholder+edit path
    // when the API/client doesn't support drafts.
    const draftID = c.draft + 1
    c.draft = draftID
    let drafts = false
    try {
      await this.#tg.sendMessageDraft({ chatID, draftID, text: "", canStop: true })
      drafts = true
    } catch {
      /* draft streaming unsupported → legacy edit-in-place below */
    }
    let placeholder: { message_id: number } | null = null
    if (!drafts) {
      placeholder = await this.#tg.sendMessage({ chatID, text: "…", replyMarkup: kin([[btn("⏹ Stop", "abt")]]) })
    }
    await this.#tg.sendChatAction({ chatID, action: "typing" })

    const mdl = this.#store.model(chatID)
    let model
    if (mdl) {
      const sep = mdl.indexOf("/")
      model = { providerID: mdl.slice(0, sep), modelID: mdl.slice(sep + 1) }
    }

    const sub = new AbortController()
    let acc = ""
    let lastEdit = 0
    let lastText: string | null = null
    let lastHadMarkup = true

    // push the latest stream tail (draft animate in place; legacy edits the
    // placeholder message). A single failed push never kills the stream.
    const preview = async (body: string) => {
      const text = body.slice(-MAX_MSG) || (drafts ? "" : "…")
      if (text === lastText) return
      lastText = text
      lastHadMarkup = true
      try {
        if (drafts) await this.#tg.sendMessageDraft({ chatID, draftID, text })
        else if (placeholder) await this.#tg.editMessageText({ chatID, messageID: placeholder.message_id, text })
      } catch {
        /* ignore */
      }
      lastEdit = Date.now()
    }

    const clearPlaceholder = async (body: string) => {
      if (!placeholder) return
      const text = body.slice(-MAX_MSG)
      if (text === lastText && !lastHadMarkup) return
      lastText = text
      lastHadMarkup = false
      await this.#tg.editMessageText({ chatID, messageID: placeholder.message_id, text, replyMarkup: null })
    }

    // persist the finished answer as a real message; the ephemeral draft goes
    // away on its own as soon as a message lands in the chat.
    const present = async (body: string) => {
      if (!body.trim()) {
        if (placeholder) await this.#tg.deleteMessage({ chatID, messageID: placeholder.message_id })
        return
      }
      const rich = mdToRich(body)
      if (rich.length) {
        try {
          await this.#tg.sendRichMessage({ chatID, rich_message: { blocks: rich } })
          if (placeholder) await this.#tg.deleteMessage({ chatID, messageID: placeholder.message_id })
          lastText = body.slice(-MAX_MSG)
          lastHadMarkup = false
          return
        } catch {
          // client or API rejected the rich message → fall back to the box render
        }
      }
      if (placeholder) await clearPlaceholder(body)
      else await this.#tg.sendMessage({ chatID, text: body.slice(-MAX_MSG) })
    }

    const streamTask = (async () => {
      try {
        for await (const evt of ws.adapter.events(sub.signal)) {
          if (ac.signal.aborted) break
          // opencode streams chain-of-thought as its own "reasoning" part;
          // that must never leak into the visible answer.
          if (
            evt.type === "part.delta" &&
            evt.sessionID === sessionID &&
            evt.text &&
            evt.partType !== "reasoning"
          ) {
            acc += evt.text
            if (Date.now() - lastEdit > 700) await preview(acc)
          } else if (evt.type === "permission.requested" && evt.sessionID === sessionID) {
            const msg = await this.#tg.sendMessage({
              chatID,
              text: `🔐 ${evt.permissionID}`,
              replyMarkup: kin([[btn("Allow", `allow:${evt.permissionID}`)], [btn("Deny", `deny:${evt.permissionID}`)]]),
            })
            c.pending.set(evt.permissionID, { sessionID, messageID: msg.message_id })
          }
        }
      } catch {
        /* subscription closed */
      }
    })()

    try {
      const reply = await ws.adapter.prompt(sessionID, promptText, {
        signal: ac.signal,
        ...(model ? { model } : {}),
        ...(opts?.filePaths?.length ? { filePaths: opts.filePaths } : {}),
      })
      if (!acc) acc = reply.parts.filter((p) => p.kind === "text").map((p) => p.text).join("")
      for (const p of reply.parts) if (p.kind === "tool") acc += `\n[⚙ ${p.name}]`
      const media = reply.parts.filter((p): p is FilePart => p.kind === "file")
      if (acc.trim()) await present(acc)
      else if (placeholder) await this.#tg.deleteMessage({ chatID, messageID: placeholder.message_id })
      for (const f of media) await this.#sendPartFile(chatID, f)
    } catch (err) {
      if (ac.signal.aborted) await present(acc.trim() ? acc : "(stopped)")
      else {
        const text = `⚠️ ${(err as Error).message}`.slice(-MAX_MSG)
        if (placeholder) {
          lastText = text
          lastHadMarkup = false
          await this.#tg.editMessageText({ chatID, messageID: placeholder.message_id, text, replyMarkup: null })
        } else {
          await this.#tg.sendMessage({ chatID, text })
        }
      }
    } finally {
      sub.abort()
      await streamTask.catch(() => {})
      c.inflight = null
    }
  }

  // the agent produced a file (image or otherwise) — surface it in the chat
  async #sendPartFile(chatID: number, f: FilePart): Promise<void> {
    if (!f.filePath) return
    try {
      if (IMAGE_RE.test(f.filePath)) await this.#tg.sendPhoto({ chatID, filePath: f.filePath })
      else await this.#tg.sendDocument({ chatID, filePath: f.filePath })
    } catch (err) {
      await this.#tg.sendMessage({ chatID, text: `⚠️ couldn't send a produced file: ${(err as Error).message}` })
    }
  }

  // ─── wipe: Telegram-side only. Clears the visible chat (bot's own messages)
  // and never touches backend storage — sessions, store.json, titles and model
  // picks all stay. Deleting conversation history is not this command's job. ───

  async #wipe(chatID: number): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#ws(c.workspace)
    if (c.inflight) {
      try {
        await ws.adapter.abort(c.sessionID ?? "")
      } catch {
        /* ignore */
      }
      c.inflight.abort()
      c.inflight = null
    }

    const ids = [...c.msgs].slice(-WIPE_DELETE_CAP)
    c.msgs.clear()
    for (let i = 0; i < ids.length; i++) {
      try {
        await this.#tg.deleteMessage({ chatID, messageID: ids[i]! })
      } catch {
        /* older than 48h / already gone */
      }
      if (i > 0 && i % 7 === 6) await sleep(150)
    }

    c.picker = null
    c.del = null
    c.awaiting = null
    c.pending.clear()
    c.settingsMsg = null

    await this.#tg.sendMessage({ chatID, text: "🧽 chat cleared — bot messages removed. conversations are untouched." })
  }

  // continuation picker: new conversation, 4 most recent, paginated "see more"
  async #wipePick(chatID: number, page: number, messageID: number | null): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#ws(c.workspace)
    const sorted = [...(await ws.adapter.listSessions())].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    const ids = sorted.map((s) => s.id)
    const lastPage = Math.max(0, Math.ceil(ids.length / WIPE_PAGE) - 1)
    const p = Math.max(0, Math.min(page, lastPage))
    const from = p * WIPE_PAGE
    const shown = ids.slice(from, from + WIPE_PAGE)

    const rows: InlineButton[][] = [[btn("🆕 New conversation", "neww")]]
    for (const id of shown) {
      const s = sorted[ids.indexOf(id)]!
      rows.push([btn(this.#displayTitle(id, s.title), `open:${ids.indexOf(id)}`)])
    }
    const nav: InlineButton[] = []
    if (p > 0) nav.push(btn("‹ back", "backp"))
    if (ids.length > from + WIPE_PAGE) nav.push(btn("See more ›", "morep"))
    if (nav.length) rows.push(nav)

    const body = [
      "Which conversation do you want to continue?",
      "",
      "(sessions are kept — I only cleared this chat's messages)",
    ].join("\n")

    const reply = messageID === null
      ? await this.#tg.sendMessage({ chatID, text: body, replyMarkup: kin(rows) })
      : { message_id: messageID }

    if (messageID !== null) {
      await this.#tg.editMessageText({ chatID, messageID, text: body, replyMarkup: kin(rows) })
    }
    c.picker = { messageID: reply.message_id, ws: c.workspace, sessions: ids }
    c.page = p
    c.del = null
  }

  // ─── settings button-tree ───

  async #settingsRoot(chatID: number, messageID: number | null): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#ws(c.workspace)
    const active = c.sessionID ? await ws.adapter.getSession(c.sessionID) : null
    const label = active ? this.#displayTitle(active.id, active.title) : "(none)"
    const model = this.#store.model(chatID) ?? "default"

    const body = [
      "⚙️ Settings",
      "",
      `engine: ${c.harness ?? ws.adapter.id}`,
      `model: ${model}`,
      `conversation: "${label}"`,
      `workspace: ${c.workspace}`,
    ].join("\n")
    const markup = kin([
      [btn(`🤖 Model · ${model}`, "set:model")],
      [btn("✏️ Rename conversation", "set:rename")],
      [btn("🧽 Wipe this chat", "set:wipe")],
      [btn("‹ Done", "set:done")],
    ])

    if (messageID === null) {
      const reply = await this.#tg.sendMessage({ chatID, text: body, replyMarkup: markup })
      c.settingsMsg = reply.message_id
    } else {
      await this.#tg.editMessageText({ chatID, messageID, text: body, replyMarkup: markup })
    }
  }

  async #settingsModel(chatID: number, messageID: number, requestPage?: number): Promise<void> {
    const c = await this.#chat(chatID)
    const ws = this.#ws(c.workspace)
    const current = this.#store.model(chatID)
    const native: ModelRef[] = ws ? (await ws.adapter.models?.().catch(() => [])) ?? [] : []
    const caps = (await ws.adapter.capabilities?.().catch(() => new Map<string, ModelCaps>())) ?? new Map<string, ModelCaps>()
    const labels: string[] = ["default"]
    const seen = new Set<string>(["default"])
    for (const ref of native) {
      const label = `${ref.providerID}/${ref.modelID}`
      if (seen.has(label)) continue
      seen.add(label)
      labels.push(label)
    }
    for (const label of this.#extraModels) {
      if (seen.has(label)) continue
      seen.add(label)
      labels.push(label)
    }
    const pages = Math.max(1, Math.ceil(labels.length / MAX_LIST))
    const page = Math.max(0, Math.min(requestPage ?? c.settingsPage ?? 0, pages - 1))
    c.settingsPage = page
    const rows: InlineButton[][] = []
    const from = page * MAX_LIST
    let anyImage = false
    for (let i = from; i < Math.min(from + MAX_LIST, labels.length); i++) {
      const label = labels[i]!
      const mark = label === "default" ? current === null : label === current
      const image = caps.get(label)?.image === true
      if (image) anyImage = true
      const b: InlineButton = btn(`${label}${image ? " 🖼" : ""}`, label === "default" ? "mdl:off" : `mdl:${label}`)
      if (mark) b.style = "success" // green = the model this chat runs on
      rows.push([b])
    }
    if (pages > 1) {
      const nav: InlineButton[] = [btn(`page ${page + 1} / ${pages}`, "mdlp:page")]
      if (page > 0) nav.unshift(btn("‹ Prev", "mdlp:prev"))
      if (page < pages - 1) nav.push(btn("Next ›", "mdlp:next"))
      rows.push(nav)
    }
    rows.push([btn("‹ Back", "set:root")])
    const body = [
      "🤖 Model",
      "",
      `current: ${current ?? "default (engine picks)"}`,
      "",
      "Tap one — the next message in this chat runs on it.",
      ...(anyImage ? ["🖼 = accepts images"] : []),
      ...(pages > 1 ? [`page ${page + 1} / ${pages} (${labels.length} models)`] : []),
    ].join("\n")
    await this.#tg.editMessageText({ chatID, messageID, text: body, replyMarkup: kin(rows) })
  }

  // when a photo/document lands on a model we can't see it with, offer the
  // vision-capable ones directly (once per current model, not on every message).
  async #suggestImageModel(chatID: number): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#ws(c.workspace)
    const current = this.#store.model(chatID) ?? "default"
    if (c.suggestedImage === current) return
    const caps = (await ws.adapter.capabilities?.().catch(() => new Map<string, ModelCaps>())) ?? new Map<string, ModelCaps>()
    if (caps.size === 0) return
    if (caps.get(current)?.image === true) return
    const native: ModelRef[] = (await ws.adapter.models?.().catch(() => [])) ?? []
    const picks: string[] = []
    const seen = new Set<string>()
    for (const ref of native) {
      const label = `${ref.providerID}/${ref.modelID}`
      if (seen.has(label)) continue
      seen.add(label)
      if (caps.get(label)?.image === true) picks.push(label)
      if (picks.length === 3) break
    }
    if (picks.length === 0) return
    const rows: InlineButton[][] = picks.map((label) => [btn(`🖼 ${label}`, `mdl:${label}`)])
    rows.push([btn("All models ›", "set:model")])
    c.suggestedImage = current
    const reply = await this.#tg.sendMessage({
      chatID,
      text: "🖼 This model can't read images. Switch to a vision-capable one?",
      replyMarkup: kin(rows),
    })
    c.msgs.add(reply.message_id)
  }

  async #settingsRename(chatID: number, messageID: number, requestPage?: number): Promise<void> {
    const c = this.#chat(chatID)
    // renaming is about the conversation you're already in — no picker needed
    if (c.sessionID) {
      c.awaiting = { kind: "rename", sessionID: c.sessionID }
      await this.#tg.editMessageText({ chatID, messageID, text: "✏️ Type the new name for this conversation…", replyMarkup: null })
      return
    }
    const ws = this.#ws(c.workspace)
    const sorted = [...(await ws.adapter.listSessions())].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    const ids = sorted.map((s) => s.id)
    if (!ids.length) {
      await this.#tg.editMessageText({ chatID, messageID, text: "(no conversations to rename — just send a message first)", replyMarkup: null })
      return
    }
    const pages = Math.max(1, Math.ceil(ids.length / MAX_LIST))
    const page = Math.max(0, Math.min(requestPage ?? c.page, pages - 1))
    c.page = page
    const rows: InlineButton[][] = ids
      .slice(page * MAX_LIST, (page + 1) * MAX_LIST)
      .map((id) => [btn(this.#displayTitle(id, ""), `ren:${ids.indexOf(id)}`)])
    if (pages > 1) {
      const nav: InlineButton[] = [btn(`page ${page + 1} / ${pages}`, "renp:page")]
      if (page > 0) nav.unshift(btn("‹ Prev", "renp:prev"))
      if (page < pages - 1) nav.push(btn("Next ›", "renp:next"))
      rows.push(nav)
    }
    rows.push([btn("‹ Back", "set:root")])
    c.picker = { messageID, ws: c.workspace, sessions: ids }
    c.del = null
    await this.#tg.editMessageText({ chatID, messageID, text: "✏️ Rename\n\nWhich conversation? (no active conversation yet)", replyMarkup: kin(rows) })
  }

  async #onCallback(cq: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
    const tg = this.#tg
    const data = cq.data ?? ""
    const msg = cq.message
    if (!msg) return tg.answerCallbackQuery({ id: cq.id })
    const chatID = msg.chat.id
    const c = this.#chat(chatID)
    const ws = this.#ws(c.workspace)
    const [verb, rest] = data.split(":")
    const i = Number(rest)

    switch (verb) {
      case "set":
        if (rest === "root") await this.#settingsRoot(chatID, msg.message_id)
        else if (rest === "model") await this.#settingsModel(chatID, msg.message_id)
        else if (rest === "rename") await this.#settingsRename(chatID, msg.message_id)
        else if (rest === "wipe") await this.#wipe(chatID)
        else if (rest === "done") {
          c.settingsMsg = null
          await this.#tg.editMessageText({ chatID, messageID: msg.message_id, text: "⚙️ closed", replyMarkup: null })
        } else {
          await tg.answerCallbackQuery({ id: cq.id, text: "stale menu" })
          break
        }
        await tg.answerCallbackQuery({ id: cq.id })
        break
      case "mdlp": {
        const cur = c.settingsPage ?? 0
        const next = rest === "prev" ? cur - 1 : rest === "next" ? cur + 1 : cur
        await this.#settingsModel(chatID, msg.message_id, next)
        await tg.answerCallbackQuery({ id: cq.id, text: rest === "page" ? `page ${cur + 1}` : undefined })
        break
      }
      case "renp": {
        const cur = c.page
        const next = rest === "prev" ? cur - 1 : rest === "next" ? cur + 1 : cur
        await this.#settingsRename(chatID, msg.message_id, next)
        await tg.answerCallbackQuery({ id: cq.id, text: rest === "page" ? `page ${cur + 1}` : undefined })
        break
      }
      case "mdl": {
        if (rest === "off") this.#store.clearModel(chatID)
        else this.#store.setModel(chatID, rest)
        await this.#settingsModel(chatID, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id, text: rest === "off" ? "back to default" : `model: ${rest}` })
        break
      }
      case "ren": {
        const p = c.picker
        if (!p || p.ws !== c.workspace) return tg.answerCallbackQuery({ id: cq.id, text: "menu expired - run /settings" })
        const id = p.sessions[i]
        if (!id) return tg.answerCallbackQuery({ id: cq.id, text: "no such conversation" })
        c.awaiting = { kind: "rename", sessionID: id }
        await this.#tg.editMessageText({ chatID, messageID: msg.message_id, text: "✏️ Type the new name for this conversation…", replyMarkup: null })
        await tg.answerCallbackQuery({ id: cq.id, text: "type the name" })
        break
      }
      case "neww": {
        await this.#newConversation(chatID, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id, text: "new" })
        break
      }
      case "morep": {
        await this.#wipePick(chatID, c.page + 1, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "backp": {
        await this.#wipePick(chatID, Math.max(0, c.page - 1), msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "hns": {
        const h = this.#wsFor(rest)
        if (!h) return tg.answerCallbackQuery({ id: cq.id, text: "no such engine" })
        c.harness = rest
        const s = await h.adapter.createSession("New conversation")
        c.sessionID = s.id
        c.picker = null
        c.del = null
        c.page = 0
        await this.#tg.editMessageText({ chatID, messageID: msg.message_id, text: `💬 new conversation · engine: ${rest}`, replyMarkup: null })
        await tg.answerCallbackQuery({ id: cq.id, text: `engine: ${rest}` })
        break
      }
      case "open": {
        const p = c.picker
        if (!p || p.ws !== c.workspace) return tg.answerCallbackQuery({ id: cq.id, text: "menu expired - run /ls again" })
        const id = p.sessions[i]
        if (!id) return tg.answerCallbackQuery({ id: cq.id, text: "no such conversation" })
        c.sessionID = id
        c.del = null
        c.awaiting = null
        const s = await ws.adapter.getSession(id)
        await this.#tg.editMessageText({ chatID, messageID: p.messageID, text: `▶ "${this.#displayTitle(id, s?.title ?? "")}"`, replyMarkup: null })
        await tg.answerCallbackQuery({ id: cq.id, text: "opened" })
        break
      }
      case "deld": {
        const p = c.picker
        if (!p || p.ws !== c.workspace) return tg.answerCallbackQuery({ id: cq.id, text: "menu expired - run /del again" })
        const id = p.sessions[i]
        if (!id) return tg.answerCallbackQuery({ id: cq.id, text: "no such conversation" })
        c.del = { messageID: p.messageID, i }
        const s = await ws.adapter.getSession(id)
        await this.#tg.editMessageText({
          chatID,
          messageID: p.messageID,
          text: `Delete "${this.#displayTitle(id, s?.title ?? "")}"?`,
          replyMarkup: kin([[btn("🗑 Delete", "dely")], [btn("Cancel", "deln")]]),
        })
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "dely": {
        const d = c.del
        const p = c.picker
        if (!d || !p) return tg.answerCallbackQuery({ id: cq.id, text: "nothing to delete" })
        const id = p.sessions[d.i]
        if (id) {
          await ws.adapter.deleteSession(id)
          if (c.sessionID === id) c.sessionID = null
        }
        c.picker = null
        c.del = null
        await this.#tg.editMessageText({ chatID, messageID: d.messageID, text: "🗑 deleted", replyMarkup: null })
        await tg.answerCallbackQuery({ id: cq.id, text: "deleted" })
        break
      }
      case "deln": {
        const d = c.del
        c.del = null
        if (d) await this.#tg.editMessageText({ chatID, messageID: d.messageID, text: "canceled", replyMarkup: null })
        await tg.answerCallbackQuery({ id: cq.id, text: "canceled" })
        break
      }
      case "wsw": {
        if (!this.#workspaces.some((w) => w.name === rest)) return tg.answerCallbackQuery({ id: cq.id, text: "no such workspace" })
        c.workspace = rest
        c.sessionID = null
        c.picker = null
        c.del = null
        c.page = 0
        await this.#tg.editMessageText({ chatID, messageID: msg.message_id, text: `workspace: ${rest}`, replyMarkup: null })
        await tg.answerCallbackQuery({ id: cq.id, text: "switched" })
        break
      }
      case "abt": {
        if (!c.inflight) return tg.answerCallbackQuery({ id: cq.id, text: "nothing running" })
        await ws.adapter.abort(c.sessionID ?? "")
        c.inflight.abort()
        await tg.answerCallbackQuery({ id: cq.id, text: "stopping…" })
        break
      }
      case "allow":
      case "deny": {
        const pending = c.pending.get(rest)
        if (!pending) return tg.answerCallbackQuery({ id: cq.id, text: "already answered" })
        await ws.adapter.respondApproval(pending.sessionID, { id: rest, sessionID: pending.sessionID, title: "", metadata: {} }, verb === "allow")
        c.pending.delete(rest)
        await this.#tg.editMessageText({ chatID, messageID: msg.message_id, text: verb === "allow" ? "✅ allowed" : "⛔ denied", replyMarkup: null })
        await tg.answerCallbackQuery({ id: cq.id, text: verb === "allow" ? "allowed" : "denied" })
        break
      }
      default:
        await tg.answerCallbackQuery({ id: cq.id, text: "stale button" })
    }
  }
}
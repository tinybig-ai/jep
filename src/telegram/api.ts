import { readFile } from "node:fs/promises"
import { basename } from "node:path"

const TG_API = "https://api.telegram.org/bot"
const TG_FILE = "https://api.telegram.org/file/bot"

export interface TgUser {
  id: number
  username?: string
  first_name?: string
  /** true for the bot's own messages — how a swipe-reply is told apart */
  is_bot?: boolean
}

export interface TgMessage {
  message_id: number
  chat: { id: number; type: string }
  from?: TgUser
  text?: string
  caption?: string
  photo?: { file_id: string; file_unique_id?: string; width?: number; height?: number; file_size?: number }[]
  document?: { file_id: string; file_unique_id?: string; file_name?: string; mime_type?: string; file_size?: number }
  sticker?: {
    file_id: string
    file_unique_id?: string
    /** the emoji this sticker stands for — its actual semantic content */
    emoji?: string
    set_name?: string
    /** .tgs Lottie animation: not an image anything can read */
    is_animated?: boolean
    /** .webm video sticker: likewise */
    is_video?: boolean
    width?: number
    height?: number
    /** static preview, present for animated/video stickers */
    thumbnail?: { file_id: string }
  }
  /** the press-and-hold mic: Ogg/Opus, and the reason transcription exists */
  voice?: { file_id: string; duration?: number; mime_type?: string; file_size?: number }
  /** an attached audio file (mp3/m4a/…) */
  audio?: { file_id: string; duration?: number; file_name?: string; mime_type?: string; file_size?: number }
  /** the round selfie clip — someone talking, in an mp4 */
  video_note?: { file_id: string; duration?: number; file_size?: number }
  // set on group messages that were sent as ephemeral (visible to one user + bot)
  ephemeral_message_id?: number
  /** present when the user swipe-replied — the message being pointed at */
  reply_to_message?: TgMessage
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: {
    id: string
    from?: TgUser
    message?: { message_id: number; chat: { id: number } }
    data?: string
  }
  // the user tapped the native "stop" button on a draft (needs can_stop: true)
  stopped_message_generation?: { chat: { id: number }; draft_id?: number }
}

export interface InlineButton {
  text: string
  callback_data: string
  /** optional button background: "success" (green), "danger" (red), "primary" (blue) */
  style?: "success" | "danger" | "primary"
  /** render the button inert — it does nothing when pressed (Bot API 10.3+) */
  disabled?: boolean
}

/** a button inside a rich message (RichBlockButtons, Bot API 10.3+) */
export interface RichMessageButton {
  text: string
  callback_data: string
  style?: "success" | "danger" | "primary" | "link"
  disabled?: boolean
}

/** make the message visible only to `receiver_user_id` + the bot (groups only) */
export interface EphemeralParameters {
  receiver_user_id: number
  callback_query_id?: string
  replace_callback_query_message?: boolean
}

export type ReplyMarkup = {
  inline_keyboard: InlineButton[][]
  /** reply bar forced on the recipient, as if the message was replied to (10.3) */
  force_reply?: boolean
}

export interface TgBotCommand {
  command: string
  description: string
}

export type ParseMode = "HTML" | "MarkdownV2"

export interface TelegramApi {
  getUpdates(props: { offset?: number; timeout?: number }): Promise<TgUpdate[]>
  sendMessage(params: {
    chatID: number
    text: string
    replyMarkup?: ReplyMarkup
    parseMode?: ParseMode
    ephemeralMessageParameters?: EphemeralParameters
    disableNotification?: boolean
  }): Promise<{ message_id: number; ephemeral_message_id?: number }>
  editMessageText(params: {
    chatID: number
    messageID: number
    text: string
    replyMarkup?: ReplyMarkup | null
    parseMode?: ParseMode
  }): Promise<void>
  deleteMessage(params: { chatID: number; messageID: number }): Promise<void>
  /** react to a message with a single emoji (Bot API 7.0+) */
  setMessageReaction(params: { chatID: number; messageID: number; emoji: string }): Promise<void>
  pinChatMessage(params: { chatID: number; messageID: number; disableNotification?: boolean }): Promise<void>
  unpinChatMessage(params: { chatID: number; messageID: number }): Promise<void>
  sendRichMessage(params: {
    chatID: number
    rich_message: Record<string, unknown>
    ephemeralMessageParameters?: EphemeralParameters
    disableNotification?: boolean
    /** local files to embed via attach:// refs in the rich blocks (10.3) */
    files?: Array<{ name: string; filePath: string }>
  }): Promise<{ message_id: number; ephemeral_message_id?: number }>
  /** replace a rich message in place (editMessageText + rich_message, 10.1+) */
  editRichMessage(params: { chatID: number; messageID: number; rich_message: Record<string, unknown> }): Promise<void>
  /** delete an ephemeral (group, single-receiver) message */
  deleteEphemeralMessage(params: { chatID: number; ephemeralMessageID: number }): Promise<void>
  sendChatAction(params: { chatID: number; action: string }): Promise<void>
  answerCallbackQuery(params: { id: string; text?: string }): Promise<void>
  setMyCommands(commands: TgBotCommand[]): Promise<void>
  /** download a message's file (photo/document) as raw bytes */
  getFileContent(fileID: string): Promise<Buffer>
  sendPhoto(params: { chatID: number; filePath: string; caption?: string }): Promise<{ message_id: number }>
  sendDocument(params: { chatID: number; filePath: string; caption?: string }): Promise<{ message_id: number }>
  /** Bot API 9.4+: animated preview while the answer is being generated */
  sendMessageDraft(params: { chatID: number; draftID: number; text?: string; canStop?: boolean; parseMode?: string }): Promise<void>
  /** Bot API 10.1+: animated rich-message preview while the answer is being generated */
  sendRichMessageDraft(params: { chatID: number; draftID: number; rich_message: Record<string, unknown>; canStop?: boolean }): Promise<void>
}

// A bare fetch() never times out. A request Telegram accepts but then never
// answers would hang its caller forever — no error, no log, and the turn's
// inflight state never cleared. Every call gets an abort deadline instead; the
// signal stays armed through the body read, so a stalled response trips it too.
const CALL_TIMEOUT_MS = 20_000
// uploads and downloads move real bytes over a phone-grade link
const FILE_TIMEOUT_MS = 60_000

// A connection that drops mid-call — DNS, a reset, this machine's network
// blinking once an hour — is not an answer from Telegram, it is the request
// never arriving. Surfaced raw, that TypeError ("fetch failed") aborted
// whatever turn was in flight, so one blip cost an agent's whole run. Those
// are retried. A timeout is not: Telegram may have accepted that request and
// be slow to answer, and a second copy would post the message twice.
const RETRY_DELAYS_MS = [500, 2_000]
const isConnectionError = (err: unknown): boolean =>
  err instanceof TypeError && /fetch failed|network|socket|terminated/i.test(err.message)

export function createTelegramApi(token: string): TelegramApi {
  const url = (method: string) => `${TG_API}${token}/${method}`

  async function tgJson<T>(target: string, init: RequestInit, label: string, timeoutMs: number): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(target, { ...init, signal: AbortSignal.timeout(timeoutMs) })
        const json = (await res.json()) as { ok: boolean; result: T; description?: string }
        if (!json.ok) throw new Error(`telegram ${label}: ${json.description ?? "unknown error"}`)
        return json.result
      } catch (err) {
        if ((err as Error)?.name === "TimeoutError") throw new Error(`telegram ${label}: timed out after ${timeoutMs}ms`)
        const delay = RETRY_DELAYS_MS[attempt]
        // getUpdates rides blips out in its own poll loop, and a retry here
        // would only delay that; everything else gets its second chance here
        if (delay === undefined || label === "getUpdates" || !isConnectionError(err)) throw err
        console.error(`[tg] ${label}: ${(err as Error).message} — retrying in ${delay}ms`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  function call<T>(method: string, body: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    return tgJson<T>(
      url(method),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      method,
      timeoutMs,
    )
  }

  // Invalid formatting should degrade to plain text, never to a user-facing error.
  async function callWithFallback<T>(method: string, body: Record<string, unknown>): Promise<T> {
    try {
      return await call<T>(method, body)
    } catch (err) {
      const msg = (err as Error)?.message ?? ""
      if (body.parse_mode && /can't parse entities|failed to parse/i.test(msg)) {
        return call<T>(method, { ...body, parse_mode: undefined })
      }
      throw err
    }
  }

  const MIME_BY_EXT: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
  }

  // classic inline buttons carry text/callback plus optional style and the
  // inert `disabled` flag (DisabledButton: an empty object, Bot API 10.3+).
  function serialInline(b: InlineButton): Record<string, unknown> {
    const out: Record<string, unknown> = { text: b.text, callback_data: b.callback_data }
    if (b.style) out.style = b.style
    if (b.disabled) out.disabled = {}
    return out
  }
  const serialMarkup = (m: ReplyMarkup): Record<string, unknown> => ({
    inline_keyboard: m.inline_keyboard.map((row) => row.map((b) => serialInline(b))),
    ...(m.force_reply === true ? { force_reply: true } : {}),
  })

  // sendRichMessage needs multipart when blocks embed local files via
  // `attach://<name>`; without files it stays a plain JSON call.
  async function sendRichMultipart(
    chatID: number,
    richMessage: Record<string, unknown>,
    files: Array<{ name: string; filePath: string }>,
    extra: Record<string, unknown>,
  ): Promise<{ message_id: number; ephemeral_message_id?: number }> {
    const form = new FormData()
    form.append("chat_id", String(chatID))
    form.append("rich_message", JSON.stringify(richMessage))
    for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === "string" ? v : JSON.stringify(v))
    for (const f of files) {
      const bytes = await readFile(f.filePath)
      const name = basename(f.filePath)
      const ext = name.slice(name.lastIndexOf(".")).toLowerCase()
      form.append(f.name, new Blob([new Uint8Array(bytes)], { type: MIME_BY_EXT[ext] ?? "application/octet-stream" }), name)
    }
    return tgJson<{ message_id: number; ephemeral_message_id?: number }>(
      url("sendRichMessage"),
      { method: "POST", body: form },
      "sendRichMessage",
      FILE_TIMEOUT_MS,
    )
  }

  async function sendMultipart(method: "sendPhoto" | "sendDocument", chatID: number, filePath: string, caption?: string) {
    const bytes = await readFile(filePath)
    const name = basename(filePath)
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase()
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream"
    const form = new FormData()
    form.append("chat_id", String(chatID))
    form.append(method === "sendPhoto" ? "photo" : "document", new Blob([new Uint8Array(bytes)], { type: mime }), name)
    if (caption) form.append("caption", caption)
    return tgJson<{ message_id: number }>(url(method), { method: "POST", body: form }, method, FILE_TIMEOUT_MS)
  }

  return {
    async getUpdates(props) {
      // long poll: Telegram holds the request open for `timeout` seconds by
      // design, so the abort deadline is that plus room for the round trip
      const poll = props.timeout ?? 30
      return call<TgUpdate[]>(
        "getUpdates",
        {
          offset: props.offset,
          timeout: poll,
          allowed_updates: ["message", "callback_query", "stopped_message_generation"],
        },
        poll * 1_000 + CALL_TIMEOUT_MS,
      )
    },
    sendMessage(params) {
      return callWithFallback<{ message_id: number; ephemeral_message_id?: number }>("sendMessage", {
        chat_id: params.chatID,
        text: params.text,
        ...(params.replyMarkup ? { reply_markup: serialMarkup(params.replyMarkup) } : {}),
        ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
        ...(params.ephemeralMessageParameters ? { ephemeral_message_parameters: params.ephemeralMessageParameters } : {}),
        ...(params.disableNotification ? { disable_notification: true } : {}),
      })
    },
    editMessageText(params) {
      const body: Record<string, unknown> = {
        chat_id: params.chatID,
        message_id: params.messageID,
        text: params.text,
      }
      if (params.replyMarkup !== undefined) body.reply_markup = params.replyMarkup ? serialMarkup(params.replyMarkup) : { inline_keyboard: [] }
      if (params.parseMode) body.parse_mode = params.parseMode
      return callWithFallback<void>("editMessageText", body).catch((err) => {
        if (err instanceof Error && /message is not modified/.test(err.message)) return
        throw err
      })
    },
    deleteMessage(params) {
      return call<void>("deleteMessage", { chat_id: params.chatID, message_id: params.messageID })
    },
    setMessageReaction(params) {
      return call<void>("setMessageReaction", {
        chat_id: params.chatID,
        message_id: params.messageID,
        reaction: [{ type: "emoji", emoji: params.emoji }],
      })
    },
    pinChatMessage(params) {
      return call<void>("pinChatMessage", {
        chat_id: params.chatID,
        message_id: params.messageID,
        ...(params.disableNotification ? { disable_notification: true } : {}),
      })
    },
    unpinChatMessage(params) {
      return call<void>("unpinChatMessage", { chat_id: params.chatID, message_id: params.messageID })
    },
    sendRichMessage(params) {
      const extra: Record<string, unknown> = {}
      if (params.ephemeralMessageParameters) extra.ephemeral_message_parameters = params.ephemeralMessageParameters
      if (params.disableNotification) extra.disable_notification = true
      if (params.files?.length) return sendRichMultipart(params.chatID, params.rich_message, params.files, extra)
      return call<{ message_id: number; ephemeral_message_id?: number }>("sendRichMessage", {
        chat_id: params.chatID,
        rich_message: params.rich_message,
        ...extra,
      })
    },
    editRichMessage(params) {
      return callWithFallback<void>("editMessageText", {
        chat_id: params.chatID,
        message_id: params.messageID,
        rich_message: params.rich_message,
      }).catch((err) => {
        if (err instanceof Error && /message is not modified/.test(err.message)) return
        throw err
      })
    },
    deleteEphemeralMessage(params) {
      return call<void>("deleteEphemeralMessage", { chat_id: params.chatID, ephemeral_message_id: params.ephemeralMessageID })
    },
    sendChatAction(params) {
      return call<void>("sendChatAction", { chat_id: params.chatID, action: params.action })
    },
    answerCallbackQuery(params) {
      return call<void>("answerCallbackQuery", { callback_query_id: params.id, text: params.text })
    },
    setMyCommands(commands) {
      return call<void>("setMyCommands", { commands })
    },
    async getFileContent(fileID) {
      const { file_path } = await call<{ file_path: string }>("getFile", { file_id: fileID })
      // file downloads live under `/file/bot<token>/<file_path>`, not the methods base
      try {
        const res = await fetch(`${TG_FILE}${token}/${file_path}`, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) })
        if (!res.ok) throw new Error(`telegram getFile download: ${res.status}`)
        return Buffer.from(await res.arrayBuffer())
      } catch (err) {
        if ((err as Error)?.name === "TimeoutError") {
          throw new Error(`telegram getFile download: timed out after ${FILE_TIMEOUT_MS}ms`)
        }
        throw err
      }
    },
    async sendPhoto(params) {
      return sendMultipart("sendPhoto", params.chatID, params.filePath, params.caption)
    },
    async sendDocument(params) {
      return sendMultipart("sendDocument", params.chatID, params.filePath, params.caption)
    },
    sendMessageDraft(params) {
      return callWithFallback<void>("sendMessageDraft", {
        chat_id: params.chatID,
        draft_id: params.draftID,
        ...(params.text !== undefined ? { text: params.text } : {}),
        ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
        ...(params.canStop ? { can_stop: true } : {}),
      })
    },
    sendRichMessageDraft(params) {
      return call<void>("sendRichMessageDraft", {
        chat_id: params.chatID,
        draft_id: params.draftID,
        rich_message: params.rich_message,
        ...(params.canStop ? { can_stop: true } : {}),
      })
    },
  }
}
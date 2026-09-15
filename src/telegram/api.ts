import { readFile } from "node:fs/promises"
import { basename } from "node:path"

const TG_API = "https://api.telegram.org/bot"
const TG_FILE = "https://api.telegram.org/file/bot"

export interface TgUser {
  id: number
  username?: string
  first_name?: string
}

export interface TgMessage {
  message_id: number
  chat: { id: number; type: string }
  from?: TgUser
  text?: string
  caption?: string
  photo?: { file_id: string; file_unique_id?: string; width?: number; height?: number; file_size?: number }[]
  document?: { file_id: string; file_unique_id?: string; file_name?: string; mime_type?: string; file_size?: number }
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
}

export type ReplyMarkup = { inline_keyboard: InlineButton[][] }

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
  }): Promise<{ message_id: number }>
  editMessageText(params: {
    chatID: number
    messageID: number
    text: string
    replyMarkup?: ReplyMarkup | null
    parseMode?: ParseMode
  }): Promise<void>
  deleteMessage(params: { chatID: number; messageID: number }): Promise<void>
  sendRichMessage(params: { chatID: number; rich_message: Record<string, unknown> }): Promise<{ message_id: number }>
  sendChatAction(params: { chatID: number; action: string }): Promise<void>
  answerCallbackQuery(params: { id: string; text?: string }): Promise<void>
  setMyCommands(commands: TgBotCommand[]): Promise<void>
  /** download a message's file (photo/document) as raw bytes */
  getFileContent(fileID: string): Promise<Buffer>
  sendPhoto(params: { chatID: number; filePath: string; caption?: string }): Promise<{ message_id: number }>
  sendDocument(params: { chatID: number; filePath: string; caption?: string }): Promise<{ message_id: number }>
  /** Bot API 9.4+: animated preview while the answer is being generated */
  sendMessageDraft(params: { chatID: number; draftID: number; text?: string; canStop?: boolean }): Promise<void>
  /** Bot API 10.1+: animated rich-message preview while the answer is being generated */
  sendRichMessageDraft(params: { chatID: number; draftID: number; rich_message: Record<string, unknown>; canStop?: boolean }): Promise<void>
}

export function createTelegramApi(token: string): TelegramApi {
  const url = (method: string) => `${TG_API}${token}/${method}`

  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(url(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as { ok: boolean; result: T; description?: string }
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? "unknown error"}`)
    return json.result
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

  async function sendMultipart(method: "sendPhoto" | "sendDocument", chatID: number, filePath: string, caption?: string) {
    const bytes = await readFile(filePath)
    const name = basename(filePath)
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase()
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream"
    const form = new FormData()
    form.append("chat_id", String(chatID))
    form.append(method === "sendPhoto" ? "photo" : "document", new Blob([new Uint8Array(bytes)], { type: mime }), name)
    if (caption) form.append("caption", caption)
    const res = await fetch(url(method), { method: "POST", body: form })
    const json = (await res.json()) as { ok: boolean; result: { message_id: number }; description?: string }
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? "unknown error"}`)
    return json.result
  }

  return {
    async getUpdates(props) {
      return call<TgUpdate[]>("getUpdates", {
        offset: props.offset,
        timeout: props.timeout ?? 30,
        allowed_updates: ["message", "callback_query", "stopped_message_generation"],
      })
    },
    sendMessage(params) {
      return callWithFallback<{ message_id: number }>("sendMessage", {
        chat_id: params.chatID,
        text: params.text,
        ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
        ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
      })
    },
    editMessageText(params) {
      const body: Record<string, unknown> = {
        chat_id: params.chatID,
        message_id: params.messageID,
        text: params.text,
      }
      if (params.replyMarkup !== undefined) body.reply_markup = params.replyMarkup ?? { inline_keyboard: [] }
      if (params.parseMode) body.parse_mode = params.parseMode
      return callWithFallback<void>("editMessageText", body).catch((err) => {
        if (err instanceof Error && /message is not modified/.test(err.message)) return
        throw err
      })
    },
    deleteMessage(params) {
      return call<void>("deleteMessage", { chat_id: params.chatID, message_id: params.messageID })
    },
    sendRichMessage(params) {
      return call<{ message_id: number }>("sendRichMessage", {
        chat_id: params.chatID,
        rich_message: params.rich_message,
      })
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
      const res = await fetch(`${TG_FILE}${token}/${file_path}`)
      if (!res.ok) throw new Error(`telegram getFile download: ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    },
    async sendPhoto(params) {
      return sendMultipart("sendPhoto", params.chatID, params.filePath, params.caption)
    },
    async sendDocument(params) {
      return sendMultipart("sendDocument", params.chatID, params.filePath, params.caption)
    },
    sendMessageDraft(params) {
      return call<void>("sendMessageDraft", {
        chat_id: params.chatID,
        draft_id: params.draftID,
        ...(params.text !== undefined ? { text: params.text } : {}),
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
import { readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs"
import { join, sep } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { startOpenCodeServer } from "./adapters/opencode.ts"
import { assertAdapterImplements } from "./core/compliance.ts"
import type { HarnessAdapter } from "./core/ports.ts"
import { TelegramBot } from "./telegram/bot.ts"
import { createTelegramApi, type TelegramApi, type TgUpdate } from "./telegram/api.ts"
import { Pairing, newPairCode } from "./telegram/pair.ts"
import { ChatStore } from "./telegram/store.ts"
import { ReminderStore } from "./telegram/reminders.ts"

const FIXTURE = join(import.meta.dirname, "..", "fixture")
const DEFAULT_WORKSPACES = ["workspace-alpha", "workspace-beta"].map((n) => join(FIXTURE, n))
const DATA_HOME = process.env.JEP_DATA_HOME ?? mkdtempSync(join(tmpdir(), "jep-tg-"))
const UPLOADS_DIR = join(DATA_HOME, "uploads")

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface CallRec {
  method: string
  chatID?: number
  messageID?: number
  text?: string
  parse_mode?: string
  reply_markup?: { inline_keyboard: Array<Array<Record<string, unknown>>>; force_reply?: boolean }
  rich?: unknown
  silent?: boolean
  ephemeral?: number
}

interface Ws {
  name: string
  dir: string
  adapter: HarnessAdapter
}

// Ws.name is a routing key — chats persist it to pick their workspace, and
// #ws(name) resolves it by first match — so two directories sharing a
// basename must not share a name, or the second one is unreachable and its
// chats silently route to the first. Widen the name leftwards along the path
// until it's unique ("jep", then "code/jep", ...), falling back to the whole
// directory if even that collides.
function uniqueWsName(dir: string, taken: Ws[]): string {
  const segs = dir.split(sep).filter(Boolean)
  const used = new Set(taken.map((w) => w.name))
  for (let n = 1; n <= segs.length; n++) {
    const name = segs.slice(-n).join(sep)
    if (!used.has(name)) return name
  }
  return dir
}

// opencode serve runs with an isolated XDG_DATA_HOME so the bot's sessions
// never mix with the user's CLI. That isolation hides opencode auth — the bot
// couldn't run opencode-go (Go subscription) or zen models. Mirror the user's
// real auth.json into the isolated store so every pickable model actually runs.
function syncOpenCodeAuth(): void {
  if (process.env.JEP_TG_MOCK === "1") return
  const real = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json")
  const dst = join(DATA_HOME, "opencode", "auth.json")
  if (!existsSync(real)) return
  try {
    mkdirSync(join(DATA_HOME, "opencode"), { recursive: true })
    copyFileSync(real, dst)
  } catch {
    /* read-only data home — go/zen models will still be listed but may not run */
  }
}

async function buildMockApi(): Promise<TelegramApi> {
  const updates = readFileSync(0, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TgUpdate)
  let nextID = 1
  const calls: CallRec[] = []
  return {
    async getUpdates(props) {
      return updates
        .filter((u) => props.offset == null || u.update_id >= props.offset)
        .splice(0)
    },
    async sendMessage(params) {
      calls.push({
        method: "sendMessage",
        chatID: params.chatID,
        text: params.text,
        ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
        ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
        ...(params.disableNotification ? { silent: true } : {}),
        ...(params.ephemeralMessageParameters ? { ephemeral: params.ephemeralMessageParameters.receiver_user_id } : {}),
      })
      const id = nextID++
      return params.ephemeralMessageParameters ? { message_id: id, ephemeral_message_id: nextID++ } : { message_id: id }
    },
    async editMessageText(params) {
      calls.push({ method: "editMessageText", chatID: params.chatID, messageID: params.messageID, text: params.text, ...(params.parseMode ? { parse_mode: params.parseMode } : {}) })
    },
    async deleteMessage(params) {
      calls.push({ method: "deleteMessage", chatID: params.chatID, messageID: params.messageID })
    },
    async pinChatMessage(params) {
      calls.push({ method: "pinChatMessage", chatID: params.chatID, messageID: params.messageID })
    },
    async unpinChatMessage(params) {
      calls.push({ method: "unpinChatMessage", chatID: params.chatID, messageID: params.messageID })
    },
    async sendRichMessage(params) {
      calls.push({
        method: "sendRichMessage",
        chatID: params.chatID,
        rich: params.rich_message,
        ...(params.files?.length ? { text: `files=${params.files.map((f) => f.name).join(",")}` } : {}),
        ...(params.disableNotification ? { silent: true } : {}),
        ...(params.ephemeralMessageParameters ? { ephemeral: params.ephemeralMessageParameters.receiver_user_id } : {}),
      })
      const id = nextID++
      return params.ephemeralMessageParameters ? { message_id: id, ephemeral_message_id: nextID++ } : { message_id: id }
    },
    async editRichMessage(params) {
      calls.push({ method: "editRichMessage", chatID: params.chatID, messageID: params.messageID, rich: params.rich_message })
    },
    async deleteEphemeralMessage(params) {
      calls.push({ method: "deleteEphemeralMessage", chatID: params.chatID, messageID: params.ephemeralMessageID })
    },
    async sendMessageDraft(params) {
      calls.push({ method: "sendMessageDraft", chatID: params.chatID, text: `draft=${params.draftID} text=${JSON.stringify(params.text ?? "")} can_stop=${params.canStop === true}` })
    },
    async sendRichMessageDraft(params) {
      calls.push({ method: "sendRichMessageDraft", chatID: params.chatID, rich: { draft: params.draftID, ...(params.rich_message as Record<string, unknown>) }, text: `draft=${params.draftID}` })
    },
    async sendChatAction(params) {
      calls.push({ method: "sendChatAction", chatID: params.chatID })
    },
    async answerCallbackQuery(params) {
      calls.push({ method: "answerCallbackQuery", text: params.text })
    },
    async setMyCommands(commands) {
      calls.push({ method: "setMyCommands", text: `n=${commands.length}: ${commands.map((c) => "/" + c.command).join(" ")}` })
    },
    async getFileContent() {
      // 1x1 transparent PNG so ingest/upload paths run without a real download
      return Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      )
    },
    async sendPhoto(params) {
      calls.push({ method: "sendPhoto", chatID: params.chatID, text: `file=${params.filePath}${params.caption ? ` caption=${JSON.stringify(params.caption)}` : ""}` })
      return { message_id: nextID++ }
    },
    async sendDocument(params) {
      calls.push({ method: "sendDocument", chatID: params.chatID, text: `file=${params.filePath}${params.caption ? ` caption=${JSON.stringify(params.caption)}` : ""}` })
      return { message_id: nextID++ }
    },
    dump() {
      for (const c of calls) {
        console.log(`CALL ${c.method} chat=${c.chatID}${c.messageID ? ` msg=${c.messageID}` : ""}${c.parse_mode ? ` mode=${c.parse_mode}` : ""}${c.silent ? " silent" : ""}${c.ephemeral != null ? ` ephemeral=${c.ephemeral}` : ""}${c.rich ? ` rich=${JSON.stringify(c.rich).slice(0, 220)}` : ""} text=${JSON.stringify(c.text ?? "")}`)
        if (c.reply_markup) console.log(`     keyboard: ${JSON.stringify(c.reply_markup.inline_keyboard)}${c.reply_markup.force_reply ? " force_reply" : ""}`)
      }
    },
  }
}

async function main() {
  syncOpenCodeAuth()
  const mockMode = process.env.JEP_TG_MOCK === "1"
  const dirs = (process.env.JEP_WORKSPACES ?? "").split(":").filter(Boolean)
  // no env var to set up before the bot is useful: outside mock mode, the
  // workspace defaults to wherever this process was launched from/with (the
  // plist's WorkingDirectory, or wherever you `cd`'d before running it).
  // Mock mode keeps the bundled two-workspace fixtures so switching between
  // workspaces stays testable regardless of the caller's own cwd.
  const workspaceDirs = dirs.length ? dirs : mockMode ? DEFAULT_WORKSPACES : [process.cwd()]

  const workspaces: Ws[] = []

  // shared by the boot loop below and by TelegramBot#discoverWorkspaces,
  // which calls this later to start serving a project it finds out about
  // only after boot (e.g. via the adapter's listProjects). The bot holds this
  // very array, so names stay unique across both paths.
  const spawnWorkspace = async (dir: string): Promise<Ws> => {
    const ad = await startOpenCodeServer(dir, { dataHome: DATA_HOME })
    assertAdapterImplements(ad)
    return { name: uniqueWsName(dir, workspaces), dir, adapter: ad }
  }

  for (const dir of workspaceDirs) workspaces.push(await spawnWorkspace(dir))
  const activeWsName = workspaces[0]!.name

  const tg = mockMode ? await buildMockApi() : createTelegramApi(process.env.JEP_TG_TOKEN ?? "")

  const pairFile = join(DATA_HOME, "pairing.json")
  const code = process.env.JEP_TG_PAIR_CODE ?? newPairCode()
  const pairMax = Number(process.env.JEP_TG_PAIR_MAX ?? "") || 5
  const pairWindowMs = (Number(process.env.JEP_TG_PAIR_WINDOW ?? "") || 60) * 1000
  const r = Number(process.env.JEP_TG_PAIR_ROTATE ?? "")
  const pairRotate = Number.isFinite(r) ? r : 10
  const pairing = Pairing.load(code, pairFile, { max: pairMax, windowMs: pairWindowMs, rotateAt: pairRotate })
  const ownerSeed = process.env.JEP_TG_OWNER
  if (ownerSeed && pairing.owner === null) pairing.adoptOwner(Number(ownerSeed))

  console.error(`jep-tg  ·  data home: ${DATA_HOME}`)
  console.error(`workspaces: ${workspaces.map((w) => w.name).join(", ")}  ·  mode: ${mockMode ? "MOCK" : "live"}`)
  if (pairing.owner === null) {
    console.error(`pairing code: ${code}   (send /pair ${code} in Telegram to claim the bot)`)
  } else {
    console.error(`owner: ${pairing.owner}  ·  paired chats: ${pairing.count()}`)
  }

  const bot = new TelegramBot(tg, workspaces, activeWsName, pairing, ChatStore.load(join(DATA_HOME, "store.json")), (process.env.JEP_TG_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean), UPLOADS_DIR, spawnWorkspace, ReminderStore.load(join(DATA_HOME, "reminders.json")))

  try {
    await tg.setMyCommands(TelegramBot.commands)
  } catch (err) {
    console.error("setMyCommands failed:", (err as Error).message)
  }

  let offset = 0
  let backoff = 1_000
  for (;;) {
    let updates: TgUpdate[]
    try {
      updates = await tg.getUpdates({ offset, timeout: mockMode ? 0 : 30 })
    } catch (err) {
      // Telegram long-polling throws transient 50x/network errors routinely;
      // a single one must never kill the daemon. Back off and retry.
      if (mockMode) throw err
      console.error(`getUpdates failed (${new Date().toISOString()}): ${(err as Error).message} — retrying in ${backoff / 1000}s`)
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 30_000)
      continue
    }
    backoff = 1_000
    for (const u of updates) {
      if (u.update_id >= offset) offset = u.update_id + 1
      try {
        await bot.handleUpdate(u)
      } catch (err) {
        console.error(`update ${u.update_id} failed (continuing):`, (err as Error).message)
      }
    }
    if (mockMode && updates.length === 0) break
  }

  // turns run off the update loop now, so the fixture's last prompts may still
  // be in flight when the mock input runs dry — let them finish before dumping
  await bot.drain()
  const dump = (tg as { dump?: () => void }).dump
  if (dump) dump()
  for (const ws of workspaces) await ws.adapter.close()
  console.error("bye.")
}

main().catch((err) => {
  console.error("jep-tg failed:", err)
  process.exit(1)
})
import { readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs"
import { join, sep } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { buildHarnesses, DEFAULT_HARNESS } from "./core/harnesses.ts"
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

// how much of a rich message the mock dump prints. 220 was short enough to cut
// off the tail of a settings menu, which hides exactly the rows you are
// usually checking for; JEP_DUMP_CHARS widens it further when needed.
const RICH_DUMP_CHARS = Number(process.env.JEP_DUMP_CHARS ?? "") || 2000

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
  // one directory keeps one name no matter how many harnesses serve it —
  // the harness is a separate axis, not a different workspace
  const sameDir = taken.find((w) => w.dir === dir)
  if (sameDir) return sameDir.name
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
        console.log(`CALL ${c.method} chat=${c.chatID}${c.messageID ? ` msg=${c.messageID}` : ""}${c.parse_mode ? ` mode=${c.parse_mode}` : ""}${c.silent ? " silent" : ""}${c.ephemeral != null ? ` ephemeral=${c.ephemeral}` : ""}${c.rich ? ` rich=${JSON.stringify(c.rich).slice(0, RICH_DUMP_CHARS)}` : ""} text=${JSON.stringify(c.text ?? "")}`)
        if (c.reply_markup) console.log(`     keyboard: ${JSON.stringify(c.reply_markup.inline_keyboard)}${c.reply_markup.force_reply ? " force_reply" : ""}`)
      }
    },
  }
}

async function main() {
  syncOpenCodeAuth()
  const mockMode = process.env.JEP_TG_MOCK === "1"
  const store = ChatStore.load(join(DATA_HOME, "store.json"))
  const dirs = (process.env.JEP_WORKSPACES ?? "").split(":").filter(Boolean)
  // no env var to set up before the bot is useful: outside mock mode, the
  // workspace defaults to wherever this process was launched from/with (the
  // plist's WorkingDirectory, or wherever you `cd`'d before running it).
  // Mock mode keeps the bundled two-workspace fixtures so switching between
  // workspaces stays testable regardless of the caller's own cwd.
  const bootDirs = dirs.length ? dirs : mockMode ? DEFAULT_WORKSPACES : [process.cwd()]
  // ...plus anything added from the phone. Env dirs stay first, so the active
  // workspace is still whatever the machine was configured with. A saved dir
  // that has since been deleted is dropped rather than failing the boot.
  const saved = store.workspaces().filter((d) => {
    if (existsSync(d)) return true
    console.error(`[ws] forgetting ${d} — no longer on disk`)
    store.removeWorkspace(d)
    return false
  })
  const workspaceDirs = [...new Set([...bootDirs, ...saved])]

  const workspaces: Ws[] = []

  // shared by the boot loop below and by TelegramBot#discoverWorkspaces,
  // which calls this later to start serving a project it finds out about
  // only after boot (e.g. via the adapter's listProjects). The bot holds this
  // very array, so names stay unique across both paths.
  const harnesses = buildHarnesses({ dataHome: DATA_HOME })
  const spawnWorkspace = async (dir: string, harnessID?: string): Promise<Ws> => {
    const want = harnessID ?? DEFAULT_HARNESS
    const harness = harnesses.find((h) => h.id === want)
    if (!harness) throw new Error(`unknown harness '${want}' (have: ${harnesses.map((h) => h.id).join(", ")})`)
    const ad = await harness.start(dir)
    assertAdapterImplements(ad)
    return { name: uniqueWsName(dir, workspaces), dir, adapter: ad }
  }

  // one bad directory must not take the whole bot down with it — a saved
  // workspace can rot (moved repo, unreadable mount) long after it was added
  for (const dir of workspaceDirs) {
    try {
      workspaces.push(await spawnWorkspace(dir))
    } catch (err) {
      console.error(`[ws] skipping ${dir}: ${(err as Error)?.message ?? err}`)
    }
  }
  // A chat can be pointed at a non-default harness, and that harness is
  // normally started on demand by the picker — which does not survive a
  // restart. Without this the chat silently fell back to opencode while still
  // holding a codex session id, and every read 500'd.
  for (const ctx of store.allChatContexts()) {
    if (!ctx.harness || ctx.harness === DEFAULT_HARNESS) continue
    if (!existsSync(ctx.dir)) continue
    if (workspaces.some((w) => w.dir === ctx.dir && w.adapter.id === ctx.harness)) continue
    try {
      workspaces.push(await spawnWorkspace(ctx.dir, ctx.harness))
      console.error(`[ws] restored ${ctx.harness} for ${ctx.dir}`)
    } catch (err) {
      console.error(`[ws] couldn't restore ${ctx.harness} for ${ctx.dir}: ${(err as Error)?.message ?? err}`)
    }
  }

  if (!workspaces.length) throw new Error(`no workspace could be started (tried: ${workspaceDirs.join(", ")})`)
  const activeWsName = workspaces[0]!.name

  // The update loop never returns in live mode, so the close() sweep at the
  // end of main() only ever ran under the mock. Every real restart therefore
  // orphaned one `opencode serve` per workspace to init, and they accumulated
  // silently across restarts. launchd stops us with SIGTERM, so take the hint
  // and shut the children down first. `workspaces` is the live array the bot
  // itself appends to, so lazily-started servers get cleaned up too.
  let stopping = false
  const shutdown = async (sig: string) => {
    if (stopping) return
    stopping = true
    console.error(`${sig} — stopping ${workspaces.length} workspace server(s)`)
    await Promise.all(workspaces.map((w) => w.adapter.close().catch(() => {})))
    process.exit(0)
  }
  process.once("SIGTERM", () => void shutdown("SIGTERM"))
  process.once("SIGINT", () => void shutdown("SIGINT"))

  // only offer harnesses that are actually installed here — a picker row that
  // always fails is worse than no row
  const available: Array<{ id: string; label: string; icon: string }> = []
  for (const h of harnesses) {
    if (mockMode && h.id !== DEFAULT_HARNESS) continue
    if (await h.available()) available.push({ id: h.id, label: h.label, icon: h.icon })
    else console.error(`[harness] ${h.id} unavailable — not offering it`)
  }
  console.error(`harnesses: ${available.map((h) => h.id).join(", ") || "(none)"}`)

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

  const bot = new TelegramBot(tg, workspaces, activeWsName, pairing, store, (process.env.JEP_TG_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean), UPLOADS_DIR, spawnWorkspace, available, ReminderStore.load(join(DATA_HOME, "reminders.json")))

  // One-shot at boot, and boot is exactly when the network is least likely to
  // be up: the machine has often just woken, which is what kills the long poll
  // an hour at a time. A blip here used to leave the slash-command menu stale
  // until the next restart, so retry a few times before giving up.
  void (async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await tg.setMyCommands(TelegramBot.commands)
        if (attempt > 1) console.error(`setMyCommands succeeded on attempt ${attempt}`)
        return
      } catch (err) {
        console.error(`setMyCommands failed (attempt ${attempt}/5):`, (err as Error).message)
        await sleep(Math.min(1_000 * 2 ** (attempt - 1), 30_000))
      }
    }
  })()

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
// The gateway is jep's second presentation adapter — a native phone client
// speaks to the same core the Telegram bot speaks to: plain HTTP commands plus
// one push feed (Server-Sent Events), consuming the very same
// HarnessAdapter port. It holds no chat-store state and touches no Telegram
// surface. Every endpoint the phone can call is listed in docs/GATEWAY.md,
// which stays in step with this file.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { execFile } from "node:child_process"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import type { HarnessAdapter, HarnessSettingSpec, SessionImport, Terminal } from "../../core/ports.ts"
import type { PairingAdmin } from "../../core/pairing.ts"
import { pushFor, UnregisteredToken, type PushNotifier } from "../../core/push.ts"
import { judgeTurn, LIVENESS, type LivenessConfig } from "../../core/liveness.ts"
import { readClaudeMcp, readCodexMcp, readOpencodeMcp, writeClaudeProjectEnabled, writeCodexMcpEnabled, writeOpencodeMcpEnabled } from "../../core/mcpconfig.ts"
import { listSkills, skillDirsFor, writeSkillModelInvocation } from "../../core/skills.ts"
import type { AskRequest, DomainEvent, HarnessError, Message, Part } from "../../core/types.ts"
import { eventSession, isAborted } from "../../core/types.ts"
import { describeError } from "../../core/errors.ts"
import { usageOf } from "../../core/usage.ts"
import { attachedPaths, stripInjectedContext, transcriptText } from "../../core/transcript.ts"
import { newPairCode } from "../telegram/pair.ts"

export interface GatewayDeps {
  // called lazily and repeatedly: the Telegram bot can spawn more workspace
  // servers at any time (project discovery), and the gateway must pick up
  adapters(): Array<{ name: string; adapter: HarnessAdapter }>
  /** the harnesses installed here, and the default — what a conversation may
   * be created under, independent of any one workspace */
  harnesses?(): { ids: string[]; default: string }
  /** settings schemas for harnesses that have not started a workspace yet */
  harnessSettings?(harness: string): HarnessSettingSpec[]
  /** bring a directory up as a workspace under a harness, the way the bot's
   * "Add project" does; the gateway holds no spawn logic of its own */
  addWorkspace?(dir: string, harness?: string): Promise<{ name: string; adapter: HarnessAdapter }>
  /** the directory the browser may not climb above (default $HOME) */
  browseRoot?: string
  /** restart the server serving a directory — an imported session is in the
   * store but a running opencode server only lists sessions from its own boot,
   * so it has to come up again to see it */
  restartWorkspace?(dir: string): Promise<void>
  /** the harness whose separate store can be imported from (opencode), when
   * one exists — the gateway knows only this port, never the storage */
  import?: SessionImport
  /** a shell per conversation, when the operator allows terminals — the port
   * owns how it runs (tmux today), the gateway owns only the policy */
  terminal?: Terminal
  /** how a sleeping phone is woken. Absent = no push configured, and the
   * device falls back to its own connection */
  push?: PushNotifier
  dataHome: string
  port: number
  /** pinned pairing code; generated fresh per boot when omitted */
  pairCode?: string
  /** attempts per address per minute before the pair gate slams shut; a
   * production default, loosened by tests that must pair repeatedly */
  pairLimit?: number
  /** turn-liveness ceilings, for an operator who wants them shorter or longer
   * than the JEP_TURN_IDLE_MS / JEP_TOOL_IDLE_MS defaults (and for tests, which
   * cannot wait out five real minutes) */
  liveness?: Partial<LivenessConfig>
}

export interface GatewayHandle {
  close(): Promise<void>
  /** the code currently accepted by POST /pair — for the boot banner */
  pairCode: string
  /** the port actually bound (useful when the caller passes 0) */
  port: number
  /** this client's pairing surface, for the daemon's aggregate view */
  pairingAdmin: PairingAdmin
}

const TOKEN_FILE = "gateway-tokens.json"
const TITLES_FILE = "gateway-titles.json"
const MODELS_FILE = "gateway-models.json"
const AGENTS_FILE = "gateway-agents.json"
const TERMINAL_FILE = "gateway-terminal.json"
const ARCHIVED_FILE = "gateway-archived.json"
const SEEN_FILE = "gateway-seen.json"
const PUSH_FILE = "gateway-push.json"
const HARNESS_SETTINGS_FILE = "gateway-harness-settings.json"
// asks remembered per conversation for /history; pending ones are never dropped
const ASK_LEDGER_MAX = 50
const BODY_MAX = 1 << 20

// Turn liveness — when a quiet turn is given up on — is core/liveness.ts,
// shared with the Telegram client so both give up at the same moment.

interface AskRecord {
  ask: AskRequest
  /** pending: waiting on a human. answered: a client chose `answer`. closed:
   * settled some other way — answered elsewhere, stood down, or outlived by
   * the turn that raised it */
  state: "pending" | "answered" | "closed"
  answer?: string
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface GitCommitView {
  hash: string
  shortHash: string
  subject: string
  author: string
  time: number
}

function gitText(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout: 4_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

async function gitSnapshot(cwd: string) {
  try {
    await gitText(cwd, ["rev-parse", "--show-toplevel"])
  } catch {
    return { isRepository: false, branch: null, head: null, changedFiles: 0, commits: [] as GitCommitView[] }
  }
  const [branchText, statusText, logText] = await Promise.all([
    gitText(cwd, ["branch", "--show-current"]).catch(() => ""),
    gitText(cwd, ["status", "--porcelain=v1", "--untracked-files=no"]).catch(() => ""),
    gitText(cwd, ["log", "-n", "30", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1e"]).catch(() => ""),
  ])
  const commits = logText.split("\x1e").flatMap((record) => {
    const fields = record.trim().split("\x1f")
    if (fields.length < 5 || !fields[0]) return []
    const time = Number(fields[4])
    return [{ hash: fields[0]!, shortHash: fields[1]!, subject: fields[2]!, author: fields[3]!, time: Number.isFinite(time) ? time : 0 }]
  })
  const branch = branchText.trim() || (commits.length ? "detached HEAD" : "unborn branch")
  return {
    isRepository: true,
    branch,
    head: commits[0] ?? null,
    changedFiles: statusText.split("\n").filter(Boolean).length,
    commits,
  }
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest()
const same = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b))

// The harness stores jep's own context header on a session's first prompt, and
// splices its machinery (system reminders, command envelopes, background
// output) into user turns. None of it belongs on the phone: show what the
// person actually typed, the same way the Telegram client strips it.
function cleanForDisplay(m: Message): Message {
  if (m.role !== "user") return m
  // A print-mode harness (claude) gets attachments as a path list in the text.
  // The list is stripped from what is shown, and the files it named come back
  // as file parts: stripped alone, the message lost its thumbnail the moment
  // the phone swapped its own copy for the record.
  const files: Part[] = m.parts.flatMap((p) =>
    p.kind === "text"
      ? attachedPaths(stripInjectedContext(p.text)).map((fp) => ({ kind: "file" as const, filePath: fp, fileName: basename(fp), mimeType: mimeForPath(fp) }))
      : [],
  )
  const parts = m.parts
    .map((p) => (p.kind === "text" ? { ...p, text: transcriptText(p.text) } : p))
    .filter((p) => p.kind !== "text" || p.text.trim().length > 0)
  return { ...m, parts: [...parts, ...files] }
}

// Content type for a file the phone fetches: enough for images to render
// inline; anything else is served as octets.
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  heic: "image/heic",
  avif: "image/avif",
}
function mimeForPath(p: string): string {
  const dot = p.lastIndexOf(".")
  const ext = dot >= 0 ? p.slice(dot + 1).toLowerCase() : ""
  return IMAGE_MIME[ext] ?? "application/octet-stream"
}
const FILE_MAX = 25 * 1024 * 1024

async function loadTokens(dataHome: string): Promise<Map<string, number>> {
  try {
    const raw = JSON.parse(await readFile(join(dataHome, TOKEN_FILE), "utf8")) as Record<string, number>
    return new Map(Object.entries(raw))
  } catch {
    return new Map()
  }
}

const saveTokens = async (dataHome: string, tokens: Map<string, number>): Promise<void> => {
  await mkdir(dataHome, { recursive: true })
  await writeFile(join(dataHome, TOKEN_FILE), JSON.stringify(Object.fromEntries(tokens), null, 1))
}

// The phone renames conversations its own way — like Telegram, the rename is a
// client concern. jep's harnesses don't expose one, so the gateway keeps its
// own overrides (persisted, like the tokens) and overlays them on listings.
async function loadTitles(dataHome: string): Promise<Map<string, string>> {
  try {
    const raw = JSON.parse(await readFile(join(dataHome, TITLES_FILE), "utf8")) as Record<string, string>
    return new Map(Object.entries(raw))
  } catch {
    return new Map()
  }
}

const saveTitles = async (dataHome: string, titles: Map<string, string>): Promise<void> => {
  await mkdir(dataHome, { recursive: true })
  await writeFile(join(dataHome, TITLES_FILE), JSON.stringify(Object.fromEntries(titles), null, 1))
}

// The model a conversation runs on is a client concern here too: the phone
// picks one per session from Settings, and the gateway remembers it (persisted,
// like the titles) so the choice survives the app closing and applies to the
// next prompt. Default is no override — the harness's own model.
async function loadModels(dataHome: string): Promise<Map<string, string>> {
  try {
    const raw = JSON.parse(await readFile(join(dataHome, MODELS_FILE), "utf8")) as Record<string, string>
    return new Map(Object.entries(raw))
  } catch {
    return new Map()
  }
}

const saveModels = async (dataHome: string, models: Map<string, string>): Promise<void> => {
  await mkdir(dataHome, { recursive: true })
  await writeFile(join(dataHome, MODELS_FILE), JSON.stringify(Object.fromEntries(models), null, 1))
}

// The primary agent (opencode's "build" / "plan") a conversation runs under,
// remembered per session exactly like the model. Not a harness — a harness is
// fixed for the life of a conversation.
async function loadAgents(dataHome: string): Promise<Map<string, string>> {
  try {
    const raw = JSON.parse(await readFile(join(dataHome, AGENTS_FILE), "utf8")) as Record<string, string>
    return new Map(Object.entries(raw))
  } catch {
    return new Map()
  }
}

const saveAgents = async (dataHome: string, agents: Map<string, string>): Promise<void> => {
  await mkdir(dataHome, { recursive: true })
  await writeFile(join(dataHome, AGENTS_FILE), JSON.stringify(Object.fromEntries(agents), null, 1))
}

type SessionHarnessSettings = Record<string, boolean>

async function loadHarnessSettings(dataHome: string): Promise<Map<string, SessionHarnessSettings>> {
  try {
    const raw = JSON.parse(await readFile(join(dataHome, HARNESS_SETTINGS_FILE), "utf8")) as Record<string, unknown>
    return new Map(Object.entries(raw).flatMap(([sessionID, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return []
      const settings = Object.fromEntries(Object.entries(value).filter((row): row is [string, boolean] => typeof row[1] === "boolean"))
      return [[sessionID, settings]]
    }))
  } catch {
    return new Map()
  }
}

const saveHarnessSettings = async (dataHome: string, settings: Map<string, SessionHarnessSettings>): Promise<void> => {
  await mkdir(dataHome, { recursive: true })
  await writeFile(join(dataHome, HARNESS_SETTINGS_FILE), JSON.stringify(Object.fromEntries(settings), null, 1))
}

function valuesForSettings(specs: HarnessSettingSpec[], values: SessionHarnessSettings = {}): SessionHarnessSettings {
  return Object.fromEntries(specs.map((setting) => [setting.id, values[setting.id] ?? setting.default]))
}

// Conversations the user filed away: hidden from the list, never deleted. Like
// the titles, a client-side concern the gateway remembers for the phone.
async function loadArchived(dataHome: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await readFile(join(dataHome, ARCHIVED_FILE), "utf8")) as string[]
    return new Set(raw)
  } catch {
    return new Set()
  }
}

// When each conversation was last looked at, on any device. "Unread" lived
// only on the phone, so a reinstall marked everything unread and two devices
// never agreed; the daemon is the one place both can read.
async function loadSeen(dataHome: string): Promise<Map<string, number>> {
  try {
    const raw = JSON.parse(await readFile(join(dataHome, SEEN_FILE), "utf8")) as Record<string, unknown>
    return new Map(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0))
  } catch {
    return new Map()
  }
}

const saveSeen = async (dataHome: string, seen: Map<string, number>): Promise<void> => {
  await mkdir(dataHome, { recursive: true })
  await writeFile(join(dataHome, SEEN_FILE), JSON.stringify(Object.fromEntries(seen), null, 1))
}

const saveArchived = async (dataHome: string, ids: Set<string>): Promise<void> => {
  await mkdir(dataHome, { recursive: true })
  await writeFile(join(dataHome, ARCHIVED_FILE), JSON.stringify([...ids], null, 1))
}

// Tokens that proved the pairing code a second time and are therefore allowed
// to open a shell. Kept apart from the plain paired tokens: holding a device
// token is not enough to get a terminal, on purpose.
async function loadTerminalTokens(dataHome: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await readFile(join(dataHome, TERMINAL_FILE), "utf8")) as string[]
    return new Set(raw)
  } catch {
    return new Set()
  }
}

const saveTerminalTokens = async (dataHome: string, tokens: Set<string>): Promise<void> => {
  await mkdir(dataHome, { recursive: true })
  await writeFile(join(dataHome, TERMINAL_FILE), JSON.stringify([...tokens], null, 1))
}

// Device tokens for push. One per installation; a phone that reinstalls
// registers a new one, and the old one is pruned when FCM says it is dead.
async function loadPushTokens(dataHome: string): Promise<Set<string>> {
  try {
    return new Set(JSON.parse(await readFile(join(dataHome, PUSH_FILE), "utf8")) as string[])
  } catch {
    return new Set()
  }
}

const savePushTokens = async (dataHome: string, tokens: Set<string>): Promise<void> => {
  await mkdir(dataHome, { recursive: true })
  await writeFile(join(dataHome, PUSH_FILE), JSON.stringify([...tokens], null, 1))
}

// A directory read can hang forever: a folder the launchd process can't reach
// (macOS TCC — Downloads/Documents/Desktop, with no grant) or a stalled mount.
// libuv's thread pool is small (4), so a few of those wedge every fs op and
// even DNS in the daemon. A browse is therefore bounded, serialized, and
// remembered — a folder that didn't answer is refused outright for a while
// instead of leaking another thread.

const BROWSE_TIMEOUT_MS = 4_000
const BROWSE_STALL_TTL_MS = 10 * 60_000
const stalledDirs = new Map<string, number>()
let browseInFlight = 0

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))])
}

async function listDirs(cwd: string): Promise<Array<{ name: string; git: boolean }>> {
  const entries = await readdir(cwd, { withFileTypes: true })
  const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."))
  // async, per-entry bounded: a synchronous stat here could block the event loop
  const out = await Promise.all(
    folders.map(async (e) => ({
      name: e.name,
      git: (await withTimeout(stat(join(cwd, e.name, ".git")).then(() => true).catch(() => false), 1_000)) === true,
    })),
  )
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// where each harness keeps its MCP config, so the phone can list and toggle
// servers the way the bot does — read straight from the file, zero turns
function mcpPaths(): { opencode: string; codex: string; claude: string } {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return {
    opencode: join(xdg, "opencode", "opencode.json"),
    codex: join(homedir(), ".codex", "config.toml"),
    claude: join(homedir(), ".claude.json"),
  }
}

/** keep a phone-supplied leaf filename from walking out of the uploads dir */
function leafName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file"
  return base.replace(/[^\w.\- ]/g, "_").slice(0, 120) || "file"
}

// DoS guard on the one unauthenticated endpoint (mirrors the Telegram Pairing
// limits): at most N attempts per rolling minute per address.
const PAIR_WINDOW_MS = 60_000
const pairAttempts = new Map<string, number[]>()
function pairRateOK(max: number, ip: string): boolean {
  const seen = (pairAttempts.get(ip) ?? []).filter((t) => Date.now() - t < PAIR_WINDOW_MS)
  if (seen.length >= max) return false
  seen.push(Date.now())
  pairAttempts.set(ip, seen)
  for (const [k, v] of pairAttempts) if (v.length === 0) pairAttempts.delete(k)
  return true
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > BODY_MAX) return undefined
    chunks.push(chunk as Buffer)
  }
  // an empty body is not invalid JSON — plenty of commands carry no payload
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return undefined
  }
}

/** a caller-supplied count: numbers only, clamped, with a sane default */
export function positiveInt(raw: string | null, fallback: number, lo: number, hi: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), lo), hi) : fallback
}

/**
 * A restart that waits for the work to finish.
 *
 * Restarting a daemon is how a change reaches the machine, but a restart taken
 * at the wrong moment cuts a live turn in half and leaves the user to wake the
 * agent up again by hand. So the restart is armed rather than fired: it exits
 * once the daemon has been quiet for `quietMs` — no harness event from any
 * client, so no turn is mid-flight — with `maxWaitMs` as a hard cap, because a
 * restart must never be the thing that wedges a deploy. Returns a cancel.
 */export function restartWhenQuiet(opts: {
  quietMs: number
  maxWaitMs: number
  /** when the last harness event arrived */
  activity: () => number
  exit: () => void
  intervalMs?: number
  log?: (msg: string) => void
}): () => void {
  const { quietMs, maxWaitMs, activity, exit, intervalMs = 500, log } = opts
  const started = Date.now()
  const tick = setInterval(() => {
    const idleFor = Date.now() - activity()
    if (idleFor >= quietMs || Date.now() - started >= maxWaitMs) {
      clearInterval(tick)
      log?.(`restart: idle ${Math.round(idleFor / 1000)}s — exiting for launchd`)
      exit()
    }
  }, intervalMs)
  tick.unref?.()
  return () => clearInterval(tick)
}

// attachments are handed over as raw octets, not JSON
const ATTACH_MAX = 32 << 20
async function readRaw(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > cap) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export async function startGateway(deps: GatewayDeps): Promise<GatewayHandle> {
  // single-use, always: every successful pairing or terminal unlock spends the
  // code and mints a fresh one, so a code seen once is never valid again
  let pairCode = deps.pairCode ?? newPairCode()
  let tokens = await loadTokens(deps.dataHome)
  // this client's pairing surface, reported through the shared admin port so
  // tooling never reads gateway files directly
  const pairingAdmin: PairingAdmin = {
    client: "gateway",
    status: () => ({
      client: "gateway",
      label: "Gateway (Android, native)",
      code: pairCode,
      owner: null,
      devices: tokens.size,
      hint: "enter the address, then this code",
    }),
  }
  const spendPairCode = (usedFor: string): void => {
    pairCode = newPairCode()
    pairingAdmin.onChange?.()
    console.error(`[gw] pairing code spent (${usedFor}) — new code: ${pairCode}`)
  }
  const titles = await loadTitles(deps.dataHome)
  const archived = await loadArchived(deps.dataHome)
  const seen = await loadSeen(deps.dataHome)
  const models = await loadModels(deps.dataHome)
  const agents = await loadAgents(deps.dataHome)
  const harnessSettings = await loadHarnessSettings(deps.dataHome)
  const terminalTokens = await loadTerminalTokens(deps.dataHome)
  const pushTokens = await loadPushTokens(deps.dataHome)
  // Whether this gateway offers a shell at all — an operator decision on the
  // machine, not something a paired phone can turn on for itself.
  const terminalAllowed = process.env.JEP_TERMINAL === "1" || process.env.JEP_TERMINAL === "true"

  // help-files the phone needs, resolved as events and commands arrive
  const sessionAdapters = new Map<string, HarnessAdapter>()
  const askSessions = new Map<string, string>()
  const liveness: LivenessConfig = { ...LIVENESS, ...deps.liveness }
  const idleGraceMs = liveness.idleGraceMs
  // Asks still waiting on a human, per session. A turn parked on a permission
  // prompt is not stalled — it is being polite — so the watchdog holds its fire
  // until the ask is answered or stood down.
  const asksBySession = new Map<string, Set<string>>()
  const openAsks = (sessionID: string): Set<string> => {
    const hit = asksBySession.get(sessionID)
    if (hit) return hit
    const fresh = new Set<string>()
    asksBySession.set(sessionID, fresh)
    return fresh
  }
  const closeAsk = (askID: string): void => {
    const sid = askSessions.get(askID)
    if (sid) asksBySession.get(sid)?.delete(askID)
  }
  // Every ask a conversation raised, and how it ended, served with /history.
  // An ask is part of the conversation's record: a card that only lived in the
  // event stream vanished when the next ask replaced it, and a phone that was
  // disconnected when one arrived never learned a turn was waiting on it.
  const askLedger = new Map<string, AskRecord[]>()
  const askRecords = new Map<string, AskRecord>()
  const recordAsk = (ask: AskRequest): void => {
    if (askRecords.has(ask.id)) return
    const rec: AskRecord = { ask, state: "pending" }
    askRecords.set(ask.id, rec)
    const list = askLedger.get(ask.sessionID) ?? []
    list.push(rec)
    // bounded: the oldest settled ones go first, a pending one never does
    while (list.length > ASK_LEDGER_MAX) {
      const i = list.findIndex((r) => r.state !== "pending")
      if (i < 0) break
      askRecords.delete(list[i]!.ask.id)
      list.splice(i, 1)
    }
    askLedger.set(ask.sessionID, list)
  }
  // "answered" (with the option) wins over "closed": a harness announces the
  // resolution of the very answer /respond just gave, sometimes before
  // /respond gets to record which option it was
  const settleAsk = (askID: string, state: "answered" | "closed", answer?: string): void => {
    const rec = askRecords.get(askID)
    if (!rec || rec.state === "answered") return
    rec.state = state
    if (answer) rec.answer = answer
  }
  // uploads land in <dataHome>/attachments, remembered by id for the next prompt
  const attachments = new Map<string, { path: string; name: string; sessionID: string }>()
  const attachmentRoot = join(deps.dataHome, "attachments")

  // fan-out: one push feed per device, none of them ever addressable by token
  const clients = new Set<ServerResponse>()
  // a keepalive comment so an idle stream is not dropped by a proxy or a phone
  // radio between turns, and a dead socket surfaces here rather than silently
  const pingTimer = setInterval(() => {
    for (const res of [...clients]) {
      try {
        res.write(": ping\n\n")
      } catch {
        clients.delete(res)
      }
    }
  }, 15_000)
  pingTimer.unref()
  const broadcast = (evt: DomainEvent): void => {
    const frame = `data: ${JSON.stringify(evt)}\n\n`
    for (const res of [...clients]) {
      try {
        res.write(frame)
      } catch {
        clients.delete(res)
      }
    }
  }

  // The harness hands back a conversation's *entire* message list — megabytes
  // for a long one — and the phone pages it 30 at a time. Without this, every
  // scroll-up refetched and re-mapped the whole session. A short-lived cache
  // makes paging cheap; a turn's own writes invalidate only by age.
  const MSG_TTL_MS = 4_000
  const msgCache = new Map<string, { at: number; rows: Message[] }>()
  const cachedMessages = async (a: HarnessAdapter, sid: string): Promise<Message[]> => {
    const hit = msgCache.get(sid)
    if (hit && Date.now() - hit.at < MSG_TTL_MS) return hit.rows
    const rows = await a.messages(sid).catch(() => [] as Message[])
    msgCache.set(sid, { at: Date.now(), rows })
    return rows
  }

  // One pump per adapter, for the life of the process: every events()
  // call holds its own subscription (fresh feed instance each time, so
  // Telegram's per-turn watchers and this pump never steal from each
  // other), and everything the harness emits is forwarded to every
  // connected device. A device decides what an event means to it: play it
  // into an open chat, or raise a notification for one it has in the
  // background.
  // A push is fire-and-forget: the feed must never stall on FCM, and a token
  // the service reports as dead is pruned rather than retried forever.
  const wake = async (evt: DomainEvent): Promise<void> => {
    const message = deps.push ? pushFor(evt) : null
    if (!deps.push || !message) return
    for (const token of [...pushTokens]) {
      try {
        await deps.push.send(token, message)
      } catch (err) {
        if (err instanceof UnregisteredToken) {
          pushTokens.delete(token)
          await savePushTokens(deps.dataHome, pushTokens).catch(() => {})
          console.error("[gw] dropped a push token the service says is gone")
          continue
        }
        console.error(`[gw] push failed: ${(err as Error)?.message ?? err}`)
      }
    }
  }

  // when the last harness event arrived, from any client. A turn in flight is
  // always making events, so "quiet" means "nobody is mid-turn" — which is what
  // a restart waits for before it exits.
  let lastActivity = Date.now()

  const pumps = new Map<HarnessAdapter, AbortController>()
  async function pump(adapter: HarnessAdapter, signal: AbortSignal): Promise<void> {
    let backoff = 2_000
    while (!signal.aborted) {
      let got = false
      try {
        for await (const evt of adapter.events(signal)) {
          got = true
          lastActivity = Date.now()
          // every event on a session pushes that session's watchdog deadline
          // out: a turn producing anything at all has not stalled
          const sid = eventSession(evt)
          const live = sid ? turns.get(sid) : undefined
          if (live) live.lastActivity = Date.now()
          if (evt.type === "ask.requested") {
            askSessions.set(evt.ask.id, evt.ask.sessionID)
            openAsks(evt.ask.sessionID).add(evt.ask.id)
            recordAsk(evt.ask)
            console.error(`[ask] surfaced ${evt.ask.id} (${evt.ask.title})`)
          }
          // the ask is spent, wherever it was answered: stop holding the
          // watchdog off, or a turn parked on a card nobody can answer any
          // more would never be judged stalled
          if (evt.type === "ask.resolved") {
            closeAsk(evt.askID)
            settleAsk(evt.askID, "closed")
            if (live) live.lastActivity = Date.now()
            console.error(`[ask] resolved ${evt.askID}`)
          }
          // what the turn is doing decides which ceiling applies, so track the
          // tools the harness reports as running (and when each one started)
          if (evt.type === "part.updated" && evt.part?.kind === "tool" && live) {
            if (evt.part.status === "running") {
              if (!live.runningTools.has(evt.partID)) {
                live.runningTools.set(evt.partID, { name: evt.part.name, startedAt: evt.part.startedAt ?? Date.now() })
              }
            } else live.runningTools.delete(evt.partID)
          }
          // the turn is over and the record is settled: drop the snapshot so the
          // next read is the finished one
          if (evt.type === "session.idle" || evt.type === "turn.aborted") msgCache.delete(evt.sessionID)
          // The harness says the turn is done. prompt() normally returns right
          // about now — but that POST can hang even with the answer fully
          // streamed, which pinned the turn (and everything queued behind it)
          // forever. Give it a grace period, then finalize from the transcript.
          if (evt.type === "session.idle" && live?.running && !live.ending && live.idleGrace === undefined) {
            live.idleGrace = setTimeout(() => {
              live.idleGrace = undefined
              endTurn(evt.sessionID, live, { kind: "idle" }, "idle-grace")
            }, idleGraceMs)
          }
          // The harness's own account of a failed turn, delivered on the stream
          // rather than by prompt() rejecting. Left unhandled it vanished and the
          // turn sat until somebody hit stop.
          if (evt.type === "session.error" && live?.running) {
            console.error(`[turn] session.error (gateway session ${evt.sessionID}): ${evt.message}`)
            endTurn(evt.sessionID, live, { kind: "error", message: evt.message || "the harness reported an error" }, "session-error")
            void adapter.abort(evt.sessionID).catch(() => {})
          }
          // steer: a prompt waiting behind this turn is folded in at the next tool
          // boundary — abort here, and the runner starts the waiting prompt
          if (evt.type === "part.updated" && evt.part?.kind === "other" && evt.part.nativeType === "step-finish") {
            const st = turns.get(evt.sessionID)
            // only a prompt that asked to steer interrupts the running turn; one
            // that asked to wait for the end is left alone
            if (st?.running && st.waiting[0]?.steer) st.signal?.abort()
          }
          broadcast(evt)
          void wake(evt)
        }
      } catch {
        /* feed died — resubscribe below */
      }
      if (signal.aborted) return
      backoff = got ? 2_000 : Math.min(backoff * 2, 30_000)
      await sleep(backoff)
    }
  }
  const ensurePumps = (): void => {
    for (const { adapter } of deps.adapters()) {
      if (pumps.has(adapter)) continue
      const signal = new AbortController()
      pumps.set(adapter, signal)
      void pump(adapter, signal.signal)
    }
  }
  ensurePumps()
  const pumpTimer = setInterval(ensurePumps, 30_000)
  pumpTimer.unref()

  // sessions ↔ adapter routing, filled by every listing and completed by a
  // bounded scan when a command names a session we haven't seen listed
  const ensureListed = async (id: string): Promise<HarnessAdapter | null> => {
    const hit = sessionAdapters.get(id)
    if (hit) return hit
    for (const { adapter } of deps.adapters()) {
      const s = await adapter.getSession(id).catch(() => null)
      if (s) {
        sessionAdapters.set(id, adapter)
        return adapter
      }
    }
    return null
  }

  // One turn in flight per session, plus whatever waits behind it. The queue is
  // what makes "send while it works" real: a prompt that arrives mid-turn waits,
  // and is steered in at the next tool boundary — or forced, when the client asks
  // to abort the running turn and run it now. This mirrors the Telegram client's
  // own turn queue.
  type TurnResult = { status: number; message?: Message; aborted?: boolean; cancelled?: boolean; error?: string }
  type PendingTurn = {
    text: string
    filePaths: string[]
    model?: { providerID: string; modelID: string }
    agent?: string
    /** steer at the next tool boundary (the default) or wait for the turn to end */
    steer: boolean
    /** the client's own handle, so it can edit / cancel / force this while it waits */
    clientID?: string
    resolve: (r: TurnResult) => void
  }
  // How a turn ended when something other than prompt() decided it. The runner
  // reads this after the abort lands, so a stalled or failed turn reports what
  // actually happened instead of the bare "aborted" every abort used to become.
  type TurnEnd =
    /** the harness said session.idle; the answer is streamed, prompt() just hung */
    | { kind: "idle" }
    /** a provider failure the harness logged but never put on the event stream */
    | { kind: "provider"; error: HarnessError }
    /** the harness's own session.error */
    | { kind: "error"; message: string }
    /** nothing came back at all for a whole ceiling */
    | { kind: "stall"; elapsedMs: number; tool?: string }
  type TurnState = {
    running: PendingTurn | null
    waiting: PendingTurn[]
    signal?: AbortController
    /** when this session last produced any harness event — the watchdog's clock */
    lastActivity: number
    /** tools the harness says are running now, so a stall can name the culprit */
    runningTools: Map<string, { name: string; startedAt: number }>
    /** set by the watchdog or the event stream, read by the runner */
    ending?: TurnEnd
    /** armed by session.idle, cleared when the turn settles */
    idleGrace?: ReturnType<typeof setTimeout>
  }
  const newTurnState = (): TurnState => ({ running: null, waiting: [], lastActivity: Date.now(), runningTools: new Map() })
  const turns = new Map<string, TurnState>()
  const isActive = (id: string): boolean => turns.get(id)?.running != null

  // End the running turn for a reason that is not a client stop. The abort is
  // what unblocks prompt(); `ending` is what tells the runner why, so the phone
  // gets a named failure rather than a silent stop.
  const endTurn = (id: string, st: TurnState, end: TurnEnd, origin: string): void => {
    if (!st.running || st.ending) return
    st.ending = end
    console.error(`[stop] origin=${origin} (gateway session ${id})`)
    st.signal?.abort()
  }

  // The liveness the gateway used to be missing entirely. Every turn runs with
  // timeoutMs: 0, so without this a turn whose harness went silent — a 429, a
  // usage cap, a dropped upstream socket — stayed "running" forever, and every
  // prompt queued behind it waited with it. The only way out was the human
  // hitting stop.
  const watchdogTimer = setInterval(() => {
    for (const [id, st] of turns) {
      if (!st.running || !st.signal || st.ending) continue
      const adapter = sessionAdapters.get(id)
      // A provider failure opencode logs to its own stderr and never emits as an
      // event (a 429, a usage cap). This is the one place that failure is
      // legible, so prefer it over waiting out the ceiling for an unexplained
      // stall: the turn is not coming back, and now we can say why.
      const pe = adapter?.providerError?.(id)
      if (pe) {
        console.error(`[watchdog] provider error (gateway session ${id}): ${describeError(pe)}`)
        endTurn(id, st, { kind: "provider", error: pe }, "watchdog-provider-error")
        void adapter?.abort(id).catch(() => {})
        continue
      }
      const v = judgeTurn({
        now: Date.now(),
        lastActivity: st.lastActivity,
        // parked on a permission ask: waiting on the human, not stalled
        waitingOnHuman: (asksBySession.get(id)?.size ?? 0) > 0,
        tools: [...st.runningTools.values()],
        config: liveness,
      })
      if (!v.stalled) continue
      console.error(
        `[watchdog] turn stalled ${Math.round(v.elapsedMs / 1000)}s (ceiling ${Math.round(v.ceilingMs / 1000)}s, tools=${st.runningTools.size}${v.wedgedMs !== undefined ? `, ${v.tool} wedged ${Math.round(v.wedgedMs / 60_000)}m` : ""}, gateway session ${id})`,
      )
      endTurn(id, st, { kind: "stall", elapsedMs: v.elapsedMs, ...(v.tool ? { tool: v.tool } : {}) }, "watchdog-stall")
      void adapter?.abort(id).catch(() => {})
    }
  }, liveness.tickMs)
  watchdogTimer.unref()

  async function runNext(id: string): Promise<void> {
    const st = turns.get(id)
    if (!st || st.running) return
    const next = st.waiting.shift()
    if (!next) {
      turns.delete(id)
      return
    }
    const adapter = await ensureListed(id)
    if (!adapter) {
      next.resolve({ status: 404, error: "no such session" })
      void runNext(id)
      return
    }
    st.running = next
    st.ending = undefined
    st.runningTools.clear()
    st.lastActivity = Date.now()
    const ac = new AbortController()
    st.signal = ac
    try {
      const message = await adapter.prompt(id, next.text, {
        timeoutMs: 0,
        filePaths: next.filePaths,
        ...(next.model ? { model: next.model } : {}),
        ...(next.agent ? { agent: next.agent } : {}),
        harnessSettings: harnessSettings.get(id) ?? {},
        signal: ac.signal,
      })
      next.resolve({ status: 200, message })
    } catch (err) {
      // An abort with a reason behind it is not a client stop: the watchdog or
      // the event stream ended this turn, and the reason is the whole point.
      const end = st.ending
      if (end && isAborted(err)) next.resolve(await settleEnded(adapter, id, end))
      // a stop is not a failure: it is the turn ending because somebody asked
      else if (isAborted(err)) next.resolve({ status: 200, aborted: true })
      else next.resolve({ status: 502, error: String((err as Error)?.message ?? err) })
    } finally {
      st.running = null
      st.signal = undefined
      st.ending = undefined
      st.runningTools.clear()
      if (st.idleGrace) clearTimeout(st.idleGrace)
      st.idleGrace = undefined
      // the turn wrote to the record; a snapshot from during it must not outlive it
      msgCache.delete(id)
      void runNext(id)
    }
  }

  // Turn a watchdog/stream ending into the answer the phone gets. `idle` is a
  // success — the harness finished and only the blocking POST hung, so the
  // streamed answer is read back off the transcript. The rest are real
  // failures, named as precisely as the harness let us name them.
  async function settleEnded(adapter: HarnessAdapter, id: string, end: TurnEnd): Promise<TurnResult> {
    if (end.kind === "idle") {
      msgCache.delete(id)
      const rows = await adapter.messages(id, { limit: 8 }).catch(() => [] as Message[])
      const last = [...rows].reverse().find((m) => m.role === "assistant")
      // the harness said the turn is done; if the record somehow has no
      // assistant message, a bare stop is still truer than inventing one
      return last ? { status: 200, message: last } : { status: 200, aborted: true }
    }
    if (end.kind === "provider") return { status: 502, error: describeError(end.error) }
    if (end.kind === "error") return { status: 502, error: end.message }
    const secs = Math.round(end.elapsedMs / 1000)
    const forHowLong = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`
    return {
      status: 504,
      error: end.tool
        ? `tool ${end.tool} ran ${forHowLong} with no progress — turn abandoned`
        : `no activity for ${forHowLong} — turn abandoned`,
    }
  }

  // the only directories a client may read: our own data, and any workspace a
  // harness is serving
  const rootsFor = (): string[] => [resolve(deps.dataHome), ...deps.adapters().map(({ adapter }) => resolve(adapter.workspace))]
  /** a reader shows text; a whole 200 MB file in a sheet helps nobody */
  const READ_MAX = 2 << 20

  const tokenOf = (req: IncomingMessage, url: URL): string | null => {
    const head = req.headers.authorization ?? ""
    if (head.startsWith("Bearer ")) return head.slice(7).trim()
    const q = url.searchParams.get("token")
    return q && q.length > 0 ? q : null
  }

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local")
    const path = url.pathname
    const ip = req.socket.remoteAddress ?? "?"
    try {
      if (path === "/health" && req.method === "GET") return json(res, 200, { ok: true, paired: tokens.size > 0 })

      if (path === "/pair" && req.method === "POST") {
        if (!pairRateOK(deps.pairLimit ?? 5, ip)) return json(res, 429, { error: "too many attempts, wait a minute" })
        const body = (await readBody(req)) as { code?: string } | undefined
        if (typeof body?.code !== "string" || !same(body.code.trim(), pairCode)) {
          return json(res, 403, { error: "wrong pairing code" })
        }
        const token = randomBytes(24).toString("hex")
        tokens.set(token, Date.now())
        await saveTokens(deps.dataHome, tokens)
        spendPairCode("device paired")
        // hand back the next code: the one just used is spent
        return json(res, 200, { token, nextCode: pairCode })
      }

      // everything below is token-gated
      const token = tokenOf(req, url)
      if (!token || !tokens.has(token)) return json(res, 401, { error: "pair first" })

      if (path === "/stream" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        })
        res.write(": ok\n\n")
        clients.add(res)
        req.socket.setTimeout(0)
        console.error(`[gw] stream open (${clients.size} client(s))`)
        req.on("close", () => {
          clients.delete(res)
          console.error(`[gw] stream closed (${clients.size} left)`)
        })
        return
      }

      // bytes for a file part, so the phone can render an image inline. The
      // phone builds this from the part's filePath; only paths under jep's own
      // data home or a served workspace are readable, so this is not a general
      // file reader.
      if (path === "/file" && req.method === "GET") {
        const encoded = url.searchParams.get("p") ?? ""
        const decoded = encoded ? Buffer.from(encoded, "base64url").toString("utf8") : ""
        if (!decoded) return json(res, 400, { error: "p required" })
        const abs = resolve(decoded)
        if (!rootsFor().some((r) => abs === r || abs.startsWith(r + sep))) {
          return json(res, 403, { error: "outside the served roots" })
        }
        try {
          const info = await stat(abs)
          if (!info.isFile() || info.size > FILE_MAX) return json(res, 404, { error: "no such file" })
          const body = await readFile(abs)
          res.writeHead(200, { "content-type": mimeForPath(abs), "cache-control": "private, max-age=300" })
          res.end(body)
        } catch {
          return json(res, 404, { error: "no such file" })
        }
      }

      // attach carries raw octets, not JSON — handle before the body gate
      if (path === "/attach" && req.method === "POST") {
        const attachSession = url.searchParams.get("id")
        const attachName = leafName(url.searchParams.get("name") ?? "file")
        const raw = await readRaw(req, ATTACH_MAX)
        if (raw == null) return json(res, 413, { error: "attachment too large" })
        if (!attachSession) return json(res, 400, { error: "id required" })
        const attachID = `att-${randomBytes(8).toString("hex")}`
        await mkdir(attachmentRoot, { recursive: true })
        const stored = join(attachmentRoot, `${attachID}-${attachName}`)
        await writeFile(stored, raw)
        attachments.set(attachID, { path: stored, name: attachName, sessionID: attachSession })
        return json(res, 200, { id: attachID, name: attachName })
      }

      const body = await readBody(req)
      if (body === undefined && req.method === "POST") return json(res, 400, { error: "bad json" })
      const b = (body ?? {}) as Record<string, unknown>
      const str = (k: string): string | null => (typeof b[k] === "string" ? (b[k] as string) : null)

      if (req.method !== "POST") return json(res, 404, { error: "no such route" })

      if (path === "/sessions" || path === "/archived") {
        ensurePumps()
        // the archived view is the only place a filed-away conversation shows
        const wantArchived = path === "/archived"
        const items = []
        for (const { name, adapter } of deps.adapters()) {
          const list = await adapter.listSessions().catch(() => [])
          for (const s of list) {
            sessionAdapters.set(s.id, adapter)
            // archived conversations are filed away, not listed
            if (archived.has(s.id) !== wantArchived) continue
            const overridden = titles.get(s.id)
            // `adapter` is the workspace's friendly name; `harness` the engine
            // behind it (opencode/codex/claude). Both are display-only: a
            // conversation cannot move between harnesses after it exists.
            // `active` = a turn is in flight for it right now (a reply streaming,
            // a tool running) — the phone shows a live mark on the row
            items.push({ ...s, title: overridden ?? s.title, adapter: name, harness: adapter.id, active: isActive(s.id), seenAt: seen.get(s.id) ?? 0 })
          }
        }
        items.sort((x, y) => y.updatedAt - x.updatedAt)
        return json(res, 200, { items })
      }

      // what the phone may create a conversation in: each served workspace, the
      // harness behind it, and its directory — for creation-time selection
      if (path === "/workspaces") {
        const items = deps.adapters().map(({ name, adapter }) => ({ name, harness: adapter.id, dir: adapter.workspace }))
        return json(res, 200, { items })
      }

      // the harnesses installed here (opencode/codex/claude), and the default
      if (path === "/harnesses") {
        const h = deps.harnesses?.() ?? {
          ids: [...new Set(deps.adapters().map((a) => a.adapter.id))],
          default: deps.adapters()[0]?.adapter.id ?? "",
        }
        return json(res, 200, { harnesses: h.ids, default: h.default })
      }

      // The same adapter-declared schema powers creation-time controls (by
      // harness id) and per-conversation settings (by session id).
      if (path === "/harness-settings") {
        const sessionID = str("id")
        if (sessionID) {
          const adapter = await ensureListed(sessionID)
          if (!adapter) return json(res, 404, { error: "unknown session" })
          const options = adapter.settings?.() ?? deps.harnessSettings?.(adapter.id) ?? []
          return json(res, 200, { options, values: valuesForSettings(options, harnessSettings.get(sessionID)) })
        }
        const harnessID = str("harness")
        if (!harnessID) return json(res, 400, { error: "harness required" })
        const adapter = deps.adapters().find((item) => item.adapter.id === harnessID)?.adapter
        const options = adapter?.settings?.() ?? deps.harnessSettings?.(harnessID) ?? []
        return json(res, 200, { options, values: Object.fromEntries(options.map((o) => [o.id, o.default])) })
      }

      // 📂 directory browser, bounded to one root so a tap can't wander into
      // /etc and "up" has somewhere to stop — the same rule the bot's picker
      // uses. Folders only, dotfiles hidden.
      if (path === "/browse") {
        const root = resolve(deps.browseRoot ?? homedir())
        const asked = str("path")
        const cwd0 = asked ? resolve(asked) : root
        const cwd = cwd0 === root || cwd0.startsWith(root + sep) ? cwd0 : root
        const parent = cwd === root ? null : dirname(cwd)
        const stalledAt = stalledDirs.get(cwd)
        if (stalledAt && Date.now() - stalledAt < BROWSE_STALL_TTL_MS) {
          return json(res, 504, { error: "that folder doesn't respond to the daemon (permission or a stalled mount)" })
        }
        if (browseInFlight > 0) return json(res, 429, { error: "another folder listing is still running" })
        browseInFlight++
        try {
          const listed = await withTimeout(listDirs(cwd), BROWSE_TIMEOUT_MS)
          if (listed === "timeout") {
            stalledDirs.set(cwd, Date.now())
            return json(res, 504, { error: "that folder didn't respond — it may be permission-protected or on a stalled mount" })
          }
          return json(res, 200, { cwd, root, parent, dirs: listed })
        } catch (err) {
          // unreadable (ENOENT/EACCES) is not a wedge: show it empty, as the bot does
          console.error(`[gw] browse ${cwd}: ${(err as Error)?.message ?? err}`)
          return json(res, 200, { cwd, root, parent, dirs: [] })
        } finally {
          browseInFlight--
        }
      }

      // Step-up auth for the one dangerous feature: proving the pairing code
      // again unlocks a shell for *this* device token. Until then nothing about
      // the terminal is reachable, so a leaked device token is not a shell.
      if (path === "/term") {
        return json(res, 200, {
          allowed: terminalAllowed,
          authorized: terminalAllowed && terminalTokens.has(token),
        })
      }

      if (path === "/term/unlock") {
        if (!terminalAllowed) {
          return json(res, 403, { error: "this gateway does not allow a terminal (set JEP_TERMINAL=1 on the daemon)" })
        }
        const code = str("code")
        if (!code || !same(code.trim(), pairCode)) return json(res, 403, { error: "wrong pairing code" })
        terminalTokens.add(token)
        await saveTerminalTokens(deps.dataHome, terminalTokens)
        spendPairCode("terminal unlocked")
        return json(res, 200, { ok: true, nextCode: pairCode })
      }

      if (path === "/term/lock") {
        terminalTokens.delete(token)
        await saveTerminalTokens(deps.dataHome, terminalTokens)
        return json(res, 200, { ok: true })
      }

      if (path === "/new") {
        const title = str("title")
        const wantWorkspace = str("workspace") // a served workspace's name
        const wantPath = str("path") // …or an absolute directory to serve
        const wantHarness = str("harness")
        const requestedSettings = b.harnessSettings && typeof b.harnessSettings === "object" && !Array.isArray(b.harnessSettings)
          ? Object.fromEntries(Object.entries(b.harnessSettings).filter((row): row is [string, boolean] => typeof row[1] === "boolean"))
          : {}
        const all = deps.adapters()
        // creation-time selection: name a workspace and/or a harness, or hand
        // over a directory. With nothing, the first served one (the old default).
        let picked =
          wantWorkspace || wantPath || wantHarness
            ? all.find(
                ({ name, adapter }) =>
                  (!wantWorkspace || name === wantWorkspace) &&
                  (!wantPath || adapter.workspace === wantPath) &&
                  (!wantHarness || adapter.id === wantHarness),
              )
            : all[0]
        // a directory we don't serve yet: bring it up under the harness, the
        // same spawn the bot's "Add project" performs
        if (!picked && wantPath && deps.addWorkspace) {
          try {
            picked = await deps.addWorkspace(wantPath, wantHarness || undefined)
          } catch (err) {
            return json(res, 400, { error: String((err as Error)?.message ?? err) })
          }
        }
        // a workspace we serve under a *different* harness, asked for a new
        // one (jep+opencode exists, jep+claude asked): bring that harness up
        // for the same directory rather than refusing — this is "test a new
        // harness on an existing project", not an error
        if (!picked && wantWorkspace && wantHarness && deps.addWorkspace) {
          const dir = all.find((w) => w.name === wantWorkspace)?.adapter.workspace
          if (dir) {
            try {
              picked = await deps.addWorkspace(dir, wantHarness)
            } catch (err) {
              return json(res, 400, { error: String((err as Error)?.message ?? err) })
            }
          }
        }
        if (!picked) return json(res, 400, { error: "no such workspace or harness" })
        const settingSpecs = picked.adapter.settings?.() ?? deps.harnessSettings?.(picked.adapter.id) ?? []
        if (Object.keys(requestedSettings).some((key) => !settingSpecs.some((spec) => spec.id === key))) {
          return json(res, 400, { error: "unknown harness setting" })
        }
        const s = await picked.adapter.createSession(title || undefined)
        sessionAdapters.set(s.id, picked.adapter)
        if (settingSpecs.length) {
          harnessSettings.set(s.id, valuesForSettings(settingSpecs, requestedSettings))
          await saveHarnessSettings(deps.dataHome, harnessSettings)
        }
        return json(res, 200, { session: { ...s, adapter: picked.name, harness: picked.adapter.id } })
      }

      // ── importing a session from the same harness's other store ─────────
      // The gateway knows only the SessionImport port — which harness has a
      // separate store, how to read it, how to fork: all behind the port.
      if (path === "/importable") {
        const all = (await deps.import?.list()) ?? []
        // only sessions in a directory jep serves; anything else would land in
        // the store but never show in a workspace's list
        const dirs = new Set(deps.adapters().map((a) => a.adapter.workspace))
        return json(res, 200, { sessions: all.filter((s) => dirs.has(s.dir)) })
      }

      if (path === "/import") {
        const sid = str("id")
        if (!sid) return json(res, 400, { error: "id required" })
        const forked = (await deps.import?.fork(sid)) ?? { ok: false }
        if (!forked.ok) return json(res, 502, { error: "import failed" })
        msgCache.delete(sid) // a stale frame must not outlive the import
        // a running server only lists sessions from its boot; bring the one
        // serving this directory back up so the import shows
        if (forked.dir && deps.restartWorkspace) {
          await deps.restartWorkspace(forked.dir).catch(() => {})
          // Bringing the server back up is only half of it: it lists what it
          // can see once it is actually serving. Wait for the copy to be
          // visible before answering, so the phone's immediate refresh finds
          // it instead of a list that will not change until something else
          // happens. Only after a restart — without one the copy is already
          // there, and waiting would just be latency.
          sessionAdapters.delete(sid)
          for (let i = 0; i < 20; i++) {
            if (await ensureListed(sid)) break
            await sleep(250)
          }
        }
        return json(res, 200, { ok: true, id: sid })
      }


      // Create a folder inside the browse root, so a conversation can start in
      // one that does not exist yet. Bounded by the same root as browsing: the
      // phone may not conjure directories anywhere the daemon can see.
      if (path === "/mkdir") {
        const root = resolve(deps.browseRoot ?? homedir())
        const parent = str("path")
        const name = (str("name") ?? "").trim()
        if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
          return json(res, 400, { error: "a folder name can't be empty or contain a slash" })
        }
        const dir = parent ? resolve(parent) : root
        if (dir !== root && !dir.startsWith(root + sep)) return json(res, 403, { error: "outside the browse root" })
        const target = join(dir, name)
        if (!target.startsWith(root + sep)) return json(res, 403, { error: "outside the browse root" })
        try {
          await mkdir(target)
          return json(res, 200, { ok: true, path: target })
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if (code === "EEXIST") return json(res, 409, { error: "a folder with that name is already there" })
          return json(res, 500, { error: `couldn't create it: ${(err as Error)?.message ?? err}` })
        }
      }

      // A device registers the token FCM gave it. Not an id route: it is
      // about this device, not about a conversation.
      if (path === "/push/register" || path === "/push/unregister") {
        if (!deps.push) return json(res, 503, { error: "this gateway has no push configured" })
        const deviceToken = (str("token") ?? "").trim()
        if (!deviceToken) return json(res, 400, { error: "token required" })
        if (path === "/push/register") pushTokens.add(deviceToken)
        else pushTokens.delete(deviceToken)
        await savePushTokens(deps.dataHome, pushTokens)
        return json(res, 200, { ok: true, devices: pushTokens.size })
      }

      // Arm a restart instead of taking one: the daemon exits by itself once it
      // has been quiet for a beat (no turn is mid-flight), or at the cap. A
      // deploy therefore never cuts a live turn off at the knees, and the user
      // is never left waking the agent up by hand afterwards.
      if (path === "/restart") {
        const quietMs = positiveInt(str("quiet") ?? url.searchParams.get("quiet"), 5, 1, 60) * 1_000
        const maxWaitMs = positiveInt(str("maxWait") ?? url.searchParams.get("maxWait"), 180, 5, 900) * 1_000
        console.error(`[gw] restart armed — exits after ${quietMs / 1000}s quiet, at most ${maxWaitMs / 1000}s`)
        restartWhenQuiet({
          quietMs,
          maxWaitMs,
          activity: () => lastActivity,
          exit: () => process.exit(0),
          log: (msg) => console.error(`[gw] ${msg}`),
        })
        return json(res, 200, { ok: true, quietMs, maxWaitMs })
      }

      // Answering an ask is keyed by the ask id, not a session id: the ask
      // already names its session, and demanding a session id here is what
      // silently 400'd every approval from the phone (the app posts only
      // askID + optionID). So this route sits above the id gate, and takes the
      // session id only as a fallback for an ask this process never surfaced.
      if (path === "/respond") {
        const askID = str("askID")
        const optionID = str("optionID")
        if (!askID || !optionID) return json(res, 400, { error: "askID and optionID required" })
        const sid = askSessions.get(askID) ?? str("id") ?? ""
        if (!sid) {
          console.error(`[ask] respond askID=${askID} option=${optionID} -> no session for this ask`)
          return json(res, 404, { error: "unknown ask" })
        }
        const owner = await ensureListed(sid)
        if (!owner) {
          console.error(`[ask] respond askID=${askID} option=${optionID} -> no session`)
          return json(res, 404, { error: "unknown ask" })
        }
        const ok = await owner.respondAsk(sid, askID, optionID).catch(() => false)
        // answered: the turn is the model's problem again, so the watchdog's
        // clock starts running on it once more
        closeAsk(askID)
        if (ok) settleAsk(askID, "answered", optionID)
        const live = turns.get(sid)
        if (live) live.lastActivity = Date.now()
        console.error(`[ask] respond askID=${askID} option=${optionID} -> ${ok ? "ok" : "failed"}`)
        return json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "ask already answered" })
      }

      // Standing an ask down: the person answered in their own words instead of
      // choosing. The harness is holding the turn open on that ask, so this is
      // what lets the turn finish — without it the phone shows a turn that never
      // ends until someone hits stop.
      if (path === "/reject") {
        const askID = str("askID")
        if (!askID) return json(res, 400, { error: "askID required" })
        const sid = askSessions.get(askID) ?? str("id") ?? ""
        if (!sid) return json(res, 404, { error: "unknown ask" })
        const owner = await ensureListed(sid)
        if (!owner) return json(res, 404, { error: "unknown ask" })
        const ok = await owner.rejectAsk(sid, askID).catch(() => false)
        closeAsk(askID)
        if (ok) settleAsk(askID, "closed")
        const live = turns.get(sid)
        if (live) live.lastActivity = Date.now()
        console.error(`[ask] reject askID=${askID} -> ${ok ? "ok" : "failed"}`)
        return json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "ask already answered" })
      }

      const id = str("id")
      if (!id) return json(res, 400, { error: "id required" })
      const adapter = await ensureListed(id)
      if (!adapter) return json(res, 404, { error: "unknown session" })

      if (path === "/read") {
        // A file the transcript linked to, read as text. A relative path means
        // "in this conversation's workspace" — resolved here, by the one process
        // that knows which workspace a session belongs to, rather than guessing
        // a directory on the client and then having the roots check second-guess it.
        const readPath = str("path")
        if (!readPath) return json(res, 400, { error: "path required" })
        const abs = isAbsolute(readPath)
          ? resolve(readPath)
          : resolve(adapter.workspace, readPath)
        if (!rootsFor().some((r) => abs === r || abs.startsWith(r + sep))) {
          return json(res, 403, { error: "outside the served roots" })
        }
        try {
          const info = await stat(abs)
          if (!info.isFile()) return json(res, 404, { error: "no such file" })
          if (info.size > READ_MAX) return json(res, 413, { error: "too large to read here" })
          return json(res, 200, { path: readPath, text: (await readFile(abs)).toString("utf8") })
        } catch {
          return json(res, 404, { error: "no such file" })
        }
      }

      if (path === "/rename") {
        const name = str("title")
        if (!name) return json(res, 400, { error: "title required" })
        titles.set(id, name)
        await saveTitles(deps.dataHome, titles)
        return json(res, 200, { ok: true })
      }

      // looked at, on some device: later is kept (a device with a slow clock
      // must not make a conversation unread again). `at: 0` is "mark unread".
      if (path === "/seen") {
        const at = typeof b.at === "number" ? b.at : Date.now()
        if (at <= 0) seen.delete(id)
        else seen.set(id, Math.max(seen.get(id) ?? 0, at))
        await saveSeen(deps.dataHome, seen)
        return json(res, 200, { ok: true, seenAt: seen.get(id) ?? 0 })
      }

      // archive hides a conversation from the list without touching the
      // harness — the same filed-away idea as a mail client
      if (path === "/archive" || path === "/unarchive") {
        if (path === "/archive") archived.add(id)
        else archived.delete(id)
        await saveArchived(deps.dataHome, archived)
        return json(res, 200, { ok: true, archived: archived.has(id) })
      }

      if (path === "/delete") {
        sessionAdapters.delete(id)
        attachments.forEach((v, k) => {
          if (v.sessionID === id) attachments.delete(k)
        })
        titles.delete(id)
        await saveTitles(deps.dataHome, titles)
        archived.delete(id)
        await saveArchived(deps.dataHome, archived)
        if (seen.delete(id)) await saveSeen(deps.dataHome, seen)
        const gone = await adapter.deleteSession(id).catch(() => false)
        if (gone) {
          harnessSettings.delete(id)
          asksBySession.delete(id)
          for (const r of askLedger.get(id) ?? []) askRecords.delete(r.ask.id)
          askLedger.delete(id)
          await saveHarnessSettings(deps.dataHome, harnessSettings)
        }
        return json(res, gone ? 200 : 404, gone ? { ok: true } : { error: "couldn't delete" })
      }

      if (path === "/set-harness-setting") {
        const key = str("key")
        const enabled = typeof b.enabled === "boolean" ? b.enabled : null
        if (!key || enabled == null) return json(res, 400, { error: "key and boolean enabled required" })
        const specs = adapter.settings?.() ?? deps.harnessSettings?.(adapter.id) ?? []
        if (!specs.some((setting) => setting.id === key)) return json(res, 400, { error: "unknown harness setting" })
        const current = valuesForSettings(specs, harnessSettings.get(id))
        current[key] = enabled
        harnessSettings.set(id, current)
        await saveHarnessSettings(deps.dataHome, harnessSettings)
        return json(res, 200, { ok: true, values: current })
      }

      // the pickable models for this conversation's harness, plus the one it is
      // currently set to (null = the harness default). Powers the phone's
      // Settings screen, mirroring Telegram's model picker.
      if (path === "/models") {
        const list = adapter.models ? await adapter.models().catch(() => []) : []
        // capabilities ride along so the phone can badge vision/attachment
        // models and show a context limit — the same data Telegram's picker
        // uses for its 🖼 marker and the image-model suggestion.
        const caps = adapter.capabilities ? await adapter.capabilities().catch(() => new Map()) : new Map()
        const enriched = list.map((m) => {
          const c = caps.get(`${m.providerID}/${m.modelID}`)
          return { ...m, image: c?.image ?? false, attachment: c?.attachment ?? false, contextLimit: c?.contextLimit ?? 0 }
        })
        const resolvedDefault = adapter.defaultModel ? await adapter.defaultModel().catch(() => null) : null
        // the window of the model this conversation actually runs on, which may
        // be one the picker does not list (an alias, a 1M variant, whatever the
        // CLI fell back to) — the status line's fill rate needs it either way
        const running = models.get(id) ?? resolvedDefault
        const contextLimit = (running && caps.get(running)?.contextLimit) || 0
        return json(res, 200, { models: enriched, current: models.get(id) ?? null, default: resolvedDefault, contextLimit })
      }

      // the primary agents this harness offers, plus the conversation's choice.
      // The adapter owns the ids, so the phone renders whatever it declares
      // instead of a list jep would have to keep in step.
      if (path === "/agents") {
        const list = adapter.agents ? await adapter.agents().catch(() => []) : []
        return json(res, 200, {
          agents: list,
          current: agents.get(id) ?? null,
          default: list.find((a) => a.default)?.id ?? null,
        })
      }

      if (path === "/agent") {
        return json(res, 200, { current: agents.get(id) ?? null })
      }

      if (path === "/setagent") {
        const agent = str("agent")
        if (agent) {
          // when the harness names its agents, refuse one it doesn't offer (a
          // stale id from another harness); a harness that names none accepts
          // the id and simply ignores it at run time (the adapter clamps)
          const list = adapter.agents ? await adapter.agents().catch(() => []) : []
          if (list.length && !list.some((a) => a.id === agent)) return json(res, 400, { error: "unknown agent" })
          agents.set(id, agent)
        } else {
          agents.delete(id)
        }
        await saveAgents(deps.dataHome, agents)
        return json(res, 200, { ok: true, agent: agent || null })
      }

      // what this conversation has spent — tokens and reported cost, summed
      // from the harness's own record (cost is reported, never computed)
      if (path === "/usage") {
        return json(res, 200, { usage: usageOf(await cachedMessages(adapter, id)) })
      }

      // the subagent sessions this conversation spawned — reached from the
      // conversation, never listed on their own
      if (path === "/subagents") {
        const sessions = adapter.subagents ? await adapter.subagents(id).catch(() => []) : []
        // `items`, like /sessions — the client decodes both with the same shape
        return json(res, 200, { items: sessions })
      }

      // the files this conversation has changed, so the phone can show them
      if (path === "/diff") {
        const files = adapter.diff ? await adapter.diff(id).catch(() => []) : []
        return json(res, 200, { files })
      }

      // The log belongs to the workspace, not a harness-specific diff
      // implementation. Only fixed git arguments run; the client never supplies
      // a command or path.
      if (path === "/git") {
        return json(res, 200, await gitSnapshot(adapter.workspace))
      }

      // Compress this conversation's context (opencode "compact"). The port is
      // optional: a harness that has no such control answers 501, so the phone
      // can hide the row rather than pretend it failed at pressing it.
      if (path === "/compact") {
        if (!adapter.compact) return json(res, 501, { error: "this harness can't compact" })
        // A refusal (false) and a broken attempt (throw) are different facts, and
        // reporting a timed-out summarize as "refused" sent the phone chasing the
        // wrong thing. Keep them apart.
        let failure: string | null = null
        const ok = await adapter.compact(id).catch((err) => {
          const msg = (err as Error)?.message ?? String(err)
          console.error(`[gw] compact ${id} failed: ${msg}`)
          failure = /timeout|abort/i.test(msg) ? "compacting took too long and was given up on" : msg
          return false
        })
        if (failure) return json(res, 504, { error: failure })
        // the adapter names its own refusal in the daemon log (40x from the
        // harness); here it is relayed as-is so a phone shows the truth
        if (!ok) return json(res, 409, { error: "the harness refused to compact" })
        // the summarize rewrites the transcript; a cached frame from before it
        // must not be served afterwards
        msgCache.delete(id)
        return json(res, 200, { ok: true })
      }

      // ── the in-chat terminal ────────────────────────────────────────────
      // A shell in the conversation's own folder. Only when the operator
      // allows it AND this device proved the pairing code. How the shell is
      // run (tmux, a pty, anything) is the Terminal port's business; this is
      // only the policy and the wire shape.
      if (path.startsWith("/term/")) {
        if (!terminalAllowed) return json(res, 403, { error: "this gateway does not allow a terminal" })
        if (!terminalTokens.has(token)) return json(res, 403, { error: "terminal isn't unlocked for this device" })
        if (!deps.terminal) return json(res, 503, { error: "no terminal is available" })
        try {
          if (path === "/term/open") {
            await deps.terminal.open(id, adapter.workspace)
            return json(res, 200, { ok: true })
          }
          if (path === "/term/frame") {
            return json(res, 200, { text: await deps.terminal.frame(id) })
          }
          if (path === "/term/input") {
            const text = str("text")
            const key = str("key")
            await deps.terminal.send(id, { ...(key ? { key } : {}), ...(text != null ? { text } : {}) })
            return json(res, 200, { ok: true })
          }
          if (path === "/term/close") {
            await deps.terminal.close(id)
            return json(res, 200, { ok: true })
          }
        } catch (err) {
          console.error(`[gw] ${path} failed: ${(err as Error)?.message ?? err}`)
          return json(res, 500, { error: String((err as Error)?.message ?? err) })
        }
        return json(res, 404, { error: "no such terminal route" })
      }


      // the skills this conversation's harness loads, from the SKILL.md dirs
      if (path === "/skills") {
        const dirs = adapter.skillDirs?.() ?? skillDirsFor(adapter.id, adapter.workspace)
        let skills: unknown[] = []
        try {
          skills = await listSkills(dirs.userDirs, dirs.projectDirs)
        } catch (err) {
          console.error(`[gw] skills: ${(err as Error)?.message ?? err}`)
        }
        return json(res, 200, { skills, toggleable: dirs.toggleable })
      }

      // hide / allow a skill for the model — one frontmatter line in its SKILL.md
      if (path === "/setskill") {
        const skillPath = str("path")
        if (!skillPath) return json(res, 400, { error: "path required" })
        await writeSkillModelInvocation(skillPath, b.disabled === true)
        return json(res, 200, { ok: true })
      }

      // the MCP servers this harness will start, and whether each is enabled
      if (path === "/mcp") {
        const paths = mcpPaths()
        let servers: unknown[] = []
        try {
          if (adapter.id === "opencode") servers = await readOpencodeMcp(paths.opencode)
          else if (adapter.id === "codex") servers = await readCodexMcp(paths.codex)
          else if (adapter.id === "claude") {
            const c = await readClaudeMcp(paths.claude, adapter.workspace)
            servers = [...c.user, ...c.project]
          }
        } catch (err) {
          console.error(`[gw] mcp: ${(err as Error)?.message ?? err}`)
        }
        return json(res, 200, { servers })
      }

      if (path === "/setmcp") {
        const name = str("name")
        if (!name) return json(res, 400, { error: "name required" })
        const enabled = b.enabled === true
        const paths = mcpPaths()
        if (adapter.id === "opencode") await writeOpencodeMcpEnabled(paths.opencode, name, enabled)
        else if (adapter.id === "codex") await writeCodexMcpEnabled(paths.codex, name, enabled)
        else if (adapter.id === "claude") await writeClaudeProjectEnabled(paths.claude, adapter.workspace, name, enabled)
        return json(res, 200, { ok: true })
      }

      // set (or clear, with no model) this conversation's model. Persisted, and
      // applied to the next prompt — the choice outlives the app.
      if (path === "/setmodel") {
        const ref = str("model")
        if (ref) models.set(id, ref)
        else models.delete(id)
        await saveModels(deps.dataHome, models)
        return json(res, 200, { ok: true, model: ref || null })
      }

      if (path === "/history") {
        const limit = typeof b.limit === "number" ? Math.max(0, Math.floor(b.limit)) : 0
        const before = typeof b.before === "number" ? b.before : 0
        // how many messages the phone already holds, so an older page can be
        // asked for as one bounded window instead of the whole conversation
        const have = typeof b.have === "number" ? Math.max(0, Math.floor(b.have)) : 0
        // Ask the harness for a window, never the scroll. One of the user's
        // conversations is 3151 messages — 199 MB — and fetching, parsing and
        // mapping all of it to serve 30 messages, once per page, is what kept
        // taking the daemon down. `before` is unusable on opencode, so an older
        // page is "the window plus what the phone holds", then sliced here.
        const want = limit > 0 ? limit + have + 1 : 0
        const rows = want > 0 ? await adapter.messages(id, { limit: want }) : await adapter.messages(id)
        const window = rows
          .filter((m) => !before || m.time < before)
          .sort((a, b) => a.time - b.time)
        const hasMore = limit > 0 && window.length > limit
        const messages = (limit > 0 ? window.slice(-limit) : window)
          .map(cleanForDisplay)
          .filter((m) => m.role !== "user" || m.parts.length > 0)
        // the asks ride along whole (they are few): each is placed by its own
        // anchor, and the pending one is what holds the composer
        const asks = (askLedger.get(id) ?? []).map((r) => ({ ...r.ask, state: r.state, ...(r.answer ? { answer: r.answer } : {}) }))
        return json(res, 200, { messages, hasMore, asks })
      }

      if (path === "/prompt") {
        const files: string[] = Array.isArray(b.files) ? b.files.filter((f): f is string => typeof f === "string") : []
        const filePaths = files.map((fid) => attachments.get(fid)?.path).filter((p): p is string => Boolean(p))
        // an attachment with no words is a valid prompt: the harness still needs
        // something to read, so fill it in here as well. The Android app sends
        // its own copy of this line so its optimistic row agrees; the Telegram
        // client fills the same line in on its side.
        const asked = str("text") ?? ""
        if (!asked && filePaths.length === 0) return json(res, 400, { error: "text required" })
        const text = asked || "see the attached file"
        // this conversation's chosen model, if the phone set one in Settings
        const ref = models.get(id)
        const [providerID = "", modelID = ""] = ref ? ref.split("/") : []
        const model = providerID && modelID ? { providerID, modelID } : undefined
        const agent = agents.get(id)
        let settle!: (r: TurnResult) => void
        const done = new Promise<TurnResult>((r) => { settle = r })
        const pending: PendingTurn = {
          text,
          filePaths,
          model,
          agent,
          steer: b.steer !== false,
          clientID: str("clientID") ?? undefined,
          resolve: settle,
        }
        const st = turns.get(id) ?? newTurnState()
        turns.set(id, st)
        if (b.force === true) {
          // force: run this next, and if a turn is in flight, abort it so it can
          st.waiting.unshift(pending)
          st.signal?.abort()
        } else {
          // queue normally: the pump steers it in at the next tool boundary
          st.waiting.push(pending)
        }
        void runNext(id)
        const result = await done
        if (result.message) return json(res, 200, { message: result.message })
        if (result.aborted) return json(res, 200, { aborted: true })
        if (result.cancelled) return json(res, 200, { cancelled: true })
        return json(res, result.status, { error: result.error ?? "prompt failed" })
      }

      if (path === "/stop") {
        console.error(`[stop] origin=client (gateway session ${id}, device ${token.slice(0, 6)}, from ${req.socket.remoteAddress ?? "?"})`)
        const stopped = await adapter.abort(id).catch(() => false)
        return json(res, 200, { stopped })
      }

      // act on a queued prompt the client still holds a handle to (a clientID):
      // cancel it, change its words, or force it to run now. Once it is running
      // it is too late, and the client is told so.
      if (path === "/queue/cancel" || path === "/queue/edit" || path === "/queue/force") {
        const clientID = str("clientID")
        if (!clientID) return json(res, 400, { error: "clientID required" })
        const st = turns.get(id)
        if (st?.running?.clientID === clientID) return json(res, 409, { error: "already running" })
        const idx = st ? st.waiting.findIndex((p) => p.clientID === clientID) : -1
        if (!st || idx < 0) return json(res, 404, { error: "not queued" })
        const entry = st.waiting[idx]!
        if (path === "/queue/cancel") {
          st.waiting.splice(idx, 1)
          entry.resolve({ status: 200, cancelled: true })
          return json(res, 200, { ok: true })
        }
        if (path === "/queue/edit") {
          const more = str("text") ?? ""
          if (!more.trim()) return json(res, 400, { error: "text required" })
          entry.text = more
          return json(res, 200, { ok: true })
        }
        // force: run it next, aborting the running turn so it can
        st.waiting.splice(idx, 1)
        st.waiting.unshift(entry)
        st.signal?.abort()
        return json(res, 200, { ok: true })
      }

      return json(res, 404, { error: "no such route" })
    } catch (err) {
      console.error(`[gw] ${req.method} ${path} failed: ${(err as Error)?.message ?? err}`)
      if (!res.headersSent) json(res, 500, { error: "internal" })
      else res.end()
    }
  })

  await new Promise<void>((resolve) => server.listen(deps.port, "0.0.0.0", resolve))
  const bound = (server.address() as { port: number }).port
  console.error(`[gw] listening on :${bound}  ·  pairing code: ${pairCode}`)

  return {
    pairCode,
    port: bound,
    pairingAdmin,
    close: async () => {
      clearInterval(pumpTimer)
      clearInterval(pingTimer)
      clearInterval(watchdogTimer)
      for (const st of turns.values()) if (st.idleGrace) clearTimeout(st.idleGrace)
      for (const signal of pumps.values()) signal.abort()
      for (const res of clients) res.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

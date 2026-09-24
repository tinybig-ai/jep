// The gateway is jep's second presentation adapter — a native phone client
// speaks to the same core the Telegram bot speaks to: plain HTTP commands plus
// one push feed (Server-Sent Events), consuming the very same
// HarnessAdapter port. It holds no chat-store state and touches no Telegram
// surface. Every endpoint the phone can call is listed in docs/GATEWAY.md,
// which stays in step with this file.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import type { HarnessAdapter, SessionImport, Terminal } from "../../core/ports.ts"
import type { PairingAdmin } from "../../core/pairing.ts"
import { pushFor, UnregisteredToken, type PushNotifier } from "../../core/push.ts"
import { readClaudeMcp, readCodexMcp, readOpencodeMcp, writeClaudeProjectEnabled, writeCodexMcpEnabled, writeOpencodeMcpEnabled } from "../../core/mcpconfig.ts"
import { listSkills, skillDirsFor, writeSkillModelInvocation } from "../../core/skills.ts"
import type { DomainEvent, Message } from "../../core/types.ts"
import { isAborted } from "../../core/types.ts"
import { usageOf } from "../../core/usage.ts"
import { transcriptText } from "../../core/transcript.ts"
import { newPairCode } from "../telegram/pair.ts"

export interface GatewayDeps {
  // called lazily and repeatedly: the Telegram bot can spawn more workspace
  // servers at any time (project discovery), and the gateway must pick up
  adapters(): Array<{ name: string; adapter: HarnessAdapter }>
  /** the harnesses installed here, and the default — what a conversation may
   * be created under, independent of any one workspace */
  harnesses?(): { ids: string[]; default: string }
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
const PUSH_FILE = "gateway-push.json"
const BODY_MAX = 1 << 20

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest()
const same = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b))

// The harness stores jep's own context header on a session's first prompt, and
// splices its machinery (system reminders, command envelopes, background
// output) into user turns. None of it belongs on the phone: show what the
// person actually typed, the same way the Telegram client strips it.
function cleanForDisplay(m: Message): Message {
  if (m.role !== "user") return m
  const parts = m.parts
    .map((p) => (p.kind === "text" ? { ...p, text: transcriptText(p.text) } : p))
    .filter((p) => p.kind !== "text" || p.text.trim().length > 0)
  return { ...m, parts }
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
  const models = await loadModels(deps.dataHome)
  const agents = await loadAgents(deps.dataHome)
  const terminalTokens = await loadTerminalTokens(deps.dataHome)
  const pushTokens = await loadPushTokens(deps.dataHome)
  // Whether this gateway offers a shell at all — an operator decision on the
  // machine, not something a paired phone can turn on for itself.
  const terminalAllowed = process.env.JEP_TERMINAL === "1" || process.env.JEP_TERMINAL === "true"

  // help-files the phone needs, resolved as events and commands arrive
  const sessionAdapters = new Map<string, HarnessAdapter>()
  const askSessions = new Map<string, string>()
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

  const pumps = new Map<HarnessAdapter, AbortController>()
  async function pump(adapter: HarnessAdapter, signal: AbortSignal): Promise<void> {
    let backoff = 2_000
    while (!signal.aborted) {
      let got = false
      try {
        for await (const evt of adapter.events(signal)) {
          got = true
          if (evt.type === "ask.requested") {
            askSessions.set(evt.ask.id, evt.ask.sessionID)
            console.error(`[ask] surfaced ${evt.ask.id} (${evt.ask.title})`)
          }
          // the turn is over and the record is settled: drop the snapshot so the
          // next read is the finished one
          if (evt.type === "session.idle" || evt.type === "turn.aborted") msgCache.delete(evt.sessionID)
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
  type TurnState = { running: PendingTurn | null; waiting: PendingTurn[]; signal?: AbortController }
  const turns = new Map<string, TurnState>()
  const isActive = (id: string): boolean => turns.get(id)?.running != null

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
    const ac = new AbortController()
    st.signal = ac
    try {
      const message = await adapter.prompt(id, next.text, {
        timeoutMs: 0,
        filePaths: next.filePaths,
        ...(next.model ? { model: next.model } : {}),
        ...(next.agent ? { agent: next.agent } : {}),
        signal: ac.signal,
      })
      next.resolve({ status: 200, message })
    } catch (err) {
      // a stop is not a failure: it is the turn ending because somebody asked
      if (isAborted(err)) next.resolve({ status: 200, aborted: true })
      else next.resolve({ status: 502, error: String((err as Error)?.message ?? err) })
    } finally {
      st.running = null
      st.signal = undefined
      // the turn wrote to the record; a snapshot from during it must not outlive it
      msgCache.delete(id)
      void runNext(id)
    }
  }

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
        const roots = [resolve(deps.dataHome), ...deps.adapters().map(({ adapter }) => resolve(adapter.workspace))]
        if (!roots.some((r) => abs === r || abs.startsWith(r + sep))) {
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
            items.push({ ...s, title: overridden ?? s.title, adapter: name, harness: adapter.id, active: isActive(s.id) })
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
        const s = await picked.adapter.createSession(title || undefined)
        sessionAdapters.set(s.id, picked.adapter)
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

      const id = str("id")
      if (!id) return json(res, 400, { error: "id required" })
      const adapter = await ensureListed(id)
      if (!adapter) return json(res, 404, { error: "unknown session" })

      if (path === "/rename") {
        const name = str("title")
        if (!name) return json(res, 400, { error: "title required" })
        titles.set(id, name)
        await saveTitles(deps.dataHome, titles)
        return json(res, 200, { ok: true })
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
        const gone = await adapter.deleteSession(id).catch(() => false)
        return json(res, gone ? 200 : 404, gone ? { ok: true } : { error: "couldn't delete" })
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
        return json(res, 200, { models: enriched, current: models.get(id) ?? null, default: resolvedDefault })
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
        return json(res, 200, { messages, hasMore })
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
        const st = turns.get(id) ?? { running: null, waiting: [] }
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

      if (path === "/respond") {
        const askID = str("askID")
        const optionID = str("optionID")
        if (!askID || !optionID) return json(res, 400, { error: "askID and optionID required" })
        const sid = askSessions.get(askID) ?? id
        const owner = await ensureListed(sid)
        if (!owner) {
          console.error(`[ask] respond askID=${askID} option=${optionID} -> no session`)
          return json(res, 404, { error: "unknown ask" })
        }
        const ok = await owner.respondAsk(sid, askID, optionID).catch(() => false)
        console.error(`[ask] respond askID=${askID} option=${optionID} -> ${ok ? "ok" : "failed"}`)
        return json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "ask already answered" })
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
      for (const signal of pumps.values()) signal.abort()
      for (const res of clients) res.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

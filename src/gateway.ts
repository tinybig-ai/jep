// The gateway is jep's second presentation adapter — a native phone client
// speaks to the same core the Telegram bot speaks to: plain HTTP commands plus
// one push feed (Server-Sent Events), consuming the very same
// HarnessAdapter port. It holds no chat-store state and touches no Telegram
// surface. Every endpoint the phone can call is listed in docs/GATEWAY.md,
// which stays in step with this file.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { HarnessAdapter } from "./core/ports.ts"
import type { DomainEvent } from "./core/types.ts"
import { newPairCode } from "./telegram/pair.ts"

export interface GatewayDeps {
  // called lazily and repeatedly: the Telegram bot can spawn more workspace
  // servers at any time (project discovery), and the gateway must pick up
  adapters(): Array<{ name: string; adapter: HarnessAdapter }>
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
}

const TOKEN_FILE = "gateway-tokens.json"
const TITLES_FILE = "gateway-titles.json"
const BODY_MAX = 1 << 20

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest()
const same = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b))

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
  const pairCode = deps.pairCode ?? newPairCode()
  let tokens = await loadTokens(deps.dataHome)
  const titles = await loadTitles(deps.dataHome)

  // help-files the phone needs, resolved as events and commands arrive
  const sessionAdapters = new Map<string, HarnessAdapter>()
  const askSessions = new Map<string, string>()
  // uploads land in <dataHome>/attachments, remembered by id for the next prompt
  const attachments = new Map<string, { path: string; name: string; sessionID: string }>()
  const attachmentRoot = join(deps.dataHome, "attachments")

  // fan-out: one push feed per device, none of them ever addressable by token
  const clients = new Set<ServerResponse>()
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

  // One pump per adapter, for the life of the process: every events()
  // call holds its own subscription (fresh feed instance each time, so
  // Telegram's per-turn watchers and this pump never steal from each
  // other), and everything the harness emits is forwarded to every
  // connected device. A device decides what an event means to it: play it
  // into an open chat, or raise a notification for one it has in the
  // background.
  const pumps = new Map<HarnessAdapter, AbortController>()
  async function pump(adapter: HarnessAdapter, signal: AbortSignal): Promise<void> {
    let backoff = 2_000
    while (!signal.aborted) {
      let got = false
      try {
        for await (const evt of adapter.events(signal)) {
          got = true
          if (evt.type === "ask.requested") askSessions.set(evt.ask.id, evt.ask.sessionID)
          broadcast(evt)
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

  // one turn at a time per session, seen across every device and Telegram:
  // the harness serializes anyway, but a clean 409 beats a hung phone
  const active = new Set<string>()

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
        return json(res, 200, { token })
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
        req.on("close", () => clients.delete(res))
        return
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

      if (path === "/sessions") {
        ensurePumps()
        const items = []
        for (const { name, adapter } of deps.adapters()) {
          const list = await adapter.listSessions().catch(() => [])
          for (const s of list) {
            sessionAdapters.set(s.id, adapter)
            const overridden = titles.get(s.id)
            items.push({ ...s, title: overridden ?? s.title, adapter: name })
          }
        }
        items.sort((x, y) => y.updatedAt - x.updatedAt)
        return json(res, 200, { items })
      }

      if (path === "/new") {
        const { adapter } = deps.adapters()[0] ?? {}
        if (!adapter) return json(res, 503, { error: "no workspace is being served" })
        const title = str("title")
        const s = await adapter.createSession(title || undefined)
        sessionAdapters.set(s.id, adapter)
        return json(res, 200, { session: s })
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

      if (path === "/delete") {
        sessionAdapters.delete(id)
        attachments.forEach((v, k) => {
          if (v.sessionID === id) attachments.delete(k)
        })
        titles.delete(id)
        await saveTitles(deps.dataHome, titles)
        const gone = await adapter.deleteSession(id).catch(() => false)
        return json(res, gone ? 200 : 404, gone ? { ok: true } : { error: "couldn't delete" })
      }

      if (path === "/history") {
        const messages = await adapter.messages(id).catch(() => [])
        return json(res, 200, { messages })
      }

      if (path === "/prompt") {
        const text = str("text")
        if (!text) return json(res, 400, { error: "text required" })
        if (active.has(id)) return json(res, 409, { error: "busy" })
        const files: string[] = Array.isArray(b.files) ? b.files.filter((f): f is string => typeof f === "string") : []
        const filePaths = files.map((fid) => attachments.get(fid)?.path).filter((p): p is string => Boolean(p))
        active.add(id)
        try {
          const message = await adapter.prompt(id, text, { filePaths })
          return json(res, 200, { message })
        } catch (err) {
          return json(res, 502, { error: String((err as Error)?.message ?? err) })
        } finally {
          active.delete(id)
        }
      }

      if (path === "/stop") {
        const stopped = await adapter.abort(id).catch(() => false)
        return json(res, 200, { stopped })
      }

      if (path === "/respond") {
        const askID = str("askID")
        const optionID = str("optionID")
        if (!askID || !optionID) return json(res, 400, { error: "askID and optionID required" })
        const sid = askSessions.get(askID) ?? id
        const owner = await ensureListed(sid)
        if (!owner) return json(res, 404, { error: "unknown ask" })
        const ok = await owner.respondAsk(sid, askID, optionID).catch(() => false)
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
    close: async () => {
      clearInterval(pumpTimer)
      for (const signal of pumps.values()) signal.abort()
      for (const res of clients) res.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

import { spawn, execFile, type ChildProcess } from "node:child_process"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Agent } from "undici"
import type { AgentRef, HarnessAdapter, ModelRef, ModelCaps } from "../core/ports.ts"
import type { AskOption, DomainEvent, FileDiff, HarnessError, Message, Part, ProjectSummary, SessionSummary, SkillDirs } from "../core/types.ts"
import { TurnAbortedError } from "../core/types.ts"
import { resolveAgent } from "../core/agents.ts"
import { parseOpencodeLogError } from "./opencode-log.ts"
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode"
const MODEL_REF = process.env.JEP_MODEL ?? "localfree-models-proxy/auto"
const DEFAULT_TIMEOUT_MS = 180_000

// opencode's own primary agents — the one place that names them. Clients read
// them through the port instead of hardcoding "build"/"plan".
const AGENTS: AgentRef[] = [
  { id: "build", label: "Build", detail: "executes tools", default: true },
  { id: "plan", label: "Plan", detail: "read-only, no edits" },
]

// A turn against a slow (free) model can legitimately run past Node's default
// 5-minute fetch timeouts (undici's headersTimeout/bodyTimeout), and the whole
// point of the adapter is that a long run is not an error. Zero disables the
// wall-clock ceilings; liveness is owned by the caller's idle watchdog instead.
// The cast bridges two structurally-divergent copies of undici's types — the
// npm package's and @types/node's bundled undici-types; at runtime they are
// the same Dispatcher and the global fetch accepts it.
type FetchDispatcher = NonNullable<Parameters<typeof fetch>[1]>["dispatcher"]
const NO_TIMEOUT_AGENT = new Agent({ headersTimeout: 0, bodyTimeout: 0 }) as unknown as FetchDispatcher

// Namespaces every session id we expose at the port boundary, so ids from
// different harness adapters can never collide and stay stable across
// restarts. Native ids (e.g. "ses_…", "msg_…") are only ever used internally.
const HARNESS_NS = "opencode"

const toInternalId = (native: string) => `${HARNESS_NS}://${native}`
const toNativeId = (id: string) =>
  id.startsWith(`${HARNESS_NS}://`) ? id.slice(HARNESS_NS.length + 3) : id

// Two listings of the same store seen through different scopes: union them by
// id, the project-scoped entry winning a tie. One opencode data home can hold
// more than one project row for the same worktree (its project id follows repo
// identity), and /session only ever returns the project this serve instance
// resolved, so the cross-project view is what adds the threads filed under a
// sibling project. Exported so the unit test can pin that ordering rule.
export function mergeSessionRows(primary: any[], supplement: any[]): any[] {
  const byID = new Map<string, any>()
  for (const s of primary ?? []) {
    const id = String(s?.id ?? "")
    if (id) byID.set(id, s)
  }
  for (const s of supplement ?? []) {
    const id = String(s?.id ?? "")
    if (id && !byID.has(id)) byID.set(id, s)
  }
  return [...byID.values()]
}

const listenRe = /listening on http:\/\/([^:]+):(\d+)/

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
}

// opencode spells a stop as an error: MessageAbortedError, or a plain
// "Aborted" message depending on where it was raised. Only this adapter needs
// to know that — it becomes turn.aborted for everyone else.
export function isAbortPayload(raw: unknown): boolean {
  if (raw && typeof raw === "object") {
    const { name, message } = raw as { name?: unknown; message?: unknown }
    return /abort/i.test(String(name ?? "")) || /abort/i.test(String(message ?? ""))
  }
  return /abort/i.test(String(raw ?? ""))
}

function mimeFor(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

interface SseFrame {
  event?: string
  data?: string
}

// shape of `GET /provider` (only the parts capabilities() reads). Kept as
// module-level aliases: node's type-stripper rejects `?:` literals when inline
// inside a generic call argument.
interface ProviderModelMeta {
  capabilities?: { attachment?: boolean; input?: { image?: boolean } }
  limit?: { context?: number }
  /** registry models carry their own provider; config ones are keyed by it */
  providerID?: string
}
interface ProviderRoot {
  all?: Array<{ id?: string; models?: Record<string, ProviderModelMeta> }>
}

function parseSse(raw: string): SseFrame[] {
  const frames: SseFrame[] = []
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue
    const frame: SseFrame = {}
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) frame.event = line.slice(6).trim()
      else if (line.startsWith("data:")) frame.data = line.slice(5).trimStart()
    }
    frames.push(frame)
  }
  return frames
}

function mapPart(part: any, workspace: string): Part {
  // opencode marks its own scaffolding `synthetic` — e.g. the
  // "Called the Read tool with the following input: …" text it inserts when a
  // file is attached. It is written for the model, never for a person; passing
  // it on painted that scaffolding into the user's own message on every client.
  if (part?.synthetic === true) return { kind: "other", nativeType: "synthetic" }
  switch (part?.type) {
    case "text":
      return { kind: "text", text: part.text ?? "", ...(part.id ? { id: part.id } : {}) }
    case "tool":
      return {
        kind: "tool",
        id: part.id ?? "",
        name: part.tool ?? "tool",
        // tool input/output live under `state` in the event stream (and in the
        // message parts), not at the top level
        input: part.state?.input ?? part.input ?? {},
        output: part.state?.output ?? part.output ?? {},
        status: part.state?.status,
        title: part.state?.title,
        metadata: part.state?.metadata,
        ...(typeof part.state?.time?.start === "number" ? { startedAt: part.state.time.start } : {}),
      }
    case "reasoning": {
      const start = part.time?.start
      const end = part.time?.end
      const durationMs = typeof start === "number" && typeof end === "number" ? end - start : undefined
      return { kind: "reasoning", text: part.text ?? "", id: part.id ?? "", ...(durationMs !== undefined ? { durationMs } : {}) }
    }
    case "snapshot":
      return { kind: "snapshot" }
    case "file": {
      const mime = part.mime_type ?? part.mime
      const raw = part.file_path ?? part.url ?? ""
      // An input attachment (what the user sent) arrives as a data: URL with the
      // bytes inlined; an output FilePart carries a file:// url or a path. A
      // data: URL is not a path: joining it produced
      // "<workspace>/data:image/jpeg;base64,…", a file that exists nowhere, and
      // shipping the inlined bytes to every client on every history page is
      // megabytes per image. Name it from the mime instead.
      if (raw.startsWith("data:")) {
        const ext = (mime ?? "").split("/")[1]?.split("+")[0] ?? ""
        const name = part.file_name ?? part.filename ?? (ext ? `attached.${ext}` : "attached file")
        return { kind: "file", filePath: name, fileName: name, mimeType: mime }
      }
      let fp = raw
      try {
        if (raw.startsWith("file://")) fp = fileURLToPath(raw)
      } catch {
        /* keep raw */
      }
      if (!fp) return { kind: "other", nativeType: "file" }
      return {
        kind: "file",
        filePath: path.isAbsolute(fp) ? fp : path.join(workspace, fp),
        fileName: part.file_name ?? part.filename,
        mimeType: mime,
      }
    }
    default:
      return { kind: "other", nativeType: part?.type ?? "unknown" }
  }
}

// opencode stores a user attachment as an inline data: URL with no name, and
// marks its own scaffolding `synthetic`. That scaffolding is a
// "Called the Read tool with the following input: {\"filePath\":…}" text naming
// the exact file jep handed over. Recover the real path (and name) from it and
// drop the scaffolding, rather than showing it to anyone or decoding the bytes.
function mapParts(parts: any[] | undefined, workspace: string): Part[] {
  const rows = parts ?? []
  const attached = rows
    .filter((p) => p?.synthetic === true && typeof p?.text === "string")
    .flatMap((p) => [...String(p.text).matchAll(/"filePath"\s*:\s*"([^"]+)"/g)].map((m) => m[1] as string))
  let next = 0
  return rows
    .filter((p) => p?.synthetic !== true)
    .map((p): Part => {
      const isDataFile = p?.type === "file" && typeof p?.url === "string" && (p.url as string).startsWith("data:")
      const fp = isDataFile ? attached[next] : undefined
      if (fp) {
        next++
        return {
          kind: "file",
          filePath: fp,
          fileName: p.file_name ?? p.filename ?? path.basename(fp),
          mimeType: p.mime_type ?? p.mime,
        }
      }
      return mapPart(p, workspace)
    })
}

function mapMessage(info: any, parts: any[] | undefined, workspace: string): Message {
  const time = info.time && typeof info.time === "object" ? info.time.created : info.time
  const completed = info.time && typeof info.time === "object" ? info.time.completed : undefined
  const durationMs =
    typeof time === "number" && typeof completed === "number" && completed >= time ? completed - time : undefined
  const t = info.tokens
  const model = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined
  return {
    id: info.id,
    sessionID: toInternalId(info.sessionID ?? ""),
    role: info.role === "user" ? "user" : "assistant",
    time: typeof time === "number" ? time : Date.now(),
    ...(durationMs !== undefined ? { durationMs } : {}),
    parts: mapParts(parts, workspace),
    ...(typeof info.cost === "number" ? { cost: info.cost } : {}),
    ...(model ? { model } : {}),
    ...(t
      ? {
          tokens: {
            input: t.input ?? 0,
            output: t.output ?? 0,
            reasoning: t.reasoning ?? 0,
            cache: { read: t.cache?.read ?? 0, write: t.cache?.write ?? 0 },
          },
        }
      : {}),
    ...(info.error ? { error: mapError(info.error) } : {}),
  }
}

// opencode reports a failed turn *on the message* (info.error) and still
// answers the prompt POST with 200, so a refusal looks exactly like an empty
// reply unless this is carried through. The useful text is nested under
// data.message; name alone ("APIError") says nothing.
function mapError(e: any): HarnessError {
  const name = typeof e?.name === "string" ? e.name : undefined
  const message =
    (typeof e?.data?.message === "string" && e.data.message) ||
    (typeof e?.message === "string" && e.message) ||
    name ||
    "error"
  const provider = typeof e?.data?.providerID === "string" ? e.data.providerID : undefined
  const model = typeof e?.data?.modelID === "string" ? e.data.modelID : undefined
  const status = typeof e?.data?.statusCode === "number" ? e.data.statusCode : undefined
  return {
    ...(name ? { name } : {}),
    message,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(status ? { status } : {}),
  }
}

export class OpenCodeAdapter implements HarnessAdapter {
  readonly id = "opencode"
  readonly workspace: string
  readonly endpoint: string
  #child: ChildProcess
  #eventReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>()
  #modelsAt = 0
  #modelsCache: ModelRef[] = []
  #capsAt = 0
  #capsCache: Map<string, ModelCaps> = new Map()
  // opencode's message.part.delta events carry only partID (no type), so we
  // remember each part's type from its message.part.updated event (which always
  // precedes the deltas) to tell reasoning apart from answer text.
  #partTypes = new Map<string, string>()
  // permission request ids already surfaced, so an ask opencode re-emits (or
  // sends under both event names) is shown once, not three times
  #askedPermissions = new Set<string>()
  // A question ask is answered by LABEL, not by jep's option id, and the ids
  // carry a truncated label (and a question index) that opencode would not
  // recognise. So the real label of each option is remembered here, keyed by
  // the ask id, when the ask is surfaced — the reply needs it back.
  #questionLabels = new Map<string, Map<string, string>>()
  // provider failures (429 / usage cap / upstream 5xx) parsed out of opencode's
  // own stderr, keyed by native session id. opencode logs these but never
  // emits a session.error for them, so without this a rate-limited turn just
  // goes silent and the watchdog can only say "no activity".
  #providerErrors: Map<string, { error: HarnessError; at: number }>

  constructor(
    child: ChildProcess,
    workspace: string,
    endpoint: string,
    providerErrors: Map<string, { error: HarnessError; at: number }> = new Map(),
  ) {
    this.#child = child
    this.workspace = workspace
    this.endpoint = endpoint
    this.#providerErrors = providerErrors
  }

  #url(path: string): string {
    return `${this.endpoint}${path}`
  }

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    // read-only control calls can hang forever behind a busy/stalled serve
    // server; a hard timeout turns those into a clear error instead.
    const res = await fetch(this.#url(path), {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new HttpError(res.status, `opencode ${init?.method ?? "GET"} ${path} -> ${res.status}: ${body.slice(0, 200)}`)
    }
    return res.json() as T
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    return this.#json("/global/health")
  }

  // Unlike the CLI harnesses, nothing is left to the engine here: a prompt
  // with no model picked is sent as MODEL_REF, so that is the answer.
  async defaultModel(): Promise<string | null> {
    return MODEL_REF
  }

  async models(): Promise<ModelRef[]> {
    if (this.#modelsCache.length > 0 && Date.now() - this.#modelsAt < 60_000) return this.#modelsCache
    const refs: ModelRef[] = []
    // JEP_MODEL is "provider/model"; anything else is a misconfiguration, and
    // a half-parsed ref would surface as a model that silently never runs
    const [defProvider = "", defModel = ""] = MODEL_REF.split("/")
    refs.push({ providerID: defProvider, modelID: defModel })
    const configProviders = new Set<string>()
    try {
      const cfgPath =
        process.env.OPENCODE_CONFIG ??
        path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode", "opencode.json")
      const cfg = JSON.parse(stripJsonc(await readFile(cfgPath, "utf8")))
      const providers = (cfg?.providers ?? cfg?.provider ?? {}) as Record<string, { models?: Record<string, unknown> | string }>
      for (const [providerID, p] of Object.entries(providers)) {
        if (!p) continue
        configProviders.add(providerID)
        if (p.models && typeof p.models === "object") {
          for (const modelID of Object.keys(p.models)) refs.push({ providerID, modelID })
        } else if (typeof p.models === "string") {
          refs.push({ providerID, modelID: p.models })
        }
      }
    } catch (err) {
      // missing config is normal; an unparseable one silently costs you every
      // model it defines, so say which it was
      const e = err as NodeJS.ErrnoException
      if (e?.code !== "ENOENT") console.error(`[models] config unreadable: ${e?.message ?? err}`)
    }

    // The config only knows custom/local providers. The models the user can
    // actually pick in opencode come from `opencode models`: the free opencode
    // (zen) models like big-pickle, plus opencode-go (Go subscription).
    try {
      const list = await new Promise<string>((resolve, reject) => {
        execFile(OPENCODE_BIN, ["models"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err) reject(err)
          else resolve(stdout)
        })
      })
      for (const line of list.split("\n")) {
        const ref = line.trim()
        const slash = ref.indexOf("/")
        if (slash <= 0) continue
        const providerID = ref.slice(0, slash)
        const modelID = ref.slice(slash + 1)
        if (!modelID) continue
        if (providerID === "opencode" || providerID === "opencode-go" || configProviders.has(providerID)) {
          refs.push({ providerID, modelID })
        }
      }
    } catch (err) {
      // without the CLI the picker silently loses every opencode/opencode-go
      // model and shows only what the config declares — never quietly
      console.error(`[models] \`opencode models\` failed, picker limited to config models: ${(err as Error)?.message ?? err}`)
    }

    const out: ModelRef[] = []
    const seen = new Set<string>()
    for (const ref of refs) {
      const key = `${ref.providerID}/${ref.modelID}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ref)
    }
    this.#modelsCache = out
    this.#modelsAt = Date.now()
    return out
  }

  async createSession(title?: string): Promise<SessionSummary> {
    return this.#json("/session", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    }).then((s: any) => this.#toSummary(s))
  }

  // `provider/model` -> input capabilities, taken from the serve API's own
  // model metadata. `/provider` returns `{ all: [ { id, models: { ... } } ] }`
  // where each model carries `capabilities.{ attachment, input.image, ... }`.
  async capabilities(): Promise<Map<string, ModelCaps>> {
    if (this.#capsCache.size > 0 && Date.now() - this.#capsAt < 60_000) return this.#capsCache
    const out = new Map<string, ModelCaps>()
    try {
      const data = await this.#json<ProviderRoot>("/provider")
      for (const provider of data.all ?? []) {
        for (const [key, m] of Object.entries(provider.models ?? {})) {
          const caps = m.capabilities ?? {}
          // registry providers (opencode, opencode-go, localfree-models-proxy)
          // key models bare (`qwen3.7-max`); config providers use the full
          // `provider/model` key. Normalize so every key matches picker labels.
          const normalized = key.includes("/") ? key : `${m.providerID ?? provider.id}/${key}`
          out.set(normalized, {
            image: caps.input?.image === true,
            attachment: caps.attachment === true,
            contextLimit: typeof m.limit?.context === "number" ? m.limit.context : 0,
          })
        }
      }
    } catch (err) {
      console.error(`[caps] /provider read failed, models left unmarked: ${(err as Error)?.message ?? err}`)
    }
    this.#capsCache = out
    this.#capsAt = Date.now()
    return out
  }

  async getSession(id: string): Promise<SessionSummary | null> {
    try {
      const s = await this.#json(`/session/${encodeURIComponent(toNativeId(id))}`)
      return this.#toSummary(s)
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null
      throw err
    }
  }

  // every workspace jep spawns shares one opencode data home (same dataHome
  // passed to startOpenCodeServer for each), and opencode's own session store
  // is global to that data home regardless of which directory created a
  // session — confirmed empirically: a second `opencode serve` rooted
  // elsewhere but sharing the data home already sees the first one's
  // sessions via its own /session. So a session stays reachable no matter
  // how many times the configured workspace directory changes; jep doesn't
  // need to filter by directory itself to get that.
  //
  // /session is scoped to the one *project* this serve instance resolved,
  // though, and opencode can hold more than one project row for the same
  // worktree: its project id is keyed to repo identity, so adding or renaming
  // a remote, rewriting history, or re-initing the repo mints a new id and
  // strands every earlier session under the old one. Those threads then
  // vanish from /ls even though they are still in the store. /experimental/
  // session lists across projects, so unioning it with the project-scoped list
  // keeps them reachable. Absent on older opencode — then the project list is
  // the whole of what this adapter can know.
  async listSessions(): Promise<SessionSummary[]> {
    const sessions = mergeSessionRows(
      await this.#json<any[]>("/session"),
      await this.#crossProjectSessions(),
    )
    // a session with a parent is a subagent the model spawned for a sub-task —
    // an implementation detail of somebody else's turn, never something you
    // meant to open, so it never lists (the codex adapter does the same). The
    // parent still reports how many it has, and they're reachable from there.
    const children = new Map<string, number>()
    for (const s of sessions) {
      const parent = s?.parentID ?? s?.parent_id
      if (parent) children.set(String(parent), (children.get(String(parent)) ?? 0) + 1)
    }
    return sessions
      .filter((s) => !(s?.parentID ?? s?.parent_id))
      .map((s) => ({ ...this.#toSummary(s), subagents: children.get(String(s.id)) ?? 0 }))
  }

  // every session in this workspace's directory, whichever project row holds it.
  // Best-effort: a 404 (older opencode) means no supplement, and anything else
  // is logged and swallowed so an enrichment can never take down the primary
  // listing it exists to help.
  async #crossProjectSessions(): Promise<any[]> {
    try {
      return await this.#json<any[]>(`/experimental/session?directory=${encodeURIComponent(this.workspace)}`)
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404))
        console.error(`[sessions] cross-project listing failed: ${(err as Error)?.message ?? err}`)
      return []
    }
  }

  async subagents(sessionID: string): Promise<SessionSummary[]> {
    const native = toNativeId(sessionID)
    const sessions = await this.#json<any[]>("/session")
    return sessions
      .filter((s) => String(s?.parentID ?? s?.parent_id ?? "") === native)
      .sort((a, b) => (a?.time?.created ?? 0) - (b?.time?.created ?? 0))
      .map((s) => this.#toSummary(s))
  }

  // GET /project: every project this data home knows of, regardless of
  // which one this adapter's own instance is rooted in (verified: an
  // instance rooted in one project still lists every other project here —
  // only /session is scoped to the calling instance's own project).
  async listProjects(): Promise<ProjectSummary[]> {
    const projects = await this.#json<any[]>("/project")
    return projects.filter((p) => p.worktree && p.worktree !== "/").map((p) => ({ id: p.id, worktree: p.worktree }))
  }

  async diff(sessionID: string): Promise<FileDiff[]> {
    const rows = await this.#json<any[]>(`/session/${encodeURIComponent(toNativeId(sessionID))}/diff`)
    return rows.map((r) => ({ file: r.file ?? "", additions: r.additions ?? 0, deletions: r.deletions ?? 0, status: r.status }))
  }

  #toSummary(s: any): SessionSummary {
    const created = s.time && typeof s.time === "object" ? s.time.created : s.time
    const createdAt = typeof created === "number" ? created : Date.now()
    const updated = s.time && typeof s.time === "object" ? s.time.updated : undefined
    return {
      id: toInternalId(s.id),
      title: s.title ?? "",
      workspace: s.directory ?? this.workspace,
      createdAt,
      updatedAt: typeof updated === "number" ? updated : createdAt,
    }
  }

  async prompt(
    sessionID: string,
    text: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal; model?: ModelRef; filePaths?: string[]; agent?: string },
  ): Promise<Message> {
    const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // a fresh turn invalidates the last turn's provider failure: whatever we
    // recorded before is no longer this prompt's story
    this.#providerErrors.delete(toNativeId(sessionID))
    const controller = new AbortController()
    const onAbort = () => {
      controller.abort()
      void this.abort(sessionID)
    }
    opts?.signal?.addEventListener("abort", onAbort, { once: true })
    // timeoutMs: 0 disables the absolute deadline. A real agent turn can run
    // for half an hour and any fixed ceiling eventually cuts one off mid-work,
    // so callers that watch the event stream (see the bot's idle watchdog)
    // opt out of this one and kill the turn on *inactivity* instead.
    const timer =
      timeout > 0
        ? setTimeout(() => {
            // the one abort that is neither a stop nor a harness event: name it,
            // or a turn cut off by this deadline reads as having died for no
            // reason (which is exactly how the gateway's 3-minute ceiling hid)
            console.error(`[stop] origin=prompt-timeout (session ${sessionID}, ${timeout}ms)`)
            onAbort()
          }, timeout)
        : null

    try {
      const [defaultProvider, defaultModel] = MODEL_REF.split("/")
      const model = opts?.model ?? { providerID: defaultProvider, modelID: defaultModel }
      const agent = resolveAgent(AGENTS, opts?.agent)
      const parts = [
        { type: "text", text },
        ...(opts?.filePaths ?? []).map((fp) => ({ type: "file", mime: mimeFor(fp), url: pathToFileURL(fp).href })),
      ]
      const res = await fetch(this.#url(`/session/${encodeURIComponent(toNativeId(sessionID))}/message`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts, model, ...(agent ? { agent } : {}) }),
        signal: controller.signal,
        dispatcher: NO_TIMEOUT_AGENT,
      })
      if (!res.ok) {
        const textError = await res.text().catch(() => "")
        throw new Error(`prompt -> ${res.status}: ${textError.slice(0, 200)}`)
      }
      const data = (await res.json()) as { info?: any; parts?: any[] }
      return mapMessage(data.info ?? {}, data.parts ?? [], this.workspace)
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        // a stop and a timeout are both AbortErrors; only the first is a stop
        if (opts?.signal?.aborted) throw new TurnAbortedError()
        throw new Error(`prompt timed out after ${timeout}ms`)
      }
      // "fetch failed" is Node's generic "the connection dropped" message, and
      // it reads like a mystery. Name what actually happened — the local
      // opencode server reset or refused the request — and carry the OS code.
      if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
        const cause = (err as { cause?: { code?: string } }).cause
        throw new Error(`opencode server connection lost${cause?.code ? ` (${cause.code})` : ""}`)
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      opts?.signal?.removeEventListener("abort", onAbort)
    }
  }

  async messages(sessionID: string, opts?: { limit?: number }): Promise<Message[]> {
    // opencode pages by `limit` (newest N); its `before` rejects every value we
    // tried, so walking back is done by asking for a bigger newest-N instead
    const q = opts?.limit && opts.limit > 0 ? `?limit=${Math.floor(opts.limit)}` : ""
    const rows = await this.#json<any[]>(`/session/${encodeURIComponent(toNativeId(sessionID))}/message${q}`)
    return rows
      .map((r) => mapMessage(r?.info ?? {}, r?.parts ?? [], this.workspace))
      .sort((a, b) => a.time - b.time)
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.#json(`/session/${encodeURIComponent(toNativeId(id))}`, { method: "DELETE" })
  }

  async abort(sessionID: string): Promise<boolean> {
    // opencode answers a stop with its own session.error (MessageAbortedError),
    // which events() translates to turn.aborted — so every watcher, not just
    // the caller who asked, learns how the turn ended
    return this.#json(`/session/${encodeURIComponent(toNativeId(sessionID))}/abort`, { method: "POST" })
  }

  async agents(): Promise<AgentRef[]> {
    return AGENTS
  }

  // The provider failure opencode named for this session but never surfaced as
  // a session.error event (see opencode-log.ts). Cleared at the start of every
  // turn, so a failure can only ever explain the turn it happened in — a stale
  // 429 never gets blamed for an unrelated stall minutes later.
  providerError(sessionID: string): HarnessError | null {
    return this.#providerErrors.get(toNativeId(sessionID))?.error ?? null
  }

  // opencode's own three answers, passed straight through: "always" is a
  // standing rule it saves, not a second "once", so collapsing them into a
  // boolean would throw away the only one of the three that changes anything
  // beyond this call.
  async respondAsk(sessionID: string, askID: string, optionID: string): Promise<boolean> {
    try {
      // Two kinds of ask, two different routes. A permission is answered on
      // the session's permissions endpoint. A question — the `question` tool
      // parking the turn on a human — is answered on the global questions
      // endpoint, and by LABEL: jep's option id carries a truncated label and a
      // question index, which opencode would not recognise. The real label was
      // remembered when the ask was surfaced.
      const labels = this.#questionLabels.get(askID)
      if (labels) {
        const label = labels.get(optionID) ?? optionID
        this.#questionLabels.delete(askID)
        await this.#json(`/question/${encodeURIComponent(askID)}/reply`, {
          method: "POST",
          body: JSON.stringify({ answers: [[label]] }),
        })
        return true
      }
      await this.#json(
        `/session/${encodeURIComponent(toNativeId(sessionID))}/permissions/${encodeURIComponent(askID)}`,
        { method: "POST", body: JSON.stringify({ response: optionID }) },
      )
      return true
    } catch (err) {
      // The request is already gone: answered elsewhere, timed out, or re-issued
      // by opencode. There is nothing left to answer, and surfacing this as a
      // failure left the turn blocked on a prompt that no longer existed. A stale
      // approval is a no-op, not an error.
      if (err instanceof HttpError && err.status === 404) return true
      throw err
    }
  }

  // opencode auto-loads the cross-agent user dirs and its own project roots
  // (verified against its own loader: `.opencode/skill(s)/<name>/SKILL.md`)
  skillDirs(): SkillDirs {
    return {
      userDirs: [path.join(os.homedir(), ".claude", "skills"), path.join(os.homedir(), ".agents", "skills")],
      projectDirs: [path.join(this.workspace, ".opencode", "skills"), path.join(this.workspace, ".opencode", "skill")],
      toggleable: true,
    }
  }

  async *events(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    let res: Response
    try {
      res = await fetch(this.#url("/event"), { signal: controller.signal, dispatcher: NO_TIMEOUT_AGENT })
    } catch (err) {
      // losing this subscription means no live streaming for the whole turn
      if (!controller.signal.aborted) console.error(`[events] subscribe failed: ${(err as Error)?.message ?? err}`)
      return
    }
    if (!res.body) return
    const reader = res.body.getReader()
    this.#eventReaders.add(reader)
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          for (const frame of parseSse(raw)) {
            if (!frame.data) continue
            const evt = this.#toDomainEvent(frame)
            if (evt) yield evt
          }
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort)
      this.#eventReaders.delete(reader)
      controller.abort()
    }
  }

  #toDomainEvent(frame: SseFrame): DomainEvent | null {
    let data: any
    try {
      data = JSON.parse(frame.data ?? "")
    } catch {
      return null
    }
    const type = data?.type ?? frame.event ?? ""
    const props = data?.properties ?? {}
    const rawSession = props.sessionID as string | undefined
    const sessionID = rawSession ? toInternalId(rawSession) : undefined
    const messageID = props.messageID as string | undefined
    const partID = props.partID as string | undefined
    switch (type) {
      case "server.connected":
        return { type: "server.connected" }
      case "message.created":
        return {
          type: "message.created",
          sessionID: sessionID ?? "",
          messageID: (props.info?.id as string | undefined) ?? messageID ?? "",
          role: (props.info?.role as string | undefined) ?? "",
        }
      case "message.updated":
        return {
          type: "message.updated",
          sessionID: sessionID ?? "",
          messageID: (props.info?.id as string | undefined) ?? messageID ?? "",
          role: (props.info?.role as string | undefined) ?? "",
        }
      case "session.idle":
        return { type: "session.idle", sessionID: sessionID ?? "" }
      case "message.part.updated": {
        const part = props.part as { id?: string; type?: string; messageID?: string } | undefined
        if (part?.id && part.type) {
          if (this.#partTypes.size > 5_000) this.#partTypes.clear()
          this.#partTypes.set(part.id, part.type)
        }
        return {
          type: "part.updated",
          sessionID: sessionID ?? "",
          messageID: part?.messageID ?? messageID ?? "",
          // the part's own id, NOT a top-level event partID — opencode 1.18
          // puts the id inside part and sends no partID field. Keying these
          // events by anything else lands every full-state snapshot in one
          // shared slot, and the live view renders the answer twice: once
          // from the delta-accumulated part, once from this orphan.
          partID: part?.id ?? partID ?? "",
          partType: (part?.type as string) ?? "",
          part: part && (part as { synthetic?: unknown }).synthetic !== true ? mapPart(part, this.workspace) : undefined,
        }
      }
      case "message.part.delta":
        return {
          type: "part.delta",
          sessionID: sessionID ?? "",
          messageID: messageID ?? "",
          partID: partID ?? "",
          // prefer the explicit field if the server ever adds it, else the
          // type we learned from this part's message.part.updated event
          partType: (props.partType as string | undefined) ?? this.#partTypes.get(partID ?? "") ?? "",
          text: props.field === "text" ? (props.delta ?? "") as string : "",
        }
      case "question.asked": {
        // the `question` tool: the model parked the turn on the human. Each
        // question carries its own choices; option ids are "<question idx>:<label>"
        // so a tap names both the slot it fills and the answer it carries.
        const questions = (Array.isArray(props.questions) ? props.questions : []) as Array<{
          question?: string
          header?: string
          options?: Array<{ label?: string }>
        }>
        const options: AskOption[] = []
        const labels = new Map<string, string>()
        questions.forEach((q, qi) => {
          for (const o of q.options ?? []) {
            const label = String(o?.label ?? "").trim()
            if (label) {
              const id = `${qi}:${label.slice(0, 28)}`
              options.push({ id, label: label.slice(0, 64) })
              labels.set(id, label)
            }
          }
        })
        const askID = (props.id as string) ?? ""
        if (askID) {
          if (this.#questionLabels.size > 2_000) this.#questionLabels.clear()
          this.#questionLabels.set(askID, labels)
        }
        return {
          type: "ask.requested",
          sessionID: sessionID ?? "",
          ask: {
            id: askID,
            sessionID: sessionID ?? "",
            kind: "question",
            title: questions[0]?.header || questions[0]?.question || "question",
            ...(questions.length ? { detail: questions.map((q) => q.question ?? "").filter(Boolean).join("\n\n") } : {}),
            options,
          },
        }
      }
      case "permission.asked":
      case "permission.updated": {
        const permID = (props.id as string) ?? ""
        if (permID) {
          if (this.#askedPermissions.has(permID)) return null
          if (this.#askedPermissions.size > 2_000) this.#askedPermissions.clear()
          this.#askedPermissions.add(permID)
        }
        // The runtime sends this as "permission.asked"; "permission.updated"
        // is the same ask surfaced through the older event name. The id alone
        // used to be all jep passed on, so the prompt read "🔐 per_a1b2…" —
        // the one thing about the request that tells you nothing. What is
        // being asked for is `permission` (the tool) and `patterns` (what it
        // wants to touch), with the command itself down in metadata.
        const meta = (props.metadata ?? {}) as Record<string, unknown>
        const patterns = Array.isArray(props.patterns) ? (props.patterns as string[]) : []
        const detail = [typeof meta.command === "string" ? meta.command : "", patterns.join("  ")]
          .filter(Boolean)
          .join("\n")
        return {
          type: "ask.requested",
          sessionID: sessionID ?? "",
          ask: {
            id: (props.id as string) ?? "",
            sessionID: sessionID ?? "",
            title: (props.permission as string) || "permission",
            ...(detail ? { detail } : {}),
            options: [
              { id: "once", label: "Allow once", style: "success" },
              { id: "always", label: "Always allow" },
              { id: "reject", label: "Deny", style: "danger" },
            ],
          },
        }
      }
      case "session.error": {
        const raw = props.error
        // a stop is reported as an error (MessageAbortedError / "Aborted") but
        // it is not a failure — it is how the turn ended. Translated here, in
        // the one place that knows opencode's spelling, so no client has to
        // read the prose.
        if (isAbortPayload(raw)) return { type: "turn.aborted", sessionID: sessionID ?? "" }
        // props.error is usually a string, but has been seen as a structured
        // {name, message} object depending on what failed upstream (a raw
        // provider SDK error vs. opencode's own wrapping) -- stringify
        // defensively rather than let a template literal turn it into
        // "[object Object]" in the log and in the chat.
        const message =
          typeof raw === "string"
            ? raw
            : raw && typeof raw === "object"
              ? ((raw.message as string | undefined) ?? JSON.stringify(raw))
              : String(raw ?? "unknown error")
        return { type: "session.error", sessionID: sessionID ?? "", message }
      }
      default:
        return { type: "other", eventType: type, sessionID, raw: data }
    }
  }

  async close(): Promise<void> {
    for (const reader of this.#eventReaders) await reader.cancel().catch(() => {})
    this.#eventReaders.clear()
    this.#child.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      if (this.#child.exitCode !== null) return resolve()
      this.#child.once("exit", () => resolve())
      setTimeout(resolve, 2_000)
    })
  }
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// opencode config is JSONC; drop whole-line // comments (URLs live inside quoted
// strings so they're untouched), then hand the rest to JSON.parse.
function stripJsonc(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
}

export async function startOpenCodeServer(workspace: string, opts?: { dataHome?: string }): Promise<OpenCodeAdapter> {
  // --print-logs: opencode otherwise keeps its logs to its own file, and the
  // one record that matters here — `message="stream error"` (a 429, a usage
  // cap) — never becomes a session.error SSE event. On stderr it reaches the
  // forwarder below, which is the only way a frontend ever learns the reason.
  const child = spawn(OPENCODE_BIN, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: workspace,
    env: opts?.dataHome ? { ...process.env, XDG_DATA_HOME: opts.dataHome } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  // Only the startup phase (below) captured this into `out`, and nothing
  // read it again after the "listening" line landed -- so anything the
  // opencode binary itself printed once running (a provider SDK error that
  // never made it into a session.error SSE event, an uncaught exception, a
  // crash) was invisible. Forward it into our own log for the life of the
  // process, tagged by workspace so parallel servers don't interleave blind.
  const tag = path.basename(workspace)
  // `--print-logs` puts every level on stderr, so forward only what's worth a
  // line in our log (WARN/ERROR) and keep the provider failures on the side,
  // where a stalled turn can ask for them by session id.
  const providerErrors = new Map<string, { error: HarnessError; at: number }>()
  const forwardLine = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue
      const err = parseOpencodeLogError(line)
      if (err) providerErrors.set(err.sessionID, { error: err.error, at: Date.now() })
      if (err || /\blevel=(ERROR|WARN)\b/.test(line)) console.error(`[opencode:${tag}] ${line}`)
    }
  }

  let endpoint = ""
  const portPromise = new Promise<string>((resolve, reject) => {
    let out = ""
    const timer = setTimeout(() => reject(new Error(`opencode serve failed to start in ${workspace}: no listening line. logs:\n${out}`)), 15_000)
    const onData = (chunk: Buffer) => {
      out += chunk.toString()
      const m = listenRe.exec(out)
      if (m) {
        clearTimeout(timer)
        const port = m[2]
        child.stdout?.off("data", onData)
        child.stderr?.off("data", onData)
        child.stdout?.on("data", forwardLine)
        child.stderr?.on("data", forwardLine)
        resolve(`http://127.0.0.1:${port}`)
      }
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`opencode serve exited early (code ${code}):\n${out}`))
    })
    child.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

  endpoint = await portPromise
  const adapter = new OpenCodeAdapter(child, workspace, endpoint, providerErrors)
  return adapter
}
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { HarnessAdapter, ApprovalRequest, ModelRef, ModelCaps } from "../core/ports.ts"
import type { DomainEvent, Message, Part, SessionSummary } from "../core/types.ts"

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode"
const MODEL_REF = process.env.JEP_MODEL ?? "localfree-models-proxy/auto"
const DEFAULT_TIMEOUT_MS = 180_000

// Namespaces every session id we expose at the port boundary, so ids from
// different harness adapters can never collide and stay stable across
// restarts. Native ids (e.g. "ses_…", "msg_…") are only ever used internally.
const HARNESS_NS = "opencode"

const toInternalId = (native: string) => `${HARNESS_NS}://${native}`
const toNativeId = (id: string) =>
  id.startsWith(`${HARNESS_NS}://`) ? id.slice(HARNESS_NS.length + 3) : id

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
}
interface ProviderRoot {
  all?: Array<{ models?: Record<string, ProviderModelMeta> }>
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
  switch (part?.type) {
    case "text":
      return { kind: "text", text: part.text ?? "" }
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
      }
    case "reasoning":
      return { kind: "reasoning", text: part.text ?? "" }
    case "snapshot":
      return { kind: "snapshot" }
    case "file": {
      // output FileParts carry a file:// url, not a file_path
      const raw = part.file_path ?? part.url ?? ""
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
        mimeType: part.mime_type ?? part.mime,
      }
    }
    default:
      return { kind: "other", nativeType: part?.type ?? "unknown" }
  }
}

function mapMessage(info: any, parts: any[] | undefined, workspace: string): Message {
  const time = info.time && typeof info.time === "object" ? info.time.created : info.time
  return {
    id: info.id,
    sessionID: toInternalId(info.sessionID ?? ""),
    role: info.role === "user" ? "user" : "assistant",
    time: typeof time === "number" ? time : Date.now(),
    parts: (parts ?? []).map((p) => mapPart(p, workspace)),
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

  constructor(child: ChildProcess, workspace: string, endpoint: string) {
    this.#child = child
    this.workspace = workspace
    this.endpoint = endpoint
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

  async models(): Promise<ModelRef[]> {
    if (this.#modelsCache.length > 0 && Date.now() - this.#modelsAt < 60_000) return this.#modelsCache
    const refs: ModelRef[] = []
    const [defProvider, defModel] = MODEL_REF.split("/")
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
    } catch {
      // missing/unparseable config is fine — the default MODEL_REF is still returned
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
    } catch {
      // CLI unavailable — config models are still returned
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
          })
        }
      }
    } catch {
      /* capabilities are best-effort; the picker simply leaves unknown models unmarked */
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

  async listSessions(): Promise<SessionSummary[]> {
    const sessions = await this.#json<any[]>("/session")
    return sessions
      .filter((s) => (s.directory ?? this.workspace) === this.workspace)
      .map((s) => this.#toSummary(s))
  }

  #toSummary(s: any): SessionSummary {
    const created = s.time && typeof s.time === "object" ? s.time.created : s.time
    return {
      id: toInternalId(s.id),
      title: s.title ?? "",
      workspace: s.directory ?? this.workspace,
      createdAt: typeof created === "number" ? created : Date.now(),
    }
  }

  async prompt(
    sessionID: string,
    text: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal; model?: ModelRef },
  ): Promise<Message> {
    const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const onAbort = () => {
      controller.abort()
      void this.abort(sessionID)
    }
    opts?.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(onAbort, timeout)

    try {
      const [defaultProvider, defaultModel] = MODEL_REF.split("/")
      const model = opts?.model ?? { providerID: defaultProvider, modelID: defaultModel }
      const parts = [
        { type: "text", text },
        ...(opts?.filePaths ?? []).map((fp) => ({ type: "file", mime: mimeFor(fp), url: pathToFileURL(fp).href })),
      ]
      const res = await fetch(this.#url(`/session/${encodeURIComponent(toNativeId(sessionID))}/message`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts, model }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const textError = await res.text().catch(() => "")
        throw new Error(`prompt -> ${res.status}: ${textError.slice(0, 200)}`)
      }
      const data = (await res.json()) as { info?: any; parts?: any[] }
      return mapMessage(data.info ?? {}, data.parts ?? [], this.workspace)
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        throw new Error(opts?.signal?.aborted ? "prompt aborted" : `prompt timed out after ${timeout}ms`)
      }
      throw err
    } finally {
      clearTimeout(timer)
      opts?.signal?.removeEventListener("abort", onAbort)
    }
  }

  async messages(sessionID: string): Promise<Message[]> {
    const rows = await this.#json<any[]>(`/session/${encodeURIComponent(toNativeId(sessionID))}/message`)
    return rows
      .map((r) => mapMessage(r?.info ?? {}, r?.parts ?? [], this.workspace))
      .sort((a, b) => a.time - b.time)
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.#json(`/session/${encodeURIComponent(toNativeId(id))}`, { method: "DELETE" })
  }

  async abort(sessionID: string): Promise<boolean> {
    return this.#json(`/session/${encodeURIComponent(toNativeId(sessionID))}/abort`, { method: "POST" })
  }

  async respondApproval(sessionID: string, approval: ApprovalRequest, allow: boolean): Promise<boolean> {
    return this.#json(
      `/session/${encodeURIComponent(toNativeId(sessionID))}/permissions/${encodeURIComponent(approval.id)}`,
      {
        method: "POST",
        body: JSON.stringify({ response: allow ? "allowed" : "rejected" }),
      },
    )
  }

  async *events(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    let res: Response
    try {
      res = await fetch(this.#url("/event"), { signal: controller.signal })
    } catch {
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
          partID: partID ?? "",
          partType: (part?.type as string) ?? "",
          part: part ? mapPart(part, this.workspace) : undefined,
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
      case "permission.updated":
        return { type: "permission.requested", sessionID: sessionID ?? "", permissionID: props.id ?? "" }
      case "session.error":
        return { type: "session.error", sessionID: sessionID ?? "", message: props.error ?? "" }
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
  const child = spawn(OPENCODE_BIN, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: workspace,
    env: opts?.dataHome ? { ...process.env, XDG_DATA_HOME: opts.dataHome } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })

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
  const adapter = new OpenCodeAdapter(child, workspace, endpoint)
  return adapter
}
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { HarnessAdapter, HarnessCommand, ModelCaps, ModelRef } from "../core/ports.ts"
import type { DomainEvent, FileDiff, Message, Part, ProjectSummary, SessionSummary, SkillDirs } from "../core/types.ts"
import { splitQuoteText, transcriptText, withQuoteText, stripInjectedContext, contextFor, isScaffold } from "../core/transcript.ts"
import { TurnAbortedError } from "../core/types.ts"

/**
 * Pi CLI as a harness.
 *
 * Pi is a request/response CLI rather than a server. `--mode json` gives us a
 * stream for one turn, while `--session-id` and `--session-dir` make each
 * invocation continue the same append-only JSONL conversation. This is the
 * same shape as the Codex adapter, with Pi's session files supplying history.
 */
const PI_BIN = process.env.JEP_PI_BIN ?? "pi"
const PI_AGENT_DIR = process.env.JEP_PI_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent")
const PI_PROVIDER = process.env.JEP_PI_PROVIDER
const PI_MODEL = process.env.JEP_PI_MODEL
// Pi extensions are part of the provider/model contract (for example,
// pi-litellm registers the dynamic `litellm` provider). Keep them enabled by
// default; an operator can opt into the old isolated behavior explicitly.
const PI_NO_EXTENSIONS = /^(1|true|yes)$/i.test(process.env.JEP_PI_NO_EXTENSIONS ?? "")
const piExtensionArgs = (): string[] => PI_NO_EXTENSIONS ? ["--no-extensions"] : []
const HARNESS_NS = "pi"

const toInternalId = (native: string) => `${HARNESS_NS}://${native}`
const toNativeId = (id: string) => (id.startsWith(`${HARNESS_NS}://`) ? id.slice(HARNESS_NS.length + 3) : id)

interface PiSessionFile {
  type: "session"
  id: string
  cwd: string
  timestamp?: string
}

interface PiEntry {
  type?: string
  id?: string
  timestamp?: string
  message?: any
  name?: string
}

interface PiModelConfig {
  id?: string
  name?: string
  input?: string[]
  contextWindow?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

interface PiProviderConfig {
  models?: PiModelConfig[]
}

interface PiModelsFile {
  providers?: Record<string, PiProviderConfig>
}

interface PiAdapterOptions {
  /** jep's isolated data home; absent means Pi's regular session root */
  dataHome?: string
}

export class PiAdapter implements HarnessAdapter {
  readonly id = "pi"
  readonly workspace: string
  readonly endpoint: string

  #sessionDir: string
  #modelsCache: ModelRef[] = []
  #modelsAt = 0
  #capsCache = new Map<string, ModelCaps>()
  #capsAt = 0
  // conversations that already got jep's context header (see contextFor)
  #briefed = new Map<string, number>()
  #pendingTitles = new Map<string, { title: string; createdAt: number }>()
  #running = new Map<string, ChildProcess>()
  #aborting = new Set<string>()
  #bus = new Set<(evt: DomainEvent) => void>()
  #closed = false

  constructor(workspace: string, opts: PiAdapterOptions = {}) {
    this.workspace = path.resolve(workspace)
    this.endpoint = `pi-cli:${this.workspace}`
    const root = opts.dataHome ? path.join(opts.dataHome, "pi-sessions") : path.join(PI_AGENT_DIR, "sessions")
    this.#sessionDir = path.join(root, encodeWorkspace(this.workspace))
  }

  #emit(evt: DomainEvent): void {
    for (const fn of this.#bus) {
      try {
        fn(evt)
      } catch (err) {
        console.error(`[pi] subscriber threw: ${(err as Error)?.message ?? err}`)
      }
    }
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(PI_BIN, ["--version"], { timeout: 15_000, env: piEnv() }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
      })
      return { healthy: true, version: out.trim() }
    } catch (err) {
      return { healthy: false, version: (err as Error)?.message ?? "pi not runnable" }
    }
  }

  async prepare(): Promise<void> {
    await mkdir(this.#sessionDir, { recursive: true })
  }

  async createSession(title?: string): Promise<SessionSummary> {
    const native = randomUUID()
    const now = Date.now()
    this.#pendingTitles.set(native, { title: title ?? "", createdAt: now })
    return { id: toInternalId(native), title: title ?? "", workspace: this.workspace, createdAt: now, updatedAt: now }
  }

  async getSession(id: string): Promise<SessionSummary | null> {
    const native = toNativeId(id)
    return (await this.listSessions()).find((s) => toNativeId(s.id) === native) ?? null
  }

  async listSessions(): Promise<SessionSummary[]> {
    await mkdir(this.#sessionDir, { recursive: true })
    const out: SessionSummary[] = []
    let names: string[] = []
    try {
      names = (await readdir(this.#sessionDir)).filter((name) => name.endsWith(".jsonl"))
    } catch {
      names = []
    }
    for (const name of names) {
      const file = path.join(this.#sessionDir, name)
      const parsed = await readPiFile(file)
      if (!parsed || parsed.header.cwd && path.resolve(parsed.header.cwd) !== this.workspace) continue
      const mtime = await fileTime(file)
      const createdAt = Date.parse(parsed.header.timestamp ?? "") || mtime
      const named = [...parsed.entries].reverse().find((entry) => entry.type === "session_info" && typeof entry.name === "string")?.name
      const first = parsed.entries.find((entry) => entry.type === "message" && entry.message?.role === "user")
      const firstText = first ? messageText(first.message) : ""
      out.push({
        id: toInternalId(parsed.header.id),
        title: clip(named || transcriptText(splitQuoteText(stripInjectedContext(firstText).trimStart()).text)),
        workspace: this.workspace,
        createdAt,
        updatedAt: Math.max(mtime, lastEntryTime(parsed.entries, createdAt)),
      })
    }
    for (const [native, meta] of this.#pendingTitles) {
      if (!out.some((s) => toNativeId(s.id) === native)) {
        out.push({ id: toInternalId(native), title: meta.title, workspace: this.workspace, createdAt: meta.createdAt, updatedAt: meta.createdAt })
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async messages(sessionID: string, opts?: { limit?: number }): Promise<Message[]> {
    const native = toNativeId(sessionID)
    if (this.#pendingTitles.has(native) && !(await this.#findFile(native))) return []
    const file = await this.#findFile(native)
    if (!file) return []
    const parsed = await readPiFile(file)
    if (!parsed) return []
    const out = mapPiEntries(parsed.entries, toInternalId(parsed.header.id))
    return opts?.limit && opts.limit > 0 ? out.slice(-opts.limit) : out
  }

  async deleteSession(id: string): Promise<boolean> {
    const native = toNativeId(id)
    this.#pendingTitles.delete(native)
    const file = await this.#findFile(native)
    if (!file) return true
    try {
      await unlink(file)
      return true
    } catch (err) {
      console.error(`[pi] delete failed for ${native}: ${(err as Error)?.message ?? err}`)
      return false
    }
  }

  async prompt(
    sessionID: string,
    text: string,
    opts?: {
      timeoutMs?: number
      signal?: AbortSignal
      model?: ModelRef
      filePaths?: string[]
      agent?: string
      quote?: string
      brief?: boolean
    },
  ): Promise<Message> {
    const native = toNativeId(sessionID)
    const model = opts?.model ?? (PI_PROVIDER && PI_MODEL ? { providerID: PI_PROVIDER, modelID: PI_MODEL } : undefined)
    const prompt = `${contextFor(text, this.#briefed, native, opts?.brief)}${withQuoteText(text, opts?.quote)}`
    const args = [
      "--mode",
      "json",
      "--session-dir",
      this.#sessionDir,
      "--session-id",
      native,
      ...(model ? ["--provider", model.providerID, "--model", model.modelID] : []),
      "--approve",
      ...piExtensionArgs(),
      ...((opts?.filePaths ?? []).map((file) => `@${file}`)),
      prompt,
    ]
    const child = spawn(PI_BIN, args, { cwd: this.workspace, env: piEnv(), stdio: ["ignore", "pipe", "pipe"] })
    console.error(`[pi] prompt spawn session=${sessionID} pid=${child.pid ?? "?"} chars=${text.length} model=${model ? `${model.providerID}/${model.modelID}` : "default"} files=${opts?.filePaths?.length ?? 0}`)
    this.#running.set(native, child)
    this.#aborting.delete(native)

    let stderr = ""
    let lastAssistant: Message | null = null
    let finalAssistant: Message | null = null
    let failure: { name: string; message: string } | undefined
    let buf = ""
    const onAbort = () => {
      this.#aborting.add(native)
      child.kill("SIGTERM")
    }
    opts?.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = opts?.timeoutMs && opts.timeoutMs > 0 ? setTimeout(onAbort, opts.timeoutMs) : null

    try {
      await new Promise<void>((resolve, reject) => {
        const consume = (chunk: Buffer | string) => {
          buf += chunk.toString()
          const lines = buf.split("\n")
          buf = lines.pop() ?? ""
          for (const line of lines) {
            const event = parseJsonLine(line)
            if (!event) continue
            const parsed = handlePiEvent(event, toInternalId(native), (evt) => this.#emit(evt))
            if (parsed.assistant) {
              lastAssistant = parsed.assistant
              finalAssistant = parsed.assistant
            }
            if (parsed.failure) {
              failure = parsed.failure
              this.#emit({ type: "session.error", sessionID: toInternalId(native), message: parsed.failure.message })
            }
          }
        }
        child.stdout?.on("data", consume)
        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString()
        })
        child.on("error", reject)
        child.on("close", (code) => {
          console.error(`[pi] prompt close session=${sessionID} pid=${child.pid ?? "?"} code=${code ?? "?"} failure=${failure?.message ? "yes" : "no"} stderr=${stderr.trim() ? "yes" : "no"}`)
          if (this.#aborting.has(native) || opts?.signal?.aborted) return reject(new TurnAbortedError())
          if (code !== 0 && !failure) failure = { name: "PiError", message: stderr.trim().slice(0, 500) || `pi exited ${code}` }
          if (buf.trim()) consume(`${buf}\n`)
          resolve()
        })
      })
    } finally {
      if (timer) clearTimeout(timer)
      opts?.signal?.removeEventListener("abort", onAbort)
      this.#running.delete(native)
      this.#aborting.delete(native)
    }

    const history = await this.messages(sessionID)
    // A failed Pi process often leaves the previous assistant message as the last
    // transcript row. Returning that row made the gateway answer 200 for a prompt
    // that never reached the provider, so the web client discarded the person's
    // optimistic bubble with no indication. A provider failure is a failure even
    // when an older answer exists in the session.
    if (failure) {
      const detail = (failure.message || stderr.trim()).replace(/\bsk-[A-Za-z0-9_-]+\b/g, "sk-<redacted>").slice(0, 500)
      console.error(`[pi] prompt failure session=${sessionID} model=${model ? `${model.providerID}/${model.modelID}` : "default"} ${detail}`)
      throw new Error(failure.message)
    }
    const answer = [...history].reverse().find((message) => message.role === "assistant") ?? finalAssistant ?? lastAssistant
    console.error(`[pi] prompt result session=${sessionID} model=${model ? `${model.providerID}/${model.modelID}` : "default"} answer=${answer ? "yes" : "no"} failure=no`)
    if (answer) return answer
    return {
      id: toInternalId(`${native}:turn-${Date.now()}`),
      sessionID: toInternalId(native),
      role: "assistant",
      time: Date.now(),
      parts: [],
      ...(failure ? { error: failure } : {}),
    }
  }

  async abort(sessionID: string): Promise<boolean> {
    const native = toNativeId(sessionID)
    const child = this.#running.get(native)
    if (!child) return false
    this.#aborting.add(native)
    child.kill("SIGTERM")
    return true
  }

  // The header as a message of its own (see HarnessAdapter.brief): a normal turn
  // carrying only the header, stopped the moment Pi has written the user
  // message, before the model answers. A running turn already has its header.
  async brief(sessionID: string, opts?: { model?: ModelRef }): Promise<boolean> {
    const native = toNativeId(sessionID)
    if (this.#running.has(native)) return false
    const header = contextFor("", this.#briefed, native, true).trim()
    if (!header) return true
    const model = opts?.model ?? (PI_PROVIDER && PI_MODEL ? { providerID: PI_PROVIDER, modelID: PI_MODEL } : undefined)
    const ok = await this.#recordOnly(native, header, model)
    // contextFor spent the header; if it never landed, the next message must carry it
    if (!ok) this.#briefed.delete(native)
    return ok
  }

  async #recordOnly(native: string, text: string, model?: ModelRef): Promise<boolean> {
    const args = [
      "--mode", "json", "--session-dir", this.#sessionDir, "--session-id", native,
      ...(model ? ["--provider", model.providerID, "--model", model.modelID] : []),
      "--approve", ...piExtensionArgs(), text,
    ]
    const child = spawn(PI_BIN, args, { cwd: this.workspace, env: piEnv(), stdio: ["ignore", "pipe", "ignore"] })
    return new Promise<boolean>((resolve) => {
      let buf = ""
      let recorded = false
      const stop = () => {
        clearTimeout(timer)
        child.kill("SIGTERM")
        resolve(recorded)
      }
      // never wait on a Pi that does not answer: the command still goes out
      const timer = setTimeout(stop, 15_000)
      child.once("close", () => { clearTimeout(timer); resolve(recorded) })
      child.once("error", stop)
      child.stdout?.on("data", (chunk: Buffer) => {
        buf += chunk.toString()
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          try {
            const rec = JSON.parse(line) as { type?: string; message?: { role?: string } }
            if (rec.type === "message_end" && rec.message?.role === "user") {
              recorded = true
              return stop()
            }
          } catch {}
        }
      })
    })
  }

  // Compress the conversation with Pi's own RPC `compact`. Turns stay one-shot
  // `--mode json` runs; this starts a second, short-lived `pi --mode rpc` on the
  // same session file, sends the one command and exits. Refused while a turn is
  // running, so two processes never append to one file.
  async compact(sessionID: string): Promise<{ ok: boolean; error?: string }> {
    const native = toNativeId(sessionID)
    if (this.#running.has(native)) return { ok: false, error: "a turn is running on this session" }
    const file = await this.#findFile(native)
    if (!file) return { ok: false, error: "session file not found" }
    const res = await piRpc(PI_BIN, ["--mode", "rpc", "--session", file, ...piExtensionArgs()], this.workspace, piEnv(), { type: "compact" }, PI_COMPACT_TIMEOUT_MS)
    if (!res.success) {
      const msg = res.error ?? "unknown"
      console.error(`[pi] compact ${native} refused: ${msg}`)
      return { ok: false, error: msg }
    }
    return { ok: true }
  }

  // The commands Pi would accept here: prompt templates and skills, found from
  // the workspace folder. No session is involved, so nothing is written.
  // `--approve` matches the turn runs: without Pi's trust flag it skips the
  // project's own prompt templates, and the list would show fewer commands than
  // a turn can run.
  async commands(_sessionID: string): Promise<HarnessCommand[]> {
    const res = await piRpc(PI_BIN, ["--mode", "rpc", "--no-session", "--approve", ...piExtensionArgs()], this.workspace, piEnv(), { type: "get_commands" }, 30_000)
    if (!res.success) return []
    const list = (res.data as { commands?: Array<{ name?: string; description?: string; source?: string }> } | undefined)?.commands ?? []
    return list
      .filter((c) => typeof c.name === "string" && c.name)
      .map((c) => ({ name: c.name!, ...(c.description ? { description: c.description } : {}), source: c.source ?? "other" }))
  }

  async respondAsk(_sessionID: string, _askID: string, _optionID: string): Promise<boolean> {
    // Pi deliberately has no built-in permission prompts. Its RPC extension UI
    // is not exposed by JSON mode, so there is no ask channel to answer here.
    return false
  }

  async rejectAsk(_sessionID: string, _askID: string): Promise<boolean> {
    return false
  }

  skillDirs(): SkillDirs {
    return {
      userDirs: [path.join(PI_AGENT_DIR, "skills"), path.join(os.homedir(), ".agents", "skills")],
      projectDirs: [path.join(this.workspace, ".pi", "skills"), path.join(this.workspace, ".agents", "skills")],
      toggleable: true,
    }
  }

  async models(): Promise<ModelRef[]> {
    if (this.#modelsCache.length > 0 && Date.now() - this.#modelsAt < 60_000) return this.#modelsCache
    const models: ModelRef[] = []
    for (const m of await listPiCliModels()) models.push(m)
    const configured = await readPiModels()
    for (const [providerID, provider] of Object.entries(configured.providers ?? {})) {
      for (const model of provider.models ?? []) {
        if (model.id && !models.some((m) => m.providerID === providerID && m.modelID === model.id)) {
          models.push({ providerID, modelID: model.id })
        }
      }
    }
    if (PI_PROVIDER && PI_MODEL && !models.some((m) => m.providerID === PI_PROVIDER && m.modelID === PI_MODEL)) {
      models.push({ providerID: PI_PROVIDER, modelID: PI_MODEL })
    }
    this.#modelsCache = models
    this.#modelsAt = Date.now()
    return models
  }

  async defaultModel(): Promise<string | null> {
    if (PI_PROVIDER && PI_MODEL) return `${PI_PROVIDER}/${PI_MODEL}`
    const settings = await readPiSettings()
    const provider = settings.defaultProvider
    const model = settings.defaultModel
    return provider && model ? `${provider}/${model}` : null
  }

  async capabilities(): Promise<Map<string, ModelCaps>> {
    if (this.#capsCache.size > 0 && Date.now() - this.#capsAt < 60_000) return this.#capsCache
    const out = new Map<string, ModelCaps>()
    for (const m of await listPiCliModels()) {
      out.set(`${m.providerID}/${m.modelID}`, {
        image: m.image ?? false,
        attachment: true,
        contextLimit: m.contextLimit ?? 0,
      })
    }
    const configured = await readPiModels()
    for (const [providerID, provider] of Object.entries(configured.providers ?? {})) {
      for (const model of provider.models ?? []) {
        if (!model.id) continue
        const key = `${providerID}/${model.id}`
        if (out.has(key)) continue
        out.set(key, {
          image: model.input?.includes("image") ?? false,
          attachment: true,
          contextLimit: Number(model.contextWindow ?? 0),
        })
      }
    }
    this.#capsCache = out
    this.#capsAt = Date.now()
    return out
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return [{ id: this.workspace, worktree: this.workspace }]
  }

  async diff(_sessionID: string): Promise<FileDiff[]> {
    return []
  }

  async *events(signal?: AbortSignal): AsyncIterable<DomainEvent> {
    const queue: DomainEvent[] = [{ type: "server.connected" }]
    let wake: (() => void) | null = null
    const push = (evt: DomainEvent) => {
      queue.push(evt)
      wake?.()
    }
    this.#bus.add(push)
    try {
      while (!this.#closed && !signal?.aborted) {
        while (queue.length) {
          const evt = queue.shift()!
          yield evt
          if (signal?.aborted) return
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          if (signal) signal.addEventListener("abort", () => resolve(), { once: true })
        })
        wake = null
      }
    } finally {
      this.#bus.delete(push)
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const child of this.#running.values()) child.kill("SIGTERM")
    this.#running.clear()
    this.#emit({ type: "other", eventType: "adapter.closed", raw: null })
  }

  async #findFile(native: string): Promise<string | null> {
    let names: string[]
    try {
      names = (await readdir(this.#sessionDir)).filter((name) => name.endsWith(".jsonl"))
    } catch {
      return null
    }
    for (const name of names) {
      const file = path.join(this.#sessionDir, name)
      const parsed = await readPiFile(file)
      if (parsed?.header.id === native) return file
    }
    return null
  }
}

// Compacting runs a summarizing model turn: 48s on an 80-message session, so a
// generous budget for a long one. Overridable for slow providers.
const PI_COMPACT_TIMEOUT_MS = Number(process.env.JEP_PI_COMPACT_TIMEOUT_MS) || 10 * 60_000

/**
 * Send one command to a short-lived `pi --mode rpc` process and return its
 * response. The child is always killed afterwards. A command carries an id and
 * Pi echoes it, so stray session events on stdout are skipped, not mistaken for
 * the answer. Resolves with success:false (never rejects) on a spawn failure,
 * a timeout, or the process exiting first.
 */
export function piRpc(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  command: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const id = `jep-${randomUUID()}`
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
    let buf = ""
    let done = false
    const finish = (r: { success: boolean; data?: unknown; error?: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill("SIGTERM")
      resolve(r)
    }
    const timer = setTimeout(() => finish({ success: false, error: `no answer within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs)
    child.once("error", (err) => finish({ success: false, error: err.message }))
    child.once("close", () => finish({ success: false, error: "pi exited before it answered" }))
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let rec: { type?: string; id?: string; success?: boolean; data?: unknown; error?: string }
        try {
          rec = JSON.parse(line)
        } catch {
          continue
        }
        if (rec.type === "response" && rec.id === id) {
          finish(rec.success ? { success: true, data: rec.data } : { success: false, error: rec.error ?? "refused" })
          return
        }
      }
    })
    child.stdin?.on("error", () => {})
    child.stdin?.write(JSON.stringify({ id, ...command }) + "\n")
  })
}

function piEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PI_CODING_AGENT_DIR: PI_AGENT_DIR }
}

function encodeWorkspace(workspace: string): string {
  return `--${workspace.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

async function fileTime(file: string): Promise<number> {
  try {
    return Math.floor((await stat(file)).mtimeMs)
  } catch {
    return Date.now()
  }
}

async function readPiFile(file: string): Promise<{ header: PiSessionFile; entries: PiEntry[] } | null> {
  try {
    const raw = await readFile(file, "utf8")
    const lines = raw.split("\n").filter(Boolean)
    const header = JSON.parse(lines.shift() ?? "") as PiSessionFile
    if (header?.type !== "session" || !header.id) return null
    const entries: PiEntry[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as PiEntry
        if (entry && typeof entry === "object") entries.push(entry)
      } catch {
        // Ignore a half-written trailing line from an active session.
      }
    }
    return { header, entries }
  } catch {
    return null
  }
}

function parseJsonLine(line: string): any | null {
  const text = line.trim()
  if (!text.startsWith("{")) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content
  if (!Array.isArray(message?.content)) return ""
  return message.content
    .map((part: any) => (part?.type === "text" ? String(part.text ?? "") : ""))
    .join("")
}

function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function lastEntryTime(entries: PiEntry[], fallback: number): number {
  for (const entry of [...entries].reverse()) {
    const time = Date.parse(entry.timestamp ?? "")
    if (time) return time
  }
  return fallback
}

export function mapPiEntries(entries: PiEntry[], sessionID: string): Message[] {
  const out: Message[] = []
  const toolByID = new Map<string, Part & { kind: "tool" }>()
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue
    const native = entry.message
    const id = `${sessionID}:${entry.id ?? out.length}`
    const time = Number(native.timestamp) || Date.parse(entry.timestamp ?? "") || Date.now()
    if (native.role === "toolResult") {
      const tool = toolByID.get(String(native.toolCallId ?? ""))
      if (tool) {
        tool.output = contentText(native.content)
        tool.status = native.isError ? "error" : "completed"
      }
      continue
    }
    if (native.role !== "user" && native.role !== "assistant") continue
    const parts: Part[] = []
    if (native.role === "user") {
      const raw = stripInjectedContext(messageText(native)).trimStart()
      const { quote, text } = splitQuoteText(raw)
      if (quote) parts.push({ kind: "quote", text: quote })
      if (text) parts.push({ kind: "text", text: transcriptText(text) })
      // jep's own scaffolding (a loop's next step, a watch's wake-up) has no
      // words a person typed: keep the marker whole so the client can draw the
      // boundary, instead of turning it into an empty message
      if (!parts.length && raw) parts.push({ kind: "text", text: isScaffold(raw) ? raw : transcriptText(raw) })
    } else {
      for (const content of Array.isArray(native.content) ? native.content : []) {
        if (content?.type === "text" && content.text) parts.push({ kind: "text", text: String(content.text) })
        else if (content?.type === "thinking" && content.thinking) parts.push({ kind: "reasoning", text: String(content.thinking) })
        else if (content?.type === "toolCall") {
          const tool: Part & { kind: "tool" } = {
            kind: "tool",
            id: String(content.id ?? `${id}:tool`),
            name: String(content.name ?? "tool"),
            input: content.arguments ?? {},
            output: "",
            status: "running",
          }
          toolByID.set(String(content.id ?? ""), tool)
          parts.push(tool)
        } else if (content?.type) {
          parts.push({ kind: "other", nativeType: String(content.type) })
        }
      }
    }
    const message: Message = {
      id,
      sessionID,
      role: native.role,
      time,
      parts,
      ...(native.role === "assistant" && native.provider && native.model ? { model: `${native.provider}/${native.model}` } : {}),
      ...(native.role === "assistant" && native.usage ? { tokens: usageTokens(native.usage), cost: Number(native.usage.cost?.total ?? 0) } : {}),
      ...(native.role === "assistant" && native.errorMessage ? { error: { name: "PiError", message: String(native.errorMessage), model: native.model ? String(native.model) : undefined, provider: native.provider ? String(native.provider) : undefined } } : {}),
    }
    out.push(message)
  }
  return out
}

function usageTokens(usage: any): Message["tokens"] {
  return {
    input: Number(usage.input ?? 0),
    output: Number(usage.output ?? 0),
    reasoning: Number(usage.reasoning ?? 0),
    cache: { read: Number(usage.cacheRead ?? 0), write: Number(usage.cacheWrite ?? 0) },
  }
}

function contentText(content: any): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part: any) => (part?.type === "text" ? String(part.text ?? "") : "")).join("")
}

interface HandledPiEvent {
  assistant?: Message
  failure?: { name: string; message: string }
}

// Pi restamps its message on every update, so keying the id on that timestamp
// gave each chunk its own message — and so its own part, which a client drew as
// one more block instead of one growing paragraph. The id is remembered per
// conversation from the message's start until it ends, so every delta in a reply
// lands in the same part.
const openMessages = new Map<string, string>()

/** exported for tests: the id every event of the message now in flight uses */
export function messageIdFor(event: any, sessionID: string): string {
  if (event.type === "message_start") {
    const id = `${sessionID}:${String(event.message?.timestamp ?? Date.now())}`
    openMessages.set(sessionID, id)
    return id
  }
  if (event.type === "message_end") {
    const id = openMessages.get(sessionID) ?? `${sessionID}:${String(event.message?.timestamp ?? Date.now())}`
    openMessages.delete(sessionID)
    return id
  }
  return openMessages.get(sessionID) ?? `${sessionID}:${String(event.message?.timestamp ?? Date.now())}`
}

function handlePiEvent(event: any, sessionID: string, emit: (event: DomainEvent) => void): HandledPiEvent {
  const messageID = messageIdFor(event, sessionID)
  if (event.type === "message_update") {
    const delta = event.assistantMessageEvent
    if (delta?.type === "text_delta" || delta?.type === "thinking_delta") {
      emit({ type: "part.delta", sessionID, messageID, partID: `${messageID}:${delta.type}`, text: String(delta.delta ?? ""), partType: delta.type === "text_delta" ? "text" : "reasoning" })
    }
    return {}
  }
  if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
    const message = mapPiEntries([{ type: "message", id: messageID, timestamp: new Date().toISOString(), message: event.message }], sessionID)[0]
    if (!message) return {}
    emit({ type: event.type === "message_start" ? "message.created" : "message.updated", sessionID, messageID: message.id, role: message.role })
    if (event.type === "message_end" && message.role === "assistant") return { assistant: message, failure: message.error ? { name: message.error.name ?? "PiError", message: message.error.message } : undefined }
    return {}
  }
  if (event.type === "tool_execution_start") {
    emit({
      type: "part.updated",
      sessionID,
      messageID,
      partID: String(event.toolCallId ?? `${messageID}:tool`),
      partType: "tool",
      part: { kind: "tool", id: String(event.toolCallId ?? `${messageID}:tool`), name: String(event.toolName ?? "tool"), input: event.args ?? {}, output: "", status: "running" },
    })
  } else if (event.type === "tool_execution_end") {
    emit({
      type: "part.updated",
      sessionID,
      messageID,
      partID: String(event.toolCallId ?? `${messageID}:tool`),
      partType: "tool",
      part: { kind: "tool", id: String(event.toolCallId ?? `${messageID}:tool`), name: String(event.toolName ?? "tool"), input: event.args ?? {}, output: event.result ?? "", status: event.isError ? "error" : "completed" },
    })
  } else if (event.type === "agent_end") {
    const assistant = [...(event.messages ?? [])].reverse().find((message: any) => message?.role === "assistant")
    const mapped = assistant ? mapPiEntries([{ type: "message", id: messageID, timestamp: new Date().toISOString(), message: assistant }], sessionID)[0] : undefined
    emit({ type: "session.idle", sessionID })
    if (mapped?.error) return { assistant: mapped, failure: { name: mapped.error.name ?? "PiError", message: mapped.error.message } }
    return mapped ? { assistant: mapped } : {}
  }
  return {}
}

async function readPiModels(): Promise<PiModelsFile> {
  try {
    return JSON.parse(await readFile(path.join(PI_AGENT_DIR, "models.json"), "utf8")) as PiModelsFile
  } catch {
    return {}
  }
}

interface PiCliModel extends ModelRef {
  image?: boolean
  contextLimit?: number
}

async function listPiCliModels(): Promise<PiCliModel[]> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(PI_BIN, ["--list-models"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: piEnv() }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
    })
    const models: PiCliModel[] = []
    for (const line of out.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("provider")) continue
      const m = trimmed.match(/^([a-z0-9_-]+)\s+(\S+)\s+(\S+)\s+\S+\s+\S+\s+(yes|no)\s*$/i)
      if (m) {
        models.push({
          providerID: m[1]!,
          modelID: m[2]!,
          contextLimit: parseContext(m[3]!),
          image: m[4]!.toLowerCase() === "yes",
        })
        continue
      }
      const bare = trimmed.match(/^([a-z0-9_-]+)\s+(\S+)/i)
      if (bare) models.push({ providerID: bare[1]!, modelID: bare[2]! })
    }
    return models
  } catch (err) {
    console.error(`[pi] \`pi --list-models\` failed, picker limited to models.json: ${(err as Error)?.message ?? err}`)
    return []
  }
}

function parseContext(token: string): number {
  const m = token.match(/^([\d.]+)\s*([MK])?$/i)
  if (!m) return 0
  const n = Number(m[1] ?? 0)
  if (!Number.isFinite(n)) return 0
  const unit = (m[2] ?? "").toUpperCase()
  if (unit === "M") return Math.round(n * 1_000_000)
  if (unit === "K") return Math.round(n * 1_000)
  return Math.round(n)
}

interface PiSettingsFile {
  defaultProvider?: string
  defaultModel?: string
}

async function readPiSettings(): Promise<PiSettingsFile> {
  try {
    return JSON.parse(await readFile(path.join(PI_AGENT_DIR, "settings.json"), "utf8")) as PiSettingsFile
  } catch {
    return {}
  }
}

/** Matches the other CLI adapters' supervisor-shaped starter. */
export async function startPiAdapter(workspace: string, opts: PiAdapterOptions = {}): Promise<PiAdapter> {
  const adapter = new PiAdapter(workspace, opts)
  const h = await adapter.health()
  if (!h.healthy) throw new Error(`pi not runnable: ${h.version}`)
  await adapter.prepare()
  return adapter
}

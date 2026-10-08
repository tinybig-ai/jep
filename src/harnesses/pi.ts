import { spawn, execFile, type ChildProcess } from "node:child_process"
import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { HarnessAdapter, ModelCaps, ModelRef } from "../core/ports.ts"
import type { DomainEvent, FileDiff, Message, Part, ProjectSummary, SessionSummary, SkillDirs } from "../core/types.ts"
import { splitQuoteText, transcriptText, withQuoteText } from "../core/transcript.ts"
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
const PI_PROVIDER = process.env.JEP_PI_PROVIDER ?? "free-models"
const PI_MODEL = process.env.JEP_PI_MODEL ?? "auto"
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
        title: clip(named || transcriptText(splitQuoteText(firstText).text)),
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
    },
  ): Promise<Message> {
    const native = toNativeId(sessionID)
    const model = opts?.model ?? { providerID: PI_PROVIDER, modelID: PI_MODEL }
    const prompt = withQuoteText(text, opts?.quote)
    const args = [
      "--mode",
      "json",
      "--session-dir",
      this.#sessionDir,
      "--session-id",
      native,
      "--provider",
      model.providerID,
      "--model",
      model.modelID,
      "--approve",
      "--no-extensions",
      ...((opts?.filePaths ?? []).map((file) => `@${file}`)),
      prompt,
    ]
    const child = spawn(PI_BIN, args, { cwd: this.workspace, env: piEnv(), stdio: ["ignore", "pipe", "pipe"] })
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
    const answer = [...history].reverse().find((message) => message.role === "assistant") ?? finalAssistant ?? lastAssistant
    if (answer) return failure ? { ...answer, error: failure } : answer
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
    const configured = await readPiModels()
    const models: ModelRef[] = []
    for (const [providerID, provider] of Object.entries(configured.providers ?? {})) {
      for (const model of provider.models ?? []) {
        if (model.id) models.push({ providerID, modelID: model.id })
      }
    }
    return models.length ? models : [{ providerID: PI_PROVIDER, modelID: PI_MODEL }]
  }

  async defaultModel(): Promise<string | null> {
    return `${PI_PROVIDER}/${PI_MODEL}`
  }

  async capabilities(): Promise<Map<string, ModelCaps>> {
    const configured = await readPiModels()
    const out = new Map<string, ModelCaps>()
    for (const [providerID, provider] of Object.entries(configured.providers ?? {})) {
      for (const model of provider.models ?? []) {
        if (!model.id) continue
        out.set(`${providerID}/${model.id}`, {
          image: model.input?.includes("image") ?? false,
          attachment: true,
          contextLimit: Number(model.contextWindow ?? 0),
        })
      }
    }
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

function piEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PI_CODING_AGENT_DIR: PI_AGENT_DIR }
}

function encodeWorkspace(workspace: string): string {
  return `--${workspace.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

async function fileTime(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs
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
      const raw = messageText(native)
      const { quote, text } = splitQuoteText(raw)
      if (quote) parts.push({ kind: "quote", text: quote })
      if (text) parts.push({ kind: "text", text: transcriptText(text) })
      if (!parts.length && raw) parts.push({ kind: "text", text: transcriptText(raw) })
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

function handlePiEvent(event: any, sessionID: string, emit: (event: DomainEvent) => void): HandledPiEvent {
  const messageID = `${sessionID}:${String(event.message?.timestamp ?? Date.now())}`
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

/** Matches the other CLI adapters' supervisor-shaped starter. */
export async function startPiAdapter(workspace: string, opts: PiAdapterOptions = {}): Promise<PiAdapter> {
  const adapter = new PiAdapter(workspace, opts)
  const h = await adapter.health()
  if (!h.healthy) throw new Error(`pi not runnable: ${h.version}`)
  await adapter.prepare()
  return adapter
}

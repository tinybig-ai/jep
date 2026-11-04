import { realpathSync, statSync } from "node:fs"
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { killStuckTools, stopTree } from "../core/proctree.ts"
import { readFileSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { HarnessAdapter, ModelRef } from "../core/ports.ts"
import type { DomainEvent, FileDiff, Message, Part, ProjectSummary, SessionSummary } from "../core/types.ts"
import { hasMcp, type ConversationMcp } from "../core/mcp.ts"
import { MCP_SERVER_PATH, TOOLS_SERVER, toolsMode, wantsMcp } from "../core/tools.ts"
import { splitQuoteText, transcriptText, withQuoteText, stripInjectedContext, contextFor } from "../core/transcript.ts"
import { TurnAbortedError } from "../core/types.ts"

/**
 * Goose as a harness.
 *
 * Goose is a request/response CLI with its own session store. `goose run
 * --output-format stream-json` gives one turn as whole messages (it does not
 * stream tokens), and `goose session export --format json` gives the record.
 * Goose names its sessions itself, so jep hands it a name of its own
 * (`jep-<uuid>`) and finds the conversation again by that name.
 */
const GOOSE_BIN = process.env.JEP_GOOSE_BIN ?? "goose"
const GOOSE_CONFIG = process.env.JEP_GOOSE_CONFIG ?? path.join(os.homedir(), ".config", "goose", "config.yaml")
// provider keys goose reads from the environment (KEY=value lines, mode 0600),
// so the daemon needs nothing exported and the key is never in a command line
const GOOSE_ENV = process.env.JEP_GOOSE_ENV ?? path.join(os.homedir(), ".config", "goose", "jep.env")
const HARNESS_NS = "goose"
const NAME_PREFIX = "jep-"
const LIST_TTL_MS = 3_000

const toInternalId = (native: string) => `${HARNESS_NS}://${native}`
const toNativeId = (id: string) => (id.startsWith(`${HARNESS_NS}://`) ? id.slice(HARNESS_NS.length + 3) : id)
const gooseName = (native: string) => `${NAME_PREFIX}${native}`

interface GooseListed {
  id: string
  name?: string
  working_dir?: string
  last_message_snippet?: string | null
  created_at?: string
  updated_at?: string
}

export class GooseAdapter implements HarnessAdapter {
  // every turn can be given servers of its own (--with-extension)
  readonly takesMcp = true
  readonly id = "goose"
  readonly workspace: string
  readonly endpoint: string

  #pending = new Map<string, { title: string; createdAt: number }>()
  /** conversations goose is known to hold: a turn has run in them, or a listing showed them. A listing that
   *  fails says nothing about what exists, so a turn must not start a second session of the same name. */
  #known = new Set<string>()
  /** whether the last listing worked: an empty answer from a failed list is not an empty folder */
  #listOk = true
  // conversations that already got jep's context header (see contextFor)
  #briefed = new Set<string>()
  #running = new Map<string, ChildProcess>()
  #aborting = new Set<string>()
  #bus = new Set<(evt: DomainEvent) => void>()
  #listed: { at: number; rows: GooseListed[] } | null = null
  #closed = false

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace)
    this.endpoint = `goose-cli:${this.workspace}`
  }

  #emit(evt: DomainEvent): void {
    for (const fn of this.#bus) {
      try {
        fn(evt)
      } catch (err) {
        console.error(`[goose] subscriber threw: ${(err as Error)?.message ?? err}`)
      }
    }
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    try {
      const out = await run(["--version"], 15_000)
      return { healthy: true, version: out.trim() }
    } catch (err) {
      return { healthy: false, version: (err as Error)?.message ?? "goose not runnable" }
    }
  }

  async createSession(title?: string): Promise<SessionSummary> {
    const native = randomUUID()
    const now = Date.now()
    this.#pending.set(native, { title: title ?? "", createdAt: now })
    return { id: toInternalId(native), title: title ?? "", workspace: this.workspace, createdAt: now, updatedAt: now }
  }

  async getSession(id: string): Promise<SessionSummary | null> {
    const native = toNativeId(id)
    return (await this.listSessions()).find((s) => toNativeId(s.id) === native) ?? null
  }

  async #rows(fresh = false): Promise<GooseListed[]> {
    if (!fresh && this.#listed && Date.now() - this.#listed.at < LIST_TTL_MS) return this.#listed.rows
    let rows: GooseListed[] = []
    this.#listOk = true
    try {
      const parsed = JSON.parse(await run(["session", "list", "--format", "json", "-w", this.workspace], 20_000))
      // goose's -w matches by prefix, so the adapter for ~/code also got every session of
      // ~/code/project, and the gateway listed that chat once per adapter. Only the exact folder.
      const here = realDir(this.workspace)
      if (Array.isArray(parsed))
        rows = parsed.filter(
          (r) =>
            typeof r?.name === "string" &&
            r.name.startsWith(NAME_PREFIX) &&
            (typeof r.working_dir !== "string" || realDir(r.working_dir) === here),
        )
    } catch {
      rows = []
      this.#listOk = false
    }
    for (const r of rows) if (r.name?.startsWith(NAME_PREFIX)) this.#known.add(r.name.slice(NAME_PREFIX.length))
    this.#listed = { at: Date.now(), rows }
    return rows
  }

  async listSessions(): Promise<SessionSummary[]> {
    const rows = await this.#rows()
    const out: SessionSummary[] = []
    // goose can hold several sessions under one name (a turn that ran without --resume started a new one);
    // they are one conversation here: the newest speaks for it, the oldest start is its beginning
    const byName = new Map<string, GooseListed[]>()
    for (const row of rows) byName.set(row.name!, [...(byName.get(row.name!) ?? []), row])
    for (const same of byName.values()) {
      const stamp = (r: GooseListed) => Date.parse(r.updated_at ?? "") || Date.parse(r.created_at ?? "") || 0
      const row = same.reduce((a, b) => (stamp(b) >= stamp(a) ? b : a))
      const native = row.name!.slice(NAME_PREFIX.length)
      const createdAt = Math.min(...same.map((r) => Date.parse(r.created_at ?? "") || Date.now()))
      const first = this.#titles.get(native) ?? this.#pending.get(native)?.title ?? clip(transcriptText(row.last_message_snippet ?? ""))
      out.push({
        id: toInternalId(native),
        title: first,
        workspace: this.workspace,
        createdAt,
        updatedAt: Date.parse(row.updated_at ?? "") || createdAt,
      })
    }
    for (const [native, meta] of this.#pending) {
      if (!out.some((s) => toNativeId(s.id) === native)) {
        out.push({ id: toInternalId(native), title: meta.title, workspace: this.workspace, createdAt: meta.createdAt, updatedAt: meta.createdAt })
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  // the first words of each conversation, read once from its record
  #titles = new Map<string, string>()

  async messages(sessionID: string, opts?: { limit?: number }): Promise<Message[]> {
    const native = toNativeId(sessionID)
    const exported = await this.#export(native)
    if (!exported) return []
    const out = mapGooseMessages(exported.conversation ?? [], toInternalId(native), exported.provider_name)
    const firstUser = out.find((m) => m.role === "user")
    const text = firstUser?.parts.find((p) => p.kind === "text")
    if (text && text.kind === "text" && !this.#titles.has(native)) this.#titles.set(native, clip(text.text))
    return opts?.limit && opts.limit > 0 ? out.slice(-opts.limit) : out
  }

  async #export(native: string): Promise<any | null> {
    try {
      return JSON.parse(await run(["session", "export", "--name", gooseName(native), "--format", "json"], 30_000))
    } catch {
      return null
    }
  }

  async deleteSession(id: string): Promise<boolean> {
    const native = toNativeId(id)
    this.#pending.delete(native)
    this.#titles.delete(native)
    this.#listed = null
    if (!(await this.#rows(true)).some((r) => r.name === gooseName(native))) return true
    // `goose session remove` asks "are you sure?" on a terminal and fails on a
    // plain pipe. `script` supplies the terminal, and a shell pipe (not a Node
    // socket, which `script` refuses) supplies the answer.
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(
        "sh",
        ["-c", `(sleep 1; printf 'y\\r') | script -q /dev/null "$0" session remove --name "$1"`, GOOSE_BIN, gooseName(native)],
        { stdio: "ignore" },
      )
      child.on("error", () => resolve(false))
      child.on("close", () => resolve(true))
      setTimeout(() => child.kill("SIGTERM"), 15_000)
    })
    this.#listed = null
    return ok && !(await this.#rows(true)).some((r) => r.name === gooseName(native))
  }

  async prompt(
    sessionID: string,
    text: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal; model?: ModelRef; filePaths?: string[]; agent?: string; quote?: string; brief?: boolean; mcp?: ConversationMcp },
  ): Promise<Message> {
    const native = toNativeId(sessionID)
    let body = withQuoteText(text, opts?.quote)
    if (opts?.filePaths?.length) body += `\n\nAttached files:\n${opts.filePaths.map((file) => `- ${file}`).join("\n")}`
    // jep's header goes first, once per conversation (see contextFor)
    body = `${contextFor(text, this.#briefed, native, opts?.brief)}${body}`
    const row = (await this.#rows(true)).find((r) => r.name === gooseName(native))
    // a failed listing proves nothing: trust what this daemon has seen, or a second session of the same name is born
    const exists = row !== undefined || this.#known.has(native)
    const args = ["run", "--name", gooseName(native), ...(exists ? ["--resume"] : [])]
    // Extensions are only handed over when the session is being created: goose
    // stores them in the session, and being handed a name it already has is a
    // hard error — "extension name 'x' is already in use", exit 1, with the
    // words on stdout and nothing at all on stderr, so the turn read as a bare
    // "goose exited 1" on every resume after the first.
    if (!exists) {
      // jep's own tools, as one more extension beside the ones goose already has
      if (wantsMcp(toolsMode())) args.push("--with-extension", `${TOOLS_SERVER}:${process.execPath} ${MCP_SERVER_PATH} --session ${sessionID}`)
      // a client's servers for this conversation: one more extension each. Values never hold
      // spaces (core/mcp.ts refuses them), so goose's own splitting cannot break them apart.
      if (hasMcp(opts?.mcp))
        for (const [name, def] of Object.entries(opts.mcp)) {
          const env = Object.entries(def.env ?? {}).map(([k, v]) => `${k}=${v} `).join("")
          args.push("--with-extension", `${name}:${env}${[def.command, ...(def.args ?? [])].join(" ")}`)
        }
    }
    args.push("--output-format", "stream-json", "-t", body)
    if (opts?.model?.providerID && opts.model.modelID) args.push("--provider", opts.model.providerID, "--model", opts.model.modelID)
    const child = spawn(GOOSE_BIN, args, {
      cwd: this.workspace,
      // how `jep-watch` finds its conversation
      env: { ...keyEnv(), ...process.env, GOOSE_MODE: process.env.GOOSE_MODE ?? "auto", JEP_SESSION: sessionID },
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.#running.set(native, child)
    this.#aborting.delete(native)

    const sid = toInternalId(native)
    let stderr = ""
    let failure: { name: string; message: string } | undefined
    // goose waits out a provider's Retry-After in silence (an hour, for a usage cap) and says
    // nothing on stdout, so the turn looked hung until the watchdog killed it with no reason.
    // Its own log does say: a long refusal ends the turn now, with the provider's words.
    let gaveUp = false
    const stopLog = watchGooseLog(Date.now(), row?.id, (problem) => {
      if (failure) return
      failure = { name: "ProviderRefused", message: problem }
      this.#emit({ type: "session.error", sessionID: sid, message: problem })
      gaveUp = true
      stopTree(child)
    })
    let buf = ""
    const calls = new Map<string, { messageID: string; part: Part & { kind: "tool" } }>()
    const onAbort = () => {
      this.#aborting.add(native)
      stopTree(child)
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
            const failed = handleGooseEvent(event, sid, (evt) => this.#emit(evt), calls)
            if (failed) {
              failure = failed
              this.#emit({ type: "session.error", sessionID: sid, message: failed.message })
            }
          }
        }
        child.stdout?.on("data", consume)
        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString()
        })
        child.on("error", reject)
        child.on("close", (code) => {
          if (gaveUp) return resolve()
          if (this.#aborting.has(native) || opts?.signal?.aborted) return reject(new TurnAbortedError())
          if (buf.trim()) consume(`${buf}\n`)
          if (code !== 0 && !failure) failure = { name: "GooseError", message: stderr.trim().slice(-500) || `goose exited ${code}` }
          if (code === 0) this.#known.add(native) // goose holds it now
          resolve()
        })
      })
    } finally {
      stopLog()
      if (timer) clearTimeout(timer)
      opts?.signal?.removeEventListener("abort", onAbort)
      this.#running.delete(native)
      this.#aborting.delete(native)
      this.#pending.delete(native)
      this.#listed = null
    }
    this.#emit({ type: "session.idle", sessionID: sid })

    const history = await this.messages(sessionID)
    const answer = [...history].reverse().find((message) => message.role === "assistant")
    if (answer) return failure ? { ...answer, error: failure } : answer
    return {
      id: toInternalId(`${native}:turn-${Date.now()}`),
      sessionID: sid,
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
    stopTree(child)
    return true
  }

  /** a tool goose started has been silent for `sinceMs`: kill it, so goose sees it fail and goes on */
  async unwedge(sessionID: string, sinceMs: number): Promise<boolean> {
    return killStuckTools(this.#running.get(toNativeId(sessionID)), sinceMs)
  }

  async respondAsk(_sessionID: string, _askID: string, _optionID: string): Promise<boolean> {
    // `goose run` in auto mode never asks, so there is no ask to answer
    return false
  }

  async rejectAsk(_sessionID: string, _askID: string): Promise<boolean> {
    return false
  }

  async models(): Promise<ModelRef[]> {
    const { provider, model } = await readGooseConfig()
    const out: ModelRef[] = provider && model ? [{ providerID: provider, modelID: model }] : []
    // every model of every custom provider goose has (OpenCode Go and the like)
    const dir = path.join(path.dirname(GOOSE_CONFIG), "custom_providers")
    let files: string[] = []
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()
    } catch {
      files = []
    }
    for (const file of files) {
      try {
        const def = JSON.parse(await readFile(path.join(dir, file), "utf8"))
        for (const m of Array.isArray(def.models) ? def.models : []) {
          if (def.name && m?.name && !out.some((r) => r.providerID === def.name && r.modelID === m.name)) out.push({ providerID: def.name, modelID: m.name })
        }
      } catch {
        // a provider file goose cannot read is not worth failing the picker for
      }
    }
    return out
  }

  async defaultModel(): Promise<string | null> {
    const { provider, model } = await readGooseConfig()
    return provider && model ? `${provider}/${model}` : null
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
    for (const child of this.#running.values()) stopTree(child)
    this.#running.clear()
    this.#emit({ type: "other", eventType: "adapter.closed", raw: null })
  }
}

function keyEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const line of readFileSync(GOOSE_ENV, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "")
    }
  } catch {
    // no key file: goose uses whatever it finds in the environment or keychain
  }
  return out
}

/** a folder as the filesystem names it (macOS's /var is /private/var), or as given when it is gone */
function realDir(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

/** where goose writes each CLI run's log, one folder per day */
const GOOSE_LOG_DIR = process.env.JEP_GOOSE_LOG_DIR ?? path.join(os.homedir(), ".local", "state", "goose", "logs", "cli")
/** a refusal goose would wait longer than this to retry is the turn's end, not a pause */
const GIVE_UP_AFTER_S = 120

/** Watch the log of the goose run started at `since` for a provider refusal goose would sit out
 *  for long (a usage cap, a long rate limit). `conversation` is goose's own session id, when the
 *  session already exists, so a parallel run's log is never read as this one's. */
export function watchGooseLog(since: number, conversation: string | undefined, onProblem: (message: string) => void): () => void {
  const read = new Map<string, number>()
  let done = false
  const scan = async () => {
    if (done) return
    const day = (t: number) => new Date(t).toISOString().slice(0, 10)
    for (const dir of new Set([day(since), day(Date.now())]).values()) {
      const folder = path.join(GOOSE_LOG_DIR, dir)
      let names: string[] = []
      try {
        names = await readdir(folder)
      } catch {
        continue
      }
      for (const name of names) {
        const file = path.join(folder, name)
        let size = 0
        try {
          const st = statSync(file)
          if (st.mtimeMs < since - 2_000) continue
          size = st.size
        } catch {
          continue
        }
        const from = read.get(file) ?? 0
        if (size <= from) continue
        read.set(file, size)
        let text = ""
        try {
          text = (await readFile(file, "utf8")).slice(from)
        } catch {
          continue
        }
        for (const line of text.split("\n")) {
          if (!line.includes("RateLimitExceeded") && !line.includes("Provider request failed")) continue
          if (conversation && !line.includes(`"gen_ai.conversation.id":"${conversation}"`)) continue
          const problem = gooseRefusal(line)
          if (problem) {
            done = true
            onProblem(problem)
            return
          }
        }
      }
    }
  }
  const timer = setInterval(() => void scan(), 3_000)
  return () => {
    done = true
    clearInterval(timer)
  }
}

/** a log line goose writes when it will sit out a refusal, as words for the person, or null */
export function gooseRefusal(line: string): string | null {
  // the log holds JSON, so the quotes around details are escaped: details: \"...\"
  const m = line.match(/RateLimitExceeded \{ details: \\"(.*?)\\", retry_delay: Some\((\d+)s\)/)
  if (!m) return null
  const seconds = Number(m[2])
  if (!(seconds > GIVE_UP_AFTER_S)) return null
  const minutes = Math.round(seconds / 60)
  return `The model's provider refused: ${m[1]}. goose would wait ${minutes} min before trying again, so this turn stopped. Pick another model, or try later.`
}

function run(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(GOOSE_BIN, args, { timeout, maxBuffer: 256 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

async function readGooseConfig(): Promise<{ provider?: string; model?: string }> {
  try {
    const raw = await readFile(GOOSE_CONFIG, "utf8")
    const pick = (key: string) => raw.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"))?.[1]?.replace(/^["']|["']$/g, "")
    return { provider: pick("GOOSE_PROVIDER"), model: pick("GOOSE_MODEL") }
  } catch {
    return {}
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

function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function resultText(content: any): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : ""
  return content.map((part: any) => (part?.type === "text" ? String(part.text ?? "") : "")).join("")
}

/**
 * Goose's record to jep's messages. A tool call and its result are two goose
 * messages (the result is a "user" one); the result folds back onto the call.
 * Messages goose marks `userVisible: false` (its own turn-context note) are
 * dropped.
 */
export function mapGooseMessages(conversation: any[], sessionID: string, provider?: string): Message[] {
  const out: Message[] = []
  // goose stamps messages in whole seconds, so a message and the reply that started in the same
  // second tie, and a client ordering by time could draw the reply above the message. The record's
  // order is the truth: each message is at least a millisecond after the one before it.
  let last = 0
  const toolByID = new Map<string, Part & { kind: "tool" }>()
  conversation.forEach((native, index) => {
    if (native?.metadata?.userVisible === false) return
    const role = native?.role === "assistant" ? "assistant" : native?.role === "user" ? "user" : null
    if (!role) return
    const parts: Part[] = []
    let onlyResults = true
    for (const content of Array.isArray(native.content) ? native.content : []) {
      if (content?.type === "toolResponse") {
        const tool = toolByID.get(String(content.id ?? ""))
        const result = content.toolResult
        if (tool) {
          tool.output = result?.status === "success" ? resultText(result.value?.content) : String(result?.error ?? result?.value ?? "")
          tool.status = result?.status === "success" && !result.value?.isError ? "completed" : "error"
        }
        continue
      }
      onlyResults = false
      if (content?.type === "text" && content.text) {
        if (role === "user") {
          const { quote, text } = splitQuoteText(stripInjectedContext(String(content.text)).trimStart())
          if (quote) parts.push({ kind: "quote", text: quote })
          if (text) parts.push({ kind: "text", text: transcriptText(text) })
        } else parts.push({ kind: "text", text: String(content.text) })
      } else if ((content?.type === "thinking" || content?.type === "reasoning") && (content.thinking || content.text)) {
        parts.push({ kind: "reasoning", text: String(content.thinking ?? content.text) })
      } else if (content?.type === "toolRequest") {
        const call = content.toolCall
        const tool: Part & { kind: "tool" } = {
          kind: "tool",
          id: String(content.id ?? `${sessionID}:${index}:tool`),
          name: String(call?.value?.name ?? "tool"),
          input: call?.value?.arguments ?? {},
          output: "",
          status: call?.status === "success" ? "running" : "error",
        }
        toolByID.set(tool.id, tool)
        parts.push(tool)
      } else if (content?.type) {
        parts.push({ kind: "other", nativeType: String(content.type) })
      }
    }
    if (onlyResults && !parts.length) return
    const usage = native.metadata?.usage
    const inference = native.metadata?.inference
    out.push({
      id: `${sessionID}:${native.id ?? index}`,
      sessionID,
      role,
      time: (last = Math.max((Number(native.created) || 0) * 1000 || Date.now(), last + 1)),
      ...(usage?.elapsedMs ? { durationMs: Number(usage.elapsedMs) } : {}),
      parts,
      ...(role === "assistant" && inference?.requestedModel ? { model: `${inference.provider ?? provider ?? "goose"}/${inference.requestedModel}` } : {}),
      ...(role === "assistant" && usage
        ? {
            tokens: {
              input: Number(usage.inputTokens ?? 0),
              output: Number(usage.outputTokens ?? 0),
              reasoning: 0,
              cache: { read: Number(usage.cacheReadInputTokens ?? 0), write: Number(usage.cacheWriteInputTokens ?? 0) },
            },
          }
        : {}),
    })
  })
  return out
}

/** One stream-json event to domain events; returns a failure when the event is one. */
function handleGooseEvent(
  event: any,
  sessionID: string,
  emit: (event: DomainEvent) => void,
  calls: Map<string, { messageID: string; part: Part & { kind: "tool" } }>,
): { name: string; message: string } | undefined {
  if (event.type === "error") return { name: "GooseError", message: String(event.error ?? event.message ?? "goose error") }
  if (event.type !== "message" || !event.message) return undefined
  const [message] = mapGooseMessages([event.message], sessionID)
  if (event.message.role !== "assistant") {
    // a tool result: the call it belongs to finished
    for (const content of Array.isArray(event.message.content) ? event.message.content : []) {
      if (content?.type !== "toolResponse") continue
      const call = calls.get(String(content.id ?? ""))
      if (!call) continue
      const result = content.toolResult
      call.part.output = result?.status === "success" ? resultText(result.value?.content) : String(result?.error ?? result?.value ?? "")
      call.part.status = result?.status === "success" && !result.value?.isError ? "completed" : "error"
      emit({ type: "part.updated", sessionID, messageID: call.messageID, partID: call.part.id, partType: "tool", part: { ...call.part } })
    }
    return undefined
  }
  if (!message) return undefined
  emit({ type: "message.created", sessionID, messageID: message.id, role: "assistant" })
  for (const part of message.parts) {
    if (part.kind === "text" || part.kind === "reasoning") {
      emit({ type: "part.delta", sessionID, messageID: message.id, partID: `${message.id}:${part.kind}`, text: part.text, partType: part.kind })
    } else if (part.kind === "tool") {
      calls.set(part.id, { messageID: message.id, part })
      emit({ type: "part.updated", sessionID, messageID: message.id, partID: part.id, partType: "tool", part })
    }
  }
  emit({ type: "message.updated", sessionID, messageID: message.id, role: "assistant" })
  return undefined
}

/** Matches the other CLI adapters' starter. */
export async function startGooseAdapter(workspace: string): Promise<GooseAdapter> {
  const adapter = new GooseAdapter(workspace)
  const h = await adapter.health()
  if (!h.healthy) throw new Error(`goose not runnable: ${h.version}`)
  return adapter
}

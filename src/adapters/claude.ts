import { spawn, execFile, type ChildProcess } from "node:child_process"
import { readFile, readdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { HarnessAdapter, ApprovalRequest, ModelRef, ModelCaps } from "../core/ports.ts"
import type { DomainEvent, FileDiff, Message, Part, ProjectSummary, SessionSummary } from "../core/types.ts"

/**
 * Claude Code as a harness.
 *
 * Shaped like the Codex adapter — no server, one process per turn, transcripts
 * on disk — but with two real advantages: `--include-partial-messages` emits
 * token-level deltas (so streaming is actually smooth, unlike Codex's
 * completed-items-only feed), and every transcript line carries its own `cwd`.
 *
 * Auth is whatever `claude` already uses; nothing here reads or forwards a
 * token, which is what keeps subscription access intact.
 */
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude"
const CLAUDE_HOME = process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude")
const PROJECTS_DIR = path.join(CLAUDE_HOME, "projects")

const HARNESS_NS = "claude"
const toInternalId = (native: string) => `${HARNESS_NS}://${native}`
const toNativeId = (id: string) => (id.startsWith(`${HARNESS_NS}://`) ? id.slice(HARNESS_NS.length + 3) : id)

// Same problem as Codex: the port hands out a session id at createSession
// time, but Claude only names one when it runs (system/init carries it).
const PENDING = "pending-"
const isPending = (nativeID: string) => nativeID.startsWith(PENDING)

interface TranscriptMeta {
  id: string
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
  file: string
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly id = "claude"
  readonly workspace: string
  readonly endpoint: string

  #alias = new Map<string, string>()
  #pendingTitles = new Map<string, { title: string; createdAt: number }>()
  #running = new Map<string, ChildProcess>()
  #bus = new Set<(evt: DomainEvent) => void>()
  #closed = false
  // parsed transcript heads, keyed by file — re-reading every session on each
  // listSessions would make /ls crawl once a project has a few hundred
  #metaCache = new Map<string, { mtime: number; meta: TranscriptMeta | null }>()

  constructor(workspace: string) {
    this.workspace = workspace
    this.endpoint = `claude-cli:${workspace}`
  }

  #emit(evt: DomainEvent): void {
    for (const fn of this.#bus) {
      try {
        fn(evt)
      } catch (err) {
        console.error(`[claude] subscriber threw: ${(err as Error)?.message ?? err}`)
      }
    }
  }

  #real(sessionID: string): string {
    const native = toNativeId(sessionID)
    return this.#alias.get(native) ?? native
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(CLAUDE_BIN, ["--version"], { timeout: 20_000 }, (err, stdout) =>
          err ? reject(err) : resolve(stdout),
        )
      })
      return { healthy: true, version: out.trim() }
    } catch (err) {
      return { healthy: false, version: (err as Error)?.message ?? "claude not runnable" }
    }
  }

  // ─── sessions ───────────────────────────────────────────────────────────
  // Transcripts live at ~/.claude/projects/<mangled cwd>/<session id>.jsonl.
  // The directory name is NOT trustworthy as a path: it replaces both "/" and
  // "-" with "-", so /code/my-app and /code/my/app mangle identically. Every
  // record carries its own `cwd`, so that is what scoping uses.

  async #transcriptFiles(): Promise<string[]> {
    if (!existsSync(PROJECTS_DIR)) return []
    const out: string[] = []
    let dirs
    try {
      dirs = await readdir(PROJECTS_DIR, { withFileTypes: true })
    } catch (err) {
      console.error(`[claude] cannot read ${PROJECTS_DIR}: ${(err as Error)?.message ?? err}`)
      return []
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      try {
        for (const f of await readdir(path.join(PROJECTS_DIR, d.name))) {
          if (f.endsWith(".jsonl")) out.push(path.join(PROJECTS_DIR, d.name, f))
        }
      } catch (err) {
        console.error(`[claude] cannot read project dir ${d.name}: ${(err as Error)?.message ?? err}`)
      }
    }
    return out
  }

  async #meta(file: string): Promise<TranscriptMeta | null> {
    let raw: string
    try {
      raw = await readFile(file, "utf8")
    } catch {
      return null // rotated away between listing and reading
    }
    const cached = this.#metaCache.get(file)
    if (cached && cached.mtime === raw.length) return cached.meta

    let meta: TranscriptMeta | null = null
    let firstUser = ""
    let title = ""
    let first = 0
    let last = 0
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      let d: any
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      // a later custom title wins over the generated one
      if (d.type === "custom-title" && typeof d.customTitle === "string") title = d.customTitle
      else if (d.type === "ai-title" && typeof d.aiTitle === "string" && !title) title = d.aiTitle
      const ts = Date.parse(d.timestamp ?? "") || 0
      if (ts) {
        if (!first) first = ts
        last = ts
      }
      if (!meta && d.cwd && d.sessionId) {
        meta = { id: String(d.sessionId), cwd: String(d.cwd), title: "", createdAt: ts || Date.now(), updatedAt: ts || Date.now(), file }
      }
      if (!firstUser && d.type === "user" && !d.isSidechain) firstUser = clip(contentText(d.message?.content))
    }
    if (meta) {
      meta.title = title || firstUser
      meta.createdAt = first || meta.createdAt
      meta.updatedAt = last || meta.updatedAt
    }
    // length stands in for mtime: appended-to transcripts always grow
    this.#metaCache.set(file, { mtime: raw.length, meta })
    return meta
  }

  async listSessions(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = []
    for (const file of await this.#transcriptFiles()) {
      const meta = await this.#meta(file)
      if (!meta || meta.cwd !== this.workspace) continue
      out.push({
        id: toInternalId(meta.id),
        title: meta.title,
        workspace: meta.cwd,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      })
    }
    for (const [pending, { title, createdAt }] of this.#pendingTitles) {
      if (this.#alias.has(pending)) continue
      out.push({ id: toInternalId(pending), title, workspace: this.workspace, createdAt, updatedAt: createdAt })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async createSession(title?: string): Promise<SessionSummary> {
    const native = `${PENDING}${Math.random().toString(36).slice(2, 10)}`
    const now = Date.now()
    this.#pendingTitles.set(native, { title: title ?? "", createdAt: now })
    return { id: toInternalId(native), title: title ?? "", workspace: this.workspace, createdAt: now, updatedAt: now }
  }

  async getSession(id: string): Promise<SessionSummary | null> {
    const real = this.#real(id)
    return (await this.listSessions()).find((s) => toNativeId(s.id) === real) ?? null
  }

  async #fileFor(native: string): Promise<string | null> {
    return (await this.#transcriptFiles()).find((f) => path.basename(f) === `${native}.jsonl`) ?? null
  }

  async deleteSession(id: string): Promise<boolean> {
    const native = this.#real(id)
    if (isPending(native)) {
      this.#pendingTitles.delete(native)
      return true
    }
    const file = await this.#fileFor(native)
    if (!file) return false
    try {
      // there is no `claude delete`; the transcript *is* the session
      await rm(file)
      this.#metaCache.delete(file)
      return true
    } catch (err) {
      console.error(`[claude] delete failed for ${native}: ${(err as Error)?.message ?? err}`)
      return false
    }
  }

  // ─── transcript ─────────────────────────────────────────────────────────

  async messages(sessionID: string): Promise<Message[]> {
    const native = this.#real(sessionID)
    if (isPending(native)) return []
    const file = await this.#fileFor(native)
    if (!file) return []
    let raw: string
    try {
      raw = await readFile(file, "utf8")
    } catch (err) {
      console.error(`[claude] transcript unreadable for ${native}: ${(err as Error)?.message ?? err}`)
      return []
    }
    const out: Message[] = []
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      let d: any
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      if (d.type !== "user" && d.type !== "assistant") continue
      // sidechains are Task-tool subagents: somebody else's turn, not yours
      if (d.isSidechain) continue
      const parts = contentParts(d.message?.content)
      if (!parts.length) continue
      out.push({
        id: toInternalId(`${native}:${d.uuid ?? out.length}`),
        sessionID: toInternalId(native),
        role: d.type === "user" ? "user" : "assistant",
        time: Date.parse(d.timestamp ?? "") || Date.now(),
        parts,
        ...(d.message?.usage ? { tokens: mapUsage(d.message.usage) } : {}),
      })
    }
    return out
  }

  // ─── running a turn ─────────────────────────────────────────────────────

  async prompt(
    sessionID: string,
    text: string,
    opts?: {
      timeoutMs?: number
      signal?: AbortSignal
      model?: ModelRef
      filePaths?: string[]
      agent?: string
    },
  ): Promise<Message> {
    const native = this.#real(sessionID)
    const pending = isPending(native)

    const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"]
    if (opts?.model?.modelID) args.push("--model", opts.model.modelID)
    if (opts?.agent) args.push("--agent", opts.agent)
    if (!pending) args.push("--resume", native)
    // attachments have no flag in print mode; naming the paths is what lets
    // the agent read them with its own tools
    const body = opts?.filePaths?.length ? `${text}\n\nAttached files:\n${opts.filePaths.map((f) => `- ${f}`).join("\n")}` : text
    args.push(body)

    const child = spawn(CLAUDE_BIN, args, { cwd: this.workspace, stdio: ["ignore", "pipe", "pipe"] })
    this.#running.set(native, child)

    let realID = pending ? "" : native
    const parts: Part[] = []
    let tokens: Message["tokens"]
    let failure: { name: string; message: string } | undefined
    let stderr = ""
    // index -> position in `parts`, so streamed deltas accumulate in place
    const blockAt = new Map<number, number>()

    const onAbort = () => child.kill("SIGTERM")
    opts?.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = opts?.timeoutMs && opts.timeoutMs > 0 ? setTimeout(onAbort, opts.timeoutMs) : null

    try {
      await new Promise<void>((resolve, reject) => {
        let buf = ""
        child.stdout?.on("data", (chunk: Buffer) => {
          buf += chunk.toString()
          const lines = buf.split("\n")
          buf = lines.pop() ?? ""
          for (const line of lines) {
            const t = line.trim()
            if (!t.startsWith("{")) continue
            let d: any
            try {
              d = JSON.parse(t)
            } catch {
              continue
            }
            if (d.session_id && !realID) {
              realID = String(d.session_id)
              if (pending) {
                this.#alias.set(native, realID)
                this.#running.set(realID, child)
              }
              this.#emit({ type: "message.created", sessionID: toInternalId(realID), messageID: "", role: "assistant" })
            }
            const sid = toInternalId(realID || native)

            if (d.type === "stream_event" && d.event) {
              // a sub-agent's tokens carry parent_tool_use_id; they belong to
              // that tool call, not to the answer being composed
              if (d.parent_tool_use_id) continue
              const ev = d.event
              if (ev.type === "content_block_start" && typeof ev.index === "number") {
                const part = startBlock(ev.content_block)
                if (part) {
                  blockAt.set(ev.index, parts.length)
                  parts.push(part)
                }
              } else if (ev.type === "content_block_delta" && typeof ev.index === "number") {
                const at = blockAt.get(ev.index)
                if (at === undefined) continue
                const part = parts[at]!
                const delta = ev.delta ?? {}
                const add = delta.text ?? delta.thinking ?? delta.partial_json ?? ""
                if (!add) continue
                if (part.kind === "text") part.text += add
                else if (part.kind === "reasoning") part.text += add
                this.#emit({
                  type: "part.delta",
                  sessionID: sid,
                  messageID: sid,
                  partID: String(ev.index),
                  text: String(add),
                  partType: part.kind === "reasoning" ? "reasoning" : "text",
                })
              }
              continue
            }

            if (d.type === "assistant" && d.message?.content) {
              // the settled message: tool_use blocks only appear here
              for (const block of d.message.content) {
                if (block?.type !== "tool_use") continue
                const part: Part = {
                  kind: "tool",
                  id: String(block.id ?? ""),
                  name: String(block.name ?? "tool"),
                  input: block.input ?? {},
                  output: "",
                  status: "running",
                }
                parts.push(part)
                this.#emit({ type: "part.updated", sessionID: sid, messageID: sid, partID: part.id, partType: "tool", part })
              }
              if (d.message.usage) tokens = mapUsage(d.message.usage)
              continue
            }

            if (d.type === "result") {
              if (d.subtype && d.subtype !== "success") {
                failure = { name: "ClaudeError", message: String(d.error ?? d.result ?? d.subtype) }
                this.#emit({ type: "session.error", sessionID: sid, message: failure.message })
              }
              if (d.usage) tokens = mapUsage(d.usage)
              this.#emit({ type: "session.idle", sessionID: sid })
            }
          }
        })
        child.stderr?.on("data", (c: Buffer) => {
          stderr += c.toString()
        })
        child.on("error", reject)
        child.on("close", (code) => {
          if (opts?.signal?.aborted) return reject(new Error("prompt aborted"))
          if (code !== 0 && !failure) {
            failure = { name: "ClaudeError", message: stderr.trim().slice(0, 400) || `claude exited ${code}` }
          }
          resolve()
        })
      })
    } finally {
      if (timer) clearTimeout(timer)
      opts?.signal?.removeEventListener("abort", onAbort)
      this.#running.delete(native)
      if (realID) this.#running.delete(realID)
      this.#metaCache.clear() // the transcript just grew
    }

    return {
      id: toInternalId(`${realID || native}:turn-${Date.now()}`),
      sessionID: toInternalId(realID || native),
      role: "assistant",
      time: Date.now(),
      // empty text blocks are common (a turn that only called tools)
      parts: parts.filter((p) => p.kind !== "text" || p.text.trim()),
      ...(tokens ? { tokens } : {}),
      ...(failure ? { error: failure } : {}),
    }
  }

  async abort(sessionID: string): Promise<boolean> {
    const child = this.#running.get(this.#real(sessionID))
    if (!child) return false
    child.kill("SIGTERM")
    return true
  }

  // Claude Code gates tools with its own permission prompt, which print mode
  // resolves via --permission-mode rather than by asking. Declared because the
  // port requires it; there is nothing to answer here.
  async respondApproval(_sessionID: string, _approval: ApprovalRequest, _allow: boolean): Promise<boolean> {
    return false
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

  async models(): Promise<ModelRef[]> {
    return (process.env.JEP_CLAUDE_MODELS ?? "claude-opus-5,claude-sonnet-5,claude-haiku-4-5")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .map((modelID) => ({ providerID: "claude", modelID }))
  }

  async capabilities(): Promise<Map<string, ModelCaps>> {
    const out = new Map<string, ModelCaps>()
    for (const m of await this.models()) {
      out.set(`${m.providerID}/${m.modelID}`, { image: true, attachment: true, contextLimit: 0 })
    }
    return out
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const dirs = new Set<string>()
    for (const file of await this.#transcriptFiles()) {
      const meta = await this.#meta(file)
      if (meta?.cwd) dirs.add(meta.cwd)
    }
    return [...dirs].map((worktree) => ({ id: worktree, worktree }))
  }

  async diff(_sessionID: string): Promise<FileDiff[]> {
    return []
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const child of this.#running.values()) child.kill("SIGTERM")
    this.#running.clear()
    this.#emit({ type: "other", eventType: "adapter.closed", raw: null })
  }
}

function startBlock(block: any): Part | null {
  switch (block?.type) {
    case "text":
      return { kind: "text", text: String(block.text ?? "") }
    case "thinking":
      return { kind: "reasoning", text: String(block.thinking ?? ""), id: String(block.signature ?? "") }
    default:
      return null // tool_use arrives settled on the assistant message
  }
}

// Anthropic content blocks -> jep parts.
function contentParts(content: any): Part[] {
  if (typeof content === "string") return content.trim() ? [{ kind: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  const out: Part[] = []
  for (const b of content) {
    switch (b?.type) {
      case "text":
        if (String(b.text ?? "").trim()) out.push({ kind: "text", text: String(b.text) })
        break
      case "thinking":
        if (String(b.thinking ?? "").trim()) out.push({ kind: "reasoning", text: String(b.thinking), id: String(b.signature ?? "") })
        break
      case "tool_use":
        out.push({ kind: "tool", id: String(b.id ?? ""), name: String(b.name ?? "tool"), input: b.input ?? {}, output: "", status: "completed" })
        break
      case "tool_result":
        // folded onto its call by id, so it doesn't render as a loose part
        out.push({ kind: "tool", id: String(b.tool_use_id ?? ""), name: "result", input: {}, output: contentText(b.content), status: b.is_error ? "error" : "completed" })
        break
      default:
        break
    }
  }
  return out
}

function contentText(content: any): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("")
}

function mapUsage(u: any): Message["tokens"] {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    reasoning: u.output_tokens_details?.thinking_tokens ?? 0,
    cache: { read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0 },
  }
}

const clip = (t: string, max = 48): string => {
  const flat = t.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export async function startClaudeAdapter(workspace: string): Promise<ClaudeAdapter> {
  const adapter = new ClaudeAdapter(workspace)
  const h = await adapter.health()
  if (!h.healthy) throw new Error(`claude not runnable: ${h.version}`)
  return adapter
}

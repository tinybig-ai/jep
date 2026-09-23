import { spawn, execFile, type ChildProcess } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { readFile, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { HarnessAdapter, ModelRef, ModelCaps } from "../core/ports.ts"
import type { DomainEvent, FileDiff, Message, Part, ProjectSummary, SessionSummary, SkillDirs } from "../core/types.ts"

/**
 * Codex CLI as a harness.
 *
 * Unlike opencode there is no server to talk to: `codex exec --json` runs one
 * turn per invocation and streams JSONL events on stdout. That difference is
 * the whole design here — see #bus for how a per-turn stdout stream is turned
 * into the long-lived event subscription the port expects.
 *
 * Auth comes from whatever `codex login` stored in $CODEX_HOME. Driving the
 * official CLI is what keeps subscription and proprietary model access intact:
 * nothing here reads or forwards a token.
 */
const CODEX_BIN = process.env.CODEX_BIN ?? "codex"
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
const DEFAULT_SANDBOX = process.env.JEP_CODEX_SANDBOX ?? "workspace-write"

const HARNESS_NS = "codex"
const toInternalId = (native: string) => `${HARNESS_NS}://${native}`
const toNativeId = (id: string) => (id.startsWith(`${HARNESS_NS}://`) ? id.slice(HARNESS_NS.length + 3) : id)

// A session only gets a real id once Codex has actually run a turn
// (thread.started carries it), but the port hands out an id at createSession
// time. Sessions therefore start as a placeholder that the first prompt swaps
// for the real thread id.
const PENDING = "pending-"
const isPending = (nativeID: string) => nativeID.startsWith(PENDING)

interface SessionMeta {
  id: string
  cwd: string
  createdAt: number
  title: string
  updatedAt: number
  file: string
}

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex"
  readonly workspace: string
  readonly endpoint: string

  // pending id -> real thread id, once the first turn names it
  #alias = new Map<string, string>()
  // titles for sessions we created but Codex hasn't recorded yet
  #pendingTitles = new Map<string, { title: string; createdAt: number }>()
  // live `codex exec` children, by session, so abort() has something to kill
  #running = new Map<string, ChildProcess>()
  // every open events() subscriber; a turn's stdout is fanned out to all of them
  #bus = new Set<(evt: DomainEvent) => void>()
  #closed = false
  // rollout file metadata, keyed by file path — parsing 300 files' first line
  // on every listSessions would make /ls crawl
  #metaCache = new Map<string, SessionMeta | null>()

  constructor(workspace: string) {
    this.workspace = workspace
    this.endpoint = `codex-cli:${workspace}`
  }

  #emit(evt: DomainEvent): void {
    for (const fn of this.#bus) {
      try {
        fn(evt)
      } catch (err) {
        console.error(`[codex] subscriber threw: ${(err as Error)?.message ?? err}`)
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
        execFile(CODEX_BIN, ["--version"], { timeout: 15_000 }, (err, stdout) =>
          err ? reject(err) : resolve(stdout),
        )
      })
      return { healthy: true, version: out.trim() }
    } catch (err) {
      return { healthy: false, version: (err as Error)?.message ?? "codex not runnable" }
    }
  }

  // ─── sessions ───────────────────────────────────────────────────────────
  // Codex keeps a flat index of every session plus one "rollout" JSONL per
  // session holding the transcript. The index has no cwd, so a session's
  // workspace comes from the rollout's opening session_meta line.

  async #rolloutFiles(): Promise<string[]> {
    const root = path.join(CODEX_HOME, "sessions")
    if (!existsSync(root)) return []
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (err) {
        console.error(`[codex] cannot read ${dir}: ${(err as Error)?.message ?? err}`)
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.name.endsWith(".jsonl")) out.push(full)
      }
    }
    await walk(root)
    return out
  }

  // the opening session_meta line, which is all listSessions needs
  async #meta(file: string): Promise<SessionMeta | null> {
    if (this.#metaCache.has(file)) return this.#metaCache.get(file)!
    let meta: SessionMeta | null = null
    try {
      const raw = await readFile(file, "utf8")
      const lines = raw.split("\n")
      const row = JSON.parse(lines[0] ?? "")
      const p = row?.payload
      if (row?.type === "session_meta" && p?.cwd) {
        const created = Date.parse(p.timestamp ?? row.timestamp ?? "") || Date.now()
        meta = {
          id: p.session_id ?? p.id ?? "",
          cwd: p.cwd,
          createdAt: created,
          updatedAt: created,
          // session_index.jsonl only names a fraction of the sessions on disk,
          // so most would otherwise list as a bare id fragment. The opening
          // user message is what the conversation is actually about.
          title: firstUserLine(lines),
          file,
        }
      }
    } catch {
      // a rollout still being written, or from a version we don't understand
    }
    this.#metaCache.set(file, meta)
    return meta
  }

  // id -> { thread_name, updated_at } from the flat index
  async #index(): Promise<Map<string, { title: string; updatedAt: number }>> {
    const out = new Map<string, { title: string; updatedAt: number }>()
    const file = path.join(CODEX_HOME, "session_index.jsonl")
    if (!existsSync(file)) return out
    try {
      for (const line of (await readFile(file, "utf8")).split("\n")) {
        if (!line.trim()) continue
        const d = JSON.parse(line)
        if (!d?.id) continue
        out.set(d.id, { title: d.thread_name ?? "", updatedAt: Date.parse(d.updated_at ?? "") || 0 })
      }
    } catch (err) {
      console.error(`[codex] session index unreadable: ${(err as Error)?.message ?? err}`)
    }
    return out
  }

  // Codex's own thread metadata: id, cwd, timestamps and — crucially — the
  // names it shows in its own UI. Reading this beats walking the rollout files
  // on every call, and it is the only place the assigned name exists at all.
  #threadsFromDb(): SessionSummary[] | null {
    const file = path.join(CODEX_HOME, "state_5.sqlite")
    if (!existsSync(file)) return null
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(file, { readOnly: true })
      // thread_source is Codex's own classification: "user" for one a person
      // (or jep, via codex exec) started, "subagent" for one an agent spawned
      // to do a sub-task, null for a session imported from another tool.
      // Subagents are never something you meant to open — they are an
      // implementation detail of somebody else's turn — so they never list.
      const onlyUser = process.env.JEP_CODEX_ONLY_USER === "1"
      const rows = db
        .prepare(
          `SELECT id, name, preview, created_at_ms, updated_at_ms, recency_at_ms
             FROM threads
            WHERE cwd = ?
              AND COALESCE(thread_source, '') <> 'subagent'
              ${onlyUser ? "AND thread_source = 'user'" : ""}
            ORDER BY COALESCE(recency_at_ms, updated_at_ms, 0) DESC`,
        )
        .all(this.workspace) as Array<Record<string, unknown>>
      return rows.map((r) => {
        const updated = Number(r.recency_at_ms ?? r.updated_at_ms ?? 0) || 0
        return {
          id: toInternalId(String(r.id)),
          // `name` is what Codex assigned (it only names some threads);
          // `preview` is the opening user message, which is what its own list
          // falls back to as well.
          // preview is the raw opening prompt and can be a whole paragraph;
          // a list row has no room for that
          title: clip(str(r.name) || str(r.preview)),
          workspace: this.workspace,
          createdAt: Number(r.created_at_ms ?? 0) || updated,
          updatedAt: updated,
        }
      })
    } catch (err) {
      console.error(`[codex] threads db unreadable, falling back to rollout scan: ${(err as Error)?.message ?? err}`)
      return null
    } finally {
      try {
        db?.close()
      } catch {
        /* already closed */
      }
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    const out = this.#threadsFromDb() ?? (await this.#sessionsFromRollouts())
    // sessions created but not yet given a turn have no thread on disk yet
    for (const [pending, { title, createdAt }] of this.#pendingTitles) {
      if (this.#alias.has(pending)) continue
      out.push({ id: toInternalId(pending), title, workspace: this.workspace, createdAt, updatedAt: createdAt })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  // Fallback for a Codex too old (or too new) to have the threads table.
  async #sessionsFromRollouts(): Promise<SessionSummary[]> {
    const idx = await this.#index()
    const out: SessionSummary[] = []
    for (const file of await this.#rolloutFiles()) {
      const meta = await this.#meta(file)
      if (!meta || meta.cwd !== this.workspace) continue
      const extra = idx.get(meta.id)
      out.push({
        id: toInternalId(meta.id),
        title: extra?.title || meta.title,
        workspace: meta.cwd,
        createdAt: meta.createdAt,
        updatedAt: extra?.updatedAt || meta.createdAt,
      })
    }
    return out
  }

  async createSession(title?: string): Promise<SessionSummary> {
    // Codex names a session only when it runs one (thread.started), so hand
    // back a placeholder and let the first prompt bind it to the real id.
    const native = `${PENDING}${Math.random().toString(36).slice(2, 10)}`
    const now = Date.now()
    this.#pendingTitles.set(native, { title: title ?? "", createdAt: now })
    return { id: toInternalId(native), title: title ?? "", workspace: this.workspace, createdAt: now, updatedAt: now }
  }

  async getSession(id: string): Promise<SessionSummary | null> {
    const real = this.#real(id)
    return (await this.listSessions()).find((s) => toNativeId(s.id) === real || toNativeId(s.id) === toNativeId(id)) ?? null
  }

  async deleteSession(id: string): Promise<boolean> {
    const native = this.#real(id)
    if (isPending(native)) {
      // never reached disk; forgetting it locally is the whole delete
      this.#pendingTitles.delete(native)
      return true
    }
    try {
      await new Promise<void>((resolve, reject) => {
        // --force because there is no terminal here to confirm at: codex
        // refuses an interactive prompt it cannot show
        execFile(CODEX_BIN, ["delete", "--force", native], { timeout: 30_000 }, (err) => (err ? reject(err) : resolve()))
      })
      this.#metaCache.clear()
      return true
    } catch (err) {
      console.error(`[codex] delete failed for ${native}: ${(err as Error)?.message ?? err}`)
      return false
    }
  }

  // ─── transcript ─────────────────────────────────────────────────────────

  async messages(sessionID: string): Promise<Message[]> {
    const native = this.#real(sessionID)
    if (isPending(native)) return []
    const file = (await this.#rolloutFiles()).find((f) => f.endsWith(`-${native}.jsonl`))
    if (!file) return []
    let raw: string
    try {
      raw = await readFile(file, "utf8")
    } catch (err) {
      console.error(`[codex] transcript unreadable for ${native}: ${(err as Error)?.message ?? err}`)
      return []
    }

    // A rollout carries the same turn twice: `response_item` lines (the
    // Responses-API shape, with a role and structured content) and `event_msg`
    // lines (the UI's own feed). Most files have both, so reading both would
    // duplicate every message. response_item is preferred — it is the only one
    // that states the role — and event_msg/item_completed is the fallback for
    // sessions imported from Codex Desktop, which have no response_items.
    const rows: Array<{ row: any; payload: any }> = []
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (row?.payload) rows.push({ row, payload: row.payload })
      } catch {
        // half-written trailing line on a session still being appended to
      }
    }
    const hasResponseItems = rows.some((r) => r.row.type === "response_item")

    const out: Message[] = []
    // custom_tool_call_output arrives as its own line; fold it back into the
    // call it belongs to rather than emitting a part with no context
    const toolByCallID = new Map<string, Part & { kind: "tool" }>()
    // the external-agent bridge gives a result no id either, so it folds onto
    // whichever call came last
    let lastTool: (Part & { kind: "tool" }) | undefined
    // token_count events carry the usage of the turn just recorded
    let lastAssistant: Message | undefined

    for (const { row, payload } of rows) {
      const time = Date.parse(row.timestamp ?? "") || Date.now()
      const push = (role: "user" | "assistant", part: Part) => {
        const msg: Message = {
          id: toInternalId(`${native}:${payload.id ?? out.length}`),
          sessionID: toInternalId(native),
          role,
          time,
          parts: [part],
        }
        out.push(msg)
        if (role === "assistant") lastAssistant = msg
      }

      // codex's own per-turn usage: the rollout's token_count event, carrying
      // the same numbers turn.completed does live. Without it a codex
      // conversation shows a model and nothing else.
      if (row.type === "event_msg" && payload.type === "token_count") {
        if (lastAssistant) lastAssistant.tokens = rolloutUsage(payload.info?.last_token_usage)
        continue
      }

      if (hasResponseItems && row.type === "response_item") {
        switch (payload.type) {
          case "message": {
            const text = contentText(payload.content)
            if (!text.trim() || isCodexInjectedContext(text)) break
            // driven by another agent, codex records its tool calls and their
            // results as assistant text. They are tools: rendered as prose they
            // bury the answer under a wall of commands.
            const call = externalAgentCall(text)
            if (call) {
              const part: Part & { kind: "tool" } = {
                kind: "tool",
                id: toInternalId(`${native}:${payload.id ?? out.length}`),
                name: call.name,
                input: call.input,
                output: "",
                status: "completed",
              }
              lastTool = part
              push("assistant", part)
              break
            }
            const result = externalAgentResult(text)
            if (result !== null) {
              if (lastTool) lastTool.output = result
              break
            }
            push(payload.role === "user" ? "user" : "assistant", { kind: "text", text })
            break
          }
          case "reasoning": {
            // encrypted_content is opaque; only the summary is ever readable
            const text = Array.isArray(payload.summary) ? payload.summary.map((x: any) => x?.text ?? "").join("\n") : ""
            if (text.trim()) push("assistant", { kind: "reasoning", text, id: String(payload.id ?? "") })
            break
          }
          case "custom_tool_call": {
            const part: Part & { kind: "tool" } = {
              kind: "tool",
              id: String(payload.call_id ?? payload.id ?? ""),
              name: String(payload.name ?? "tool"),
              input: payload.input ?? {},
              output: "",
              status: payload.status === "completed" ? "completed" : "running",
            }
            if (payload.call_id) toolByCallID.set(String(payload.call_id), part)
            push("assistant", part)
            break
          }
          case "custom_tool_call_output": {
            const part = payload.call_id ? toolByCallID.get(String(payload.call_id)) : undefined
            if (part) {
              part.output = contentText(payload.output)
              part.status = "completed"
            }
            break
          }
          default:
            break
        }
        continue
      }

      if (!hasResponseItems && row.type === "event_msg" && payload.type === "item_completed" && payload.item) {
        const part = mapItem(payload.item, this.workspace)
        if (part && !(part.kind === "text" && isCodexInjectedContext(part.text))) {
          push(payload.item.type === "UserMessage" ? "user" : "assistant", part)
        }
      }
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

    const args = ["exec", "--json", "--skip-git-repo-check", "-C", this.workspace, "-s", DEFAULT_SANDBOX]
    if (opts?.model?.modelID) args.push("-m", opts.model.modelID)
    for (const f of opts?.filePaths ?? []) args.push("-i", f)
    // resume keeps the thread; a pending session starts a fresh one
    if (!pending) args.push("resume", native)
    args.push(text)

    const child = spawn(CODEX_BIN, args, { cwd: this.workspace, stdio: ["ignore", "pipe", "pipe"] })
    this.#running.set(native, child)

    let threadID = pending ? "" : native
    const parts: Part[] = []
    let tokens: Message["tokens"]
    let failure: { name: string; message: string } | undefined
    let stderr = ""

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
            let evt: any
            try {
              evt = JSON.parse(t)
            } catch {
              continue
            }
            // thread.started is where a pending session learns its real id
            if (evt.type === "thread.started" && evt.thread_id) {
              threadID = evt.thread_id
              if (pending) {
                this.#alias.set(native, threadID)
                this.#running.set(threadID, child)
              }
              this.#emit({ type: "message.created", sessionID: toInternalId(threadID), messageID: "", role: "assistant" })
              continue
            }
            if (evt.type === "item.completed" && evt.item) {
              const part = mapItem(evt.item, this.workspace)
              if (!part) continue
              // codex's injected environment block arrives as an item too — it
              // is not part of the answer
              if (part.kind === "text" && isCodexInjectedContext(part.text)) continue
              // a tool result folds onto the call it belongs to, which is the
              // only place the id-less bridge result can be matched
              if (part.kind === "tool" && part.name === "result") {
                const call = [...parts].reverse().find((p): p is Part & { kind: "tool" } => p.kind === "tool" && !p.output)
                if (call) {
                  call.output = part.output
                  this.#emit({
                    type: "part.updated",
                    sessionID: toInternalId(threadID),
                    messageID: toInternalId(threadID),
                    partID: call.id,
                    partType: "tool",
                    part: call,
                  })
                  continue
                }
              }
              parts.push(part)
              this.#emit({
                type: "part.updated",
                sessionID: toInternalId(threadID),
                messageID: toInternalId(threadID),
                partID: String(evt.item.id ?? parts.length),
                partType: part.kind,
                part,
              })
              continue
            }
            if (evt.type === "turn.completed") {
              tokens = rolloutUsage(evt.usage)
              this.#emit({ type: "session.idle", sessionID: toInternalId(threadID) })
              continue
            }
            if (evt.type === "turn.failed" || evt.type === "error") {
              const msg = evt.error?.message ?? evt.message ?? "codex reported a failure"
              failure = { name: "CodexError", message: String(msg) }
              this.#emit({ type: "session.error", sessionID: toInternalId(threadID), message: String(msg) })
            }
          }
        })
        child.stderr?.on("data", (c: Buffer) => {
          stderr += c.toString()
        })
        child.on("error", reject)
        child.on("close", (code) => {
          // a SIGTERM from abort() is a stop, not a crash — let the caller see
          // it as an aborted turn rather than a spurious failure
          if (opts?.signal?.aborted) return reject(new Error("prompt aborted"))
          if (code !== 0 && !failure) {
            failure = { name: "CodexError", message: stderr.trim().slice(0, 400) || `codex exec exited ${code}` }
          }
          resolve()
        })
      })
    } finally {
      if (timer) clearTimeout(timer)
      opts?.signal?.removeEventListener("abort", onAbort)
      this.#running.delete(native)
      if (threadID) this.#running.delete(threadID)
      this.#metaCache.clear() // the rollout just changed
    }

    return {
      id: toInternalId(`${threadID}:turn-${Date.now()}`),
      sessionID: toInternalId(threadID || native),
      role: "assistant",
      time: Date.now(),
      parts,
      ...(tokens ? { tokens } : {}),
      ...(failure ? { error: failure } : {}),
    }
  }

  async abort(sessionID: string): Promise<boolean> {
    const native = this.#real(sessionID)
    const child = this.#running.get(native)
    if (!child) return false
    child.kill("SIGTERM")
    return true
  }

  // `codex exec` decides with a sandbox policy instead of asking: its flags go
  // as far as --approve-for-me (route approvals through an automatic review)
  // and the bypass switches, and there is no channel on which a question could
  // arrive. Approvals live in the interactive TUI and the app-server protocol,
  // neither of which this adapter speaks. So nothing ever emits ask.requested
  // here, and nothing can be answered — declared because the port requires it,
  // and false is the honest answer rather than a silent "ok".
  async respondAsk(_sessionID: string, _askID: string, _optionID: string): Promise<boolean> {
    return false
  }

  // The port wants one long-lived stream; Codex only streams inside a turn.
  // Subscribers therefore attach to an in-process bus that prompt() feeds as
  // it parses each turn's stdout.
  // codex discovers skills in $CODEX_HOME/skills only (default ~/.codex/skills),
  // and its SKILL.md frontmatter has no disable flag — show, don't toggle
  skillDirs(): SkillDirs {
    return {
      userDirs: [path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "skills")],
      projectDirs: [],
      toggleable: false,
    }
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

  // Without -m, `codex exec` runs whatever config.toml names — the thing the
  // word "default" hides. Only the top-level key counts: jep never passes
  // --profile, so a [profiles.*] override is not the one in play. Hand-read
  // rather than parsed as TOML: one key, no dependency.
  async defaultModel(): Promise<string | null> {
    let toml: string
    try {
      toml = await readFile(path.join(CODEX_HOME, "config.toml"), "utf8")
    } catch {
      return null
    }
    for (const line of toml.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("[")) break // into a section: past the top level
      const m = trimmed.match(/^model\s*=\s*["']([^"']+)["']/)
      if (m) return `codex/${m[1]}`
    }
    return null
  }

  async models(): Promise<ModelRef[]> {
    // `codex exec -m` takes any model the account can reach; there is no list
    // command, so offer the ones the CLI documents as selectable.
    return (process.env.JEP_CODEX_MODELS ?? "gpt-5.5-codex,gpt-5.5,gpt-5.1-codex")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .map((modelID) => ({ providerID: "codex", modelID }))
  }

  async capabilities(): Promise<Map<string, ModelCaps>> {
    const out = new Map<string, ModelCaps>()
    for (const m of await this.models()) {
      // -i takes images on every current codex model; context limit is not
      // reported by the CLI, and 0 is the port's "unknown"
      out.set(`${m.providerID}/${m.modelID}`, { image: true, attachment: true, contextLimit: 0 })
    }
    return out
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const dirs = new Set<string>()
    for (const file of await this.#rolloutFiles()) {
      const meta = await this.#meta(file)
      if (meta?.cwd) dirs.add(meta.cwd)
    }
    return [...dirs].map((worktree) => ({ id: worktree, worktree }))
  }

  async diff(_sessionID: string): Promise<FileDiff[]> {
    return [] // codex exec reports file changes as items, not as a session diff
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const child of this.#running.values()) child.kill("SIGTERM")
    this.#running.clear()
    // wake any parked events() iterators so they observe #closed and finish
    this.#emit({ type: "other", eventType: "adapter.closed", raw: null })
  }
}

// Codex item types -> jep parts. Unknown kinds become "other" rather than
// being dropped, so a new item type shows up as something rather than nothing.
function mapItem(item: any, workspace: string): Part | null {
  const type = String(item?.type ?? "")
  switch (type) {
    case "agent_message":
    case "AgentMessage": {
      const text = textOf(item)
      // the external-agent bridge's tool call/result blocks, live. A call is a
      // tool; a result is folded onto it by the caller, which has the parts.
      const call = externalAgentCall(text)
      if (call) return { kind: "tool", id: String(item.id ?? ""), name: call.name, input: call.input, output: "", status: "completed" }
      const result = externalAgentResult(text)
      if (result !== null) return { kind: "tool", id: String(item.id ?? ""), name: "result", input: {}, output: result, status: "completed" }
      return { kind: "text", text }
    }
    case "UserMessage":
      return { kind: "text", text: textOf(item) }
    case "reasoning":
    case "Reasoning":
      return { kind: "reasoning", text: textOf(item), id: String(item.id ?? "") }
    case "command_execution":
      return {
        kind: "tool",
        id: String(item.id ?? ""),
        name: "shell",
        input: item.command ?? {},
        output: item.aggregated_output ?? item.output ?? "",
        status: item.exit_code === 0 ? "completed" : item.exit_code == null ? "running" : "error",
        title: typeof item.command === "string" ? item.command : undefined,
      }
    case "file_change":
      return {
        kind: "tool",
        id: String(item.id ?? ""),
        name: "edit",
        input: item.changes ?? {},
        output: "",
        status: "completed",
        title: Array.isArray(item.changes)
          ? item.changes.map((c: any) => path.relative(workspace, c?.path ?? "")).join(", ")
          : undefined,
      }
    case "mcp_tool_call":
      return { kind: "tool", id: String(item.id ?? ""), name: item.tool ?? "mcp", input: item.arguments ?? {}, output: item.result ?? "", status: "completed" }
    case "web_search":
      return { kind: "tool", id: String(item.id ?? ""), name: "web_search", input: item.query ?? "", output: "", status: "completed" }
    case "error":
      return { kind: "text", text: `⚠️ ${textOf(item) || "codex error"}` }
    default:
      return { kind: "other", nativeType: type || "unknown" }
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
const clip = (t: string, max = 48): string => {
  const flat = t.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// First thing the user actually said, as a title. Only the head of the file is
// scanned: the opening exchange is always near the top, and a long session can
// run to thousands of lines.
function firstUserLine(lines: string[]): string {
  for (const line of lines.slice(0, 80)) {
    if (!line.trim()) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const p = d?.payload
    if (!p) continue
    let text = ""
    if (d.type === "response_item" && p.type === "message" && p.role === "user") text = contentText(p.content)
    else if (d.type === "event_msg" && p.type === "user_message") text = String(p.message ?? "")
    text = text.replace(/\s+/g, " ").trim()
    // the jep context header is prepended to a session's first prompt; titling
    // a conversation with our own preamble would make every one identical
    const marker = "Treat the message below as the user's entire, only request."
    const at = text.indexOf(marker)
    if (at !== -1) text = text.slice(at + marker.length).replace(/^[\s-]+/, "")
    if (text) return text.length > 48 ? `${text.slice(0, 48)}…` : text
  }
  return ""
}

// Responses-API content arrays: input_text on the way in, output_text on the
// way out, and the same shape again for tool output.
// codex injects a block of its own context into the rollout — the workspace
// roots it may touch and the permission profile it runs under. It looks like a
// user turn but nobody typed it, so it must never surface as a message. Kept
// pure and exported so the rule is testable without a rollout.
export function isCodexInjectedContext(text: string): boolean {
  return /<environment_context|<workspace_roots|<permission_profile/i.test(text)
}

// codex's own token accounting, whether it arrives live on turn.completed or
// recorded in the rollout as a token_count event
function rolloutUsage(u: any): Message["tokens"] {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    reasoning: u?.reasoning_output_tokens ?? 0,
    cache: { read: u?.cached_input_tokens ?? 0, write: u?.cache_write_input_tokens ?? 0 },
  }
}

// When another agent drives codex, codex records the tool calls it makes on
// its behalf as assistant *text*:
//
//   [external_agent_tool_call: Bash]
//   description: Search for draftMode usage in bot.ts
//   command: grep -n "draftMode" src/clients/telegram/bot.ts
//   [/external_agent_tool_call]
//
// followed by the matching
//
//   [external_agent_tool_result]
//   …output…
//   [/external_agent_tool_result]
//
// They are tools, not prose — rendered as prose they bury the answer under
// pages of commands. Recognised here and turned into tool parts.
const EXTERNAL_CALL = /^\[external_agent_tool_call:\s*([^\]]+)\]\s*([\s\S]*?)\s*\[\/external_agent_tool_call\]\s*$/
const EXTERNAL_RESULT = /^\[external_agent_tool_result\]\s*([\s\S]*?)\s*(?:\[\/external_agent_tool_result\])?\s*$/

export function externalAgentCall(text: string): { name: string; input: Record<string, string> } | null {
  const m = EXTERNAL_CALL.exec(text.trim())
  if (!m) return null
  const input: Record<string, string> = {}
  for (const line of (m[2] ?? "").split("\n")) {
    const at = line.indexOf(": ")
    if (at > 0) input[line.slice(0, at).trim()] = line.slice(at + 2).trim()
  }
  return { name: m[1]!.trim(), input }
}

export function externalAgentResult(text: string): string | null {
  const m = EXTERNAL_RESULT.exec(text.trim())
  return m ? (m[1] ?? "").trim() : null
}

function contentText(content: any): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("")
}

function textOf(item: any): string {
  if (typeof item?.text === "string") return item.text
  if (Array.isArray(item?.content)) {
    return item.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("")
  }
  return ""
}

/** Matches startOpenCodeServer's shape so a supervisor can treat them alike. */
export async function startCodexAdapter(workspace: string): Promise<CodexAdapter> {
  const adapter = new CodexAdapter(workspace)
  const h = await adapter.health()
  if (!h.healthy) throw new Error(`codex not runnable: ${h.version}`)
  return adapter
}

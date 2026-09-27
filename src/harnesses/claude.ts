import { spawn, execFile, type ChildProcess } from "node:child_process"
import net from "node:net"
import { mkdir, readFile, readdir, rm, mkdtemp, writeFile } from "node:fs/promises"
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentRef, HarnessAdapter, HarnessSettingSpec, ModelRef, ModelCaps } from "../core/ports.ts"
import type { AskRequest, DomainEvent, FileDiff, Message, Part, ProjectSummary, SessionHold, SessionSummary, SkillDirs } from "../core/types.ts"
import { resolveAgent } from "../core/agents.ts"
import { quoteBlock, readQuoteBlock, withAttachments } from "../core/transcript.ts"

// claude's `--agent` takes a subagent type jep can't enumerate reliably, so it
// offers no switch here. A requested id (opencode's "build", say, left over from
// another harness) is ignored rather than forwarded, which is what used to fail
// with "--agent 'build' not found".
const AGENTS: AgentRef[] = []

// Context windows Claude Code reported, shared by every workspace and kept on
// disk. Only a finished turn reports one, so held in memory alone they were
// lost on every daemon restart, and until the next turn ended the status line
// fell back to 200K and read "461K/200K 231%" for a 1M model. One map per file,
// shared by every adapter on the same data home; with no data home (a probe,
// a test) they live in memory only.
const windowStores = new Map<string, Map<string, number>>()

function learnedWindows(file: string | null): Map<string, number> {
  if (!file) return new Map()
  const known = windowStores.get(file)
  if (known) return known
  const windows = new Map<string, number>()
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    for (const [id, w] of Object.entries(raw)) if (typeof w === "number" && w > 0) windows.set(id, w)
  } catch {
    /* nothing learned yet */
  }
  windowStores.set(file, windows)
  return windows
}

function saveLearnedWindows(file: string | null, windows: Map<string, number>): void {
  if (!file) return
  writeFile(file, JSON.stringify(Object.fromEntries(windows), null, 1)).catch(() => {})
}

// When jep last ran a turn in a Claude conversation, one small file per
// conversation (<data home>/claude-turns/<session id>). The desktop Claude Code
// hook (scripts/claude-handoff-hook.mjs) reads it: a window that loaded the
// conversation before this time has not seen what the phone did, and catches
// up. Best effort: a failed stamp only loses the catch-up.
async function markRemoteTurn(dir: string | null, sessionID: string): Promise<void> {
  if (!dir || !/^[\w-]+$/.test(sessionID)) return
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, sessionID), String(Date.now()))
  } catch {
    /* only the desktop catch-up depends on it */
  }
}

export const CLAUDE_SETTINGS: HarnessSettingSpec[] = [
  {
    id: "dangerouslySkipPermissions",
    label: "Skip permission prompts",
    description: "Run Claude with --dangerously-skip-permissions so tool use does not stop for approval.",
    default: false,
    danger: true,
  },
  {
    id: "lowPriority",
    label: "Low priority at your limit",
    description: "When you reach your usage limit, keep working at lower priority instead of stopping, like Claude's /low-priority. Uses your weekly limit. Under your limit nothing changes.",
    default: false,
  },
]

// What Claude Code's own /low-priority does on the wire: every request carries
// this header, and the server answers each one with
// anthropic-ratelimit-unified-slow-status: "not_needed" (under the limit,
// served as usual) or "active" (over it, served at lower priority). The command
// only works in an interactive window (supportsNonInteractive: false), and a
// turn jep runs is `claude -p`, so the header is set for that process through
// ANTHROPIC_CUSTOM_HEADERS, which Claude Code adds to its requests. Found in
// Claude Code 2.1.283; it is Claude Code's behavior, not a documented API.
export const LOW_PRIORITY_HEADER = "anthropic-usage-limit: slow"

/**
 * The environment a turn runs with. The setting decides the header either way:
 * on adds it once, off takes out one the daemon's own environment may carry
 * (the daemon started from a low-priority turn, say), so off is really off.
 * Every other custom header is left as it was.
 */
export function turnEnv(base: NodeJS.ProcessEnv, lowPriority: boolean): NodeJS.ProcessEnv {
  const others = (base.ANTHROPIC_CUSTOM_HEADERS ?? "").split("\n").filter((l) => l.trim() && !/^anthropic-usage-limit\s*:/i.test(l))
  const headers = lowPriority ? [...others, LOW_PRIORITY_HEADER] : others
  const env = { ...base }
  if (headers.length) env.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n")
  else delete env.ANTHROPIC_CUSTOM_HEADERS
  return env
}

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
// how long a transcript must stay quiet before its change is announced
const CHANGE_QUIET_MS = Number(process.env.JEP_CHANGE_QUIET_MS ?? "") || 800
// compacting runs a summarizing model turn, so it gets a turn-sized budget
const COMPACT_TIMEOUT_MS = Number(process.env.JEP_COMPACT_TIMEOUT_MS ?? "") || 300_000

// The MCP server Claude Code calls in place of a permission prompt (see
// claude-ask-mcp.mjs). Spawned by Claude Code, not by us, which is why it is a
// file path rather than a function.
const ASK_MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), "claude-ask-mcp.mjs")

const HARNESS_NS = "claude"
const toInternalId = (native: string) => `${HARNESS_NS}://${native}`

// One content block of one API message: the id messages() gives its transcript
// entry and the id its live stream carries, so both are the same row on a client.
const blockMessageID = (native: string, apiID: string, block: number) => toInternalId(`${native}:${apiID}:${block}`)
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
  // the transcripts directory, watched once something is listening, so a
  // conversation continued elsewhere (the desktop) reaches the phone on its own
  #watcher: FSWatcher | null = null
  #changed = new Map<string, ReturnType<typeof setTimeout>>()
  // parsed transcript heads, keyed by file — re-reading every session on each
  // listSessions would make /ls crawl once a project has a few hundred
  #metaCache = new Map<string, { mtime: number; meta: TranscriptMeta | null }>()
  // the ask channel: one unix socket for the whole adapter, opened the first
  // time a turn runs, plus the turns parked on an unanswered question
  #askSocket: string | null = null
  #askServer: net.Server | null = null
  // the session each parked ask belongs to, so standing one down can say which
  // conversation's card to take away
  #askWaiters = new Map<string, { sessionID: string; answer: (decision: { decision: "allow" | "deny"; message?: string }) => void }>()
  #askSeq = 0
  // whether this CLI build takes --permission-prompt-tool at all; asked once
  #askSupported: boolean | null = null
  // context windows Claude Code reported for the models it actually ran, keyed
  // by the id it ran and the id (or alias) the turn asked for; it knows these
  // and jep does not, so they are learned from each turn's result
  #contextWindows: Map<string, number>
  // the model the CLI resolved to on the last turn, for when nothing is configured
  #lastModel: string | null = null

  // jep's own state, from the composition root: the learned context windows
  // and the phone-turn stamps. Null means keep nothing on disk.
  #windowsFile: string | null
  #turnsDir: string | null

  constructor(workspace: string, opts: { dataHome?: string } = {}) {
    this.workspace = workspace
    this.endpoint = `claude-cli:${workspace}`
    this.#windowsFile = opts.dataHome ? path.join(opts.dataHome, "claude-context-windows.json") : null
    this.#turnsDir = opts.dataHome ? path.join(opts.dataHome, "claude-turns") : null
    this.#contextWindows = learnedWindows(this.#windowsFile)
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

  settings(): HarnessSettingSpec[] {
    return CLAUDE_SETTINGS
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
      if (!firstUser && d.type === "user" && !d.isSidechain && !d.isMeta && !isLocalCommandWrapper(d.message?.content)) {
        firstUser = clip(contentText(d.message?.content))
      }
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
    // every tool call seen so far, so a result arriving in a later turn can be
    // folded back onto the call it belongs to
    const toolsByID = new Map<string, Part & { kind: "tool" }>()
    // how many blocks of each API message came before, for blockMessageID
    const blocksSeen = new Map<string, number>()
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      let d: any
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      // sidechains are Task-tool subagents: somebody else's turn, not yours
      if (d.isSidechain) continue
      // A compaction is a transcript fact: Claude Code writes this boundary,
      // then the summary it carries forward. The boundary becomes the same
      // divider an opencode compaction draws; the summary is written for the
      // model, so it stays out of the conversation, as it does in Claude Code.
      if (d.type === "system" && d.subtype === "compact_boundary") {
        out.push({
          id: toInternalId(`${native}:${d.uuid ?? out.length}`),
          sessionID: toInternalId(native),
          role: "user",
          time: Date.parse(d.timestamp ?? "") || Date.now(),
          parts: [{ kind: "other", nativeType: "compaction" }],
        })
        continue
      }
      if (d.type !== "user" && d.type !== "assistant") continue
      // counted before anything is skipped, the way the stream counts blocks
      const apiID = d.type === "assistant" && typeof d.message?.id === "string" ? d.message.id : ""
      const block = apiID ? (blocksSeen.get(apiID) ?? 0) : 0
      if (apiID) blocksSeen.set(apiID, block + 1)
      if (d.isCompactSummary) continue
      // and neither is Claude Code talking to itself — the local-command
      // caveat, a slash command's name/args, its stdout
      if (d.isMeta || isLocalCommandWrapper(d.message?.content)) continue
      const parts = foldResults(d.type === "user" ? userParts(d.message?.content) : contentParts(d.message?.content), toolsByID)
      // A turn whose whole content was tool results has nothing left to say:
      // every part folded onto an earlier call. Emitting it anyway is what put
      // an empty purple bubble on the phone after every single tool call.
      if (!parts.length) continue
      for (const p of parts) if (p.kind === "tool") toolsByID.set(p.id, p)
      out.push({
        id: apiID ? blockMessageID(native, apiID, block) : toInternalId(`${native}:${d.uuid ?? out.length}`),
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
      harnessSettings?: Record<string, boolean>
      quote?: string
    },
  ): Promise<Message> {
    const native = this.#real(sessionID)
    const pending = isPending(native)
    // A quote goes in as a content block of its own, ahead of the message:
    // that takes the user message on stdin as stream-json instead of as an
    // argument. The transcript keeps the blocks apart, which is how
    // messages() knows the quote without reading it out of the words.
    const quote = opts?.quote?.trim() || undefined

    const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"]
    if (quote) args.push("--input-format", "stream-json")
    if (opts?.harnessSettings?.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions")
    if (opts?.model?.modelID) args.push("--model", opts.model.modelID)
    const agent = resolveAgent(AGENTS, opts?.agent)
    if (agent) args.push("--agent", agent)
    if (!pending) args.push("--resume", native)
    // attachments have no flag in print mode; naming the paths is what lets
    // the agent read them with its own tools
    const body = withAttachments(text, opts?.filePaths)
    if (!quote) args.push(body)

    // Route permission prompts to the phone. Without this, print mode has
    // nobody to ask and anything gated is simply refused — the turn comes back
    // having quietly not done the thing.
    //
    // These go after the prompt, always: --mcp-config is variadic ("JSON files
    // or strings", space-separated), so whatever follows it is swallowed as
    // another config — including the prompt, which then reads as a missing file
    // and kills the run before it starts.
    if (!opts?.harnessSettings?.dangerouslySkipPermissions && await this.#asksSupported()) {
      const sock = await this.#askChannel()
      if (sock) {
        args.push(
          "--permission-prompt-tool",
          "mcp__jep__ask",
          "--mcp-config",
          JSON.stringify({
            mcpServers: {
              jep: {
                command: process.execPath,
                args: [ASK_MCP],
                env: { JEP_ASK_SOCKET: sock, JEP_ASK_SESSION: sessionID },
              },
            },
          }),
        )
      }
    }

    // what this turn asked for, alias or not, so its context window can be
    // found again under the name a client knows it by
    const asked = opts?.model?.modelID ?? (await this.#configuredModel())
    const child = spawn(CLAUDE_BIN, args, {
      cwd: this.workspace,
      env: turnEnv(process.env, opts?.harnessSettings?.lowPriority === true),
      stdio: [quote ? "pipe" : "ignore", "pipe", "pipe"],
    })
    if (quote) {
      const content = [{ type: "text", text: quoteBlock(quote) }, { type: "text", text: body }]
      child.stdin?.end(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`)
    }
    this.#running.set(native, child)
    if (!pending) void markRemoteTurn(this.#turnsDir, native)

    let realID = pending ? "" : native
    const parts: Part[] = []
    let tokens: Message["tokens"]
    // Claude Code prices the run itself and reports it on the result event —
    // more honest than jep multiplying tokens by a rate card of its own
    let cost: number | undefined
    let model: string | undefined
    let failure: { name: string; message: string } | undefined
    let stderr = ""
    // index -> position in `parts`, so streamed deltas accumulate in place
    const blockAt = new Map<number, number>()
    // Claude Code writes every content block of an API message as a transcript
    // entry of its own, so each streamed block is its own message, named the
    // way messages() names it. Keyed by the session instead, one turn's text,
    // tool calls and next text all piled into a single live row that repeated
    // what the record already showed.
    let apiID = ""
    const blocksSettled = new Map<string, number>()
    const toolMessage = new Map<string, string>()

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
            }
            const sid = toInternalId(realID || native)
            const rid = realID || native

            if (d.type === "stream_event" && d.event) {
              // a sub-agent's tokens carry parent_tool_use_id; they belong to
              // that tool call, not to the answer being composed
              if (d.parent_tool_use_id) continue
              const ev = d.event
              if (ev.type === "message_start" && typeof ev.message?.id === "string") {
                apiID = ev.message.id
                blockAt.clear()
              } else if (ev.type === "content_block_start" && typeof ev.index === "number") {
                const part = startBlock(ev.content_block)
                if (part) {
                  blockAt.set(ev.index, parts.length)
                  parts.push(part)
                  if (apiID) {
                    this.#emit({ type: "message.created", sessionID: sid, messageID: blockMessageID(rid, apiID, ev.index), role: "assistant" })
                  }
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
                  messageID: apiID ? blockMessageID(rid, apiID, ev.index) : sid,
                  // unique across the turn: a client that keys by part alone
                  // (Telegram) would otherwise glue every message's block 0
                  partID: apiID ? `${apiID}:${ev.index}` : String(ev.index),
                  text: String(add),
                  partType: part.kind === "reasoning" ? "reasoning" : "text",
                })
              }
              continue
            }

            if (d.type === "assistant" && d.message?.content) {
              // the settled message: tool_use blocks only appear here. One
              // event per block, in order, which is how messages() counts them.
              const settled = typeof d.message.id === "string" ? d.message.id : ""
              const block = settled ? (blocksSettled.get(settled) ?? 0) : 0
              if (settled) blocksSettled.set(settled, block + 1)
              const mid = settled ? blockMessageID(rid, settled, block) : sid
              for (const block of d.message.content) {
                if (block?.type !== "tool_use") continue
                const title = toolTitle(block.input)
                const part: Part = {
                  kind: "tool",
                  id: String(block.id ?? ""),
                  name: String(block.name ?? "tool"),
                  input: block.input ?? {},
                  output: "",
                  status: "running",
                  ...(title ? { title } : {}),
                  // a running tool shows a live elapsed time, and a watchdog
                  // needs to know how long one has been quiet
                  startedAt: Date.now(),
                }
                parts.push(part)
                toolMessage.set(part.id, mid)
                this.#emit({ type: "message.created", sessionID: sid, messageID: mid, role: "assistant" })
                this.#emit({ type: "part.updated", sessionID: sid, messageID: mid, partID: part.id, partType: "tool", part })
              }
              if (d.message.usage) tokens = mapUsage(d.message.usage)
              if (typeof d.message.model === "string") model = d.message.model
              continue
            }

            // A tool's output comes back as a *user* turn carrying tool_result
            // blocks. It is not conversation — it is the call's result — so it
            // folds onto the call it belongs to rather than becoming a message
            // of its own. Without this every tool part stayed "running" for the
            // life of the turn: the phone kept spinning on finished work, and a
            // watchdog counting running tools could never tell a live tool from
            // a finished one.
            if (d.type === "user" && Array.isArray(d.message?.content)) {
              for (const block of d.message.content) {
                if (block?.type !== "tool_result") continue
                const callID = String(block.tool_use_id ?? "")
                const call = parts.find((p): p is Part & { kind: "tool" } => p.kind === "tool" && p.id === callID)
                if (!call) continue
                call.output = contentText(block.content)
                call.status = block.is_error ? "error" : "completed"
                this.#emit({ type: "part.updated", sessionID: sid, messageID: toolMessage.get(call.id) ?? sid, partID: call.id, partType: "tool", part: call })
              }
              continue
            }

            if (d.type === "result") {
              if (d.subtype && d.subtype !== "success") {
                failure = { name: "ClaudeError", message: String(d.error ?? d.result ?? d.subtype) }
                this.#emit({ type: "session.error", sessionID: sid, message: failure.message })
              }
              // result.usage adds up every API call in the turn; the last call's
              // own usage is what the context actually holds, so that one stands
              if (d.usage && !tokens) tokens = mapUsage(d.usage)
              if (typeof d.total_cost_usd === "number") cost = d.total_cost_usd
              this.#learnWindows(d.modelUsage, model, asked)
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
      // stamped again at the end: the desktop window must count everything
      // this turn wrote, not only that it began
      if (realID || !pending) void markRemoteTurn(this.#turnsDir, realID || native)
      // the turn is over, so any card it raised is unanswerable now — say so
      // rather than leaving it standing on whatever client is showing it
      this.#standDownAsks(realID || native, "the turn ended before this was answered")
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
      ...(cost !== undefined ? { cost } : {}),
      ...(model ? { model } : {}),
      ...(failure ? { error: failure } : {}),
    }
  }

  // Compress the conversation: Claude Code's /compact, which it also runs from
  // print mode (supportsNonInteractive). It writes a compact_boundary and the
  // summary into the transcript, and the next --resume carries only those
  // forward. Refused (false) while a turn owns the conversation.
  async compact(sessionID: string): Promise<boolean> {
    const native = this.#real(sessionID)
    if (isPending(native) || this.#running.has(native)) return false
    const child = spawn(CLAUDE_BIN, ["-p", "--output-format", "json", "--resume", native, "/compact"], {
      cwd: this.workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.#running.set(native, child)
    let out = ""
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()))
    const timer = setTimeout(() => child.kill("SIGTERM"), COMPACT_TIMEOUT_MS)
    try {
      const code = await new Promise<number | null>((resolve) => {
        child.once("close", resolve)
        child.once("error", () => resolve(null))
      })
      if (child.killed) throw new Error(`compacting timed out after ${Math.round(COMPACT_TIMEOUT_MS / 1000)}s`)
      if (code !== 0) return false
      try {
        return (JSON.parse(out) as { is_error?: boolean }).is_error !== true
      } catch {
        return false
      }
    } finally {
      clearTimeout(timer)
      this.#running.delete(native)
      this.#metaCache.clear()
      // it rewrote the conversation from here: a desktop window must catch up
      void markRemoteTurn(this.#turnsDir, native)
    }
  }

  async abort(sessionID: string): Promise<boolean> {
    const child = this.#running.get(this.#real(sessionID))
    if (!child) return false
    child.kill("SIGTERM")
    return true
  }

  // The turn is parked inside a tool call, waiting on this. Anything other than
  // the allow option is a denial — Claude Code's prompt tool has two answers,
  // and a denial carries a reason back to the model so it can say what it
  // could not do rather than simply failing.
  async respondAsk(_sessionID: string, askID: string, optionID: string): Promise<boolean> {
    const waiter = this.#askWaiters.get(askID)
    if (!waiter) return false
    this.#askWaiters.delete(askID)
    waiter.answer(
      optionID === "allow"
        ? { decision: "allow" }
        : { decision: "deny", message: "denied from Telegram" },
    )
    // every other client holding this card now learns it is spent
    this.#emit({ type: "ask.resolved", sessionID: waiter.sessionID, askID })
    return true
  }

  // stood down rather than answered: the same denial, without a decision the
  // model could mistake for an answer
  async rejectAsk(_sessionID: string, askID: string): Promise<boolean> {
    const waiter = this.#askWaiters.get(askID)
    if (!waiter) return false
    this.#askWaiters.delete(askID)
    waiter.answer({ decision: "deny", message: "answered in chat" })
    this.#emit({ type: "ask.resolved", sessionID: waiter.sessionID, askID })
    return true
  }

  /**
   * Stand down every ask still parked on a session, and say so. An ask belongs
   * to the turn that raised it: once that turn is over the waiter's socket is
   * gone and no answer can reach the model, so a card left standing is a button
   * that cannot work — and on the phone a standing card holds the send button
   * and the responding spinner hostage. Swept when the turn ends, not only at
   * shutdown, which is what left the "wants to run" card up after the tool had
   * already been and gone.
   */
  #standDownAsks(sessionID: string, why: string): void {
    for (const [id, waiter] of [...this.#askWaiters]) {
      if (sessionID && waiter.sessionID && waiter.sessionID !== sessionID) continue
      this.#askWaiters.delete(id)
      try {
        waiter.answer({ decision: "deny", message: why })
      } catch {
        /* the socket is already gone, which is the case this exists for */
      }
      this.#emit({ type: "ask.resolved", sessionID: waiter.sessionID || sessionID, askID: id })
    }
  }

  // One socket per adapter, opened lazily and never announced anywhere: the
  // path only reaches the MCP server we spawn, through its environment.
  async #askChannel(): Promise<string | null> {
    if (this.#askSocket) return this.#askSocket
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), "jep-claude-ask-"))
      const sock = path.join(dir, "ask.sock")
      const server = net.createServer((conn) => {
        let buf = ""
        conn.on("data", (chunk: Buffer) => {
          buf += chunk.toString()
          let nl = buf.indexOf("\n")
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (line) this.#onAsk(line, conn)
            nl = buf.indexOf("\n")
          }
        })
        conn.on("error", (err) => console.error(`[claude] ask connection: ${err.message}`))
      })
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(sock, () => resolve())
      })
      // the bot's event loop, not this, is what keeps the process alive
      server.unref()
      this.#askServer = server
      this.#askSocket = sock
      return sock
    } catch (err) {
      console.error(`[claude] ask channel unavailable: ${(err as Error)?.message ?? err}`)
      return null
    }
  }

  // one question from the MCP server: turn it into an ask the frontend can
  // render, and hold the socket open until somebody taps an answer
  #onAsk(line: string, conn: net.Socket): void {
    let msg: { id?: string; session?: string; tool?: string; input?: Record<string, unknown>; toolUseID?: string }
    try {
      msg = JSON.parse(line)
    } catch {
      console.error(`[claude] unreadable ask: ${line.slice(0, 200)}`)
      return
    }
    const askID = `ask${++this.#askSeq}`
    const input = msg.input ?? {}
    // the command for Bash, the path for a file tool, the whole input when it
    // is something else — whatever actually says what is about to happen
    const detail =
      typeof input.command === "string"
        ? input.command
        : typeof input.file_path === "string"
          ? input.file_path
          : JSON.stringify(input)
    this.#askWaiters.set(askID, {
      sessionID: msg.session ?? "",
      answer: (decision) => {
        try {
          conn.write(`${JSON.stringify({ id: msg.id, ...decision })}\n`)
        } catch (err) {
          console.error(`[claude] ask answer failed: ${(err as Error)?.message ?? err}`)
        }
      },
    })
    const ask: AskRequest = {
      id: askID,
      sessionID: msg.session ?? "",
      title: `${msg.tool ?? "a tool"} wants to run`,
      ...(detail ? { detail } : {}),
      options: [
        { id: "allow", label: "Allow", style: "success" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
      // the tool_use id is the tool part's id, live and in the transcript alike
      ...(msg.toolUseID ? { callID: msg.toolUseID } : {}),
      at: Date.now(),
    }
    this.#emit({ type: "ask.requested", sessionID: ask.sessionID, ask })
  }

  // --permission-prompt-tool is what makes any of this reachable; an older
  // build without it would reject the whole command line, taking every turn
  // with it, so it is checked once against the CLI's own help.
  async #asksSupported(): Promise<boolean> {
    if (this.#askSupported !== null) return this.#askSupported
    try {
      const help = await new Promise<string>((resolve, reject) => {
        execFile(CLAUDE_BIN, ["--help"], { timeout: 20_000, maxBuffer: 4_000_000 }, (err, stdout) =>
          err ? reject(err) : resolve(stdout),
        )
      })
      this.#askSupported = help.includes("--permission-prompt-tool")
      if (!this.#askSupported) console.error("[claude] this CLI has no --permission-prompt-tool; tool prompts stay with the CLI")
    } catch (err) {
      console.error(`[claude] couldn't read CLI help: ${(err as Error)?.message ?? err}`)
      this.#askSupported = false
    }
    return this.#askSupported
  }

  // claude scans the cross-agent user dirs plus its own project root
  skillDirs(): SkillDirs {
    return {
      userDirs: [path.join(os.homedir(), ".claude", "skills"), path.join(os.homedir(), ".agents", "skills")],
      projectDirs: [path.join(this.workspace, ".claude", "skills")],
      toggleable: true,
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
    this.#watchTranscripts()
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

  // A transcript written by anything but a turn this adapter is running is
  // news to a client that has the conversation open: say so, once per burst
  // of writes. Claude Code appends a line per event, so a desktop turn is
  // hundreds of writes; the quiet period folds them into a few notices.
  #watchTranscripts(): void {
    if (this.#watcher || this.#closed || !existsSync(PROJECTS_DIR)) return
    try {
      this.#watcher = watch(PROJECTS_DIR, { recursive: true }, (_event, file) => {
        const name = file ? path.basename(String(file)) : ""
        if (!name.endsWith(".jsonl")) return
        const native = name.slice(0, -".jsonl".length)
        // our own turn streams live already; its writes are not news
        if (this.#running.has(native)) return
        clearTimeout(this.#changed.get(native))
        this.#changed.set(
          native,
          setTimeout(() => {
            this.#changed.delete(native)
            this.#metaCache.clear()
            this.#emit({ type: "session.changed", sessionID: toInternalId(native) })
          }, CHANGE_QUIET_MS),
        )
      })
      this.#watcher.on("error", () => {
        this.#watcher?.close()
        this.#watcher = null
      })
    } catch (err) {
      console.error(`[claude] cannot watch ${PROJECTS_DIR}: ${(err as Error)?.message ?? err}`)
    }
  }

  // `claude agents --json` is the only non-TTY way to see what is running.
  // Rows carry both ids: `sessionId` is the one jep stores, `id` the short one
  // every `claude` subcommand takes.
  async #agentRow(sessionID: string): Promise<{ id: string; name?: string; startedAt?: number; kind?: string } | null> {
    const native = this.#real(sessionID)
    if (isPending(native)) return null
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(CLAUDE_BIN, ["agents", "--json"], { timeout: 20_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
      })
      const rows = JSON.parse(out)
      if (!Array.isArray(rows)) return null
      return rows.find((r: { sessionId?: string }) => r?.sessionId === native) ?? null
    } catch (err) {
      console.error(`[claude] agents --json failed: ${(err as Error)?.message ?? err}`)
      return null
    }
  }

  // A background session owns its conversation while it runs: `--resume` on it
  // exits immediately telling you to attach or stop it first. That message is
  // written for somebody at a terminal, which is precisely who the user is not.
  async sessionHold(sessionID: string): Promise<SessionHold | null> {
    const row = await this.#agentRow(sessionID)
    if (!row || row.kind !== "background") return null
    return { label: String(row.name ?? row.id), startedAt: Number(row.startedAt) || 0 }
  }

  async releaseHold(sessionID: string): Promise<boolean> {
    const row = await this.#agentRow(sessionID)
    if (!row?.id) return false
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(CLAUDE_BIN, ["stop", row.id], { timeout: 30_000 }, (err) => (err ? reject(err) : resolve()))
      })
      return true
    } catch (err) {
      console.error(`[claude] stop ${row.id} failed: ${(err as Error)?.message ?? err}`)
      return false
    }
  }

  // jep passes --model only when the chat has picked one; otherwise the CLI
  // falls back to its configured model, which is the one thing a user staring
  // at the word "default" cannot see. Same file order the CLI resolves in,
  // most specific first. The value may be an alias ("opus") rather than a full
  // id — that is what is configured, so that is what we report.
  async defaultModel(): Promise<string | null> {
    // nothing configured: the CLI still picked something, and after one turn
    // jep knows what — better than "default", which names no model at all
    const model = (await this.#configuredModel()) ?? this.#lastModel
    return model ? `claude/${model}` : null
  }

  async #configuredModel(): Promise<string | null> {
    const candidates = [
      path.join(this.workspace, ".claude", "settings.local.json"),
      path.join(this.workspace, ".claude", "settings.json"),
      path.join(CLAUDE_HOME, "settings.json"),
    ]
    for (const file of candidates) {
      try {
        const model = JSON.parse(await readFile(file, "utf8"))?.model
        if (typeof model === "string" && model.trim()) return model.trim()
      } catch {
        // missing or malformed: try the next one, then give up to "default"
      }
    }
    return null
  }

  async agents(): Promise<AgentRef[]> {
    return AGENTS
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
    const ids = new Set((await this.models()).map((m) => m.modelID))
    const fallback = await this.defaultModel()
    if (fallback) ids.add(fallback.slice("claude/".length))
    for (const id of this.#contextWindows.keys()) ids.add(id)
    for (const id of ids) {
      out.set(`claude/${id}`, { image: true, attachment: true, contextLimit: this.#contextWindow(id) })
    }
    return out
  }

  // What Claude Code reported, when a turn has run on this model; until then
  // the size its id implies — a 1M-context variant says so in the id, and
  // everything else ships with 200K.
  #contextWindow(id: string): number {
    return this.#contextWindows.get(id) ?? (/\[1m\]/i.test(id) ? 1_000_000 : 200_000)
  }

  // result.modelUsage carries a contextWindow for every model the turn used
  // (a sub-agent can run a different one). The main one is the model the
  // assistant messages named; the turn's own request, alias or not, maps to it.
  #learnWindows(usage: unknown, model: string | undefined, asked: string | null): void {
    if (!usage || typeof usage !== "object") return
    let main: { id: string; window: number; out: number } | null = null
    for (const [id, u] of Object.entries(usage as Record<string, { contextWindow?: unknown; outputTokens?: unknown }>)) {
      if (typeof u?.contextWindow !== "number" || u.contextWindow <= 0) continue
      this.#contextWindows.set(id, u.contextWindow)
      const out = typeof u.outputTokens === "number" ? u.outputTokens : 0
      // the id the messages named wins; otherwise whichever did the most work
      // (the messages may name a dated id where modelUsage keeps the short one)
      if (id === model || !main || (main.id !== model && out > main.out)) main = { id, window: u.contextWindow, out }
    }
    if (!main) return
    this.#lastModel = main.id
    if (asked) this.#contextWindows.set(asked, main.window)
    saveLearnedWindows(this.#windowsFile, this.#contextWindows)
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
    this.#watcher?.close()
    this.#watcher = null
    for (const t of this.#changed.values()) clearTimeout(t)
    this.#changed.clear()
    for (const child of this.#running.values()) child.kill("SIGTERM")
    this.#running.clear()
    // an unanswered ask outlives nothing: the socket goes, and every parked
    // turn is told no rather than left waiting on a server that has stopped
    this.#standDownAsks("", "jep is shutting down")
    this.#askServer?.close()
    this.#askServer = null
    this.#askSocket = null
    this.#emit({ type: "other", eventType: "adapter.closed", raw: null })
  }
}

// opencode hands us a display hint per tool call (its parts carry
// `state.title`); Claude Code does not, so derive one from the call's own
// input — the command a Bash call runs, the file a read or edit touches, the
// pattern a search looks for. Without it the phone has nothing to show under
// the row and can only ever say "Ran a command" with a blank line beneath it.
// Ordered by how well each key identifies its call: a Bash call is its
// command, not its description; a Task is its description, not its prompt.
const TITLE_KEYS = ["command", "file_path", "notebook_path", "pattern", "url", "query", "description", "path", "prompt"]
const TITLE_MAX = 200

export function toolTitle(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const rec = input as Record<string, unknown>
  for (const key of TITLE_KEYS) {
    const v = rec[key]
    if (typeof v !== "string" || !v.trim()) continue
    const title = v.trim()
    return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title
  }
  return undefined
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
// A user message jep sent with a quote holds it as its own first content block
// (see prompt()); anything else is read as it is.
function userParts(content: any): Part[] {
  if (Array.isArray(content) && content.length > 1 && content[0]?.type === "text") {
    const quote = readQuoteBlock(String(content[0].text ?? ""))
    if (quote) return [{ kind: "quote", text: quote }, ...contentParts(content.slice(1))]
  }
  return contentParts(content)
}

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
      case "tool_use": {
        const title = toolTitle(b.input)
        out.push({
          kind: "tool",
          id: String(b.id ?? ""),
          name: String(b.name ?? "tool"),
          input: b.input ?? {},
          output: "",
          status: "completed",
          ...(title ? { title } : {}),
        })
        break
      }
      case "tool_result":
        // Carried out as a placeholder for the assembler to fold onto the call
        // with this id; it never survives into a rendered message. `name` marks
        // it as such — see the fold in messages().
        out.push({ kind: "tool", id: String(b.tool_use_id ?? ""), name: "result", input: {}, output: contentText(b.content), status: b.is_error ? "error" : "completed" })
        break
      default:
        break
    }
  }
  return out
}

// Folds every tool_result placeholder onto the call it names, and drops it
// from the message. What is left is the conversation: an assistant turn that
// made calls, and nothing at all for the turn that merely carried their
// output. A result whose call we never saw (a truncated transcript, a
// sidechain we skipped) is dropped rather than shown as a stray "result" row.
export function foldResults(parts: Part[], toolsByID: Map<string, Part & { kind: "tool" }>): Part[] {
  const kept: Part[] = []
  for (const part of parts) {
    if (part.kind === "tool" && part.name === "result") {
      const call = toolsByID.get(part.id)
      if (call) {
        call.output = part.output
        call.status = part.status
      }
      continue
    }
    kept.push(part)
  }
  return kept
}

// Claude Code writes its own bookkeeping into the transcript as user turns:
// the caveat it prefixes, the slash command's name/message/args, and that
// command's stdout. None of it is conversation, and rendered as a purple
// bubble it reads as if the user typed it. A real prompt may quote these
// tags, so only drop a message that is *entirely* wrappers.
const LOCAL_COMMAND_TAGS = "local-command-caveat|command-name|command-message|command-args|local-command-stdout"
const LOCAL_COMMAND_ANY = new RegExp(`<(?:${LOCAL_COMMAND_TAGS})>`)
const LOCAL_COMMAND_ELEMENT = new RegExp(`<(?:${LOCAL_COMMAND_TAGS})>[\\s\\S]*?</(?:${LOCAL_COMMAND_TAGS})>`, "g")
const LOCAL_COMMAND_TAG = new RegExp(`</?(?:${LOCAL_COMMAND_TAGS})>`, "g")

export function isLocalCommandWrapper(content: any): boolean {
  const text = contentText(content)
  if (!LOCAL_COMMAND_ANY.test(text)) return false
  // every character must lie inside a wrapper — the caveat and the command
  // stdout carry prose inside their tags, so stripping tags alone is not enough
  return text.replace(LOCAL_COMMAND_ELEMENT, "").replace(LOCAL_COMMAND_TAG, "").trim() === ""
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

export async function startClaudeAdapter(workspace: string, opts: { dataHome?: string } = {}): Promise<ClaudeAdapter> {
  const adapter = new ClaudeAdapter(workspace, opts)
  const h = await adapter.health()
  if (!h.healthy) throw new Error(`claude not runnable: ${h.version}`)
  return adapter
}

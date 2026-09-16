import { mkdir, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type { HarnessAdapter, ModelCaps, ModelRef } from "../core/ports.ts"
import type { FilePart, Part, ProjectSummary, TextPart, ReasoningPart, ToolCallPart } from "../core/types.ts"
import { mdToHtml } from "./html.ts"
import { closeStreamingTable, mdTable, mdToRich } from "./rich.ts"
import type { RichBlock } from "./rich.ts"
import type { TelegramApi, TgMessage, TgUpdate, InlineButton, ReplyMarkup } from "./api.ts"
import { runComplianceSuite } from "../core/compliance.ts"
import type { Pairing } from "./pair.ts"
import type { ChatStore, InternalsSettings, DetailMode, InternalsLayout } from "./store.ts"
import type { ReminderRecord, ReminderStore } from "./reminders.ts"

interface Ws {
  name: string
  dir: string
  adapter: HarnessAdapter
}

type Awaiting =
  | { kind: "pair" }
  | { kind: "use" }
  // backTo is the message the conversation list was drawn on, when the rename
  // was started from there — so finishing one returns to the list instead of
  // dead-ending on a confirmation
  | { kind: "rename"; sessionID: string; backTo?: number }
  | { kind: "newfolder"; dir: string }
  | { kind: "clone"; dir: string }

interface ChatState {
  workspace: string
  sessionID: string | null
  // sessionID was just cleared by deleting the active conversation — the next
  // message should start a brand new one, not silently resume the most
  // recent survivor (#ensureSession's default when sessionID is null, e.g.
  // after a restart). Explicitly reset to false anywhere else sessionID is
  // cleared (workspace switches), so it never outlives the delete it's for.
  freshOnNext: boolean
  // sessionID points at a session that hasn't taken its first real prompt
  // yet — the next #freeText turn gets the jep context header prepended,
  // then this clears so later turns in the same session don't repeat it.
  sessionFresh: boolean
  harness: string | null
  inflight: AbortController | null
  // permissionID -> prompt message for in-flight keyboard prompts; ephemeralID
  // is set when the prompt was sent as a group ephemeral message
  pending: Map<string, { sessionID: string; messageID: number; ephemeralID?: number }>
  // snapshot behind the /ls and settings pickers — each entry keeps its own
  // origin workspace, since /ls spans every project; `dir` is set when that
  // project has no server running yet (see #listPicker)
  picker: { messageID: number; sessions: { id: string; ws: string; dir?: string }[]; cmdMessageID?: number } | null
  del: { messageID: number; i: number } | null
  // an arg-taking command was sent bare; next plain text is the answer
  awaiting: Awaiting | null
  // directory browser state: the folder being shown and the subfolders in it.
  // Buttons address entries by index because callback_data caps at 64 bytes,
  // which a real path blows straight through.
  browse: { cwd: string; dirs: string[]; page: number } | null
  // page shown now, shared across the rename/ls/continuation pickers
  page: number
  // the message the settings menu tree is currently drawn on
  settingsMsg: number | null
  // the model/rename picker page shown now
  settingsPage: number
  // the model that already got the "switch to a vision model" suggestion
  suggestedImage: string | null
  // last draft_id used for streaming previews (Bot API 9.4+), per chat
  draft: number
  // the chat's type ("private", "group", "supergroup", …) and the last
  // human sender — needed to scope ephemeral group prompts to that person
  chatType: string | null
  lastUserID: number | null
}

const MAX_MSG = 4000
const MAX_LIST = 10
// How long a turn may go without producing *anything* before we call it wedged.
// This replaces an absolute ceiling: a long agent turn is normal — a refactor
// can stream tool calls for half an hour and every one of those resets the
// clock — but total silence is not. Only a turn that has emitted no events at
// all for this long gets abandoned.
const TURN_IDLE_MS = Number(process.env.JEP_TURN_IDLE_MS ?? "") || 5 * 60_000
// a shallow clone of anything sane is well under this; past it, assume the
// remote is wedged rather than leaving the chat waiting indefinitely
const CLONE_TIMEOUT_MS = 10 * 60_000
const execFileAsync = promisify(execFile)
const WIPE_PAGE = 4
// files embedded into one rich message via attach:// (keep multipart modest)
const MAX_RICH_FILES = 4

const kin = (rows: InlineButton[][]): ReplyMarkup => ({ inline_keyboard: rows })
const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data })

// Handler for fire-and-forget calls whose failure must not break the caller.
// "Best-effort" is a reason not to await something, never a reason to discard
// why it failed — a silent catch is how a real fault hides for weeks.
const logFail = (tag: string) => (err: unknown) => {
  console.error(`[${tag}] ${(err as Error)?.message ?? err}`)
}

// "/remind 2h build" → { ms: 7_200_000, what: "build", every: false }
// "/remind every 1h build" → { ms: 3_600_000, what: "build", every: true }
// null when malformed or outside the 5s–7d window we bother supporting.
function parseRemind(arg: string): { ms: number; what: string; every: boolean } | null {
  const every = /^\s*every\s+/i.test(arg)
  const rest = every ? arg.replace(/^\s*every\s+/i, "") : arg
  const m = rest.match(/^\s*(\d+)\s*([smhd])\s+([\s\S]+)$/)
  if (!m) return null
  const per = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!] ?? 0
  const ms = Number(m[1]) * per
  const what = m[3]!.trim()
  if (!what || !Number.isFinite(ms) || ms < 5_000 || ms > 7 * 86_400_000) return null
  return { ms, what, every }
}

const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

// 12_430 -> "12.4K", 1_834_219 -> "1.8M" — compact like a status bar, not a spreadsheet
const fmtCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`
  return String(n)
}

// A list row is one line on a phone, shared with the harness icon, the age
// and sometimes a workspace tag. Codex titles in particular are whole opening
// prompts, and an untrimmed one pushes everything after it off the end.
const clipTitle = (t: string, max = 30): string => {
  const flat = t.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

// "how long since this conversation last moved", for list rows. Coarse on
// purpose: the point is to tell yesterday's thread from the one you were in
// ten minutes ago, not to report a duration.
const timeAgo = (ts: number): string => {
  const ms = Date.now() - ts
  if (!ts || ms < 0) return ""
  const min = Math.round(ms / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  const wk = Math.round(day / 7)
  if (wk < 5) return `${wk}w ago`
  return `${Math.round(day / 30)}mo ago`
}

// display form of a workspace directory: just the folder name
const fmtWsPath = (dir: string): string => basename(dir)

// the agent shown as its Settings icon rather than spelled out — 🔨 executes
// tools, 📝 is read-only. Same two icons the agent menu uses, so the pin and
// the menu teach each other.
const agentIcon = (agent: string): string => (agent === "plan" ? "📝" : "🔨")

// full path, but with $HOME folded back to "~" — the browser shows whole
// paths (you need to know where you are) and a phone screen is narrow.
const fmtHome = (dir: string): string => {
  const h = homedir()
  return dir === h ? "~" : dir.startsWith(h + "/") ? `~${dir.slice(h.length)}` : dir
}

const styled = (b: InlineButton, style: InlineButton["style"]): InlineButton => (style ? { ...b, style } : b)

// ─── agent-internals rendering (thinking + tool calls as collapsible details) ───

const MAX_TOOL_CHARS = 1500
// beyond this many collapses we roll per-section up to one block (message limits)
const MAX_DETAILS = 12

const stringifyTool = (v: unknown): string => {
  if (v == null) return ""
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

// keep both ends of a long payload; the middle is rarely the interesting part
function capText(s: string, max = MAX_TOOL_CHARS): string {
  if (s.length <= max) return s
  const head = s.slice(0, Math.ceil(max * 0.6))
  const tail = s.slice(-Math.floor(max * 0.4))
  return `${head}\n… (truncated) …\n${tail}`
}

const isEmptyValue = (v: unknown): boolean => {
  if (v == null) return true
  if (typeof v === "string") return v.trim() === ""
  if (typeof v === "object") return Object.keys(v).length === 0
  return false
}

const toolMeta = (t: ToolCallPart): Record<string, any> => (t.metadata ?? {}) as Record<string, any>
const toolInput = (t: ToolCallPart): Record<string, any> => (t.input ?? {}) as Record<string, any>

// opencode's tool result carries far more than the model-facing input/output:
// edit's real diff and write's file path live in `title`/`metadata`, which the
// generic input/output dump below would otherwise never show.
const MAX_HEADER_CHARS = 48
const capHeader = (s: string): string => (s.length > MAX_HEADER_CHARS ? `${s.slice(0, MAX_HEADER_CHARS - 1)}…` : s)
// a collapsed details block always shows its summary, even closed — keep it
// to a glance (icon + the one thing that matters), not a full sentence. The
// rest (diff, output, line range, match count…) belongs in the body.
const baseName = (p: string): string => p.split(/[/\\]/).pop() || p

function toolHeader(t: ToolCallPart): string {
  const meta = toolMeta(t)
  const input = toolInput(t)
  switch (t.name) {
    case "edit": {
      const stats = meta.filediff ? ` +${meta.filediff.additions ?? 0}-${meta.filediff.deletions ?? 0}` : ""
      return capHeader(`✏️ ${baseName(t.title ?? input.filePath ?? "edit")}${stats}`)
    }
    case "write":
      return capHeader(`📝 ${baseName(t.title ?? input.filePath ?? "write")}`)
    case "bash": {
      const exit = meta.exit
      const mark = exit === 0 || exit == null ? "" : ` ✗${exit}`
      const cmd = String(t.title ?? input.command ?? "bash").split("\n")[0]!
      return capHeader(`⚙ ${cmd}${mark}`)
    }
    case "read":
      return capHeader(`📖 ${baseName(t.title ?? input.filePath ?? "read")}`)
    case "glob":
      return capHeader(`🔎 ${input.pattern ?? "glob"}`)
    case "grep":
      return capHeader(`🔎 ${t.title ?? input.pattern ?? "grep"}`)
    case "task":
      return capHeader(`🤖 @${input.subagent_type ?? "subagent"}: ${t.title ?? input.description ?? ""}`)
    default:
      return `⚙ ${t.name}`
  }
}

const toolLang = (t: ToolCallPart): string | undefined => (t.name === "edit" ? "diff" : undefined)

// layout "minimal": just an icon + the tool's generic name, nothing call-specific
const TOOL_ICON: Record<string, string> = {
  edit: "✏️ edit",
  write: "📝 write",
  bash: "⚙ bash",
  read: "📖 read",
  glob: "🔎 glob",
  grep: "🔎 grep",
  task: "🤖 task",
}
const toolIcon = (t: ToolCallPart): string => TOOL_ICON[t.name] ?? `⚙ ${t.name}`

function toolBody(t: ToolCallPart): string {
  const meta = toolMeta(t)
  const input = toolInput(t)
  if (t.name === "edit") {
    const diff = meta.diff ?? meta.filediff?.patch
    if (typeof diff === "string" && diff.trim()) return diff
  }
  if (t.name === "write" && typeof input.content === "string" && input.content) return input.content
  if (t.name === "bash" && typeof t.output === "string" && t.output.trim()) return t.output
  if (t.name === "read") {
    const disp = meta.display
    if (disp?.type === "file" && typeof disp.text === "string") return disp.text
    if (disp?.type === "directory" && Array.isArray(disp.entries)) return disp.entries.join("\n")
  }
  if (t.name === "task" && typeof t.output === "string") {
    const m = t.output.match(/<task_(?:result|error)>\n?([\s\S]*?)\n?<\/task_(?:result|error)>/)
    if (m) return m[1]!.trim()
  }
  const inp = isEmptyValue(t.input) ? "" : stringifyTool(t.input)
  const out = isEmptyValue(t.output) ? "" : stringifyTool(t.output)
  const parts: string[] = []
  if (inp) parts.push(`input:\n${inp}`)
  if (out) parts.push(`output:\n${out}`)
  if (!parts.length) return t.status === "completed" ? "(no output)" : "…"
  return parts.join("\n\n")
}

const detailsBlock = (summary: string, blocks: RichBlock[], open: boolean): RichBlock => ({
  type: "details",
  summary,
  ...(open ? { is_open: true } : {}),
  blocks,
})

// "Thought for Ns" once we know how long it actually took (sub-second rounds
// up to 1s rather than printing "0s"); "Thinking" while that's still unknown
const thinkingPhrase = (ms?: number): string => (ms != null ? `Thought for ${fmtDuration(Math.max(ms, 1000))}` : "Thinking")
// several reasoning parts (one per step) can end up merged into one combined
// block/label — sum whatever duration each part actually reports, or give up
// and show no duration if none of them have it
const reasoningMs = (parts: ReasoningPart[]): number | undefined => {
  const known = parts.filter((p) => p.durationMs != null)
  return known.length ? known.reduce((sum, p) => sum + p.durationMs!, 0) : undefined
}

const reasoningBlock = (text: string, open: boolean, ms?: number): RichBlock =>
  detailsBlock(`💭 ${thinkingPhrase(ms)}`, [{ type: "paragraph", text: capText(text.trim()) }], open)

const toolBlock = (t: ToolCallPart, open: boolean): RichBlock => {
  const body = capText(toolBody(t))
  const lang = toolLang(t)
  return detailsBlock(toolHeader(t), body ? [{ type: "pre", text: body, ...(lang ? { language: lang } : {}) }] : [], open)
}

const textOf = (parts: Part[]): string =>
  parts
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n\n")

const reasoningOf = (parts: Part[]): string =>
  parts
    .filter((p): p is ReasoningPart => p.kind === "reasoning")
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n\n")

// split parts on opencode's step-start / step-finish markers
function splitSteps(parts: Part[]): Part[][] {
  const steps: Part[][] = []
  let cur: Part[] | null = null
  for (const p of parts) {
    if (p.kind === "other" && p.nativeType === "step-start") {
      cur = []
      steps.push(cur)
      continue
    }
    if (p.kind === "other" && p.nativeType === "step-finish") {
      cur = null
      continue
    }
    if (!cur) {
      cur = []
      steps.push(cur)
    }
    cur.push(p)
  }
  return steps
}

// these build the FINAL, static message only. The live draft never shows
// collapsible content — see buildLiveBlocks — so there's nothing here to keep
// in sync with closeStreamingTable's half-row heuristic.
function richPerSection(parts: Part[], s: InternalsSettings): RichBlock[] {
  const out: RichBlock[] = []
  for (const p of parts) {
    if (p.kind === "reasoning") {
      if (s.thinking !== "off" && p.text.trim()) out.push(reasoningBlock(p.text, s.thinking === "expanded", p.durationMs))
    } else if (p.kind === "tool") {
      if (s.tools !== "off") out.push(toolBlock(p, s.tools === "expanded"))
    } else if (p.kind === "text") {
      if (p.text.trim()) out.push(...mdToRich(p.text))
    }
  }
  return out
}

function richCombined(parts: Part[], s: InternalsSettings): RichBlock[] {
  const out: RichBlock[] = []
  const reasoning = reasoningOf(parts)
  const tools = parts.filter((p): p is ToolCallPart => p.kind === "tool")
  if (s.thinking !== "off" && reasoning) {
    const ms = reasoningMs(parts.filter((p): p is ReasoningPart => p.kind === "reasoning"))
    out.push(reasoningBlock(reasoning, s.thinking === "expanded", ms))
  }
  if (s.tools !== "off" && tools.length) {
    const inner: RichBlock[] = tools.map((t) => {
      const lang = toolLang(t)
      return { type: "pre", text: capText(`${toolHeader(t)}\n\n${toolBody(t)}`), ...(lang ? { language: lang } : {}) }
    })
    out.push(detailsBlock(`⚙ Tools (${tools.length})`, inner, s.tools === "expanded"))
  }
  const text = textOf(parts)
  if (text) out.push(...mdToRich(text))
  return out
}

function richPerStep(parts: Part[], s: InternalsSettings): RichBlock[] {
  const out: RichBlock[] = []
  for (const step of splitSteps(parts)) {
    const reasoning = reasoningOf(step)
    const tools = step.filter((p): p is ToolCallPart => p.kind === "tool")
    const showReasoning = s.thinking !== "off" && !!reasoning
    const showTools = s.tools !== "off" && tools.length > 0
    if (showReasoning || showTools) {
      const bits: string[] = []
      if (showReasoning) {
        const ms = reasoningMs(step.filter((p): p is ReasoningPart => p.kind === "reasoning"))
        bits.push(`💭 ${thinkingPhrase(ms)}`)
      }
      if (showTools) bits.push(tools.length === 1 ? toolHeader(tools[0]!) : `⚙ ${tools.length} tools`)
      const inner: RichBlock[] = []
      if (showReasoning) inner.push({ type: "paragraph", text: capText(reasoning) })
      if (showTools)
        for (const t of tools) {
          const lang = toolLang(t)
          inner.push({ type: "pre", text: capText(`${toolHeader(t)}\n\n${toolBody(t)}`), ...(lang ? { language: lang } : {}) })
        }
      const open = (showReasoning && s.thinking === "expanded") || (showTools && s.tools === "expanded")
      out.push(detailsBlock(capHeader(bits.join(" · ")), inner, open))
    }
    const text = textOf(step)
    if (text) out.push(...mdToRich(text))
  }
  return out
}

// no collapse at all: one icon+name per reasoning/tool part, in order, as a
// single line up front — then the plain answer text. Nothing to expand,
// nothing for a Telegram edit to ever reset.
function richMinimal(parts: Part[], s: InternalsSettings): RichBlock[] {
  const bits: string[] = []
  for (const p of parts) {
    if (p.kind === "reasoning" && s.thinking !== "off" && p.text.trim()) bits.push(`💭 ${thinkingPhrase(p.durationMs).toLowerCase()}`)
    else if (p.kind === "tool" && s.tools !== "off") bits.push(toolIcon(p))
  }
  const out: RichBlock[] = []
  if (bits.length) out.push({ type: "paragraph", text: bits.join("  ") })
  const text = textOf(parts)
  if (text) out.push(...mdToRich(text))
  return out
}

function buildRich(parts: Part[], s: InternalsSettings): RichBlock[] {
  if (s.layout === "minimal") return richMinimal(parts, s)
  if (s.layout === "combined") return richCombined(parts, s)
  if (s.layout === "per-section") {
    const blocks = richPerSection(parts, s)
    // too many collapses → roll up so the message still sends
    return blocks.filter((b) => b.type === "details").length > MAX_DETAILS ? richCombined(parts, s) : blocks
  }
  return richPerStep(parts, s)
}

// the live draft, in contrast: no collapsible content at all (nothing to
// expand mid-stream means nothing for Telegram's full-content-replace edits
// to reset). Finished reasoning/tool parts are flushed as their own
// permanent messages (see #freeText) and excluded here via `flushedIdx`; a
// tool still running shows as a plain, non-expandable status line.
// `live` marks a draft still being generated: a trailing RichBlockThinking is
// appended so the client's animated glimmer says "still working" even once
// real text is on screen. It is a progress signal, not a rendering of the
// model's reasoning — it appears whatever `thinking` is set to, and never on
// the final message.
function buildLiveBlocks(
  parts: Part[],
  s: InternalsSettings,
  flushedToolIDs: Set<string>,
  reasoningStarted: Map<string, number>,
  live = false,
): RichBlock[] {
  if (s.layout === "minimal") {
    // nothing ever gets flushed to its own message in minimal mode (there's
    // nothing collapsible to protect) — same icon-line-then-text shape live
    // as in the final message, just growing in place as parts stream in.
    // durationMs isn't known yet mid-stream, so estimate it from when we
    // first saw this part.
    const bits: string[] = []
    for (const p of parts) {
      if (p.kind === "reasoning" && s.thinking !== "off" && p.text.trim()) {
        const started = p.id ? reasoningStarted.get(p.id) : undefined
        const ms = p.durationMs ?? (started !== undefined ? Date.now() - started : undefined)
        bits.push(`💭 ${thinkingPhrase(ms).toLowerCase()}`)
      } else if (p.kind === "tool" && s.tools !== "off") bits.push(toolIcon(p))
    }
    const out: RichBlock[] = []
    if (bits.length) out.push({ type: "paragraph", text: bits.join("  ") })
    for (const p of parts) if (p.kind === "text" && p.text.trim()) out.push(...mdToRich(closeStreamingTable(p.text)))
    return withLiveMarker(out, live)
  }
  const out: RichBlock[] = []
  for (const p of parts) {
    if (p.kind === "tool") {
      if (s.tools !== "off" && !flushedToolIDs.has(p.id)) out.push({ type: "paragraph", text: toolHeader(p) })
    } else if (p.kind === "text") {
      if (p.text.trim()) out.push(...mdToRich(closeStreamingTable(p.text)))
    }
  }
  return withLiveMarker(out, live)
}

// Only appended when there is already something on screen: with nothing else
// in the draft the initial thinking-only block is already doing this job, and
// a lone marker would just duplicate it.
function withLiveMarker(out: RichBlock[], live: boolean): RichBlock[] {
  if (!live || out.length === 0) return out
  return [...out, { type: "thinking", text: "…" }]
}

const quoteLines = (title: string, body: string): string => `> **${title}**\n> ${body.split("\n").join("\n> ")}`

// HTML fallback: blockquotes (not collapsible) instead of rich details blocks
function partsToMarkdown(parts: Part[], s: InternalsSettings): string {
  if (s.layout === "minimal") {
    const bits: string[] = []
    for (const p of parts) {
      if (p.kind === "reasoning" && s.thinking !== "off" && p.text.trim()) bits.push(`💭 ${thinkingPhrase(p.durationMs).toLowerCase()}`)
      else if (p.kind === "tool" && s.tools !== "off") bits.push(toolIcon(p))
    }
    return [bits.length ? bits.join("  ") : "", textOf(parts)].filter(Boolean).join("\n\n")
  }
  const out: string[] = []
  const reasoning = reasoningOf(parts)
  const tools = parts.filter((p): p is ToolCallPart => p.kind === "tool")
  if (s.thinking !== "off" && reasoning) {
    const ms = reasoningMs(parts.filter((p): p is ReasoningPart => p.kind === "reasoning"))
    out.push(quoteLines(`💭 ${thinkingPhrase(ms)}`, capText(reasoning)))
  }
  if (s.tools !== "off" && tools.length)
    out.push(quoteLines(`⚙ Tools (${tools.length})`, capText(tools.map((t) => `${toolHeader(t)}\n\n${toolBody(t)}`).join("\n\n"))))
  const text = textOf(parts)
  if (text) out.push(text)
  return out.join("\n\n")
}

const PRESETS: Record<"simple" | "minimal" | "detailed" | "debug", InternalsSettings> = {
  simple: { thinking: "off", tools: "off", layout: "per-step" },
  minimal: { thinking: "collapsed", tools: "collapsed", layout: "minimal" },
  detailed: { thinking: "collapsed", tools: "collapsed", layout: "per-step" },
  debug: { thinking: "expanded", tools: "expanded", layout: "per-section" },
}

function internalsPreset(s: InternalsSettings): "simple" | "minimal" | "detailed" | "debug" | "custom" {
  for (const name of ["simple", "minimal", "detailed", "debug"] as const) {
    const p = PRESETS[name]
    if (p.thinking === s.thinking && p.tools === s.tools && p.layout === s.layout) return name
  }
  return "custom"
}

const cycleMode = (m: DetailMode): DetailMode => (m === "off" ? "collapsed" : m === "collapsed" ? "expanded" : "off")
const cycleLayout = (l: InternalsLayout): InternalsLayout =>
  l === "per-step" ? "per-section" : l === "per-section" ? "combined" : l === "combined" ? "minimal" : "per-step"

const HELP = [
  "jep — your coding agent, on the go.",
  "",
  "💬 Just type what you want done.",
  "",
  "/new · start fresh",
  "/ls · switch chats",
  "/settings · model, workspace & more",
  "/remind · schedule a nudge (e.g. /remind 2h build)",
  "",
  "Everything else lives in the ☰ menu.",
].join("\n")

// prepended once to a session's first real prompt (see ChatState.sessionFresh),
// gated by the user's 🧩 Context setting — orients the harness to the fact
// it's being driven through jep rather than a terminal, and where to look if
// that ever matters, then hands off cleanly so it responds to the actual
// request below, not this framing. jep itself isn't Telegram-specific — that
// addendum only applies because bot.ts is currently jep's one front end.
const JEP_CONTEXT = [
  "[jep context — background only, not a request]",
  "This conversation is relayed through jep, a phone-first control plane for coding agents (headless, no terminal on the other end). jep's own code and docs: /Users/user/Documents/code/jep — see docs/PROCESSES.md and docs/PHILOSOPHY.md.",
].join("\n")
const JEP_TELEGRAM_CONTEXT =
  "This conversation is specifically relayed via Telegram — replies render as chat messages (markdown, tables, collapsible details), not a terminal."
const JEP_CONTEXT_FOOTER = "Ignore the block above. Treat the message below as the user's entire, only request.\n---"

// A stop is not a failure. opencode reports one as MessageAbortedError on the
// message, which is indistinguishable in shape from a real error — the tell is
// either the name or the fact that we are the ones who aborted.
const isAbort = (failure: { name: string; message: string }, ac: AbortController): boolean =>
  ac.signal.aborted || /abort/i.test(failure.name) || /\baborted\b/i.test(failure.message)

// The first prompt of a fresh session carries the jep context header (see
// JEP_CONTEXT). It's for the model, not for you — in a transcript it buries
// the message you actually sent under a screen of preamble.
const stripInjectedContext = (text: string): string => {
  const i = text.indexOf(JEP_CONTEXT_FOOTER)
  return i === -1 ? text : text.slice(i + JEP_CONTEXT_FOOTER.length)
}

const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg)$/i
const imageExt = (mime?: string): string | null => {
  const m = (mime ?? "").split(";")[0]?.trim()
  const byMime: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
  }
  return byMime[m ?? ""] ?? null
}

// Stickers and photo thumbnails arrive with no file name and no mime type, so
// the extension has to come from the bytes. Getting it wrong matters: the
// harness derives the mime it sends the model from the extension alone, so a
// WEBP called .jpg is rejected as corrupt rather than read.
const sniffImageExt = (b: Buffer): string | null => {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg"
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ".png"
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return ".webp"
  if (b.length >= 4 && b.toString("ascii", 0, 4) === "GIF8") return ".gif"
  return null
}

// what a sticker actually means, for the harness: the emoji is the content,
// the set name is context. Sent as text so an animated sticker we can't
// render still says something instead of arriving as an empty message.
const stickerPrompt = (s: NonNullable<TgMessage["sticker"]>): string => {
  const parts = [s.emoji, s.set_name ? `from the "${s.set_name}" sticker set` : ""].filter(Boolean)
  return `[sticker${parts.length ? `: ${parts.join(" ")}` : ""}]`
}

export class TelegramBot {
  #tg: TelegramApi
  #workspaces: Ws[]
  #activeWsName: string
  #pairing: Pairing
  #store: ChatStore
  #extraModels: string[]
  #uploadsDir: string
  #chats = new Map<number, ChatState>()
  // tail of each chat's turn queue — see #runTurn
  #turns = new Map<number, Promise<void>>()
  #reminderStore: ReminderStore
  // id -> live timer for every reminder currently scheduled from #reminderStore
  #reminderTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // ordered by expected use — most-reached-for first. /ws, /abort, /cancel
  // stay fully functional but out of this menu: /ws moved under
  // ⚙️ Settings (a command tree, not a flat list) now that there's a home
  // for it there; /abort and /cancel are already handed to the user as an
  // explicit "⏹ Stop" button / "/cancel to stop" text exactly when each is
  // relevant, so listing them here too would just be a second, redundant
  // way to reach something already in front of you at the right moment.
  static commands = [
    { command: "new", description: "start a fresh conversation" },
    { command: "ls", description: "your conversations" },
    { command: "settings", description: "status · model · rename · workspace" },
    { command: "log", description: "this conversation's history" },
    { command: "remind", description: "remind me later, once or recurring (/remind 2h build · /remind every 1h build)" },
  ]

  // lazily starts serving a directory this bot didn't boot with — how
  // #wsForDir materializes a project the adapter knows about, or the browser
  // adds a brand new one, without a restart
  #spawn: (dir: string, harness?: string) => Promise<Ws>
  /** every harness this build can start, for the picker */
  #harnessList: Array<{ id: string; label: string; icon: string }>

  constructor(
    tg: TelegramApi,
    workspaces: Ws[],
    activeWsName: string,
    pairing: Pairing,
    store: ChatStore,
    extraModels: string[],
    uploadsDir: string,
    spawn: (dir: string, harness?: string) => Promise<Ws>,
    harnessList: Array<{ id: string; label: string; icon: string }>,
    reminders: ReminderStore,
  ) {
    this.#tg = this.#recording(tg)
    this.#workspaces = workspaces
    this.#activeWsName = activeWsName
    this.#pairing = pairing
    this.#store = store
    this.#extraModels = extraModels
    this.#uploadsDir = uploadsDir
    this.#spawn = spawn
    this.#harnessList = harnessList
    this.#reminderStore = reminders
    for (const r of reminders.list()) this.#scheduleReminder(r)
  }

  // schedules (or re-schedules, e.g. on boot) one persisted reminder. Firing
  // late (bot was down) still fires once immediately — delay just clamps to 0.
  #scheduleReminder(r: ReminderRecord): void {
    const timer = setTimeout(() => {
      void this.#tg.sendMessage({ chatID: r.chatID, text: `⏰ ${r.what}`, disableNotification: true }).catch(logFail("reminder"))
      if (r.everyMs) {
        const nextAt = Date.now() + r.everyMs
        this.#reminderStore.reschedule(r.id, nextAt)
        this.#scheduleReminder({ ...r, nextAt })
      } else {
        this.#reminderTimers.delete(r.id)
        this.#reminderStore.remove(r.id)
      }
    }, Math.max(0, r.nextAt - Date.now()))
    timer.unref?.() // never keep the process alive just for a reminder
    this.#reminderTimers.set(r.id, timer)
  }

  // renders every outgoing text through markdown → Telegram HTML, and logs
  // every send for diagnostics
  #recording(tg: TelegramApi): TelegramApi {
    const md = (text: string) => mdToHtml(text)
    return {
      getUpdates: (p) => tg.getUpdates(p),
      setMyCommands: (c) => tg.setMyCommands(c),
      sendChatAction: (p) => tg.sendChatAction(p),
      answerCallbackQuery: (p) => tg.answerCallbackQuery(p),
      deleteMessage: (p) => tg.deleteMessage(p),
      pinChatMessage: (p) => tg.pinChatMessage(p),
      unpinChatMessage: (p) => tg.unpinChatMessage(p),
      editRichMessage: (p) => tg.editRichMessage(p),
      deleteEphemeralMessage: (p) => tg.deleteEphemeralMessage(p),
      sendRichMessage: async (p) => {
        console.error(`[send] sendRichMessage chat=${p.chatID} at=${new Date().toISOString()}`)
        const r = await tg.sendRichMessage(p)
        console.error(`[send] sendRichMessage -> msg=${r.message_id}`)
        return r
      },
      sendMessageDraft: (p) => tg.sendMessageDraft({ ...p, text: p.text !== undefined ? md(p.text) : undefined, parseMode: p.text !== undefined ? "HTML" : undefined }),
      sendRichMessageDraft: (p) => {
        console.error(`[send] sendRichMessageDraft chat=${p.chatID} draft=${p.draftID} at=${new Date().toISOString()}`)
        return tg.sendRichMessageDraft(p)
      },
      getFileContent: (f) => tg.getFileContent(f),
      editMessageText: (p) => tg.editMessageText({ ...p, text: md(p.text), parseMode: "HTML" }),
      sendMessage: async (p) => {
        console.error(`[send] sendMessage chat=${p.chatID} at=${new Date().toISOString()} text=${JSON.stringify(p.text.slice(0, 60))}`)
        return tg.sendMessage({ ...p, text: md(p.text), parseMode: "HTML" })
      },
      sendPhoto: (p) => tg.sendPhoto(p),
      sendDocument: (p) => tg.sendDocument(p),
    }
  }

  #ws(name: string): Ws {
    return this.#workspaces.find((w) => w.name === name) ?? this.#workspaces[0]!
  }

  // The workspace a chat is actually talking to. A directory can be served by
  // more than one harness at once, so the name alone is ambiguous — the chat's
  // harness picks between them. Falls back to whatever is serving that
  // directory when the chosen harness isn't running for it.
  #activeWs(chatID: number): Ws {
    const c = this.#chat(chatID)
    const sameName = this.#workspaces.filter((w) => w.name === c.workspace)
    const pool = sameName.length ? sameName : this.#workspaces
    if (!c.harness) return pool[0]!
    return pool.find((w) => w.adapter.id === c.harness) ?? pool[0]!
  }

  // Session ids are namespaced by harness ("opencode://…", "codex://…"), so an
  // id from one harness is meaningless to another. That mismatch is reachable
  // whenever the harness a chat was using isn't the one now serving its
  // directory — after a restart, say, or a failed switch — and handing the id
  // over anyway makes the other harness 500 on every read.
  #sessionMatches(ws: Ws, sessionID: string | null): boolean {
    if (!sessionID) return false
    const i = sessionID.indexOf("://")
    return i === -1 || sessionID.slice(0, i) === ws.adapter.id
  }

  // Writes where this chat is pointed to disk. ChatState is in-memory, so
  // without this every restart silently relocated you: workspace fell back to
  // the first one and the conversation to whatever happened to be newest
  // there — you'd come back mid-thought and be somewhere else entirely.
  #rememberChat(chatID: number): void {
    const c = this.#chat(chatID)
    this.#store.setChatContext(chatID, this.#activeWs(chatID).dir, c.sessionID, c.harness ?? undefined)
  }

  // Every project directory the harness knows of, whether or not this bot has
  // a server running for it. Reading this costs nothing: /project is not
  // scoped to the calling instance, unlike /session.
  async #knownProjectDirs(): Promise<string[]> {
    const probe = this.#workspaces[0]
    if (!probe) return []
    try {
      const projects: ProjectSummary[] = (await probe.adapter.listProjects?.()) ?? []
      return projects.map((p) => p.worktree)
    } catch (err) {
      // /ls silently narrows to live workspaces when this fails — say why
      console.error(`[projects] listProjects failed: ${(err as Error)?.message ?? err}`)
      return []
    }
  }

  // Returns a running Ws for a directory, starting one only if there isn't
  // already one. This is the "spawn to act" half: browsing and listing stay
  // free, and a server appears at the moment you actually open something.
  async #wsForDir(dir: string, harness?: string | null): Promise<Ws> {
    const existing = this.#workspaces.find((w) => w.dir === dir && (!harness || w.adapter.id === harness))
    if (existing) return existing
    const w = await this.#spawn(dir, harness ?? undefined)
    this.#workspaces.push(w)
    return w
  }

  // Which harness owns an id, read off the id itself ("codex://…"). Rows in a
  // picker can outlive the listing that produced them, and a directory can be
  // served by two harnesses at once, so the id is the only trustworthy source.
  #harnessOf(sessionID: string): string | null {
    const i = sessionID.indexOf("://")
    return i === -1 ? null : sessionID.slice(0, i)
  }

  // A /ls row can point at a project with nothing running for it. Acting on
  // one starts its server; #ws(name) alone would silently fall back to the
  // first workspace and act on the wrong project entirely.
  async #wsForRow(row: { id?: string; ws: string; dir?: string }): Promise<Ws> {
    const harness = row.id ? this.#harnessOf(row.id) : null
    if (row.dir) return this.#wsForDir(row.dir, harness)
    // no directory on the row: fall back to the named workspace, but still
    // prefer the harness the id belongs to when several serve that name
    const byName = this.#workspaces.filter((w) => w.name === row.ws)
    const pool = byName.length ? byName : this.#workspaces
    return pool.find((w) => !harness || w.adapter.id === harness) ?? pool[0]!
  }

  // ...but a read doesn't justify starting anything: a cold row's title comes
  // from the same cache /ls listed it from.
  async #rowTitle(row: { id: string; ws: string; dir?: string }): Promise<string> {
    const harness = this.#harnessOf(row.id)
    const live = this.#workspaces.find((w) => (row.dir ? w.dir === row.dir : w.name === row.ws) && (!harness || w.adapter.id === harness))
    if (!live) {
      return this.#store.indexedSessions(row.dir ?? "", harness).find((s) => s.id === row.id)?.title ?? ""
    }
    return (await live.adapter.getSession(row.id))?.title ?? ""
  }

  #chat(id: number): ChatState {
    let c = this.#chats.get(id)
    if (!c) {
      // pick up where this chat left off before the last restart, if that
      // workspace is still around (it may have been removed since)
      const saved = this.#store.chatContext(id)
      // match the harness too: the session id belongs to it, and restoring the
      // id while falling back to a different harness is what made every read
      // fail with a 500
      const savedWs = saved
        ? (this.#workspaces.find((w) => w.dir === saved.dir && w.adapter.id === (saved.harness ?? w.adapter.id)) ??
           this.#workspaces.find((w) => w.dir === saved.dir))
        : undefined
      const harnessBack = !!savedWs && (!saved?.harness || savedWs.adapter.id === saved.harness)
      c = {
        workspace: savedWs?.name ?? this.#activeWsName,
        sessionID: harnessBack ? saved!.sessionID : null,
        // restored before anything reads it, so #activeWs resolves to the
        // harness this chat was last using rather than the default
        harness: (harnessBack && saved?.harness) || null,
        freshOnNext: false,
        sessionFresh: false,
        inflight: null,
        pending: new Map(),
        picker: null,
        del: null,
        awaiting: null,
        browse: null,
        page: 0,
        settingsMsg: null,
        settingsPage: 0,
        suggestedImage: null,
        draft: 0,
        chatType: null,
        lastUserID: null,
      }
      this.#chats.set(id, c)
    }
    return c
  }

  #displayTitle(id: string, fallback: string): string {
    return this.#store.title(id) ?? (fallback || id.slice(-8))
  }

  // resolves to the session #ensureSession would resume, without creating one
  // if there's none — so a display-only read (see #updateStatus) survives a
  // bot restart (c.sessionID lives only in memory) instead of showing blank
  // until the next real prompt re-derives it. Caches onto c.sessionID exactly
  // like #ensureSession would, so that call doesn't redo the lookup.
  async #resolveSessionID(chatID: number): Promise<string | null> {
    const c = this.#chat(chatID)
    const active = this.#activeWs(chatID)
    if (c.sessionID && !this.#sessionMatches(active, c.sessionID)) {
      console.error(`[session] dropping ${c.sessionID} — ${active.adapter.id} can't read it`)
      c.sessionID = null
    }
    if (c.sessionID) return c.sessionID
    if (c.freshOnNext) return null
    const ws = active
    const list = await ws.adapter.listSessions()
    const newest = [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (newest) c.sessionID = newest.id
    if (newest) this.#rememberChat(chatID)
    return newest?.id ?? null
  }

  // one persistent conversation per chat: resume the newest session if any,
  // otherwise create one (title = first message snippet) — unless
  // freshOnNext says the last one was just deleted out from under us, in
  // which case skip straight to creating a new one.
  async #ensureSession(chatID: number, firstText?: string): Promise<string> {
    const c = this.#chat(chatID)
    const resolved = await this.#resolveSessionID(chatID)
    if (resolved) return resolved
    const ws = this.#activeWs(chatID)
    c.freshOnNext = false
    const title = (firstText ?? "").slice(0, 40) || "My chat"
    const s = await ws.adapter.createSession(title)
    c.sessionID = s.id
    c.sessionFresh = true
    this.#rememberChat(chatID)
    return s.id
  }

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.message) await this.#gatedMessage(update.message)
    else if (update.callback_query) await this.#gatedCallback(update.callback_query)
    else if (update.stopped_message_generation) await this.#onStopGeneration(update.stopped_message_generation)
  }

  // Runs a turn *off* the update loop. tg.ts awaits handleUpdate for every
  // update in strict sequence, so awaiting a turn there froze the whole bot
  // for its entire duration: the "⏹ Stop" callback and Telegram's native stop
  // both arrive as ordinary updates, and neither could be delivered until the
  // turn they were meant to cancel had already finished. (The native button
  // animates client-side on tap, which is why stopping *looked* instant while
  // the harness kept running.) Other chats were blocked for just as long.
  //
  // Turns within one chat still run strictly in order — they share ChatState
  // and a harness session, so overlapping them would interleave two prompts
  // in one conversation. Queueing rather than rejecting means firing off
  // several thoughts in a row just works, which is the whole point on a phone.
  #runTurn(chatID: number, fn: () => Promise<void>): void {
    const prev = this.#turns.get(chatID) ?? Promise.resolve()
    // `.then(fn, fn)` so one failed turn never strands the rest of the queue
    const next = prev.then(fn, fn).catch((err) => {
      console.error(`turn failed (chat ${chatID}): ${(err as Error)?.message ?? err}`)
    })
    this.#turns.set(chatID, next)
    // drop the entry once it's the last one, so idle chats don't accumulate
    void next.then(() => {
      if (this.#turns.get(chatID) === next) this.#turns.delete(chatID)
    })
  }

  /** wait for every queued turn to finish — used by mock mode before exit */
  async drain(): Promise<void> {
    while (this.#turns.size) await Promise.all([...this.#turns.values()])
  }

  // best-effort turn cancellation, shared by the native stop button, /abort,
  // and the "⏹ Stop" callback. Always tries the harness-side abort by a
  // freshly-resolved session id — c.inflight (and c.sessionID) live only in
  // memory, so a bot restart mid-turn loses both, but the harness keeps
  // running server-side; gating on c.inflight alone would make Stop a no-op
  // exactly then, i.e. it'd look stopped client-side while still running.
  // Returns whether there was anything to stop.
  async #stopTurn(chatID: number): Promise<boolean> {
    const c = this.#chat(chatID)
    const inflight = c.inflight
    // Local abort FIRST. It is synchronous, so the turn's prompt() rejects
    // immediately and its "(stopped)" message starts rendering right away.
    // This used to run last, behind resolveSessionID and the harness abort —
    // two round trips — so the draft vanished the instant you tapped stop and
    // the reply only landed seconds later, leaving a gap with nothing in it.
    let stopped = false
    if (inflight) {
      inflight.abort()
      c.inflight = null
      stopped = true
    }
    // The harness-side abort still matters and still has to happen: a restart
    // loses c.inflight entirely, and the server keeps generating regardless of
    // what the client thinks. It just no longer gates the user-visible part.
    const sessionID = await this.#resolveSessionID(chatID)
    if (sessionID) {
      try {
        stopped = (await this.#activeWs(chatID).adapter.abort(sessionID)) || stopped
      } catch (err) {
        // usually just "the turn already ended" — but if Stop is reported as
        // not having stopped anything, this line is the reason why
        console.error(`[stop] harness abort failed (session ${sessionID}): ${(err as Error)?.message ?? err}`)
      }
    }
    return stopped
  }

  // the user tapped the native "stop" button on a streaming draft — stop the turn
  async #onStopGeneration(stop: NonNullable<TgUpdate["stopped_message_generation"]>): Promise<void> {
    const chatID = stop?.chat?.id
    if (chatID == null) return
    await this.#stopTurn(chatID)
  }

  async #gatedMessage(m: TgMessage): Promise<void> {
    const chatID = m.chat.id
    const text = (m.text ?? m.caption ?? "").trim()
    const mediaFileID = this.#mediaFileID(m)
    // an animated sticker with no thumbnail has nothing to download, but its
    // emoji is still a message — don't drop it as empty
    if (!text && !mediaFileID && !m.sticker) return
    const c = this.#chat(chatID)
    const [cmd, ...rest] = text.split(/\s+/)

    if (!this.#pairing.isPaired(chatID)) {
      if (c.awaiting?.kind === "pair") {
        if (cmd === "/cancel") {
          c.awaiting = null
          return this.#tg.sendMessage({ chatID, text: "canceled." })
        }
        if (!text.startsWith("/")) return this.#attemptPair(chatID, text)
      }
      if (cmd === "/pair") {
        const code = rest.join(" ")
        if (!code) {
          c.awaiting = { kind: "pair" }
          return this.#tg.sendMessage({
            chatID,
            text: "🔐 Please enter the pairing code.\n\nJust paste the code and hit send (/cancel to give up).",
            replyMarkup: { inline_keyboard: [], force_reply: true },
          })
        }
        return this.#attemptPair(chatID, code)
      }
      if (cmd === "start") {
        return this.#tg.sendMessage({
          chatID,
          text: "This bot is locked. Tap /pair, then enter the code to authorize this chat.",
        })
      }
      return this.#tg.sendMessage({ chatID, text: "🔒 Not paired. Tap /pair and enter the code." })
    }

    console.error(`[tg] message from chat=${chatID} (${m.chat.type}) from=${m.from?.username ?? m.from?.id ?? "?"}`)
    c.chatType = m.chat.type
    if (m.from?.id != null) c.lastUserID = m.from.id
    if (text.startsWith("/")) {
      if (cmd === "/cancel") {
        if (c.awaiting) {
          c.awaiting = null
          return this.#tg.sendMessage({ chatID, text: "canceled." })
        }
        return this.#tg.sendMessage({ chatID, text: "(nothing to cancel)" })
      }
      if (c.awaiting) c.awaiting = null
      await this.#command(chatID, cmd.slice(1), rest.join(" "), m.message_id)
    } else if (c.awaiting) {
      await this.#resolveAwaiting(chatID, text)
    } else {
      let filePaths: string[] | undefined
      if (mediaFileID) {
        try {
          filePaths = [await this.#ingestMedia(chatID, m)]
        } catch (err) {
          await this.#tg.sendMessage({ chatID, text: `⚠️ couldn't read the attachment: ${(err as Error).message}` })
        }
      }
      // a sticker on its own carries no text, so say what it was — the image
      // alone doesn't tell the model it's a sticker or which emoji it stands for
      const prompt = text || (m.sticker ? stickerPrompt(m.sticker) : text)
      this.#runTurn(chatID, async () => {
        await this.#freeText(chatID, prompt, { filePaths })
        if (mediaFileID) await this.#suggestImageModel(chatID)
      })
    }
  }

  #mediaFileID(m: TgMessage): string | null {
    if (m.photo?.length) return m.photo[m.photo.length - 1]!.file_id // biggest variant
    if (m.document?.file_id) return m.document.file_id
    if (m.sticker) {
      // a static sticker is just a .webp image. Animated (.tgs Lottie) and
      // video (.webm) ones aren't images a model can read, so fall back to
      // their static thumbnail — and if there's none, the emoji in the
      // synthesized prompt still carries what the sticker meant.
      const s = m.sticker
      if (!s.is_animated && !s.is_video) return s.file_id
      return s.thumbnail?.file_id ?? null
    }
    return null
  }

  // download a message's attachment into the uploads dir so the harness can
  // read it as a file part (absolute path).
  async #ingestMedia(chatID: number, m: TgMessage): Promise<string> {
    const fileID = this.#mediaFileID(m)
    if (!fileID) throw new Error("no attachment")
    const docName = m.document?.file_name
    const docMime = m.document?.mime_type
    const bytes = await this.#tg.getFileContent(fileID)
    const ext =
      docName?.slice(docName.lastIndexOf(".")).toLowerCase() || imageExt(docMime) || sniffImageExt(bytes) || ".jpg"
    const name = `upl-${chatID}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
    await mkdir(this.#uploadsDir, { recursive: true })
    const filePath = join(this.#uploadsDir, name)
    await writeFile(filePath, bytes)
    return filePath
  }

  async #gatedCallback(cq: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
    if (!cq.message) return this.#tg.answerCallbackQuery({ id: cq.id })
    const chatID = cq.message.chat.id
    if (!this.#pairing.isPaired(chatID)) return this.#tg.answerCallbackQuery({ id: cq.id, text: "not paired" })
    await this.#onCallback(cq)
  }

  async #attemptPair(chatID: number, code: string): Promise<void> {
    const res = this.#pairing.attempt(chatID, code.trim())
    if (res.status === "blocked") {
      const when = res.retryIn >= 60 ? `${Math.ceil(res.retryIn / 60)} min` : `~${res.retryIn}s`
      return this.#tg.sendMessage({ chatID, text: `🛑 Too many wrong codes. Try again in ${when}.` })
    }
    this.#chat(chatID).awaiting = null
    if (res.status === "bad") {
      if (res.rotated) {
        console.error(`[pair] code rotated after repeated failures. new code: ${this.#pairing.code}`)
        const owner = this.#pairing.owner
        if (owner !== null) {
          await this.#tg.sendMessage({ chatID: owner, text: `🔐 Pairing code was rotated: ${this.#pairing.code}` })
        }
      }
      return this.#tg.sendMessage({ chatID, text: "✗ Wrong pairing code." })
    }
    if (res.pairing === "owner")
      return this.#tg.sendMessage({ chatID, text: "🔐 Paired. You are the **owner** — the bot is now locked to you." })
    return this.#tg.sendMessage({ chatID, text: "🔐 Paired. Welcome — you can use the agent now." })
  }

  async #resolveAwaiting(chatID: number, text: string): Promise<void> {
    const a = this.#chat(chatID).awaiting
    // nothing was actually awaited — treat it as an ordinary prompt, queued
    // like any other so it can't block the update loop either
    if (!a) return this.#runTurn(chatID, () => this.#freeText(chatID, text))
    this.#chat(chatID).awaiting = null
    if (a.kind === "pair") return this.#attemptPair(chatID, text)
    if (a.kind === "use") return this.#resolveUse(chatID, text)
    if (a.kind === "newfolder") return this.#resolveNewFolder(chatID, a.dir, text)
    if (a.kind === "clone") return this.#resolveClone(chatID, a.dir, text)
    const t = text.trim()
    this.#store.setTitle(a.sessionID, t)
    // started from the conversation list — put the (now relabelled) list back
    // rather than leaving a bare confirmation and no way onward
    if (a.backTo !== undefined) {
      await this.#listPicker(chatID, "Conversations:", false, { messageID: a.backTo })
      return
    }
    await this.#tg.sendMessage({ chatID, text: `✏️ renamed to "${this.#store.title(a.sessionID) ?? t}"` })
  }

  // Creates <parent>/<name>, gives it a git repo (opencode's project unit is
  // the worktree, so a bare folder makes a degenerate one) and serves it.
  async #resolveNewFolder(chatID: number, parent: string, name: string): Promise<void> {
    const clean = name.trim().replace(/^\/+|\/+$/g, "")
    if (!clean || clean.includes("/") || clean.startsWith(".")) {
      await this.#tg.sendMessage({ chatID, text: "⚠️ that's not a usable folder name — try again from ➕ Add project" })
      return
    }
    const dir = join(parent, clean)
    if (existsSync(dir)) {
      await this.#tg.sendMessage({ chatID, text: `⚠️ ${fmtHome(dir)} already exists` })
      return
    }
    const sent = await this.#tg.sendMessage({ chatID, text: `📁 creating ${fmtHome(dir)}…` })
    try {
      await mkdir(dir, { recursive: true })
      await execFileAsync("git", ["init", "-q"], { cwd: dir })
    } catch (err) {
      await this.#tg.editMessageText({
        chatID,
        messageID: sent.message_id,
        text: `⚠️ couldn't create it: ${((err as Error)?.message ?? String(err)).slice(0, 300)}`,
      })
      return
    }
    await this.#addWorkspace(chatID, dir, sent.message_id)
  }

  // git clone into the browsed folder, then serve the result. Cloning is slow
  // and entirely outside our control, so it runs on the chat's turn queue —
  // the update loop (and Stop) stays live while it works.
  async #resolveClone(chatID: number, parent: string, url: string): Promise<void> {
    const src = url.trim()
    if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(src)) {
      await this.#tg.sendMessage({ chatID, text: "⚠️ that doesn't look like a repo URL — try again from ➕ Add project" })
      return
    }
    const name = (src.split("/").pop() ?? "").replace(/\.git$/, "")
    if (!name) {
      await this.#tg.sendMessage({ chatID, text: "⚠️ couldn't work out a folder name from that URL" })
      return
    }
    const dir = join(parent, name)
    if (existsSync(dir)) {
      await this.#tg.sendMessage({ chatID, text: `⚠️ ${fmtHome(dir)} already exists` })
      return
    }
    const sent = await this.#tg.sendMessage({ chatID, text: `⬇︎ cloning ${name}…` })
    this.#runTurn(chatID, async () => {
      try {
        await execFileAsync("git", ["clone", "--depth", "1", src, dir], { timeout: CLONE_TIMEOUT_MS })
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err)
        await this.#tg.editMessageText({ chatID, messageID: sent.message_id, text: `⚠️ clone failed: ${msg.slice(0, 300)}` })
        return
      }
      await this.#addWorkspace(chatID, dir, sent.message_id)
    })
  }

  async #resolveUse(chatID: number, term: string): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#activeWs(chatID)
    const list = await ws.adapter.listSessions()
    const byTitle = list.find((s) => this.#displayTitle(s.id, s.title).toLowerCase().includes(term.toLowerCase()))
    const exact = byTitle ?? (term.includes("://") ? await ws.adapter.getSession(term) : null)
    if (!exact) {
      await this.#tg.sendMessage({ chatID, text: "no conversation found — try /ls" })
      return
    }
    c.sessionID = exact.id
    this.#rememberChat(chatID)
    await this.#tg.sendMessage({ chatID, text: `▶ "${this.#displayTitle(exact.id, exact.title)}"` })
    void this.#updateStatus(chatID).catch(logFail("status"))
  }

  async #command(chatID: number, cmd: string, arg: string, messageID: number): Promise<void> {
    const tg = this.#tg
    const c = this.#chat(chatID)
    const ws = this.#activeWs(chatID)
    switch (cmd) {
      case "start":
      case "help":
        await tg.sendMessage({ chatID, text: HELP })
        break
      case "new":
        await this.#newConversation(chatID, null, arg)
        break
      case "settings":
        await this.#settingsRoot(chatID, null)
        break
      case "ls": {
        await this.#listPicker(chatID, "Conversations:", false, undefined, messageID)
        break
      }
      case "log": {
        const sessionID = await this.#ensureSession(chatID)
        const msgs = await ws.adapter.messages(sessionID)
        if (!msgs.length) {
          await tg.sendMessage({ chatID, text: "(empty — send a message to start)" })
          return
        }
        // Just the conversation: who said what. Reasoning, tool calls and
        // snapshots are working notes, and reading them back is not what a
        // transcript is for — they turned /log into a wall you had to scan
        // past to find the actual exchange.
        const text = msgs
          .map((m) => {
            const said = m.parts
              .filter((p): p is TextPart => p.kind === "text")
              .map((p) => stripInjectedContext(p.text).trim())
              .filter(Boolean)
              .join("\n")
            // an assistant turn that was only tool calls has nothing to show
            return said ? `${m.role === "user" ? "👤" : "🤖"} ${said}` : ""
          })
          .filter(Boolean)
          .join("\n\n")
        if (!text) {
          await tg.sendMessage({ chatID, text: "(nothing said yet — only tool activity so far)" })
          return
        }
        const body = text.length > MAX_MSG ? text.slice(-MAX_MSG) : text
        // 10.3 expandable blockquote: the history folds away until tapped
        try {
          await tg.sendRichMessage({
            chatID,
            rich_message: {
              blocks: [
                { type: "heading", size: 1, text: "📜 Conversation history" },
                { type: "expandable_blockquote", text: body },
              ],
            },
          })
          break
        } catch (err) {
          console.error(`[history] rich send failed, falling back to text: ${(err as Error)?.message ?? err}`)
        }
        await tg.sendMessage({ chatID, text: body })
        break
      }
      case "diff": {
        const sessionID = await this.#ensureSession(chatID)
        const diff = (await ws.adapter.diff?.(sessionID)) ?? []
        if (!diff.length) {
          await tg.sendMessage({ chatID, text: "(no file changes yet)" })
          break
        }
        const body = mdTable(
          ["File", "+", "-"],
          diff.map((f) => [f.file, `+${f.additions}`, `-${f.deletions}`]),
        )
        const blocks = mdToRich(body)
        if (blocks.length) {
          try {
            await tg.sendRichMessage({ chatID, rich_message: { blocks } })
            break
          } catch (err) {
            console.error(`[history] rich send failed, falling back to text: ${(err as Error)?.message ?? err}`)
          }
        }
        await tg.sendMessage({ chatID, text: body })
        break
      }
      case "use": {
        if (!arg) {
          c.awaiting = { kind: "use" }
          await this.#listPicker(chatID, "Which conversation? (tap one, or type a title / paste an ID · /cancel to stop)", true, undefined, messageID)
          break
        }
        await this.#resolveUse(chatID, arg)
        break
      }
      case "abort": {
        const stopped = await this.#stopTurn(chatID)
        await tg.sendMessage({ chatID, text: stopped ? "⏹ stopped" : "(no turn in flight)" })
        break
      }
      case "ws": {
        const names = this.#workspaces.map((w) => w.name)
        if (arg) {
          if (!names.includes(arg)) return tg.sendMessage({ chatID, text: `no workspace '${arg}'` })
          c.workspace = arg
          c.sessionID = null
          c.freshOnNext = false
          this.#rememberChat(chatID)
          c.picker = null
          c.del = null
          c.page = 0
          await tg.sendMessage({ chatID, text: `workspace: ${arg}` })
          void this.#updateStatus(chatID).catch(logFail("status"))
          break
        }
        await this.#settingsWorkspace(chatID, null)
        break
      }
      case "ver": {
        await tg.sendMessage({ chatID, text: "running compliance suite…" })
        const rows = await runComplianceSuite(ws.adapter)
        await tg.sendMessage({
          chatID,
          text: rows.map((r) => `  ${r.ok === true ? "✓" : r.ok === "manual" ? "~" : "✗"} ${r.method}`).join("\n"),
        })
        break
      }
      case "pair": {
        if (this.#pairing.isPaired(chatID))
          return tg.sendMessage({ chatID, text: "already paired: share the code from /pair_status to authorize someone else." })
        await this.#attemptPair(chatID, arg)
        break
      }
      case "pair_status":
      case "pair-status": {
        const owner = this.#pairing.owner
        await tg.sendMessage({
          chatID,
          text: `owner: ${owner ?? "(none)"}\npaired chats: ${this.#pairing.count()}\ncode: ${this.#pairing.code}${owner === chatID ? "  (you)" : ""}`,
        })
        break
      }
      case "remind": {
        const spec = parseRemind(arg)
        if (!spec) {
          await tg.sendMessage({
            chatID,
            text: "⏰ usage: /remind <5s–7d> <what>\ne.g. /remind 2h check the build\nrecurring: /remind every 1h check the build",
          })
          break
        }
        const r = this.#reminderStore.add(chatID, spec.what, Date.now() + spec.ms, spec.every ? spec.ms : undefined)
        this.#scheduleReminder(r)
        await tg.sendMessage({
          chatID,
          text: spec.every
            ? `⏰ ok — every ${fmtDuration(spec.ms)}, starting in ${fmtDuration(spec.ms)}.`
            : `⏰ ok — reminder in ${fmtDuration(spec.ms)}.`,
        })
        break
      }
      default:
        await tg.sendMessage({ chatID, text: `unknown command /${cmd} (try /help)` })
    }
  }

  // create a fresh conversation in whatever this chat is pointed at. The
  // harness is chosen in Settings › 🔌 Harness and resolved together with the
  // directory — picking it by harness id alone used to be enough, but a
  // harness can now serve several workspaces, so that would have landed the
  // new conversation in whichever directory happened to match first.
  async #newConversation(chatID: number, replyId: number | null, title?: string): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#activeWs(chatID)
    c.harness = ws.adapter.id
    const s = await ws.adapter.createSession(title || "New conversation")
    c.sessionID = s.id
    c.sessionFresh = true
    c.picker = null
    c.del = null
    c.page = 0
    this.#rememberChat(chatID)
    const text = title ? `💬 new conversation: ${title}` : "💬 new conversation"
    if (replyId === null) await this.#tg.sendMessage({ chatID, text })
    else await this.#tg.editMessageText({ chatID, messageID: replyId, text, replyMarkup: null })
    void this.#updateStatus(chatID).catch(logFail("status"))
  }

  // list sessions as tappable title buttons; callback snapshots into c.picker
  // each row: the conversation (tap to switch) + a small 🗑 next to it (tap
  // for a delete confirmation, via the existing deld/dely/deln flow) — one
  // view does both jobs, so there's no separate delete-only picker anymore.
  async #listPicker(
    chatID: number,
    caption: string,
    forceReply = false,
    edit?: { messageID: number },
    cmdMessageID?: number,
  ): Promise<void> {
    const c = this.#chat(chatID)
    // preserve the originating /ls or /use command message across a refresh
    // (e.g. after a delete) so "‹ Back" can still clean it up later
    const cmdID = cmdMessageID ?? (edit ? c.picker?.cmdMessageID : undefined)
    // a fresh /ls starts at the top; an in-place redraw (paging, or the
    // refresh after a delete) keeps the page you are on
    if (!edit) c.page = 0
    // resolved (not raw c.sessionID) so the active row still highlights right
    // after a bot restart, before the in-memory pointer is re-derived
    const currentSessionID = await this.#resolveSessionID(chatID)
    // Spans every project the harness knows about, not just the active one,
    // but without starting a server for each just to read a list — that used
    // to leave one idle `opencode serve` per project behind every /ls.
    // Workspaces already running are listed live (and their listing cached);
    // the rest come from that cache, and only materialize a server when a row
    // is actually opened.
    const live = await Promise.all(
      this.#workspaces.map(async (w) => {
        try {
          const list = await w.adapter.listSessions()
          this.#store.setIndexedSessions(
            w.dir,
            w.adapter.id,
            list.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt })),
          )
          return list.map((s) => ({ s, ws: w.name, dir: w.dir }))
        } catch (err) {
          console.error(`[ls] ${w.name} unreadable: ${(err as Error)?.message ?? err}`)
          return []
        }
      }),
    )
    const liveDirs = new Set(this.#workspaces.map((w) => w.dir))
    const harnessIDs = [...new Set(this.#workspaces.map((w) => w.adapter.id))]
    const cold = (await this.#knownProjectDirs())
      .filter((dir) => !liveDirs.has(dir))
      .flatMap((dir) =>
        harnessIDs.flatMap((h) =>
          this.#store.indexedSessions(dir, h).map((s) => ({
            s: { id: s.id, title: s.title, updatedAt: s.updatedAt, createdAt: s.updatedAt, workspace: dir },
            ws: fmtWsPath(dir),
            dir,
          })),
        ),
      )
    const entries = [...live.flat(), ...cold]
    if (!entries.length) {
      const text = "(no conversations yet — just send a message)"
      if (edit) await this.#tg.editMessageText({ chatID, messageID: edit.messageID, text, replyMarkup: null })
      else await this.#tg.sendMessage({ chatID, text })
      c.picker = null
      return
    }
    const sorted = entries.sort((a, b) => b.s.updatedAt - a.s.updatedAt)
    // paged rather than truncated: a codex workspace can hold hundreds of
    // threads, and "… and 85 more" made every one of them unreachable
    const pages = Math.max(1, Math.ceil(sorted.length / MAX_LIST))
    const page = Math.min(Math.max(c.page, 0), pages - 1)
    c.page = page
    const shown = sorted.slice(page * MAX_LIST, page * MAX_LIST + MAX_LIST)
    // a row from a workspace other than the active one gets tagged with its
    // origin, since the list can now span several projects at once.
    // The harness is part of a row's identity, not decoration: the same
    // directory can hold an opencode and a codex conversation with similar
    // titles, and opening the wrong one starts a thread the other can't read.
    // Icon only — the names are in Settings, and a row has no width to spare.
    const icon = (sessionID: string): string => {
      const id = this.#harnessOf(sessionID)
      const known = id ? this.#harnessList.find((h) => h.id === id) : undefined
      return known ? `${known.icon} ` : ""
    }
    const label = ({ s, ws }: (typeof shown)[number]) => {
      const age = timeAgo(s.updatedAt)
      return `${icon(s.id)}${clipTitle(this.#displayTitle(s.id, s.title))}${ws !== c.workspace ? ` · ${ws}` : ""}${age ? ` (${age})` : ""}`
    }
    // 🗑 first (left of the title, not right) reads as "here's the destructive
    // action, then the thing it acts on" and lines up under itself row to row.
    // The active conversation is green (same style Settings uses), not a
    // marker glued onto the label.
    const rows: InlineButton[][] = shown.map((entry, i) => {
      const openBtn = btn(`${i + 1}. ${label(entry)}`, `open:${i}`)
      if (entry.s.id === currentSessionID && entry.ws === c.workspace) openBtn.style = "success"
      return [{ ...btn("🗑", `deld:${i}`), style: "danger" as const }, openBtn]
    })
    // One rename button for the conversation you're in, rather than one per
    // row: renaming is something you do to where you already are, and a third
    // button on every row crowded the list for an action used far less than
    // opening or deleting. "‹ Back" dismisses the picker entirely (deletes the
    // message, not just its keyboard) — the way out without typing /cancel.
    if (pages > 1) {
      const prev = btn("‹ Prev", "lsp:prev")
      const next = btn("Next ›", "lsp:next")
      if (page <= 0) prev.disabled = true
      if (page >= pages - 1) next.disabled = true
      rows.push([prev, btn(`page ${page + 1} / ${pages}`, "lsp:page"), next])
    }
    rows.push([btn("‹ Back", "lsb"), ...(currentSessionID ? [btn("✏️ Rename current", "renc")] : [])])
    const more = pages > 1 ? [`${sorted.length} conversations`] : []

    let messageID: number | undefined
    if (forceReply) {
      // force_reply only exists on the classic keyboard — rich message
      // buttons (below) can't carry it, so /use's "type or tap" prompt keeps
      // the classic, evenly-split row. It also needs the text list (unlike
      // the button-only paths below): forceReply means typing is expected,
      // and there's nothing to read a title off of while composing a reply.
      const list = shown.map((entry, i) => `${i + 1}. "${label(entry)}"${entry.s.id === currentSessionID && entry.ws === c.workspace ? "  ◀" : ""}`)
      const markup = kin(rows)
      markup.force_reply = true
      const msg = await this.#tg.sendMessage({ chatID, text: [caption, "", ...list, ...more].join("\n"), replyMarkup: markup })
      messageID = msg.message_id
    } else {
      // rich message buttons (same format #menu uses for Settings) size each
      // button to its own label instead of splitting the row evenly, so the
      // 🗑 actually reads as smaller than the conversation button next to it.
      // No separate text list — the buttons already say what they need to.
      const result = await this.#menu(chatID, [caption, ...more], rows, edit)
      messageID = edit ? edit.messageID : result.messageID
    }
    if (messageID === undefined) return
    // dir travels with each row so a cold project's conversation can still be
    // opened — its workspace is started on demand at that point, not now
    c.picker = { messageID, sessions: shown.map(({ s, ws, dir }) => ({ id: s.id, ws, dir })), ...(cmdID !== undefined ? { cmdMessageID: cmdID } : {}) }
    c.del = null
  }

  async #freeText(chatID: number, text: string, opts?: { filePaths?: string[] }): Promise<void> {
    const c = this.#chat(chatID)
    const promptText = text || (opts?.filePaths?.length ? "see the attached file" : "")
    const internals = this.#store.internals(chatID)

    const ac = new AbortController()
    c.inflight = ac

    // The spinner goes out BEFORE any harness work. #ensureSession below can
    // list sessions and create one — two round trips to opencode — and while
    // that ran there was nothing on screen at all: no draft, not even the
    // typing dots. With thinking and tools set to "off" nothing else fills
    // that gap either, so a message just sat there looking ignored.
    // Streaming draft: prefer a RICH draft (Bot API 10.1+ — tables, code and the
    // collapsible thinking/tool details render live) with a native stop button;
    // fall back to a plain-text draft, then the legacy placeholder.
    // persisted, so it keeps climbing across restarts — a draft id is consumed
    // once the real message lands, and reusing one is accepted by Telegram but
    // renders nothing at all
    const draftID = this.#store.nextDraftID(chatID)
    c.draft = draftID
    let draftMode: "rich" | "text" | "none" = "none"
    try {
      // RichBlockThinking (Bot API 10.2, <tg-thinking> in HTML): a native,
      // client-animated "Thinking…" placeholder valid only in draft messages.
      await this.#tg.sendRichMessageDraft({
        chatID,
        draftID,
        rich_message: { blocks: [{ type: "thinking", text: "Thinking…" }] },
        canStop: true,
      })
      draftMode = "rich"
    } catch (err) {
      console.error(`[draft] rich failed: ${(err as Error)?.message ?? err}`)
      try {
        await this.#tg.sendMessageDraft({ chatID, draftID, text: "", canStop: true })
        draftMode = "text"
      } catch (err2) {
        console.error(`[draft] text failed too: ${(err2 as Error)?.message ?? err2}`)
        /* draft streaming unsupported → legacy edit-in-place below */
      }
    }
    console.error(`[draft] mode=${draftMode} chat=${chatID}`)
    let placeholder: { message_id: number } | null = null
    if (draftMode === "none") {
      placeholder = await this.#tg.sendMessage({ chatID, text: "…", replyMarkup: kin([[btn("⏹ Stop", "abt")]]) })
    }
    // Telegram clears the native "typing…" indicator after ~5s, so re-ping it
    // for the whole generation — it's the only *animated* signal we have; the
    // draft/placeholder content only updates every 700ms and sits still
    // in between (worse, dead still before the first part arrives).
    await this.#tg.sendChatAction({ chatID, action: "typing" })
    const typingTimer = setInterval(() => {
      // the one deliberate exception to logFail: this re-fires every 4s for
      // the whole turn, so a logged failure here would be a flood, and it is
      // purely the typing animation — nothing depends on it
      this.#tg.sendChatAction({ chatID, action: "typing" }).catch(() => {})
    }, 4000)

    // now that something is on screen, do the work that needs the harness
    let sessionID: string
    let ws: Ws
    let harnessText: string
    try {
      sessionID = await this.#ensureSession(chatID, promptText)
      ws = this.#activeWs(chatID)
      const injectContext = c.sessionFresh && this.#store.injectContext(chatID)
      harnessText = injectContext ? `${JEP_CONTEXT}\n${JEP_TELEGRAM_CONTEXT}\n\n${JEP_CONTEXT_FOOTER}\n\n${promptText}` : promptText
      c.sessionFresh = false
    } catch (err) {
      clearInterval(typingTimer)
      c.inflight = null
      const msg = `⚠️ couldn't start the conversation: ${(err as Error)?.message ?? err}`
      console.error(`[turn] ensureSession failed: ${(err as Error)?.stack ?? err}`)
      if (placeholder) await this.#tg.editMessageText({ chatID, messageID: placeholder.message_id, text: msg, replyMarkup: null })
      else await this.#tg.sendMessage({ chatID, text: msg })
      return
    }

    const mdl = this.#store.model(chatID, ws.adapter.id)
    let model
    if (mdl) {
      const sep = mdl.indexOf("/")
      model = { providerID: mdl.slice(0, sep), modelID: mdl.slice(sep + 1) }
    }
    const agent = this.#store.agent(chatID)

    const sub = new AbortController()
    // activity watchdog: every event on this session pushes the deadline out,
    // so a turn only dies if it has genuinely stalled (see TURN_IDLE_MS)
    let lastActivity = Date.now()
    let idleAbort = false
    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivity < TURN_IDLE_MS) return
      idleAbort = true
      ac.abort()
    }, 15_000)
    let lastEdit = 0
    let lastText: string | null = null
    let lastHadMarkup = true
    let lastRich = ""
    // Set the moment the turn stops being live. The event stream outlives the
    // prompt() call — it is only torn down in the finally — so without this a
    // late event could re-post the draft *after* the final message had already
    // been sent, showing up as a duplicate with the still-generating spinner
    // stuck on the end of it.
    let finished = false
    // parts assembled live from the event stream, keyed by partID so updates
    // replace rather than duplicate; mirrors the final `reply.parts` order
    const liveParts: Part[] = []
    const liveIndex = new Map<string, number>()
    const upsert = (id: string, p: Part) => {
      const idx = liveIndex.get(id)
      if (idx !== undefined) liveParts[idx] = p
      else {
        liveIndex.set(id, liveParts.length)
        liveParts.push(p)
      }
    }
    const reasoningBuf = new Map<string, string>()
    // when we first saw each reasoning part — durationMs isn't known until
    // the harness finalizes the part, so this is the live estimate
    const reasoningStarted = new Map<string, number>()
    const textBuf = new Map<string, string>()
    // `message.part.updated` fires for the user's own message parts too — track
    // those message ids and skip them so the prompt never leaks into the draft
    const userMessages = new Set<string>()

    // tool calls and reasoning blocks already posted as their own permanent
    // message, tracked by their stable opencode part id. Expanding one of
    // those sticks, since nothing ever edits it again. Kept out of both the
    // live draft (buildLiveBlocks) and the final combined message
    // (dropFlushed below) so nothing shows twice. `turn`/`liveParts` are two
    // separately-derived arrays of the same turn (see below), so identity
    // has to survive across them — position doesn't.
    const flushedToolIDs = new Set<string>()
    const flushedReasoningIDs = new Set<string>()
    const flushTool = async (p: ToolCallPart) => {
      // minimal layout has nothing collapsible to protect — never splits cards out
      if (internals.tools === "off" || internals.layout === "minimal" || flushedToolIDs.has(p.id)) return
      flushedToolIDs.add(p.id)
      try {
        await this.#tg.sendRichMessage({ chatID, rich_message: { blocks: [toolBlock(p, internals.tools === "expanded")] } })
      } catch (err) {
        console.error(`[card] tool send failed: ${(err as Error)?.message ?? err}`)
      }
    }
    // a finished reasoning part has no explicit "done" event of its own, but
    // opencode's step-finish marker tells us the step (and its reasoning) is over
    const flushPendingReasoning = async () => {
      if (internals.thinking === "off" || internals.layout === "minimal") return
      for (const p of liveParts) {
        if (p.kind !== "reasoning" || !p.id || !p.text.trim() || flushedReasoningIDs.has(p.id)) continue
        flushedReasoningIDs.add(p.id)
        const started = reasoningStarted.get(p.id)
        const ms = p.durationMs ?? (started !== undefined ? Date.now() - started : undefined)
        try {
          await this.#tg.sendRichMessage({ chatID, rich_message: { blocks: [reasoningBlock(p.text, internals.thinking === "expanded", ms)] } })
        } catch (err) {
          console.error(`[card] reasoning send failed: ${(err as Error)?.message ?? err}`)
        }
      }
    }
    const dropFlushed = (parts: Part[]): Part[] =>
      parts.filter((p) => {
        if (p.kind === "tool") return !flushedToolIDs.has(p.id)
        if (p.kind === "reasoning") return !p.id || !flushedReasoningIDs.has(p.id)
        return true
      })

    // re-render the live draft from the parts collected so far (throttled by the
    // caller). Rich draft → blocks; text/placeholder → plain tail.
    const renderLive = async () => {
      // Building the blocks sits INSIDE the try. It used to run outside it, so
      // a fault here escaped renderLive, killed the stream event loop, and took
      // the rest of the turn's live output with it — invisibly. Rendering is
      // decoration: a failure must cost the animation, never the answer.
      if (finished) return // the final message is already out; nothing to preview
      try {
        const blocks = buildLiveBlocks(liveParts, internals, flushedToolIDs, reasoningStarted, true)
        const json = JSON.stringify(blocks)
        if (json === lastRich) return
        lastRich = json
        if (blocks.length === 0) return // nothing to show yet — keep the "…" frame
        const tail = textOf(liveParts).slice(-(MAX_MSG - 80))
        const hint = closeStreamingTable(tail)
        if (draftMode === "rich") await this.#tg.sendRichMessageDraft({ chatID, draftID, rich_message: { blocks } })
        else if (draftMode === "text") await this.#tg.sendMessageDraft({ chatID, draftID, text: hint })
        else if (placeholder) await this.#tg.editMessageText({ chatID, messageID: placeholder.message_id, text: hint || "…" })
      } catch (err) {
        console.error(`[draft] renderLive failed (mode=${draftMode}): ${(err as Error)?.stack ?? err}`)
      }
      lastEdit = Date.now()
    }

    const clearPlaceholder = async (body: string) => {
      if (!placeholder) return
      const text = body.slice(-MAX_MSG)
      if (text === lastText && !lastHadMarkup) return
      lastText = text
      lastHadMarkup = false
      await this.#tg.editMessageText({ chatID, messageID: placeholder.message_id, text, replyMarkup: null })
    }

    // persist a finished answer (plain body) as a real message. Used on abort
    // and as the last-resort path; the normal path is presentParts.
    const presentBody = async (body: string, media: FilePart[] = []) => {
      const files = media
        .filter((f): f is FilePart & { filePath: string } => !!f.filePath)
        .slice(0, MAX_RICH_FILES)
      const blocks = mdToRich(body)
      const attached: Array<{ name: string; filePath: string }> = []
      files.forEach((f, i) => {
        const name = `f${i}`
        attached.push({ name, filePath: f.filePath })
        const photo = IMAGE_RE.test(f.filePath)
        blocks.push(
          photo
            ? { type: "photo", photo: { type: "photo", media: `attach://${name}` } }
            : { type: "document", document: { type: "document", media: `attach://${name}` } },
        )
      })
      if (draftMode === "rich" && blocks.length) {
        try {
          await this.#tg.sendRichMessage({
            chatID,
            rich_message: { blocks },
            ...(attached.length ? { files: attached } : {}),
          })
          if (placeholder) await this.#tg.deleteMessage({ chatID, messageID: placeholder.message_id })
          lastText = body.slice(-MAX_MSG)
          lastHadMarkup = false
          return
        } catch (err) {
          console.error(`[reply] rich+files send failed, falling back to text: ${(err as Error)?.message ?? err}`)
        }
      }
      if (body.trim()) {
        if (placeholder) await clearPlaceholder(body)
        else await this.#tg.sendMessage({ chatID, text: body.slice(-MAX_MSG) })
      } else if (placeholder) {
        await this.#tg.deleteMessage({ chatID, messageID: placeholder.message_id })
      }
      for (const f of media) await this.#sendPartFile(chatID, f)
    }

    // Structured render of a finished turn: thinking + tool calls become
    // collapsible `details` blocks per the chat's Internals settings; produced
    // files ride along as attach:// blocks. Falls back to markdown. Returns true
    // when something was shown.
    const presentParts = async (parts: Part[], s: InternalsSettings): Promise<boolean> => {
      const media = parts.filter((p): p is FilePart => p.kind === "file")
      const blocks = buildRich(parts, s)
      const attached: Array<{ name: string; filePath: string }> = []
      media
        .filter((f): f is FilePart & { filePath: string } => !!f.filePath)
        .slice(0, MAX_RICH_FILES)
        .forEach((f, i) => {
          const name = `f${i}`
          attached.push({ name, filePath: f.filePath })
          const photo = IMAGE_RE.test(f.filePath)
          blocks.push(
            photo
              ? { type: "photo", photo: { type: "photo", media: `attach://${name}` } }
              : { type: "document", document: { type: "document", media: `attach://${name}` } },
          )
        })
      if (draftMode === "rich" && blocks.length) {
        try {
          await this.#tg.sendRichMessage({
            chatID,
            rich_message: { blocks },
            ...(attached.length ? { files: attached } : {}),
          })
          if (placeholder) await this.#tg.deleteMessage({ chatID, messageID: placeholder.message_id })
          lastText = textOf(parts).slice(-MAX_MSG)
          lastHadMarkup = false
          return true
        } catch (err) {
          console.error(`[reply] rich send failed, falling back to markdown: ${(err as Error)?.message ?? err}`)
        }
      }
      const md = partsToMarkdown(parts, s)
      if (md.trim()) {
        if (placeholder) await clearPlaceholder(md)
        else await this.#tg.sendMessage({ chatID, text: md.slice(-MAX_MSG) })
      } else if (placeholder) {
        await this.#tg.deleteMessage({ chatID, messageID: placeholder.message_id })
      }
      for (const f of media) await this.#sendPartFile(chatID, f)
      return blocks.length > 0 || !!md.trim()
    }

    const streamTask = (async () => {
      try {
        for await (const evt of ws.adapter.events(sub.signal)) {
          if (ac.signal.aborted) break
          if (evt.type === "message.created" || evt.type === "message.updated") {
            if (evt.role === "user" && evt.messageID) userMessages.add(evt.messageID)
            continue
          }
          if (evt.sessionID !== sessionID) continue
          lastActivity = Date.now() // this turn is alive — push the watchdog out
          if (userMessages.has(evt.messageID)) continue
          if (evt.type === "part.delta" && evt.text) {
            // reasoning deltas build the collapsible 💭 block but never the answer text
            if (evt.partType === "reasoning") {
              if (!reasoningStarted.has(evt.partID)) reasoningStarted.set(evt.partID, Date.now())
              reasoningBuf.set(evt.partID, (reasoningBuf.get(evt.partID) ?? "") + evt.text)
              upsert(evt.partID, { kind: "reasoning", text: reasoningBuf.get(evt.partID)!, id: evt.partID })
            } else {
              textBuf.set(evt.partID, (textBuf.get(evt.partID) ?? "") + evt.text)
              upsert(evt.partID, { kind: "text", text: textBuf.get(evt.partID)! })
            }
            if (Date.now() - lastEdit > 700) await renderLive()
          } else if (evt.type === "part.updated" && evt.part) {
            upsert(evt.partID, evt.part)
            if (evt.part.kind === "reasoning" && !reasoningStarted.has(evt.partID)) reasoningStarted.set(evt.partID, Date.now())
            let settled = false
            if (evt.part.kind === "tool" && (evt.part.status === "completed" || evt.part.status === "error")) {
              await flushTool(evt.part)
              settled = true
            } else if (evt.part.kind === "other" && evt.part.nativeType === "step-finish") {
              await flushPendingReasoning()
              settled = true
            }
            // a card just left the draft for its own permanent message — redraw
            // now so it doesn't linger as a flat status line until the next tick
            if (settled || Date.now() - lastEdit > 700) await renderLive()
          } else if (evt.type === "permission.requested") {
            await this.#permissionPrompt(chatID, sessionID, evt.permissionID)
          }
        }
      } catch (err) {
        // Expected on abort (sub.abort() in the finally below). Anything else
        // is a real fault in the streaming path — a bug here used to vanish
        // without trace and take the whole turn's live output with it.
        if (!sub.signal.aborted) {
          console.error(`[stream] event loop died (session ${sessionID}): ${(err as Error)?.stack ?? err}`)
        }
      }
    })()

    try {
      const reply = await ws.adapter.prompt(sessionID, harnessText, {
        signal: ac.signal,
        // no absolute deadline — the idle watchdog above owns liveness now
        timeoutMs: 0,
        ...(model ? { model } : {}),
        ...(opts?.filePaths?.length ? { filePaths: opts.filePaths } : {}),
        ...(agent ? { agent } : {}),
      })
      // the turn is over: no more live previews, and stop pulling events
      finished = true
      sub.abort()
      // prompt() only returns the LAST step of a turn; pull every assistant part
      // since the user's message so earlier steps' reasoning + tool calls show.
      let turn = reply.parts
      // the harness reports a failed turn on the message, not as a failed
      // request, so this is the only place a refusal ever surfaces
      let failure = reply.error ?? null
      try {
        const all = await ws.adapter.messages(sessionID)
        const lastUser = all.reduce((idx, m, i) => (m.role === "user" ? i : idx), -1)
        if (lastUser >= 0 && lastUser < all.length - 1) {
          const after = all.slice(lastUser + 1)
          turn = after.flatMap((m) => m.parts)
          failure = after.find((m) => m.error)?.error ?? failure
        }
      } catch (err) {
        console.error(`[turn] couldn't re-read messages, using the returned one: ${(err as Error)?.message ?? err}`)
      }
      const media = turn.filter((p): p is FilePart => p.kind === "file")
      // tool/reasoning parts already posted as their own message during
      // streaming stay out of the final combined message (dropFlushed)
      const shown = await presentParts(dropFlushed(turn), internals)
      if (!shown && textOf(turn).trim()) await presentBody(textOf(turn), media)
      else if (!shown && placeholder) await this.#tg.deleteMessage({ chatID, messageID: placeholder.message_id })
      // A turn must never end silently. An error the harness reported gets
      // said out loud even when there was also content, and a turn that
      // produced nothing at all still gets a reply rather than leaving the
      // draft spinning forever.
      if (failure && isAbort(failure, ac)) {
        // You asked it to stop and it stopped — that's the feature working.
        // The harness still reports the stop as a message-level error, and it
        // arrives here rather than as a rejected prompt whenever the
        // harness-side abort finalizes the turn before the client's own
        // AbortController lands. Treat it as the outcome it is.
        if (!shown && !textOf(turn).trim()) await presentBody("(stopped)")
      } else if (failure) {
        console.error(`[turn] harness error: ${failure.name}: ${failure.message}`)
        await this.#tg.sendMessage({ chatID, text: `⚠️ ${failure.name}: ${failure.message}`.slice(0, MAX_MSG) })
      } else if (!shown && !textOf(turn).trim()) {
        console.error(`[turn] empty reply with no error (session ${sessionID})`)
        await this.#tg.sendMessage({ chatID, text: "⚠️ the model returned nothing (no text, no error)" })
      }
      void this.#updateStatus(chatID).catch(logFail("status"))
    } catch (err) {
      // same here: stopping mid-stream must not leave the draft racing the
      // message that replaces it
      finished = true
      sub.abort()
      if (ac.signal.aborted) {
        // render whatever we streamed so far (partial details included)
        const shown = await presentParts(dropFlushed(liveParts), internals)
        // a stall is not a stop: say so, or it looks like the turn was
        // cancelled deliberately and the silence goes unexplained
        const stalled = `⚠️ no activity for ${Math.round(TURN_IDLE_MS / 60_000)}m — turn abandoned`
        if (!shown) await presentBody(idleAbort ? stalled : "(stopped)")
        else if (idleAbort) await this.#tg.sendMessage({ chatID, text: stalled })
      } else {
        const text = `⚠️ ${(err as Error).message}`.slice(-MAX_MSG)
        if (placeholder) {
          lastText = text
          lastHadMarkup = false
          await this.#tg.editMessageText({ chatID, messageID: placeholder.message_id, text, replyMarkup: null })
        } else {
          await this.#tg.sendMessage({ chatID, text })
        }
      }
    } finally {
      clearInterval(typingTimer)
      clearInterval(idleTimer)
      sub.abort()
      await streamTask.catch(logFail("stream"))
      c.inflight = null
    }
  }

  // one pinned, edited-in-place message per chat: workspace, model, agent,
  // and context usage — a live status line so you don't need /settings just
  // to see what you're pointed at. Best-effort: a failure here never breaks
  // the turn that triggered it (see the void .catch() call site).
  async #updateStatus(chatID: number): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#activeWs(chatID)
    const modelKey = this.#store.model(chatID, ws.adapter.id)
    const model = modelKey ?? "default"
    const agent = this.#store.agent(chatID) ?? "build"
    let tokensLine = "–"
    const sessionID = await this.#resolveSessionID(chatID)
    if (sessionID) {
      try {
        const msgs = await ws.adapter.messages(sessionID)
        const last = [...msgs].reverse().find((m) => m.tokens)
        if (last?.tokens) {
          const t = last.tokens
          const total = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
          const limit = modelKey ? (await ws.adapter.capabilities?.().catch(() => undefined))?.get(modelKey)?.contextLimit : undefined
          tokensLine = limit ? `${fmtCount(total)}/${fmtCount(limit)}` : fmtCount(total)
        }
      } catch (err) {
        console.error(`[status] diff read failed: ${(err as Error)?.message ?? err}`)
      }
    }
    // one line, one separator: what it's allowed to do, where, how full, on what
    const text = [agentIcon(agent), fmtWsPath(ws.dir), tokensLine, model].join(" · ")

    const existing = this.#store.statusMsg(chatID)
    if (existing) {
      try {
        await this.#tg.editMessageText({ chatID, messageID: existing, text })
        return
      } catch (err) {
        console.error(`[status] edit of pinned msg failed, re-pinning: ${(err as Error)?.message ?? err}`)
      }
    }
    try {
      const sent = await this.#tg.sendMessage({ chatID, text, disableNotification: true })
      this.#store.setStatusMsg(chatID, sent.message_id)
      await this.#tg.pinChatMessage({ chatID, messageID: sent.message_id, disableNotification: true })
    } catch (err) {
      console.error(`[status] pin failed: ${(err as Error)?.message ?? err}`)
    }
  }

  // ask the user to allow/deny a tool call. In groups the prompt is sent as an
  // ephemeral message (visible to the requester + bot only, Bot API 10.2+);
  // anywhere it doesn't apply it degrades to a normal message.
  async #permissionPrompt(chatID: number, sessionID: string, permissionID: string): Promise<void> {
    const c = this.#chat(chatID)
    const markup = kin([
      [btn("Allow", `allow:${permissionID}`)],
      [btn("Deny", `deny:${permissionID}`)],
    ])
    const isGroup = c.chatType === "group" || c.chatType === "supergroup"
    try {
      if (isGroup && c.lastUserID != null) {
        try {
          const r = await this.#tg.sendMessage({
            chatID,
            text: `🔐 ${permissionID}`,
            replyMarkup: markup,
            ephemeralMessageParameters: { receiver_user_id: c.lastUserID },
          })
          c.pending.set(permissionID, {
            sessionID,
            messageID: r.message_id,
            ...(r.ephemeral_message_id !== undefined ? { ephemeralID: r.ephemeral_message_id } : {}),
          })
          return
        } catch (err) {
          console.error(`[permission] ephemeral prompt failed, using a plain one: ${(err as Error)?.message ?? err}`)
        }
      }
      const msg = await this.#tg.sendMessage({ chatID, text: `🔐 ${permissionID}`, replyMarkup: markup })
      c.pending.set(permissionID, { sessionID, messageID: msg.message_id })
    } catch (err) {
      console.error(`[tg] permission prompt failed: ${(err as Error).message}`)
    }
  }

  // the agent produced a file (image or otherwise) — surface it in the chat
  async #sendPartFile(chatID: number, f: FilePart): Promise<void> {
    if (!f.filePath) return
    try {
      if (IMAGE_RE.test(f.filePath)) await this.#tg.sendPhoto({ chatID, filePath: f.filePath })
      else await this.#tg.sendDocument({ chatID, filePath: f.filePath })
    } catch (err) {
      await this.#tg.sendMessage({ chatID, text: `⚠️ couldn't send a produced file: ${(err as Error).message}` })
    }
  }

  // continuation picker: new conversation, 4 most recent, paginated "see more"
  async #wipePick(chatID: number, page: number, messageID: number | null): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#activeWs(chatID)
    const sorted = [...(await ws.adapter.listSessions())].sort((a, b) => b.updatedAt - a.updatedAt)
    const ids = sorted.map((s) => s.id)
    const lastPage = Math.max(0, Math.ceil(ids.length / WIPE_PAGE) - 1)
    const p = Math.max(0, Math.min(page, lastPage))
    const from = p * WIPE_PAGE
    const shown = ids.slice(from, from + WIPE_PAGE)

    const rows: InlineButton[][] = [[btn("🆕 New conversation", "neww")]]
    for (const id of shown) {
      const s = sorted[ids.indexOf(id)]!
      rows.push([btn(this.#displayTitle(id, s.title), `open:${ids.indexOf(id)}`)])
    }
    const back = btn("‹ back", "backp")
    const more = btn("See more ›", "morep")
    if (p <= 0) back.disabled = true
    if (ids.length <= from + WIPE_PAGE) more.disabled = true
    rows.push([back, more])

    const body = [
      "Which conversation do you want to continue?",
      "",
      "(sessions are kept — I only cleared this chat's messages)",
    ].join("\n")

    const reply = messageID === null
      ? await this.#tg.sendMessage({ chatID, text: body, replyMarkup: kin(rows) })
      : { message_id: messageID }

    if (messageID !== null) {
      await this.#tg.editMessageText({ chatID, messageID, text: body, replyMarkup: kin(rows) })
    }
    c.picker = { messageID: reply.message_id, sessions: ids.map((id) => ({ id, ws: c.workspace })) }
    c.page = p
    c.del = null
  }

  // ─── settings button-tree ───

  // Render a menu (info lines + button rows) as a Rich Message — paragraphs plus
  // RichBlockButtons — so options render natively in rich clients. Anything that
  // rejects rich messages falls back to classic HTML text + inline keyboard, so
  // menus keep working on every client.
  async #menu(
    chatID: number,
    lines: string[],
    rows: InlineButton[][],
    edit?: { messageID: number },
  ): Promise<{ messageID?: number }> {
    const blocks: RichBlock[] = []
    for (const line of lines) if (line.trim()) blocks.push({ type: "paragraph", text: line })
    for (const row of rows) {
      blocks.push({
        type: "buttons",
        align: "left",
        buttons: row.map((b) => ({
          text: b.text,
          callback_data: b.callback_data,
          ...(b.style ? { style: b.style } : {}),
          ...(b.disabled ? { disabled: {} } : {}),
        })),
      })
    }
    try {
      if (edit) {
        await this.#tg.editRichMessage({ chatID, messageID: edit.messageID, rich_message: { blocks } })
        return {}
      }
      const sent = await this.#tg.sendRichMessage({ chatID, rich_message: { blocks } })
      return { messageID: sent.message_id }
    } catch (err) {
      console.error(`[menu] rich menu failed, falling back to classic: ${(err as Error)?.message ?? err}`)
    }
    const body = lines.join("\n")
    if (edit) {
      await this.#tg.editMessageText({ chatID, messageID: edit.messageID, text: body, replyMarkup: kin(rows) })
      return {}
    }
    const sent = await this.#tg.sendMessage({ chatID, text: body, replyMarkup: kin(rows) })
    return { messageID: sent.message_id }
  }

  async #settingsRoot(chatID: number, messageID: number | null): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#activeWs(chatID)
    const sessionID = await this.#resolveSessionID(chatID)
    const active = sessionID ? await ws.adapter.getSession(sessionID) : null
    const label = active ? this.#displayTitle(active.id, active.title) : "(none)"
    const model = this.#store.model(chatID, ws.adapter.id) ?? "default"

    // Only fields with no button of their own belong here. Anything a button
    // already carries (model, agent, internals, context, workspace) would
    // otherwise be stated twice, one line apart.
    const lines = [
      "⚙️ Settings",
      "",
      `conversation: "${label}"`,
    ]
    const rows: InlineButton[][] = [
      [btn(`🤖 Model · ${model}`, "set:model")],
      [btn(`🧭 Agent · ${this.#store.agent(chatID) ?? "build"}`, "set:agent")],
      // always shown, like 🗂 Workspace: hiding a row until a second option
      // exists is how the only route to something ends up undiscoverable, and
      // with one harness it still answers "what is actually running this?"
      [btn(`🔌 Harness · ${this.#activeWs(chatID).adapter.id}`, "set:harness")],
      [btn(`🔎 Internals · ${internalsPreset(this.#store.internals(chatID))}`, "set:internals")],
      [btn(`🧩 Context · ${this.#store.injectContext(chatID) ? "on" : "off"}`, "ctx:toggle")],
      [btn("✏️ Rename conversation", "set:rename")],
      // always shown, even with a single workspace: this is now the only way
      // to *add* a project, so hiding it until you have two made it
      // unreachable exactly when you needed it
      [btn(`🗂 Workspace · ${c.workspace}`, "set:ws")],
      [btn("‹ Done", "set:done")],
    ]

    const sent = await this.#menu(chatID, lines, rows, messageID === null ? undefined : { messageID })
    if (sent.messageID !== undefined) c.settingsMsg = sent.messageID
  }

  // 🗂 Workspace: switch between projects, or add a new one. Switching starts
  // a fresh conversation there (sessions are per-workspace).
  async #settingsWorkspace(chatID: number, messageID: number | null): Promise<void> {
    const c = this.#chat(chatID)
    const added = new Set(this.#store.workspaces())
    const rows: InlineButton[][] = this.#workspaces.map((w) => {
      const b = btn(w.name, `wsw:${w.name}`)
      if (w.name === c.workspace) b.style = "success"
      // only offer 🗑 for projects added from the phone — the ones that came
      // from JEP_WORKSPACES belong to the machine's config, and "removing"
      // one here would silently come back on the next restart
      return added.has(w.dir) ? [styled(btn("🗑", `wsrm:${w.name}`), "danger"), b] : [b]
    })
    rows.push([btn("➕ Add project", "wsadd")])
    rows.push([btn("‹ Back", "set:root")])
    const hint =
      this.#workspaces.length > 1
        ? "Tap one to switch — starts a fresh conversation there."
        : "➕ Add project to browse for another, or clone one."
    const lines = ["🗂 Workspace", "", `current: ${c.workspace}`, "", hint]
    await this.#menu(chatID, lines, rows, messageID === null ? undefined : { messageID })
  }

  // 🔌 Harness: which agent runtime answers, for this chat. Sessions belong to
  // the harness that made them — opencode and codex keep separate transcripts
  // in separate stores — so switching starts a fresh conversation rather than
  // pretending the old one carries over.
  async #settingsHarness(chatID: number, messageID: number): Promise<void> {
    const current = this.#activeWs(chatID).adapter.id
    const rows: InlineButton[][] = this.#harnessList.map((h) => {
      const b = btn(h.label, `hns:${h.id}`)
      if (h.id === current) b.style = "success"
      return [b]
    })
    rows.push([btn("‹ Back", "set:root")])
    const hint =
      this.#harnessList.length > 1
        ? "Switching starts a fresh conversation — sessions don't move between harnesses."
        : "The only harness installed here. Install another (e.g. codex) and it shows up."
    const lines = ["🔌 Harness", "", `current: ${current}`, "", hint]
    await this.#menu(chatID, lines, rows, { messageID })
  }

  // The browser is bounded to one root (JEP_BROWSE_ROOT, default $HOME) so a
  // tap can't wander into /etc, and so "⬆︎ Up" has somewhere to stop.
  #browseRoot(): string {
    return resolve(process.env.JEP_BROWSE_ROOT || homedir())
  }

  // 📂 Directory browser. Everything is addressed by index (callback_data is
  // capped at 64 bytes, nowhere near a path), so the listing behind the
  // buttons is kept on ChatState and re-read on every render.
  async #browsePicker(chatID: number, dir: string, messageID: number | null, page = 0): Promise<void> {
    const c = this.#chat(chatID)
    const root = this.#browseRoot()
    // never above the root, and never outside it via a symlink or "..":
    const cwd = resolve(dir).startsWith(root) ? resolve(dir) : root
    let dirs: string[] = []
    try {
      dirs = (await readdir(cwd, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
    } catch (err) {
      // unreadable directory — show it as empty rather than dead-ending
      console.error(`[browse] cannot read ${cwd}: ${(err as Error)?.message ?? err}`)
    }
    const PER = 8
    const pages = Math.max(1, Math.ceil(dirs.length / PER))
    const p = Math.min(Math.max(page, 0), pages - 1)
    const slice = dirs.slice(p * PER, p * PER + PER)
    const rows: InlineButton[][] = slice.map((name, k) => {
      const idx = p * PER + k
      // a git repo is what opencode treats as a project, so flag it — picking
      // a plain subfolder works but gives you a degenerate one
      const marker = existsSync(join(cwd, name, ".git")) ? "📦" : "📁"
      return [btn(`${marker} ${name}`, `wsb:${idx}`)]
    })
    if (pages > 1) {
      const prev = btn("‹", `wsbp:${p - 1}`)
      const next = btn("›", `wsbp:${p + 1}`)
      if (p <= 0) prev.disabled = true
      if (p >= pages - 1) next.disabled = true
      rows.push([prev, btn(`page ${p + 1} / ${pages}`, "wsbp:x"), next])
    }
    const already = this.#workspaces.some((w) => w.dir === cwd)
    rows.push([
      styled(btn("✅ Use this folder", "wsuse"), already ? undefined : "success"),
      ...(cwd === root ? [] : [btn("⬆︎ Up", "wsup")]),
    ])
    rows.push([btn("📁+ New folder", "wsnew"), btn("⬇︎ Clone repo", "wscl")])
    rows.push([btn("‹ Back", "set:ws")])
    c.browse = { cwd, dirs, page: p }
    const lines = [
      "📂 Add project",
      "",
      fmtHome(cwd),
      "",
      dirs.length ? "📦 = git repo" : "(no subfolders here)",
      ...(already ? ["", "already a workspace"] : []),
    ]
    await this.#menu(chatID, lines, rows, messageID === null ? undefined : { messageID })
  }

  // Brings a directory up as a workspace and points this chat at it. Spawning
  // an opencode server takes a few seconds, which is an eternity with no
  // feedback, so the caller's message is edited to say what's happening.
  async #addWorkspace(chatID: number, dir: string, messageID: number): Promise<void> {
    const c = this.#chat(chatID)
    const existing = this.#workspaces.find((w) => w.dir === dir)
    if (!existing) {
      await this.#menu(chatID, ["📂 Add project", "", `starting ${fmtHome(dir)}…`], [], { messageID })
      try {
        this.#workspaces.push(await this.#spawn(dir))
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err)
        await this.#menu(chatID, ["📂 Add project", "", `⚠️ couldn't start there:`, msg.slice(0, 300)], [[btn("‹ Back", "wsadd")]], { messageID })
        return
      }
      this.#store.addWorkspace(dir)
    }
    const w = this.#workspaces.find((x) => x.dir === dir)!
    c.workspace = w.name
    c.sessionID = null
    this.#rememberChat(chatID)
    c.freshOnNext = false
    c.sessionFresh = false
    c.picker = null
    c.del = null
    c.page = 0
    c.browse = null
    void this.#updateStatus(chatID).catch(logFail("status"))
    await this.#settingsWorkspace(chatID, messageID)
  }

  // 🧭 Agent: build (executes) vs plan (read-only, no edit tools) — a relay of
  // opencode's own primary agents, not a mode jep invents.
  async #settingsAgent(chatID: number, messageID: number): Promise<void> {
    const current = this.#store.agent(chatID) ?? "build"
    const opt = (name: string, label: string): InlineButton => {
      const b = btn(label, `agt:${name}`)
      if (current === name) b.style = "success"
      return b
    }
    const rows: InlineButton[][] = [
      [opt("build", "🔨 Build"), opt("plan", "📝 Plan")],
      [btn("‹ Back", "set:root")],
    ]
    const lines = ["🧭 Agent", "", `current: ${current}`, "", "Build executes tools. Plan is read-only — no edits."]
    await this.#menu(chatID, lines, rows, { messageID })
  }

  // 🔎 Internals: how much the agent shows per reply (thinking + tool calls).
  // Presets set all three at once; each row also cycles independently.
  async #settingsInternals(chatID: number, messageID: number): Promise<void> {
    const s = this.#store.internals(chatID)
    const preset = internalsPreset(s)
    const presetBtn = (label: string, name: "simple" | "minimal" | "detailed" | "debug"): InlineButton => {
      const b = btn(label, `intp:${name}`)
      if (preset === name) b.style = "success"
      return b
    }
    // "Custom" is a status, not an action: always inert, green only when the
    // current state matches no preset (i.e. you hand-tuned the cyclers).
    const custom = btn("Custom", "intp:custom")
    custom.disabled = true
    if (preset === "custom") custom.style = "success"
    const rows: InlineButton[][] = [
      [presetBtn("Simple", "simple"), presetBtn("Minimal", "minimal")],
      [presetBtn("Detailed", "detailed"), presetBtn("Debug", "debug"), custom],
      [btn(`💭 Thinking · ${s.thinking}`, "int:think")],
      [btn(`⚙ Tool calls · ${s.tools}`, "int:tools")],
      [btn(`🧩 Layout · ${s.layout}`, "int:layout")],
      [btn("‹ Back", "set:root")],
    ]
    const lines = [
      "🔎 Internals",
      "",
      "How much of the agent's work shows in its replies:",
      "💭 chain-of-thought · ⚙ tool calls · 🧩 how they're grouped.",
      "",
      "Tap any value to cycle it. Collapsed blocks open on tap.",
      `preset: ${preset}`,
    ]
    await this.#menu(chatID, lines, rows, { messageID })
  }

  async #settingsModel(chatID: number, messageID: number, requestPage?: number): Promise<void> {
    const c = await this.#chat(chatID)
    const ws = this.#activeWs(chatID)
    const current = this.#store.model(chatID, ws.adapter.id)
    const native: ModelRef[] = ws ? (await ws.adapter.models?.().catch(() => [])) ?? [] : []
    const caps = (await ws.adapter.capabilities?.().catch(() => new Map<string, ModelCaps>())) ?? new Map<string, ModelCaps>()
    const labels: string[] = ["default"]
    const seen = new Set<string>(["default"])
    for (const ref of native) {
      const label = `${ref.providerID}/${ref.modelID}`
      if (seen.has(label)) continue
      seen.add(label)
      labels.push(label)
    }
    for (const label of this.#extraModels) {
      if (seen.has(label)) continue
      seen.add(label)
      labels.push(label)
    }
    const pages = Math.max(1, Math.ceil(labels.length / MAX_LIST))
    // Opening the picker jumps to whichever page holds the current model, so
    // the green row is in front of you. It used to resume c.settingsPage — the
    // last page you happened to stop on — which made every model on the pages
    // you hadn't scrolled to look like it didn't exist. Only ‹ Prev / Next ›
    // (which pass requestPage) move off that page.
    const currentIdx = labels.indexOf(current ?? "default")
    const defaultPage = currentIdx >= 0 ? Math.floor(currentIdx / MAX_LIST) : 0
    const page = Math.max(0, Math.min(requestPage ?? defaultPage, pages - 1))
    c.settingsPage = page
    const rows: InlineButton[][] = []
    const from = page * MAX_LIST
    let anyImage = false
    for (let i = from; i < Math.min(from + MAX_LIST, labels.length); i++) {
      const label = labels[i]!
      const mark = label === "default" ? current === null : label === current
      const image = caps.get(label)?.image === true
      if (image) anyImage = true
      const b: InlineButton = btn(`${label}${image ? " 🖼" : ""}`, label === "default" ? "mdl:off" : `mdl:${label}`)
      if (mark) b.style = "success" // green = the model this chat runs on
      rows.push([b])
    }
    if (pages > 1) {
      const prev = btn("‹ Prev", "mdlp:prev")
      const next = btn("Next ›", "mdlp:next")
      if (page <= 0) prev.disabled = true
      if (page >= pages - 1) next.disabled = true
      rows.push([prev, btn(`page ${page + 1} / ${pages}`, "mdlp:page"), next])
    }
    rows.push([btn("‹ Back", "set:root")])
    const lines = [
      "🤖 Model",
      "",
      `current: ${current ?? "default (engine picks)"}`,
      "",
      "Tap one — the next message in this chat runs on it.",
      ...(anyImage ? ["🖼 = accepts images"] : []),
      ...(pages > 1 ? [`page ${page + 1} / ${pages} (${labels.length} models)`] : []),
    ]
    await this.#menu(chatID, lines, rows, { messageID })
  }

  // when a photo/document lands on a model we can't see it with, offer the
  // vision-capable ones directly (once per current model, not on every message).
  async #suggestImageModel(chatID: number): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#activeWs(chatID)
    const current = this.#store.model(chatID, ws.adapter.id) ?? "default"
    if (c.suggestedImage === current) return
    const caps = (await ws.adapter.capabilities?.().catch(() => new Map<string, ModelCaps>())) ?? new Map<string, ModelCaps>()
    if (caps.size === 0) return
    if (caps.get(current)?.image === true) return
    const native: ModelRef[] = (await ws.adapter.models?.().catch(() => [])) ?? []
    const picks: string[] = []
    const seen = new Set<string>()
    for (const ref of native) {
      const label = `${ref.providerID}/${ref.modelID}`
      if (seen.has(label)) continue
      seen.add(label)
      if (caps.get(label)?.image === true) picks.push(label)
      if (picks.length === 3) break
    }
    if (picks.length === 0) return
    const rows: InlineButton[][] = picks.map((label) => [btn(`🖼 ${label}`, `mdl:${label}`)])
    rows.push([btn("All models ›", "set:model")])
    c.suggestedImage = current
    await this.#tg.sendMessage({
      chatID,
      text: "🖼 This model can't read images. Switch to a vision-capable one?",
      replyMarkup: kin(rows),
    })
  }

  async #settingsRename(chatID: number, messageID: number, requestPage?: number): Promise<void> {
    const c = this.#chat(chatID)
    // renaming is about the conversation you're already in — no picker needed
    const activeSessionID = await this.#resolveSessionID(chatID)
    if (activeSessionID) {
      c.awaiting = { kind: "rename", sessionID: activeSessionID }
      await this.#tg.editMessageText({ chatID, messageID, text: "✏️ Type the new name for this conversation…", replyMarkup: null })
      return
    }
    const ws = this.#activeWs(chatID)
    const sorted = [...(await ws.adapter.listSessions())].sort((a, b) => b.updatedAt - a.updatedAt)
    const ids = sorted.map((s) => s.id)
    if (!ids.length) {
      await this.#menu(
        chatID,
        ["✏️ Rename", "", "(no conversations to rename — just send a message first)"],
        [[btn("‹ Back", "set:root")]],
        { messageID },
      )
      return
    }
    const pages = Math.max(1, Math.ceil(ids.length / MAX_LIST))
    const page = Math.max(0, Math.min(requestPage ?? c.page, pages - 1))
    c.page = page
    const rows: InlineButton[][] = ids
      .slice(page * MAX_LIST, (page + 1) * MAX_LIST)
      .map((id) => {
        const age = timeAgo(sorted.find((x) => x.id === id)?.updatedAt ?? 0)
        return [btn(`${clipTitle(this.#displayTitle(id, ""))}${age ? ` (${age})` : ""}`, `ren:${ids.indexOf(id)}`)]
      })
    if (pages > 1) {
      const prev = btn("‹ Prev", "renp:prev")
      const next = btn("Next ›", "renp:next")
      if (page <= 0) prev.disabled = true
      if (page >= pages - 1) next.disabled = true
      rows.push([prev, btn(`page ${page + 1} / ${pages}`, "renp:page"), next])
    }
    rows.push([btn("‹ Back", "set:root")])
    c.picker = { messageID, sessions: ids.map((id) => ({ id, ws: c.workspace })) }
    c.del = null
    await this.#menu(chatID, ["✏️ Rename", "", "Which conversation? (no active conversation yet)"], rows, { messageID })
  }

  async #onCallback(cq: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
    const tg = this.#tg
    const data = cq.data ?? ""
    const msg = cq.message
    if (!msg) return tg.answerCallbackQuery({ id: cq.id })
    const chatID = msg.chat.id
    const c = this.#chat(chatID)
    const ws = this.#activeWs(chatID)
    const [verb, rest] = data.split(":")
    const i = Number(rest)

    switch (verb) {
      case "set":
        if (rest === "root") await this.#settingsRoot(chatID, msg.message_id)
        else if (rest === "model") await this.#settingsModel(chatID, msg.message_id)
        else if (rest === "internals") await this.#settingsInternals(chatID, msg.message_id)
        else if (rest === "agent") await this.#settingsAgent(chatID, msg.message_id)
        else if (rest === "rename") await this.#settingsRename(chatID, msg.message_id)
        else if (rest === "ws") await this.#settingsWorkspace(chatID, msg.message_id)
        else if (rest === "harness") await this.#settingsHarness(chatID, msg.message_id)
        else if (rest === "done") {
          c.settingsMsg = null
          await this.#tg.editMessageText({ chatID, messageID: msg.message_id, text: "⚙️ closed", replyMarkup: null })
        } else {
          await tg.answerCallbackQuery({ id: cq.id, text: "stale menu" })
          break
        }
        await tg.answerCallbackQuery({ id: cq.id })
        break
      case "ctx": {
        const on = !this.#store.injectContext(chatID)
        this.#store.setInjectContext(chatID, on)
        await this.#settingsRoot(chatID, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id, text: `context: ${on ? "on" : "off"}` })
        break
      }
      case "int": {
        const s = this.#store.internals(chatID)
        if (rest === "think") s.thinking = cycleMode(s.thinking)
        else if (rest === "tools") s.tools = cycleMode(s.tools)
        else if (rest === "layout") s.layout = cycleLayout(s.layout)
        this.#store.setInternals(chatID, s)
        await this.#settingsInternals(chatID, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id, text: `internals: ${internalsPreset(s)}` })
        break
      }
      case "intp": {
        const preset = PRESETS[rest as "simple" | "minimal" | "detailed" | "debug"]
        if (!preset) {
          await tg.answerCallbackQuery({ id: cq.id, text: "unknown preset" })
          break
        }
        const s = this.#store.internals(chatID)
        this.#store.setInternals(chatID, { ...s, ...preset })
        await this.#settingsInternals(chatID, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id, text: `preset: ${rest}` })
        break
      }
      case "mdlp": {
        const cur = c.settingsPage ?? 0
        const next = rest === "prev" ? cur - 1 : rest === "next" ? cur + 1 : cur
        await this.#settingsModel(chatID, msg.message_id, next)
        await tg.answerCallbackQuery({ id: cq.id, text: rest === "page" ? `page ${cur + 1}` : undefined })
        break
      }
      case "renp": {
        const cur = c.page
        const next = rest === "prev" ? cur - 1 : rest === "next" ? cur + 1 : cur
        await this.#settingsRename(chatID, msg.message_id, next)
        await tg.answerCallbackQuery({ id: cq.id, text: rest === "page" ? `page ${cur + 1}` : undefined })
        break
      }
      case "mdl": {
        const harnessID = this.#activeWs(chatID).adapter.id
        if (rest === "off") this.#store.clearModel(chatID, harnessID)
        else this.#store.setModel(chatID, harnessID, rest)
        await this.#settingsModel(chatID, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id, text: rest === "off" ? "back to default" : `model: ${rest}` })
        void this.#updateStatus(chatID).catch(logFail("status"))
        break
      }
      case "agt": {
        this.#store.setAgent(chatID, rest)
        await this.#settingsAgent(chatID, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id, text: `agent: ${rest}` })
        void this.#updateStatus(chatID).catch(logFail("status"))
        break
      }
      // rename the conversation this chat is currently in, from the list
      case "renc": {
        const activeID = await this.#resolveSessionID(chatID)
        if (!activeID) return tg.answerCallbackQuery({ id: cq.id, text: "no active conversation" })
        const row = { id: activeID, ws: c.workspace }
        const current = this.#displayTitle(activeID, await this.#rowTitle(row))
        c.awaiting = { kind: "rename", sessionID: activeID, backTo: msg.message_id }
        await this.#tg.editMessageText({
          chatID,
          messageID: msg.message_id,
          text: `✏️ Renaming "${current}"\n\nType the new name (/cancel to stop).`,
          replyMarkup: null,
        })
        await tg.answerCallbackQuery({ id: cq.id, text: "type the name" })
        break
      }
      case "ren": {
        const p = c.picker
        if (!p) return tg.answerCallbackQuery({ id: cq.id, text: "menu expired — reopen the list" })
        const row = p.sessions[i]
        if (!row) return tg.answerCallbackQuery({ id: cq.id, text: "no such conversation" })
        // renaming is client-side only (ChatStore titles), so a row from a
        // project with no server running needs nothing started for it
        const current = this.#displayTitle(row.id, await this.#rowTitle(row))
        c.awaiting = { kind: "rename", sessionID: row.id, backTo: msg.message_id }
        await this.#tg.editMessageText({
          chatID,
          messageID: msg.message_id,
          text: `✏️ Renaming "${current}"\n\nType the new name (/cancel to stop).`,
          replyMarkup: null,
        })
        await tg.answerCallbackQuery({ id: cq.id, text: "type the name" })
        break
      }
      case "neww": {
        await this.#newConversation(chatID, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id, text: "new" })
        break
      }
      case "morep": {
        await this.#wipePick(chatID, c.page + 1, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "backp": {
        await this.#wipePick(chatID, Math.max(0, c.page - 1), msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "open": {
        const p = c.picker
        if (!p) return tg.answerCallbackQuery({ id: cq.id, text: "menu expired - run /ls again" })
        const row = p.sessions[i]
        if (!row) return tg.answerCallbackQuery({ id: cq.id, text: "no such conversation" })
        // opening a conversation from another project switches the chat into
        // that project too, so the next message routes to the right place.
        // A row from the cached index has no server yet — this is where one
        // gets started, since the user has now actually committed to it.
        let target: Ws
        try {
          target = await this.#wsForRow(row)
        } catch (err) {
          console.error(`[open] cannot serve ${row.dir}: ${(err as Error)?.message ?? err}`)
          return tg.answerCallbackQuery({ id: cq.id, text: "couldn't open that project" })
        }
        // switching projects is a side effect of opening the conversation, not
        // something the user asked for — it changes where every later message
        // runs, so it gets said out loud rather than only showing up in the pin
        const movedFrom = c.workspace !== target.name ? c.workspace : null
        c.workspace = target.name
        c.sessionID = row.id
        this.#rememberChat(chatID)
        c.del = null
        c.awaiting = null
        const s = await target.adapter.getSession(row.id)
        const opened = `▶ "${this.#displayTitle(row.id, s?.title ?? "")}"`
        await this.#tg.editMessageText({
          chatID,
          messageID: p.messageID,
          text: movedFrom ? `${opened}\n\n🗂 workspace: ${movedFrom} → ${target.name}` : opened,
          replyMarkup: null,
        })
        await tg.answerCallbackQuery({ id: cq.id, text: movedFrom ? `opened · ${target.name}` : "opened" })
        void this.#updateStatus(chatID).catch(logFail("status"))
        break
      }
      case "deld": {
        const p = c.picker
        if (!p) return tg.answerCallbackQuery({ id: cq.id, text: "menu expired - run /ls again" })
        const row = p.sessions[i]
        if (!row) return tg.answerCallbackQuery({ id: cq.id, text: "no such conversation" })
        c.del = { messageID: p.messageID, i }
        await this.#tg.editMessageText({
          chatID,
          messageID: p.messageID,
          text: `Delete "${this.#displayTitle(row.id, await this.#rowTitle(row))}"?`,
          replyMarkup: kin([[btn("🗑 Delete", "dely")], [btn("Cancel", "deln")]]),
        })
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "dely": {
        const d = c.del
        const p = c.picker
        if (!d || !p) return tg.answerCallbackQuery({ id: cq.id, text: "nothing to delete" })
        const row = p.sessions[d.i]
        if (row) {
          const target = await this.#wsForRow(row)
          await target.adapter.deleteSession(row.id)
          if (c.sessionID === row.id && c.workspace === target.name) {
            // fall back to whatever's now the most recently active
            // conversation, so the refreshed list still has one highlighted
            // instead of nothing selected
            const remaining = await target.adapter.listSessions()
            const latest = [...remaining].sort((a, b) => b.updatedAt - a.updatedAt)[0]
            c.sessionID = latest?.id ?? null
            c.freshOnNext = !latest
            this.#rememberChat(chatID)
          }
        }
        c.del = null
        // back to the (now shorter) list in place, instead of a dead-end
        // "deleted" string — #listPicker refreshes c.picker itself
        await this.#listPicker(chatID, "Conversations:", false, { messageID: d.messageID })
        await tg.answerCallbackQuery({ id: cq.id, text: "deleted" })
        break
      }
      case "deln": {
        const d = c.del
        c.del = null
        // back to the list in place, instead of a dead-end "canceled" string
        if (d) await this.#listPicker(chatID, "Conversations:", false, { messageID: d.messageID })
        await tg.answerCallbackQuery({ id: cq.id, text: "canceled" })
        break
      }
      case "lsp": {
        if (rest === "page") return tg.answerCallbackQuery({ id: cq.id, text: `page ${c.page + 1}` })
        c.page = Math.max(0, c.page + (rest === "prev" ? -1 : 1))
        const p = c.picker
        await this.#listPicker(chatID, "Conversations:", false, p ? { messageID: p.messageID } : undefined)
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "lsb": {
        const cmdMessageID = c.picker?.cmdMessageID
        c.picker = null
        // both deletes are independent round-trips — run them together instead
        // of back-to-back, or the /ls message lingers for an extra ~500ms
        await Promise.all([
          this.#tg.deleteMessage({ chatID, messageID: msg.message_id }).catch(logFail("cleanup")),
          // also clean up the /ls or /use message that opened this picker —
          // bots can delete incoming messages in private chats
          cmdMessageID !== undefined ? this.#tg.deleteMessage({ chatID, messageID: cmdMessageID }).catch(logFail("cleanup")) : Promise.resolve(),
        ])
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "wsw": {
        if (!this.#workspaces.some((w) => w.name === rest)) return tg.answerCallbackQuery({ id: cq.id, text: "no such workspace" })
        c.workspace = rest
        c.sessionID = null
        this.#rememberChat(chatID)
        c.freshOnNext = false
        c.picker = null
        c.del = null
        c.page = 0
        await this.#settingsWorkspace(chatID, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id, text: `workspace: ${rest}` })
        break
      }
      // ── directory browser (see #browsePicker) ──
      case "wsadd": {
        // start next to the workspace you're in — that's almost always the
        // same folder your other projects live in
        const start = dirname(this.#activeWs(chatID).dir)
        await this.#browsePicker(chatID, start, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "wsb": {
        const b = c.browse
        const name = b?.dirs[i]
        if (!b || !name) return tg.answerCallbackQuery({ id: cq.id, text: "stale — reopen" })
        await this.#browsePicker(chatID, join(b.cwd, name), msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "wsbp": {
        if (!c.browse || rest === "x") return tg.answerCallbackQuery({ id: cq.id })
        await this.#browsePicker(chatID, c.browse.cwd, msg.message_id, i)
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "wsup": {
        if (!c.browse) return tg.answerCallbackQuery({ id: cq.id, text: "stale — reopen" })
        await this.#browsePicker(chatID, dirname(c.browse.cwd), msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "wsuse": {
        if (!c.browse) return tg.answerCallbackQuery({ id: cq.id, text: "stale — reopen" })
        await tg.answerCallbackQuery({ id: cq.id, text: "starting…" })
        await this.#addWorkspace(chatID, c.browse.cwd, msg.message_id)
        break
      }
      case "wsnew":
      case "wscl": {
        if (!c.browse) return tg.answerCallbackQuery({ id: cq.id, text: "stale — reopen" })
        const clone = verb === "wscl"
        c.awaiting = clone ? { kind: "clone", dir: c.browse.cwd } : { kind: "newfolder", dir: c.browse.cwd }
        const prompt = clone
          ? ["⬇︎ Clone repo", "", `into ${fmtHome(c.browse.cwd)}`, "", "Send the repository URL (/cancel to stop)."]
          : ["📁+ New folder", "", `in ${fmtHome(c.browse.cwd)}`, "", "Send a name for it (/cancel to stop)."]
        await this.#menu(chatID, prompt, [[btn("‹ Back", "wsadd")]], { messageID: msg.message_id })
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "wsrm": {
        const w = this.#workspaces.find((x) => x.name === rest)
        if (!w) return tg.answerCallbackQuery({ id: cq.id, text: "no such workspace" })
        if (this.#workspaces.length < 2) return tg.answerCallbackQuery({ id: cq.id, text: "that's the only one" })
        this.#store.removeWorkspace(w.dir)
        this.#workspaces.splice(this.#workspaces.indexOf(w), 1)
        // the files stay put — this only stops serving them
        try {
          await w.adapter.close()
        } catch (err) {
          console.error(`[ws] close failed for ${w.name}: ${(err as Error)?.message ?? err}`)
        }
        if (c.workspace === w.name) {
          c.workspace = this.#workspaces[0]!.name
          c.sessionID = null
          this.#rememberChat(chatID)
          c.freshOnNext = false
          c.picker = null
          c.del = null
          void this.#updateStatus(chatID).catch(logFail("status"))
        }
        await this.#settingsWorkspace(chatID, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id, text: `removed ${w.name}` })
        break
      }
      case "hns": {
        if (!this.#harnessList.some((h) => h.id === rest)) return tg.answerCallbackQuery({ id: cq.id, text: "unknown harness" })
        const dir = this.#activeWs(chatID).dir
        if (this.#activeWs(chatID).adapter.id === rest) return tg.answerCallbackQuery({ id: cq.id, text: "already on it" })
        // starting a harness takes a moment (opencode spawns a server); say so
        await tg.answerCallbackQuery({ id: cq.id, text: "starting…" })
        if (!this.#workspaces.some((w) => w.dir === dir && w.adapter.id === rest)) {
          await this.#menu(chatID, ["🔌 Harness", "", `starting ${rest}…`], [], { messageID: msg.message_id })
          try {
            this.#workspaces.push(await this.#spawn(dir, rest))
          } catch (err) {
            const m = (err as Error)?.message ?? String(err)
            console.error(`[harness] cannot start ${rest} for ${dir}: ${m}`)
            await this.#menu(chatID, ["🔌 Harness", "", `⚠️ couldn't start ${rest}:`, m.slice(0, 300)], [[btn("‹ Back", "set:harness")]], { messageID: msg.message_id })
            break
          }
        }
        c.harness = rest
        // sessions are per-harness; carrying the old id over would point at a
        // transcript the new harness has never heard of
        c.sessionID = null
        c.freshOnNext = false
        c.sessionFresh = false
        c.picker = null
        c.del = null
        this.#rememberChat(chatID)
        void this.#updateStatus(chatID).catch(logFail("status"))
        await this.#settingsHarness(chatID, msg.message_id)
        break
      }
      case "abt": {
        const stopped = await this.#stopTurn(chatID)
        await tg.answerCallbackQuery({ id: cq.id, text: stopped ? "stopping…" : "nothing running" })
        break
      }
      case "allow":
      case "deny": {
        const pending = c.pending.get(rest)
        if (!pending) return tg.answerCallbackQuery({ id: cq.id, text: "already answered" })
        await ws.adapter.respondApproval(pending.sessionID, { id: rest, sessionID: pending.sessionID, title: "", metadata: {} }, verb === "allow")
        c.pending.delete(rest)
        if (pending.ephemeralID !== undefined) {
          // ephemeral messages have no editable message_id — just drop the prompt
          await this.#tg.deleteEphemeralMessage({ chatID, ephemeralMessageID: pending.ephemeralID }).catch(logFail("cleanup"))
        } else {
          await this.#tg.editMessageText({ chatID, messageID: msg.message_id, text: verb === "allow" ? "✅ allowed" : "⛔ denied", replyMarkup: null })
        }
        await tg.answerCallbackQuery({ id: cq.id, text: verb === "allow" ? "allowed" : "denied" })
        break
      }
      default:
        await tg.answerCallbackQuery({ id: cq.id, text: "stale button" })
    }
  }
}
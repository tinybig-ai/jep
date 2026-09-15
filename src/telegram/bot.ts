import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { HarnessAdapter, ModelCaps, ModelRef } from "../core/ports.ts"
import type { FilePart, Part, TextPart, ReasoningPart, ToolCallPart } from "../core/types.ts"
import { mdToHtml } from "./html.ts"
import { closeStreamingTable, mdToRich } from "./rich.ts"
import type { RichBlock } from "./rich.ts"
import type { TelegramApi, TgMessage, TgUpdate, InlineButton, ReplyMarkup } from "./api.ts"
import { runComplianceSuite } from "../core/compliance.ts"
import type { Pairing } from "./pair.ts"
import type { ChatStore, InternalsSettings, DetailMode, InternalsLayout } from "./store.ts"

interface Ws {
  name: string
  dir: string
  adapter: HarnessAdapter
}

type Awaiting = { kind: "pair" } | { kind: "use" } | { kind: "rename"; sessionID: string }

interface ChatState {
  workspace: string
  sessionID: string | null
  harness: string | null
  inflight: AbortController | null
  // permissionID -> prompt message for in-flight keyboard prompts; ephemeralID
  // is set when the prompt was sent as a group ephemeral message
  pending: Map<string, { sessionID: string; messageID: number; ephemeralID?: number }>
  // snapshot behind the /ls and settings pickers
  picker: { messageID: number; ws: string; sessions: string[] } | null
  del: { messageID: number; i: number } | null
  // an arg-taking command was sent bare; next plain text is the answer
  awaiting: Awaiting | null
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
const WIPE_PAGE = 4
// files embedded into one rich message via attach:// (keep multipart modest)
const MAX_RICH_FILES = 4

const kin = (rows: InlineButton[][]): ReplyMarkup => ({ inline_keyboard: rows })
const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data })

// "/remind 2h build" → { ms: 7_200_000, what: "build" }; null when malformed or
// outside the 5s–7d window we bother supporting.
function parseRemind(arg: string): { ms: number; what: string } | null {
  const m = arg.match(/^\s*(\d+)\s*([smhd])\s+([\s\S]+)$/)
  if (!m) return null
  const per = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!] ?? 0
  const ms = Number(m[1]) * per
  const what = m[3]!.trim()
  if (!what || !Number.isFinite(ms) || ms < 5_000 || ms > 7 * 86_400_000) return null
  return { ms, what }
}

const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

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
function buildLiveBlocks(
  parts: Part[],
  s: InternalsSettings,
  flushedToolIDs: Set<string>,
  reasoningStarted: Map<string, number>,
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
    return out
  }
  const out: RichBlock[] = []
  for (const p of parts) {
    if (p.kind === "tool") {
      if (s.tools !== "off" && !flushedToolIDs.has(p.id)) out.push({ type: "paragraph", text: toolHeader(p) })
    } else if (p.kind === "text") {
      if (p.text.trim()) out.push(...mdToRich(closeStreamingTable(p.text)))
    }
  }
  return out
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

export class TelegramBot {
  #tg: TelegramApi
  #workspaces: Ws[]
  #activeWsName: string
  #pairing: Pairing
  #store: ChatStore
  #extraModels: string[]
  #uploadsDir: string
  #chats = new Map<number, ChatState>()
  // in-process /remind timers (best-effort: a restart drops pending reminders)
  #reminders = new Set<ReturnType<typeof setTimeout>>()

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
    { command: "status", description: "what am I connected to" },
    { command: "settings", description: "model · rename · workspace" },
    { command: "log", description: "this conversation's history" },
    { command: "remind", description: "remind me later (e.g. /remind 2h build)" },
  ]

  constructor(tg: TelegramApi, workspaces: Ws[], activeWsName: string, pairing: Pairing, store: ChatStore, extraModels: string[], uploadsDir: string) {
    this.#tg = this.#recording(tg)
    this.#workspaces = workspaces
    this.#activeWsName = activeWsName
    this.#pairing = pairing
    this.#store = store
    this.#extraModels = extraModels
    this.#uploadsDir = uploadsDir
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

  #wsFor(harness: string): Ws | null {
    return this.#workspaces.find((w) => w.adapter.id === harness) ?? null
  }

  #harnesses(): string[] {
    return [...new Set(this.#workspaces.map((w) => w.adapter.id))]
  }

  #chat(id: number): ChatState {
    let c = this.#chats.get(id)
    if (!c) {
      c = {
        workspace: this.#activeWsName,
        sessionID: null,
        harness: null,
        inflight: null,
        pending: new Map(),
        picker: null,
        del: null,
        awaiting: null,
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

  // one persistent conversation per chat: resume the newest session if any,
  // otherwise create one (title = first message snippet).
  async #ensureSession(chatID: number, firstText?: string): Promise<string> {
    const c = this.#chat(chatID)
    if (c.sessionID) return c.sessionID
    const ws = this.#ws(c.workspace)
    const list = await ws.adapter.listSessions()
    const newest = list
      .map((s) => ({ s, t: s.time?.updated ?? 0 }))
      .sort((a, b) => b.t - a.t)[0]
    if (newest) {
      c.sessionID = newest.s.id
      return newest.s.id
    }
    const title = (firstText ?? "").slice(0, 40) || "My chat"
    const s = await ws.adapter.createSession(title)
    c.sessionID = s.id
    return s.id
  }

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.message) await this.#gatedMessage(update.message)
    else if (update.callback_query) await this.#gatedCallback(update.callback_query)
    else if (update.stopped_message_generation) await this.#onStopGeneration(update.stopped_message_generation)
  }

  // the user tapped the native "stop" button on a streaming draft — stop the turn
  async #onStopGeneration(stop: NonNullable<TgUpdate["stopped_message_generation"]>): Promise<void> {
    const chatID = stop?.chat?.id
    if (chatID == null) return
    const c = this.#chat(chatID)
    if (!c.inflight) return
    try {
      await this.#ws(c.workspace).adapter.abort(c.sessionID ?? "")
    } catch {
      /* the turn may have ended on its own already */
    }
    c.inflight.abort()
  }

  async #gatedMessage(m: TgMessage): Promise<void> {
    const chatID = m.chat.id
    const text = (m.text ?? m.caption ?? "").trim()
    const mediaFileID = this.#mediaFileID(m)
    if (!text && !mediaFileID) return
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
      await this.#command(chatID, cmd.slice(1), rest.join(" "))
    } else if (c.awaiting) {
      await this.#resolveAwaiting(chatID, text)
    } else {
      let filePaths: string[] | undefined
      if (mediaFileID) {
        try {
          filePaths = [await this.#ingestMedia(chatID, m)]
        } catch (err) {
          await this.#tg.sendMessage({ chatID, text: `⚠️ couldn't read the image: ${(err as Error).message}` })
        }
      }
      await this.#freeText(chatID, text, { filePaths })
      if (mediaFileID) await this.#suggestImageModel(chatID)
    }
  }

  #mediaFileID(m: TgMessage): string | null {
    if (m.photo?.length) return m.photo[m.photo.length - 1]!.file_id // biggest variant
    if (m.document?.file_id) return m.document.file_id
    return null
  }

  // download a message's attachment into the uploads dir so the harness can
  // read it as a file part (absolute path).
  async #ingestMedia(chatID: number, m: TgMessage): Promise<string> {
    const fileID = this.#mediaFileID(m)
    if (!fileID) throw new Error("no attachment")
    const docName = m.document?.file_name
    const docMime = m.document?.mime_type
    const ext = docName?.slice(docName.lastIndexOf(".")).toLowerCase() || imageExt(docMime) || ".jpg"
    const bytes = await this.#tg.getFileContent(fileID)
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
    if (!a) return this.#freeText(chatID, text)
    this.#chat(chatID).awaiting = null
    if (a.kind === "pair") return this.#attemptPair(chatID, text)
    if (a.kind === "use") return this.#resolveUse(chatID, text)
    const t = text.trim()
    this.#store.setTitle(a.sessionID, t)
    await this.#tg.sendMessage({ chatID, text: `✏️ renamed to "${this.#store.title(a.sessionID) ?? t}"` })
  }

  async #resolveUse(chatID: number, term: string): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#ws(c.workspace)
    const list = await ws.adapter.listSessions()
    const byTitle = list.find((s) => this.#displayTitle(s.id, s.title).toLowerCase().includes(term.toLowerCase()))
    const exact = byTitle ?? (term.includes("://") ? await ws.adapter.getSession(term) : null)
    if (!exact) {
      await this.#tg.sendMessage({ chatID, text: "no conversation found — try /ls" })
      return
    }
    c.sessionID = exact.id
    await this.#tg.sendMessage({ chatID, text: `▶ "${this.#displayTitle(exact.id, exact.title)}"` })
  }

  async #command(chatID: number, cmd: string, arg: string): Promise<void> {
    const tg = this.#tg
    const c = this.#chat(chatID)
    const ws = this.#ws(c.workspace)
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
        await this.#listPicker(chatID, "Conversations:")
        break
      }
      case "status": {
        const sessions = await ws.adapter.listSessions()
        const active = c.sessionID ? await ws.adapter.getSession(c.sessionID) : null
        const label = active ? this.#displayTitle(active.id, active.title) : "(none)"
        await tg.sendMessage({
          chatID,
          text: [
            `workspace: ${c.workspace}`,
            `engine: ${c.harness ?? ws.adapter.id}`,
            `model: ${this.#store.model(chatID) ?? "default"}`,
            `conversation: "${label}"`,
            `total conversations: ${sessions.length}`,
          ].join("\n"),
        })
        break
      }
      case "log": {
        const sessionID = await this.#ensureSession(chatID)
        const msgs = await ws.adapter.messages(sessionID)
        if (!msgs.length) {
          await tg.sendMessage({ chatID, text: "(empty — send a message to start)" })
          return
        }
        const text = msgs
          .map((m) => {
            const t = m.parts.map((p) => (p.kind === "text" || p.kind === "reasoning" ? p.text : `[${p.kind}]`)).join(" ")
            return `${m.role === "user" ? "👤" : "🤖"} ${t}`
          })
          .join("\n")
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
        } catch {
          // no rich support → plain text
        }
        await tg.sendMessage({ chatID, text: body })
        break
      }
      case "use": {
        if (!arg) {
          c.awaiting = { kind: "use" }
          await this.#listPicker(chatID, "Which conversation? (tap one, or type a title / paste an ID · /cancel to stop)", true)
          break
        }
        await this.#resolveUse(chatID, arg)
        break
      }
      case "abort": {
        if (!c.inflight) return tg.sendMessage({ chatID, text: "(no turn in flight)" })
        await ws.adapter.abort(c.sessionID ?? "")
        c.inflight.abort()
        c.inflight = null
        await tg.sendMessage({ chatID, text: "⏹ stopped" })
        break
      }
      case "ws": {
        const names = this.#workspaces.map((w) => w.name)
        if (arg) {
          if (!names.includes(arg)) return tg.sendMessage({ chatID, text: `no workspace '${arg}'` })
          c.workspace = arg
          c.sessionID = null
          c.picker = null
          c.del = null
          c.page = 0
          await tg.sendMessage({ chatID, text: `workspace: ${arg}` })
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
          await tg.sendMessage({ chatID, text: "⏰ usage: /remind <5s–7d> <what>\ne.g. /remind 2h check the build" })
          break
        }
        const timer = setTimeout(() => {
          this.#reminders.delete(timer)
          void tg.sendMessage({ chatID, text: `⏰ ${spec.what}`, disableNotification: true }).catch(() => {})
        }, spec.ms)
        timer.unref?.() // never keep the process alive just for a reminder
        this.#reminders.add(timer)
        await tg.sendMessage({ chatID, text: `⏰ ok — reminder in ${fmtDuration(spec.ms)}.` })
        break
      }
      default:
        await tg.sendMessage({ chatID, text: `unknown command /${cmd} (try /help)` })
    }
  }

  // create a fresh conversation; when exactly one harness exists it is chosen
  // automatically (TODO(harness-picker): surface multi-harness choice as
  // buttons instead of silently preferring the active workspace's engine)
  async #newConversation(chatID: number, replyId: number | null, title?: string): Promise<void> {
    const c = this.#chat(chatID)
    const harnesses = this.#harnesses()
    let ws = this.#ws(c.workspace)
    if (c.harness && this.#wsFor(c.harness)) {
      ws = this.#wsFor(c.harness)!
    } else if (harnesses.length === 1) {
      c.harness = harnesses[0]!
    }
    const s = await ws.adapter.createSession(title || "New conversation")
    c.sessionID = s.id
    c.picker = null
    c.del = null
    c.page = 0
    if (replyId === null) await this.#tg.sendMessage({ chatID, text: "💬 new conversation" })
    else await this.#tg.editMessageText({ chatID, messageID: replyId, text: "💬 new conversation", replyMarkup: null })
  }

  // list sessions as tappable title buttons; callback snapshots into c.picker
  // each row: the conversation (tap to switch) + a small 🗑 next to it (tap
  // for a delete confirmation, via the existing deld/dely/deln flow) — one
  // view does both jobs, so there's no separate delete-only picker anymore.
  async #listPicker(chatID: number, caption: string, forceReply = false): Promise<void> {
    const c = this.#chat(chatID)
    const ws = this.#ws(c.workspace)
    const sessions = await ws.adapter.listSessions()
    if (!sessions.length) {
      await this.#tg.sendMessage({ chatID, text: "(no conversations yet — just send a message)" })
      return
    }
    const sorted = [...sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    const shown = sorted.slice(0, MAX_LIST)
    const list = shown.map((s) => {
      const marker = s.id === c.sessionID ? "  ◀" : ""
      const title = this.#displayTitle(s.id, s.title)
      return `${shown.indexOf(s) + 1}. "${title}"${marker}`
    })
    const rows: InlineButton[][] = shown.map((s, i) => [
      btn(`${i + 1}. ${this.#displayTitle(s.id, s.title)}`, `open:${i}`),
      { ...btn("🗑", `deld:${i}`), style: "danger" as const },
    ])
    const lines = [caption, "", ...list, ...(sorted.length > MAX_LIST ? [`… and ${sorted.length - MAX_LIST} more`] : [])]

    let messageID: number | undefined
    if (forceReply) {
      // force_reply only exists on the classic keyboard — rich message
      // buttons (below) can't carry it, so /use's "type or tap" prompt keeps
      // the classic, evenly-split row. Nothing else needs forceReply.
      const markup = kin(rows)
      markup.force_reply = true
      const msg = await this.#tg.sendMessage({ chatID, text: lines.join("\n"), replyMarkup: markup })
      messageID = msg.message_id
    } else {
      // rich message buttons (same format #menu uses for Settings) size each
      // button to its own label instead of splitting the row evenly, so the
      // 🗑 actually reads as smaller than the conversation button next to it
      messageID = (await this.#menu(chatID, lines, rows)).messageID
    }
    if (messageID === undefined) return
    c.picker = { messageID, ws: c.workspace, sessions: shown.map((s) => s.id) }
    c.del = null
    c.page = 0
  }

  async #freeText(chatID: number, text: string, opts?: { filePaths?: string[] }): Promise<void> {
    const c = this.#chat(chatID)
    const promptText = text || (opts?.filePaths?.length ? "see the attached file" : "")
    const sessionID = await this.#ensureSession(chatID, promptText)
    const ws = this.#ws(c.workspace)
    const internals = this.#store.internals(chatID)

    const ac = new AbortController()
    c.inflight = ac

    // Streaming draft: prefer a RICH draft (Bot API 10.1+ — tables, code and the
    // collapsible thinking/tool details render live) with a native stop button;
    // fall back to a plain-text draft, then the legacy placeholder.
    const draftID = c.draft + 1
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
      this.#tg.sendChatAction({ chatID, action: "typing" }).catch(() => {})
    }, 4000)

    const mdl = this.#store.model(chatID)
    let model
    if (mdl) {
      const sep = mdl.indexOf("/")
      model = { providerID: mdl.slice(0, sep), modelID: mdl.slice(sep + 1) }
    }

    const sub = new AbortController()
    let lastEdit = 0
    let lastText: string | null = null
    let lastHadMarkup = true
    let lastRich = ""
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
      const blocks = buildLiveBlocks(liveParts, internals, flushedToolIDs, reasoningStarted)
      const json = JSON.stringify(blocks)
      if (json === lastRich) return
      lastRich = json
      if (blocks.length === 0) return // nothing to show yet — keep the "…" frame
      const tail = textOf(liveParts).slice(-(MAX_MSG - 80))
      const hint = closeStreamingTable(tail)
      try {
        if (draftMode === "rich") await this.#tg.sendRichMessageDraft({ chatID, draftID, rich_message: { blocks } })
        else if (draftMode === "text") await this.#tg.sendMessageDraft({ chatID, draftID, text: hint })
        else if (placeholder) await this.#tg.editMessageText({ chatID, messageID: placeholder.message_id, text: hint || "…" })
      } catch (err) {
        console.error(`[draft] renderLive send failed (mode=${draftMode}): ${(err as Error)?.message ?? err}`)
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
      if (blocks.length) {
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
        } catch {
          // rich (or file embedding) unsupported → classic text + separate files
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
      if (blocks.length) {
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
        } catch {
          /* rich unsupported → markdown fallback below */
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
      } catch {
        /* subscription closed */
      }
    })()

    try {
      const reply = await ws.adapter.prompt(sessionID, promptText, {
        signal: ac.signal,
        ...(model ? { model } : {}),
        ...(opts?.filePaths?.length ? { filePaths: opts.filePaths } : {}),
      })
      // prompt() only returns the LAST step of a turn; pull every assistant part
      // since the user's message so earlier steps' reasoning + tool calls show.
      let turn = reply.parts
      try {
        const all = await ws.adapter.messages(sessionID)
        const lastUser = all.reduce((idx, m, i) => (m.role === "user" ? i : idx), -1)
        if (lastUser >= 0 && lastUser < all.length - 1) turn = all.slice(lastUser + 1).flatMap((m) => m.parts)
      } catch {
        /* fall back to the single returned message */
      }
      const media = turn.filter((p): p is FilePart => p.kind === "file")
      // tool/reasoning parts already posted as their own message during
      // streaming stay out of the final combined message (dropFlushed)
      const shown = await presentParts(dropFlushed(turn), internals)
      if (!shown && textOf(turn).trim()) await presentBody(textOf(turn), media)
      else if (!shown && placeholder) await this.#tg.deleteMessage({ chatID, messageID: placeholder.message_id })
    } catch (err) {
      if (ac.signal.aborted) {
        // render whatever we streamed so far (partial details included)
        const shown = await presentParts(dropFlushed(liveParts), internals)
        if (!shown) await presentBody("(stopped)")
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
      sub.abort()
      await streamTask.catch(() => {})
      c.inflight = null
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
        } catch {
          /* not an admin / ephemeral unsupported → plain prompt below */
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
    const ws = this.#ws(c.workspace)
    const sorted = [...(await ws.adapter.listSessions())].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
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
    c.picker = { messageID: reply.message_id, ws: c.workspace, sessions: ids }
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
    } catch {
      /* rich messages unavailable → classic text + inline keyboard */
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
    const ws = this.#ws(c.workspace)
    const active = c.sessionID ? await ws.adapter.getSession(c.sessionID) : null
    const label = active ? this.#displayTitle(active.id, active.title) : "(none)"
    const model = this.#store.model(chatID) ?? "default"

    const lines = [
      "⚙️ Settings",
      "",
      `engine: ${c.harness ?? ws.adapter.id}`,
      `model: ${model}`,
      `conversation: "${label}"`,
      `workspace: ${c.workspace}`,
    ]
    const rows: InlineButton[][] = [
      [btn(`🤖 Model · ${model}`, "set:model")],
      [btn(`🔎 Internals · ${internalsPreset(this.#store.internals(chatID))}`, "set:internals")],
      [btn("✏️ Rename conversation", "set:rename")],
      ...(this.#workspaces.length > 1 ? [[btn(`🗂 Workspace · ${c.workspace}`, "set:ws")]] : []),
      [btn("‹ Done", "set:done")],
    ]

    const sent = await this.#menu(chatID, lines, rows, messageID === null ? undefined : { messageID })
    if (sent.messageID !== undefined) c.settingsMsg = sent.messageID
  }

  // 🗂 Workspace: only worth showing when there's more than one to pick from —
  // switching starts a fresh conversation there (sessions are per-workspace).
  async #settingsWorkspace(chatID: number, messageID: number | null): Promise<void> {
    const c = this.#chat(chatID)
    const rows: InlineButton[][] = this.#workspaces.map((w) => {
      const b = btn(w.name, `wsw:${w.name}`)
      if (w.name === c.workspace) b.style = "success"
      return [b]
    })
    rows.push([btn("‹ Back", "set:root")])
    const lines = ["🗂 Workspace", "", `current: ${c.workspace}`, "", "Tap one to switch — starts a fresh conversation there."]
    await this.#menu(chatID, lines, rows, messageID === null ? undefined : { messageID })
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
    const ws = this.#ws(c.workspace)
    const current = this.#store.model(chatID)
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
    const page = Math.max(0, Math.min(requestPage ?? c.settingsPage ?? 0, pages - 1))
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
    const ws = this.#ws(c.workspace)
    const current = this.#store.model(chatID) ?? "default"
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
    if (c.sessionID) {
      c.awaiting = { kind: "rename", sessionID: c.sessionID }
      await this.#tg.editMessageText({ chatID, messageID, text: "✏️ Type the new name for this conversation…", replyMarkup: null })
      return
    }
    const ws = this.#ws(c.workspace)
    const sorted = [...(await ws.adapter.listSessions())].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    const ids = sorted.map((s) => s.id)
    if (!ids.length) {
      await this.#tg.editMessageText({ chatID, messageID, text: "(no conversations to rename — just send a message first)", replyMarkup: null })
      return
    }
    const pages = Math.max(1, Math.ceil(ids.length / MAX_LIST))
    const page = Math.max(0, Math.min(requestPage ?? c.page, pages - 1))
    c.page = page
    const rows: InlineButton[][] = ids
      .slice(page * MAX_LIST, (page + 1) * MAX_LIST)
      .map((id) => [btn(this.#displayTitle(id, ""), `ren:${ids.indexOf(id)}`)])
    if (pages > 1) {
      const prev = btn("‹ Prev", "renp:prev")
      const next = btn("Next ›", "renp:next")
      if (page <= 0) prev.disabled = true
      if (page >= pages - 1) next.disabled = true
      rows.push([prev, btn(`page ${page + 1} / ${pages}`, "renp:page"), next])
    }
    rows.push([btn("‹ Back", "set:root")])
    c.picker = { messageID, ws: c.workspace, sessions: ids }
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
    const ws = this.#ws(c.workspace)
    const [verb, rest] = data.split(":")
    const i = Number(rest)

    switch (verb) {
      case "set":
        if (rest === "root") await this.#settingsRoot(chatID, msg.message_id)
        else if (rest === "model") await this.#settingsModel(chatID, msg.message_id)
        else if (rest === "internals") await this.#settingsInternals(chatID, msg.message_id)
        else if (rest === "rename") await this.#settingsRename(chatID, msg.message_id)
        else if (rest === "ws") await this.#settingsWorkspace(chatID, msg.message_id)
        else if (rest === "done") {
          c.settingsMsg = null
          await this.#tg.editMessageText({ chatID, messageID: msg.message_id, text: "⚙️ closed", replyMarkup: null })
        } else {
          await tg.answerCallbackQuery({ id: cq.id, text: "stale menu" })
          break
        }
        await tg.answerCallbackQuery({ id: cq.id })
        break
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
        if (rest === "off") this.#store.clearModel(chatID)
        else this.#store.setModel(chatID, rest)
        await this.#settingsModel(chatID, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id, text: rest === "off" ? "back to default" : `model: ${rest}` })
        break
      }
      case "ren": {
        const p = c.picker
        if (!p || p.ws !== c.workspace) return tg.answerCallbackQuery({ id: cq.id, text: "menu expired - run /settings" })
        const id = p.sessions[i]
        if (!id) return tg.answerCallbackQuery({ id: cq.id, text: "no such conversation" })
        c.awaiting = { kind: "rename", sessionID: id }
        await this.#tg.editMessageText({ chatID, messageID: msg.message_id, text: "✏️ Type the new name for this conversation…", replyMarkup: null })
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
      case "hns": {
        const h = this.#wsFor(rest)
        if (!h) return tg.answerCallbackQuery({ id: cq.id, text: "no such engine" })
        c.harness = rest
        const s = await h.adapter.createSession("New conversation")
        c.sessionID = s.id
        c.picker = null
        c.del = null
        c.page = 0
        await this.#tg.editMessageText({ chatID, messageID: msg.message_id, text: `💬 new conversation · engine: ${rest}`, replyMarkup: null })
        await tg.answerCallbackQuery({ id: cq.id, text: `engine: ${rest}` })
        break
      }
      case "open": {
        const p = c.picker
        if (!p || p.ws !== c.workspace) return tg.answerCallbackQuery({ id: cq.id, text: "menu expired - run /ls again" })
        const id = p.sessions[i]
        if (!id) return tg.answerCallbackQuery({ id: cq.id, text: "no such conversation" })
        c.sessionID = id
        c.del = null
        c.awaiting = null
        const s = await ws.adapter.getSession(id)
        await this.#tg.editMessageText({ chatID, messageID: p.messageID, text: `▶ "${this.#displayTitle(id, s?.title ?? "")}"`, replyMarkup: null })
        await tg.answerCallbackQuery({ id: cq.id, text: "opened" })
        break
      }
      case "deld": {
        const p = c.picker
        if (!p || p.ws !== c.workspace) return tg.answerCallbackQuery({ id: cq.id, text: "menu expired - run /ls again" })
        const id = p.sessions[i]
        if (!id) return tg.answerCallbackQuery({ id: cq.id, text: "no such conversation" })
        c.del = { messageID: p.messageID, i }
        const s = await ws.adapter.getSession(id)
        await this.#tg.editMessageText({
          chatID,
          messageID: p.messageID,
          text: `Delete "${this.#displayTitle(id, s?.title ?? "")}"?`,
          replyMarkup: kin([[btn("🗑 Delete", "dely")], [btn("Cancel", "deln")]]),
        })
        await tg.answerCallbackQuery({ id: cq.id })
        break
      }
      case "dely": {
        const d = c.del
        const p = c.picker
        if (!d || !p) return tg.answerCallbackQuery({ id: cq.id, text: "nothing to delete" })
        const id = p.sessions[d.i]
        if (id) {
          await ws.adapter.deleteSession(id)
          if (c.sessionID === id) c.sessionID = null
        }
        c.picker = null
        c.del = null
        await this.#tg.editMessageText({ chatID, messageID: d.messageID, text: "🗑 deleted", replyMarkup: null })
        await tg.answerCallbackQuery({ id: cq.id, text: "deleted" })
        break
      }
      case "deln": {
        const d = c.del
        c.del = null
        if (d) await this.#tg.editMessageText({ chatID, messageID: d.messageID, text: "canceled", replyMarkup: null })
        await tg.answerCallbackQuery({ id: cq.id, text: "canceled" })
        break
      }
      case "wsw": {
        if (!this.#workspaces.some((w) => w.name === rest)) return tg.answerCallbackQuery({ id: cq.id, text: "no such workspace" })
        c.workspace = rest
        c.sessionID = null
        c.picker = null
        c.del = null
        c.page = 0
        await this.#settingsWorkspace(chatID, msg.message_id)
        await tg.answerCallbackQuery({ id: cq.id, text: `workspace: ${rest}` })
        break
      }
      case "abt": {
        if (!c.inflight) return tg.answerCallbackQuery({ id: cq.id, text: "nothing running" })
        await ws.adapter.abort(c.sessionID ?? "")
        c.inflight.abort()
        await tg.answerCallbackQuery({ id: cq.id, text: "stopping…" })
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
          await this.#tg.deleteEphemeralMessage({ chatID, ephemeralMessageID: pending.ephemeralID }).catch(() => {})
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
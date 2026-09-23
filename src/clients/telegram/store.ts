import { readFileSync, writeFileSync } from "node:fs"

/** how much of a part (thinking / tool call) to show */
export type DetailMode = "off" | "collapsed" | "expanded"
/** how reasoning + tool calls are grouped in the reply. "minimal" ignores
 * collapse entirely — just an icon+name line up front, then the answer. */
export type InternalsLayout = "per-step" | "per-section" | "combined" | "minimal"

export interface InternalsSettings {
  thinking: DetailMode
  tools: DetailMode
  layout: InternalsLayout
}

export const DEFAULT_INTERNALS: InternalsSettings = {
  thinking: "collapsed",
  tools: "collapsed",
  layout: "per-step",
}

export interface StoreData {
  // session id -> display-name override (client-side; never touches the harness)
  titles: Record<string, string>
  // "<chat id>:<harness>" -> "provider/model". Scoped per harness because a
  // model is only meaningful to the harness that offers it: carrying an
  // opencode-go model into Codex asks it to run something it has never heard
  // of, and it fails the turn rather than ignoring it.
  models: Record<string, string>
  // chat id -> how much agent internals (thinking / tool calls) to show
  internals?: Record<string, InternalsSettings>
  // chat id -> primary agent name (e.g. "build", "plan")
  agents?: Record<string, string>
  // chat id -> message id of the pinned live status message
  statusMsgs?: Record<string, number>
  // chat id -> whether a fresh session's first prompt gets the jep context
  // header prepended (default: on — see StoreData.injectContext)
  injectContext?: Record<string, boolean>
  // workspace directories added from the phone. JEP_WORKSPACES is the
  // boot-time env list and can only be changed at a keyboard; these are the
  // ones picked through the browser, and they have to outlive a restart or
  // adding a project on mobile would be a per-session ritual.
  workspaces?: string[]
  // workspace dir -> last known sessions there. opencode scopes /session to
  // the calling instance's own project, so listing a project's conversations
  // otherwise means having a server running for it. Remembering what we saw
  // last time lets /ls show every project without starting anything.
  sessionIndex?: Record<string, IndexedSession[]>
  // chat id -> where that chat was last pointed. ChatState is in-memory, so
  // without this a restart silently moved you: workspace fell back to the
  // first one and the conversation to whatever was newest there. Keyed by
  // directory, not workspace name, since names can shift on collision.
  chatContext?: Record<string, { dir: string; sessionID: string | null; harness?: string }>
  // chat id -> prompts that were queued behind a running turn but had not
  // started yet. The queue lived only in memory, so a restart silently ate
  // every message you had fired off while the agent worked. The turn *in
  // flight* is deliberately not here: the harness keeps running it
  // server-side, so replaying it would ask for the same work twice.
  pending?: Record<string, PendingPrompt[]>
  // chat id -> a prompt that couldn't be delivered because the session was
  // held by another run, kept so the "⏹ Stop it & send" button still means
  // something after a restart.
  held?: Record<string, HeldPrompt>
  // chat id -> last draft id handed out. Telegram draft ids are consumed once
  // the real message lands, and a reused one is accepted but never rendered.
  // The counter lived only in memory, so every first turn after a restart
  // asked for draft 1 again and silently got no preview at all.
  draftSeq?: Record<string, number>
}

/** a queued prompt, in the only form worth replaying: what to say, and when it was said */
export interface PendingPrompt {
  text: string
  filePaths?: string[]
  queuedAt: number
}

export interface HeldPrompt {
  sessionID: string
  text: string
  filePaths?: string[]
}

export interface IndexedSession {
  id: string
  title: string
  updatedAt: number
}

// Model keys used to be the bare chat id, from when opencode was the only
// harness. Fold those into the harness-scoped form once, on load, so an
// existing chat keeps the model it was already using.
const LEGACY_MODEL_HARNESS = "opencode"
function migrateModelKeys(models: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(models)) {
    out[k.includes(":") ? k : `${k}:${LEGACY_MODEL_HARNESS}`] = v
  }
  return out
}

// One directory can be served by two harnesses at once, and their session
// lists are entirely separate — keyed by directory alone they would overwrite
// each other on every /ls, and the survivor's ids would be offered to the
// wrong harness.
const indexKey = (dir: string, harness?: string | null): string => (harness ? `${harness}\u0000${dir}` : dir)

export class ChatStore {
  #titles: Record<string, string>
  #models: Record<string, string>
  #internals: Record<string, InternalsSettings>
  #agents: Record<string, string>
  #statusMsgs: Record<string, number>
  #injectContext: Record<string, boolean>
  #workspaces: string[]
  #sessionIndex: Record<string, IndexedSession[]>
  #chatContext: Record<string, { dir: string; sessionID: string | null; harness?: string }>
  #draftSeq: Record<string, number>
  #pending: Record<string, PendingPrompt[]>
  #held: Record<string, HeldPrompt>
  #file: string | null

  // takes the persisted shape as-is: this grew to seven positional args and
  // every new field was another chance to line them up wrong
  constructor(d: StoreData, file: string | null) {
    this.#titles = d.titles ?? {}
    this.#models = migrateModelKeys(d.models ?? {})
    this.#internals = d.internals ?? {}
    this.#agents = d.agents ?? {}
    this.#statusMsgs = d.statusMsgs ?? {}
    this.#injectContext = d.injectContext ?? {}
    this.#workspaces = d.workspaces ?? []
    this.#sessionIndex = d.sessionIndex ?? {}
    this.#chatContext = d.chatContext ?? {}
    this.#draftSeq = d.draftSeq ?? {}
    this.#pending = d.pending ?? {}
    this.#held = d.held ?? {}
    this.#file = file
  }

  static load(file: string | null): ChatStore {
    if (!file) return new ChatStore({} as StoreData, null)
    try {
      return new ChatStore(JSON.parse(readFileSync(file, "utf8")) as StoreData, file)
    } catch {
      return new ChatStore({} as StoreData, file)
    }
  }

  title(id: string): string | null {
    return this.#titles[id] ?? null
  }

  model(chatID: number, harness: string): string | null {
    return this.#models[`${chatID}:${harness}`] ?? null
  }

  internals(chatID: number): InternalsSettings {
    return { ...DEFAULT_INTERNALS, ...(this.#internals[String(chatID)] ?? {}) }
  }

  agent(chatID: number): string | null {
    return this.#agents[String(chatID)] ?? null
  }

  setAgent(chatID: number, name: string): void {
    this.#agents[String(chatID)] = name
    this.#save()
  }

  statusMsg(chatID: number): number | null {
    return this.#statusMsgs[String(chatID)] ?? null
  }

  setStatusMsg(chatID: number, messageID: number): void {
    this.#statusMsgs[String(chatID)] = messageID
    this.#save()
  }

  injectContext(chatID: number): boolean {
    return this.#injectContext[String(chatID)] ?? true
  }

  setInjectContext(chatID: number, on: boolean): void {
    this.#injectContext[String(chatID)] = on
    this.#save()
  }

  /** workspace directories added from the phone (not the JEP_WORKSPACES env) */
  workspaces(): string[] {
    return [...this.#workspaces]
  }

  addWorkspace(dir: string): void {
    if (this.#workspaces.includes(dir)) return
    this.#workspaces.push(dir)
    this.#save()
  }

  removeWorkspace(dir: string): void {
    const i = this.#workspaces.indexOf(dir)
    if (i < 0) return
    this.#workspaces.splice(i, 1)
    this.#save()
  }

  /** where a chat was last pointed, so a restart doesn't silently move it */
  chatContext(chatID: number): { dir: string; sessionID: string | null; harness?: string } | null {
    return this.#chatContext[String(chatID)] ?? null
  }

  /** every chat's saved context, for restoring harnesses at boot */
  allChatContexts(): Array<{ dir: string; sessionID: string | null; harness?: string }> {
    return Object.values(this.#chatContext)
  }

  setChatContext(chatID: number, dir: string, sessionID: string | null, harness?: string): void {
    const prev = this.#chatContext[String(chatID)]
    if (prev && prev.dir === dir && prev.sessionID === sessionID && prev.harness === harness) return
    this.#chatContext[String(chatID)] = { dir, sessionID, ...(harness ? { harness } : {}) }
    this.#save()
  }

  /** next draft id for a chat — monotonic across restarts, never reused */
  nextDraftID(chatID: number): number {
    const next = (this.#draftSeq[String(chatID)] ?? 0) + 1
    this.#draftSeq[String(chatID)] = next
    this.#save()
    return next
  }

  /** prompts queued but not yet started, oldest first */
  pending(chatID: number): PendingPrompt[] {
    return this.#pending[String(chatID)] ?? []
  }

  setPending(chatID: number, items: PendingPrompt[]): void {
    const key = String(chatID)
    // this is written on every queue change, which is every message — don't
    // rewrite the file to say the same thing
    const prev = this.#pending[key] ?? []
    if (prev.length === items.length && prev.every((p, i) => p.text === items[i]!.text && p.queuedAt === items[i]!.queuedAt)) return
    if (items.length) this.#pending[key] = items
    else delete this.#pending[key]
    this.#save()
  }

  /** every chat with something waiting, for the boot-time recovery */
  allPending(): Array<{ chatID: number; items: PendingPrompt[] }> {
    return Object.entries(this.#pending).map(([k, items]) => ({ chatID: Number(k), items }))
  }

  held(chatID: number): HeldPrompt | null {
    return this.#held[String(chatID)] ?? null
  }

  setHeld(chatID: number, h: HeldPrompt | null): void {
    const key = String(chatID)
    if (h) this.#held[key] = h
    else if (!(key in this.#held)) return
    else delete this.#held[key]
    this.#save()
  }

  /** last known sessions for a workspace dir, newest first */
  indexedSessions(dir: string, harness?: string | null): IndexedSession[] {
    return this.#sessionIndex[indexKey(dir, harness)] ?? []
  }

  /** remember what a live workspace is holding, so /ls can show it cold later */
  setIndexedSessions(dir: string, harness: string, rows: IndexedSession[]): void {
    const key = indexKey(dir, harness)
    const prev = this.#sessionIndex[key]
    // listing runs on every /ls; skip the write when nothing actually moved
    if (prev && prev.length === rows.length && prev.every((p, k) => p.id === rows[k]!.id && p.title === rows[k]!.title && p.updatedAt === rows[k]!.updatedAt)) return
    this.#sessionIndex[key] = rows
    this.#save()
  }

  setTitle(id: string, title: string): void {
    if (title.trim()) this.#titles[id] = title.trim()
    else delete this.#titles[id]
    this.#save()
  }

  setModel(chatID: number, harness: string, model: string): void {
    this.#models[`${chatID}:${harness}`] = model
    this.#save()
  }

  clearModel(chatID: number, harness: string): void {
    delete this.#models[`${chatID}:${harness}`]
    this.#save()
  }

  setInternals(chatID: number, settings: InternalsSettings): void {
    this.#internals[String(chatID)] = settings
    this.#save()
  }

  clearAll(chatID: number): void {
    for (const k of Object.keys(this.#models)) if (k.startsWith(`${chatID}:`)) delete this.#models[k]
    this.#titles = {}
    this.#save()
  }

  #save(): void {
    if (!this.#file) return
    writeFileSync(
      this.#file,
      JSON.stringify(
        {
          titles: this.#titles,
          models: this.#models,
          internals: this.#internals,
          agents: this.#agents,
          statusMsgs: this.#statusMsgs,
          injectContext: this.#injectContext,
          workspaces: this.#workspaces,
          sessionIndex: this.#sessionIndex,
          chatContext: this.#chatContext,
          draftSeq: this.#draftSeq,
          pending: this.#pending,
          held: this.#held,
        },
        null,
        2,
      ),
    )
  }
}
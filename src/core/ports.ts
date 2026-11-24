import type { ConversationMcp } from "./mcp.ts"
import type {
  AskRequest,
  DomainEvent,
  FileDiff,
  HarnessError,
  McpServer,
  Message,
  ProjectSummary,
  SessionHold,
  SessionSummary,
  SkillDirs,
} from "./types.ts"

export interface ModelRef {
  providerID: string
  modelID: string
}

/** which content kinds a model accepts, per opencode's capability metadata */
export interface ModelCaps {
  image: boolean
  attachment: boolean
  // max input tokens the model accepts (harness-reported), 0 when unknown
  contextLimit: number
}

/** A harness-specific control rendered generically by clients. */
export interface HarnessSettingSpec {
  id: string
  label: string
  description: string
  default: boolean
  danger?: boolean
}

/** A primary agent a harness can run a turn under. Ids are the harness's own
 * (opencode's "build"/"plan", claude's agent types) and opaque to clients;
 * `default` marks the one the harness uses when none is chosen. */
export interface AgentRef {
  id: string
  label: string
  detail?: string
  default?: boolean
}

/**
 * A single live connection to one harness workspace. This is the "driven
 * adapter" seam of the hexagonal core: every harness we ever support (opencode
 * serve, goosed, dsh) gets normalized down to exactly this surface.
 */
/**
 * What the daemon's own services (watches, restart, picking up after a
 * restart) need of whoever runs the turns. They know nothing of HTTP or of any
 * one client: the gateway implements this today, and anything else that runs
 * turns can implement it too.
 */
export interface TurnHost {
  /** the conversation a caller means: the one it names, else the only turn
   * running in its directory. A string is the reason none can be found. */
  resolve(session: string | undefined, cwd: string | undefined): Promise<{ key: string; adapter: HarnessAdapter } | string>
  /** a conversation by key, while it still exists */
  find(key: string): Promise<HarnessAdapter | null>
  /** queue a turn that steers nothing, behind whatever is running. `notice` is
   * the daemon's own business (a watch's wake-up): it runs alone instead of
   * merging with a person's waiting words, and clients draw it as a boundary
   * rather than as something they said */
  enqueue(key: string, text: string, opts?: { resume?: boolean; notice?: boolean }): void
  /** after a restart: pick up every loop that was running; the conversations resumed. Absent, loops end with the restart. */
  resumeLoops?(): Promise<string[]>
  /** after a restart: start the waiting prompts a restart kept (unless a stop held them); the conversations started. Absent, they wait for the next prompt. */
  resumeQueues?(): Promise<string[]>
  /** `jep-end-turn` from the agent: this turn is the last one a keep going runs (core/keepgoing.ts). Absent, the command stopped nothing. */
  declareDone?(key: string): { keeping: boolean; declared: boolean; relentless?: boolean }
  /** conversations with a turn running, settling or waiting */
  busy(): number
  /** told as turns begin and end */
  observe(listener: TurnListener): void
  /** true once the daemon is shutting down */
  closing(): boolean
}

/** One conversation, as another may be told of it (`jep-read --list`) */
export interface ChatInfo {
  id: string
  title: string
  harness: string
  workspace: string
  updatedAt: number
}

/**
 * What the daemon's own services need to let one agent read another's conversation: the list, the
 * messages, and a way to put a question to the person. The gateway implements it; nothing here
 * knows how it is asked.
 */
export interface ChatDirectory {
  list(): Promise<ChatInfo[]>
  /** the newest `last` messages (0 = all) with the conversation's own title; null when it is gone */
  read(id: string, last: number): Promise<{ info: ChatInfo; messages: import("./types.ts").Message[] } | null>
  /** put a choice to the person inside conversation `key`, and wait: the chosen option id, or null when
   *  nobody answered in time or the card was stood down */
  askPerson(key: string, ask: { title: string; detail: string; options: { id: string; label: string; style?: "success" | "danger" }[] }, waitMs: number): Promise<string | null>
}

/**
 * The cards the daemon raises on its own account (`askPerson`: an agent asks to read or message
 * another conversation). A harness's ask reaches a client through that harness's event stream, but
 * these have no harness behind them, so the gateway's own broadcast was the only road, and it
 * reaches only the gateway's clients. Every other client that can put a card in front of the
 * person (Telegram) subscribes here instead, so a card is never shown on one client and missing
 * on another.
 */
export interface DaemonAskPort {
  /** a card was raised: show it where the person is */
  onRequested(listener: (ask: AskRequest) => void): () => void
  /** a card ended: answered (on any client), denied, or timed out (`optionID` null) */
  onResolved(listener: (askID: string, optionID: string | null) => void): () => void
  /** answer a card from this client; false when it is already settled */
  answer(askID: string, optionID: string): boolean
}

/** Successful conversation deletion, shared by every client. */
export interface ConversationDeletionPort {
  onDeleted(listener: (sessionID: string) => Promise<void> | void): () => void
  deleted(sessionID: string): Promise<void>
}

export interface ConversationSnapshot {
  info: ChatInfo
  model: string | null
  agent: string | null
  archived: boolean
  busy: boolean
  messages: Message[]
}

/** Shared conversation access and change notifications for every client. */
export interface ConversationSyncSource {
  list(): Promise<ChatInfo[]>
  read(id: string, limit: number): Promise<ConversationSnapshot | null>
  update(id: string, patch: { title?: string; model?: string | null; agent?: string | null }): Promise<void>
  prompt(id: string, text: string, opts?: Parameters<HarnessAdapter["prompt"]>[2]): Promise<Message>
  stop(id: string): Promise<boolean>
}

export interface ConversationSyncPort extends ConversationSyncSource {
  ready: boolean
  connect(source: ConversationSyncSource): void
  onChanged(listener: (id: string) => Promise<void> | void): () => void
  changed(id: string): Promise<void>
}

export interface TurnListener {
  /** `resume`: this turn is itself a pick-up of one a restart cut off */
  started?(key: string, resume: boolean): void
  /** `cutOff`: the daemon is shutting down and the turn died, it did not finish */
  ended?(key: string, cutOff: boolean): void
}

/** a harness's brand mark: one filled SVG path in a `box` × `box` square */
export interface HarnessMark {
  box: number
  path: string
}

/** One slash command a harness offers, as a client lists it. */
export interface HarnessCommand {
  /** without the leading slash */
  name: string
  description?: string
  /** where the harness found it: "skill", "prompt", "extension", "builtin", … */
  source: string
}

/** Daemon-wide execution policy, shared by every client and turn runner. */
export interface ExecutionPolicyPort {
  enabled(): boolean
  setEnabled(enabled: boolean): void
  apply(settings?: Record<string, boolean>): Record<string, boolean> | undefined
}

export interface HarnessAdapter {
  readonly id: string
  /** true when the harness reports the end of each step (opencode's step-finish), so a steer waits
   *  for the step; otherwise it folds in as soon as a tool call finishes */
  readonly reportsSteps?: boolean
  /** true when every turn can be given MCP servers of its own (opts.mcp); a client's definition is
   *  refused for a harness without it, never silently dropped */
  readonly takesMcp?: boolean
  readonly workspace: string
  readonly endpoint: string

  health(): Promise<{ healthy: boolean; version: string }>
  createSession(title?: string): Promise<SessionSummary>
  getSession(id: string): Promise<SessionSummary | null>
  listSessions(): Promise<SessionSummary[]>
  /** the subagent sessions a conversation spawned, when the harness has them.
   * They are filtered out of listSessions (counted there instead) and reached
   * from the conversation itself. */
  subagents?(sessionID: string): Promise<SessionSummary[]>
  prompt(
    sessionID: string,
    text: string,
    opts?: {
      timeoutMs?: number
      signal?: AbortSignal
      model?: ModelRef
      /** absolute paths to files attached to the prompt (e.g. images) */
      filePaths?: string[]
      /** primary agent to run this turn under, an id from agents() — omitted
       * means the harness default */
      agent?: string
      /** boolean settings declared by this harness, persisted per session */
      harnessSettings?: Record<string, boolean>
      /** MCP servers a client defined for this conversation (core/mcp.ts), added beside the person's own */
      mcp?: ConversationMcp
      /** the words this message answers. The adapter hands them to its harness
       * in whatever form it takes, and messages() gives them back as a quote
       * part, never as text in the message (see quoteBlock) */
      quote?: string
      /** whether this turn may carry jep's context header (see contextFor).
       * Default true; a client that has its own header or a user toggle turns
       * it off. The adapter still adds it at most once per conversation. */
      brief?: boolean
    },
  ): Promise<Message>
  /** @param opts.limit ask the harness for only the newest N, when it can
   * page. A long conversation is otherwise megabytes for a 30-message window. */
  messages(sessionID: string, opts?: { limit?: number }): Promise<Message[]>
  deleteSession(id: string): Promise<boolean>
  /** Give the conversation a name in the harness's own store, when it has
   * one. Renaming is otherwise a client-side overlay; a harness that can
   * carry the name (opencode) should, so its TUI and every other reader see
   * it too. Absent or false leaves the overlay as the only name. */
  renameSession?(sessionID: string, title: string): Promise<boolean>
  abort(sessionID: string): Promise<boolean>
  /**
   * A tool this harness started has shown no sign of life for `sinceMs` and the watchdog is about to give
   * up on the turn: end that one tool, not the turn, so the harness sees it fail and carries on. True when
   * something was killed. Absent, the turn is ended as before.
   */
  unwedge?(sessionID: string, sinceMs: number): Promise<boolean>
  /** answer a pending ask with one of its own option ids. False when the ask
   * is unknown or already answered — it may have timed out in the harness, or
   * been answered from somewhere else. */
  respondAsk(sessionID: string, askID: string, optionID: string): Promise<boolean>
  /** stand an ask down without answering it: the person replied in their own
   * words instead. The harness is holding the turn open on that ask, so leaving
   * it pending wedges the turn until someone hits stop — this is what releases
   * it. False when the ask is unknown or already answered. */
  rejectAsk(sessionID: string, askID: string): Promise<boolean>
  events(signal?: AbortSignal): AsyncIterable<DomainEvent>
  /** The last provider failure the harness named for this session (a rate
   * limit, a usage cap) when it never surfaced as a normal event — so a turn
   * that stalled in silence can still say why. Null when nothing is pending. */
  providerError?(sessionID: string): HarnessError | null
  /** where this harness looks for skills, and whether its SKILL.md frontmatter
   * honors a disable flag. Optional: adapters that don't declare it get the
   * shared convention table in core/skills.ts, so a new harness works before
   * it customizes — but every harness can own its own roots. */
  skillDirs?(): SkillDirs
  /** the MCP servers this harness will start, read from its own config: zero turns, true while an agent runs */
  mcpServers?(): Promise<McpServer[]>
  /** switch one of them on or off in the harness's own config, changing nothing else */
  setMcpEnabled?(name: string, enabled: boolean): Promise<void>
  /** the primary agents this harness offers (opencode's build/plan, claude's
   * agent types), for a picker. Omitted or empty when it has no such switch. */
  agents?(): Promise<AgentRef[]>
  models?(): Promise<ModelRef[]>
  /** the `provider/model` a prompt runs on when `opts.model` is omitted — what
   * "default" actually resolves to, so a frontend can name it instead of
   * saying "default" and leaving the user to guess. null when the harness
   * decides at run time and won't say in advance. */
  defaultModel?(): Promise<string | null>
  /** extra per-harness controls; clients render these without knowing the
   * harness that owns them. */
  settings?(): HarnessSettingSpec[]
  /** The id a session settled on. A harness that only learns a session's real
   * id from its first turn (claude) hands out a placeholder before then;
   * clients move to the real id afterwards, so whatever the gateway keeps per
   * session must move with them. Undefined when the id never changes. */
  canonicalId?(sessionID: string): string
  /** `provider/model` -> input capabilities (image/attachment), if known */
  capabilities?(): Promise<Map<string, ModelCaps>>
  /** every project this harness knows of, regardless of which directory this
   * adapter itself is rooted in — lets a frontend discover (and lazily start
   * serving) sessions that live outside the currently active workspace */
  listProjects?(): Promise<ProjectSummary[]>
  /** Who else is in this session right now, when the harness can say — a run
   * started outside jep that owns the session until it ends, so prompt() can
   * only fail. Null when nobody holds it. Consulted on a failed turn, so the
   * user is told "it's busy" rather than handed the harness's own words. */
  sessionHold?(sessionID: string): Promise<SessionHold | null>
  /** End that run so the session takes prompts again. The conversation is
   * kept — this stops the holder, not the history. Never called on its own:
   * it ends somebody's work, so it waits for the user to ask. */
  releaseHold?(sessionID: string): Promise<boolean>
  /** file changes accumulated in this session so far, if the harness tracks them */
  diff?(sessionID: string): Promise<FileDiff[]>
  /** compress the conversation's context ("compact" in opencode). Optional:
   * only harnesses that expose it declare it, and a client hides the control
   * when the adapter doesn't. Returns { ok: false, error: "..." } when the
   * harness refused (a turn may be mid-flight, session not found, etc.). The
   * selected model is supplied when known; adapters can recover it from the
   * native conversation when omitted. */
  compact?(sessionID: string, opts?: { model?: ModelRef }): Promise<{ ok: boolean; error?: string }>
  /** The slash commands this harness accepts for a conversation (prompt
   * templates, skills, built-ins), for a client to list. Optional: only
   * harnesses with a way to ask declare it. Running one is a normal prompt that
   * starts with "/" + name. Empty when the harness has none. */
  commands?(sessionID: string): Promise<HarnessCommand[]>
  /** Put jep's context header into the conversation as a message of its own,
   * if it is due, without the model answering it. The turn engine calls this
   * before a slash command, which must reach the harness as the first thing in
   * its prompt. Optional: without it a command skips the header and the next
   * ordinary message carries it. True when the header was recorded or was not
   * due; false when it could not be recorded. */
  brief?(sessionID: string, opts?: { model?: ModelRef }): Promise<boolean>
  /** Stop the child server. Sessions stay on disk for the next boot. */
  close(): Promise<void>
}

export interface HarnessSupervisor {
  start(workspace: string): Promise<HarnessAdapter>
}

/**
 * One conversation's shell, run in its workspace. The frontend names the
 * session; how the shell is spawned, read and kept alive is the
 * implementation's business — the same way a harness hides its transport.
 */
export interface Terminal {
  /** start the shell for this session, or reattach to the one already running */
  open(sessionID: string, dir: string): Promise<void>
  /** the shell's current screen, as rendered text */
  frame(sessionID: string): Promise<string>
  /** type into it, or press a named key (Enter, Tab, C-c, …) */
  send(sessionID: string, input: { text?: string; key?: string }): Promise<void>
  /** stop it */
  close(sessionID: string): Promise<void>
}

/** A conversation in a harness's *other* store — the one jep doesn't run. */
export interface ImportableSession {
  harness: string
  id: string
  title: string
  dir: string
  updatedAt: number
}

/**
 * Driven port: bring a conversation over from the same harness's other store.
 * Only a harness jep keeps its own store for needs one (opencode); the ones
 * whose store jep reads in place (codex, claude) already list your sessions,
 * so there is nothing to import.
 */
export interface SessionImport {
  readonly harness: string
  /** what could come over, newest first, minus anything jep already has */
  list(): Promise<ImportableSession[]>
  /** fork one across; `dir` names the workspace it belongs to, if it worked */
  fork(id: string): Promise<{ ok: boolean; dir?: string }>
}

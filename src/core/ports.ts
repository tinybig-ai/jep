import type {
  AskRequest,
  DomainEvent,
  FileDiff,
  HarnessError,
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
export interface HarnessAdapter {
  readonly id: "opencode" | string
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
    },
  ): Promise<Message>
  /** @param opts.limit ask the harness for only the newest N, when it can
   * page. A long conversation is otherwise megabytes for a 30-message window. */
  messages(sessionID: string, opts?: { limit?: number }): Promise<Message[]>
  deleteSession(id: string): Promise<boolean>
  abort(sessionID: string): Promise<boolean>
  /** answer a pending ask with one of its own option ids. False when the ask
   * is unknown or already answered — it may have timed out in the harness, or
   * been answered from somewhere else. */
  respondAsk(sessionID: string, askID: string, optionID: string): Promise<boolean>
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
  /** the primary agents this harness offers (opencode's build/plan, claude's
   * agent types), for a picker. Omitted or empty when it has no such switch. */
  agents?(): Promise<AgentRef[]>
  models?(): Promise<ModelRef[]>
  /** the `provider/model` a prompt runs on when `opts.model` is omitted — what
   * "default" actually resolves to, so a frontend can name it instead of
   * saying "default" and leaving the user to guess. null when the harness
   * decides at run time and won't say in advance. */
  defaultModel?(): Promise<string | null>
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
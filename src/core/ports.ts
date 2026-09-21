import type {
  AskRequest,
  DomainEvent,
  FileDiff,
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
  prompt(
    sessionID: string,
    text: string,
    opts?: {
      timeoutMs?: number
      signal?: AbortSignal
      model?: ModelRef
      /** absolute paths to files attached to the prompt (e.g. images) */
      filePaths?: string[]
      /** primary agent to run this turn under (e.g. "build", "plan"), when
       * the harness supports switching — omitted means the harness default */
      agent?: string
    },
  ): Promise<Message>
  messages(sessionID: string): Promise<Message[]>
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
  providerError?(sessionID: string): string | null
  /** where this harness looks for skills, and whether its SKILL.md frontmatter
   * honors a disable flag. Optional: adapters that don't declare it get the
   * shared convention table in core/skills.ts, so a new harness works before
   * it customizes — but every harness can own its own roots. */
  skillDirs?(): SkillDirs
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
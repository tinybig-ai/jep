import type {
  ApprovalRequest,
  DomainEvent,
  FileDiff,
  Message,
  ProjectSummary,
  SessionSummary,
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
  respondApproval(sessionID: string, approval: ApprovalRequest, allow: boolean): Promise<boolean>
  events(signal?: AbortSignal): AsyncIterable<DomainEvent>
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
  /** file changes accumulated in this session so far, if the harness tracks them */
  diff?(sessionID: string): Promise<FileDiff[]>
  /** Stop the child server. Sessions stay on disk for the next boot. */
  close(): Promise<void>
}

export interface HarnessSupervisor {
  start(workspace: string): Promise<HarnessAdapter>
}
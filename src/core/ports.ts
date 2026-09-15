import type {
  ApprovalRequest,
  DomainEvent,
  Message,
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
    },
  ): Promise<Message>
  messages(sessionID: string): Promise<Message[]>
  deleteSession(id: string): Promise<boolean>
  abort(sessionID: string): Promise<boolean>
  respondApproval(sessionID: string, approval: ApprovalRequest, allow: boolean): Promise<boolean>
  events(signal?: AbortSignal): AsyncIterable<DomainEvent>
  models?(): Promise<ModelRef[]>
  /** `provider/model` -> input capabilities (image/attachment), if known */
  capabilities?(): Promise<Map<string, ModelCaps>>
  /** Stop the child server. Sessions stay on disk for the next boot. */
  close(): Promise<void>
}

export interface HarnessSupervisor {
  start(workspace: string): Promise<HarnessAdapter>
}
export type Role = "user" | "assistant"

export interface SessionSummary {
  id: string
  title: string
  workspace: string
  createdAt: number
  // last activity, for "most recently active" ordering — falls back to
  // createdAt when the harness doesn't report it separately
  updatedAt: number
}

// a harness-level grouping sessions belong to (opencode: the enclosing git
// repo root, or a fallback bucket for directories outside any repo) —
// coarser than `workspace`/directory: several directories can share one
export interface ProjectSummary {
  id: string
  worktree: string
}

export interface TextPart {
  kind: "text"
  text: string
}

export interface ToolCallPart {
  kind: "tool"
  id: string
  name: string
  input: unknown
  output: unknown
  status?: "pending" | "running" | "completed" | "error"
  // harness-supplied display hint (e.g. the file path an edit/read/write
  // touched, or a subagent's description) and free-form structured detail
  // (e.g. a computed diff) — richer than input/output, which are the model's
  // literal call args/result and often don't carry a diff or match count
  title?: string
  metadata?: unknown
}

export interface ReasoningPart {
  kind: "reasoning"
  text: string
  // harness's stable part id, when known — lets a live-streamed reasoning
  // block be matched back to itself once a later, separately-fetched
  // snapshot of the same turn comes in (text content alone isn't a safe key:
  // two different steps can produce identical short reasoning)
  id?: string
  // wall-clock time actually spent on this reasoning block, when the harness
  // reports it (only once finalized — never present while still streaming)
  durationMs?: number
}

export interface SnapshotPart {
  kind: "snapshot"
}

export interface FilePart {
  kind: "file"
  filePath: string
  fileName?: string
  mimeType?: string
}

export interface OtherPart {
  kind: "other"
  nativeType: string
}

export type Part =
  | TextPart
  | ToolCallPart
  | ReasoningPart
  | SnapshotPart
  | FilePart
  | OtherPart

export interface Message {
  id: string
  sessionID: string
  role: Role
  time: number
  parts: Part[]
  // harness-reported token usage for this message, when known (assistant
  // messages only) — used to surface context usage, not for billing
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  // the turn failed harness-side (bad credentials, provider refusal, quota).
  // The harness reports these on the message rather than as a failed request,
  // so without this a failed turn is indistinguishable from an empty one.
  error?: { name: string; message: string }
}

// one file's accumulated change within a session, as reported by the harness
export interface FileDiff {
  file: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export interface ApprovalRequest {
  id: string
  sessionID: string
  title: string
  metadata: unknown
}

export type DomainEvent =
  | { type: "server.connected" }
  | { type: "message.created"; sessionID: string; messageID: string; role?: string }
  | { type: "message.updated"; sessionID: string; messageID: string; role?: string }
  | { type: "part.updated"; sessionID: string; messageID: string; partID: string; partType: string; part?: Part }
  | { type: "part.delta"; sessionID: string; messageID: string; partID: string; text: string; partType?: string }
  | { type: "session.idle"; sessionID: string }
  | { type: "permission.requested"; sessionID: string; permissionID: string }
  | { type: "session.error"; sessionID: string; message: string }
  | { type: "other"; eventType: string; sessionID?: string; raw: unknown }
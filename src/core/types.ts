export type Role = "user" | "assistant"

export interface SessionSummary {
  id: string
  title: string
  workspace: string
  createdAt: number
  // last activity, for "most recently active" ordering — falls back to
  // createdAt when the harness doesn't report it separately
  updatedAt: number
  // subagent sessions this one spawned. They never list on their own (a
  // subagent is an implementation detail, not something you meant to open),
  // but the count is worth showing, and they're reachable from the
  // conversation. Undefined/0 when the harness has no such notion.
  subagents?: number
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
  // harness's stable part id, when known — the minimal layout delivers
  // finished text segments as their own messages and must be able to drop
  // exactly those parts from both the live view and the final re-read
  id?: string
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
  /** epoch ms the tool started, when the harness says — a running tool shows
   * a live elapsed time in the draft, so a long tool reads as "waiting" and
   * not as a frozen spinner */
  startedAt?: number
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
  id?: string
}

export interface FilePart {
  kind: "file"
  filePath: string
  fileName?: string
  mimeType?: string
  id?: string
}

export interface OtherPart {
  kind: "other"
  nativeType: string
  id?: string
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
  /**
   * What the harness says this turn cost, in USD. Reported, never computed:
   * opencode prices the call itself and Claude Code returns total_cost_usd, and
   * either is closer to the truth than jep multiplying tokens by a rate card
   * it would have to keep up to date. Absent means the harness didn't say —
   * which is not the same as free, and /usage says so.
   */
  cost?: number
  /** "provider/model" that produced it, where the harness records it */
  model?: string
  // harness-reported token usage for this message, when known (assistant
  // messages only) — context usage, and the denominator for a cost per turn
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  // the turn failed harness-side (bad credentials, provider refusal, quota).
  // The harness reports these on the message rather than as a failed request,
  // so without this a failed turn is indistinguishable from an empty one.
  error?: HarnessError
}

// one file's accumulated change within a session, as reported by the harness
export interface FileDiff {
  file: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

// Another process is holding a session open (Claude Code's background agents,
// say), so a prompt can't be sent into it until that run ends. Not an error
// state: somebody is working in there, and the user has to decide what gives.
export interface SessionHold {
  // what the holder is called, for a message a person has to act on
  label: string
  // epoch ms the holding run started, 0 when the harness doesn't say
  startedAt: number
}

// What a harness needs a person to decide before it can carry on: a tool it
// wants to run, a file it wants to touch, a question the model asked outright.
// One shape for all of them, because from a phone they are the same thing — a
// line of text with buttons under it. The options are the harness's own
// vocabulary (opencode answers "once" / "always" / "reject"); jep carries them
// through rather than inventing a yes/no and mapping back.
export interface AskOption {
  /** what goes back to the harness when this one is tapped */
  id: string
  label: string
  /** green for the safe default, red for the destructive one */
  style?: "success" | "danger"
}

export interface AskRequest {
  id: string
  sessionID: string
  /** one line: what is being asked */
  title: string
  /** the command, the path, the question's own context — shown under the title */
  detail?: string
  options: AskOption[]
  /** permission asks answer once/always/reject; questions carry their own choices */
  kind?: "permission" | "question"
}

// Where a harness looks for skills, and whether flipping
// `disable-model-invocation` in a SKILL.md means anything to it. Declared on
// the adapter port so every harness owns its own roots; core/skills.ts keeps
// the shared convention table for adapters that don't override.
export interface SkillDirs {
  userDirs: string[]
  projectDirs: string[]
  toggleable: boolean
}

// A failure a harness names for a turn. The core models it once so every
// adapter reports the same shape (and carries the provider/model the harness
// knew) and every client renders it identically. Only `message` is guaranteed;
// the rest is present where the harness knows it.
export interface HarnessError {
  name?: string
  message: string
  /** the failing endpoint's provider id, e.g. "opencode-go" */
  provider?: string
  /** the model that was running, when the harness names it */
  model?: string
  /** HTTP status, when the failure carried one (a 429, a 5xx) */
  status?: number
}

export type DomainEvent =
  | { type: "server.connected" }
  | { type: "message.created"; sessionID: string; messageID: string; role?: string }
  | { type: "message.updated"; sessionID: string; messageID: string; role?: string }
  | { type: "part.updated"; sessionID: string; messageID: string; partID: string; partType: string; part?: Part }
  | { type: "part.delta"; sessionID: string; messageID: string; partID: string; text: string; partType?: string }
  | { type: "session.idle"; sessionID: string }
  | { type: "ask.requested"; sessionID: string; ask: AskRequest }
  | { type: "session.error"; sessionID: string; message: string }
  // The turn ended because somebody stopped it. A harness reports that as an
  // error, but it is not a failure, and every client was reading the error's
  // prose to tell the two apart. It is its own fact instead.
  | { type: "turn.aborted"; sessionID: string }
  | { type: "other"; eventType: string; sessionID?: string; raw: unknown }

// Raised by an adapter whose turn was stopped on request. The name is the
// harness's own ("AbortError", "MessageAbortedError", …) — the driven adapter
// is the only place that knows, and it translates to this.
export class TurnAbortedError extends Error {
  readonly aborted = true
  constructor(message = "aborted") {
    super(message)
    this.name = "TurnAbortedError"
  }
}

// The single place that decides whether a failure is really a stop. Adapters
// raise TurnAbortedError; this also forgives a harness's own abort error, so a
// caller that forgot to translate still gets it right.
export const isAborted = (err: unknown): boolean => {
  if (err instanceof TurnAbortedError) return true
  const e = err as { aborted?: unknown; name?: unknown } | null | undefined
  if (e?.aborted === true) return true
  return /abort/i.test(String(e?.name ?? ""))
}

// `server.connected` is the one event that belongs to no session, and only
// some of the rest name a message. Reading either field straight off a
// DomainEvent therefore doesn't type-check — these say the intent once
// instead of scattering `"sessionID" in evt` through the consumers.
export const eventSession = (e: DomainEvent): string | undefined => ("sessionID" in e ? e.sessionID : undefined)
export const eventMessage = (e: DomainEvent): string | undefined => ("messageID" in e ? e.messageID : undefined)

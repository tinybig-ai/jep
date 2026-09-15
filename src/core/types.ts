export type Role = "user" | "assistant"

export interface SessionSummary {
  id: string
  title: string
  workspace: string
  createdAt: number
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
}

export interface ReasoningPart {
  kind: "reasoning"
  text: string
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
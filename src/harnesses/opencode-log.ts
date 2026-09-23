// opencode's logger writes one `key=value` record per line (values bare or
// double-quoted) to its file log and, with `--print-logs`, to stderr.
//
// A provider failure — a 429, a usage cap, an upstream 5xx — lands here as
// `message="stream error"` and NOWHERE else: it never reaches the SSE stream
// as a session.error, so a frontend watching events sees a session that went
// busy and then simply silent. This is the one place that failure is legible,
// which is why the watchdog can finally say *why* a turn stalled. The same
// line also names `providerID`/`modelID`, so the reason comes with which
// endpoint produced it.
import type { HarnessError } from "../core/types.ts"

export interface OpenCodeLogError {
  /** opencode's native session id (ses_…), as it appears in the log line */
  sessionID: string
  /** the failure, with the provider/model the log line carried */
  error: HarnessError
}

// `key=value` where value is double-quoted (and may contain spaces) or bare.
const KV = /([A-Za-z_][\w.]*)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/g

// "AI_APICallError: Rate limit exceeded…" -> name "AI_APICallError", the rest
// as the message. No ": " means there is no name to lift out.
const splitError = (raw: string): { name?: string; message: string } => {
  const i = raw.indexOf(": ")
  return i <= 0 ? { message: raw } : { name: raw.slice(0, i), message: raw.slice(i + 2) }
}

export function parseOpencodeLogError(line: string): OpenCodeLogError | null {
  const level = /\blevel=(\w+)\b/.exec(line)?.[1]
  if (level !== "ERROR" && level !== "WARN") return null
  const fields: Record<string, string> = {}
  for (const m of line.matchAll(KV)) {
    const key = m[1]
    if (key) fields[key] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1")
  }
  const sessionID = fields["session.id"] ?? fields["sessionID"]
  if (!sessionID) return null
  // the provider failure that never makes it onto the event stream
  const isStreamError = fields["message"] === "stream error"
  const raw = fields["error.error"] ?? fields["error"]
  if (!isStreamError && !raw) return null
  const { name, message } = splitError(raw ?? fields["message"] ?? "stream error")
  const statusRaw = fields["statusCode"] ?? fields["status"]
  const status = statusRaw && /^\d+$/.test(statusRaw) ? Number(statusRaw) : undefined
  const error: HarnessError = {
    ...(name ? { name } : {}),
    message,
    ...(fields["providerID"] ? { provider: fields["providerID"] } : {}),
    ...(fields["modelID"] ? { model: fields["modelID"] } : {}),
    ...(status ? { status } : {}),
  }
  return { sessionID, error }
}

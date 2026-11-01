// MCP servers a client defines for one conversation. A client (a robot one, say,
// that gives each of its agents a tool of its own) hands them to POST /new; the
// gateway keeps them with the conversation, and the harness adds them to every
// turn beside the person's own servers, never in their place. Nothing here knows
// who the client is or what the servers do.

/** one server, run as a local program over stdio */
export interface McpServerDef {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type ConversationMcp = Record<string, McpServerDef>

/** names jep's own servers already use */
const RESERVED = new Set(["jep", "jep-tools"])
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/
const MAX_SERVERS = 8
// Goose takes a server as one command line split on spaces, so a space inside a
// value would split it wrongly. Refused everywhere, so a definition means the same
// thing on every harness.
const NO_SPACE = /^\S+$/

/** a client's definition checked, or the reason it is refused */
export function parseConversationMcp(raw: unknown): { ok: true; value: ConversationMcp } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} }
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "mcp must be an object of servers by name" }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_SERVERS) return { ok: false, error: `at most ${MAX_SERVERS} MCP servers` }
  const out: ConversationMcp = {}
  for (const [name, def] of entries) {
    if (!NAME.test(name)) return { ok: false, error: `bad MCP server name: ${name}` }
    if (RESERVED.has(name)) return { ok: false, error: `the MCP server name ${name} is jep's own` }
    if (!def || typeof def !== "object" || Array.isArray(def)) return { ok: false, error: `MCP server ${name} must be an object` }
    const { command, args, env } = def as Record<string, unknown>
    if (typeof command !== "string" || !NO_SPACE.test(command)) return { ok: false, error: `MCP server ${name} needs a command with no spaces` }
    if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === "string" && NO_SPACE.test(a))))
      return { ok: false, error: `MCP server ${name}: args must be strings with no spaces` }
    if (
      env !== undefined &&
      (!env || typeof env !== "object" || Array.isArray(env) ||
        !Object.entries(env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string" && NO_SPACE.test(v)))
    )
      return { ok: false, error: `MCP server ${name}: env must map names to values with no spaces` }
    out[name] = {
      command,
      ...(args?.length ? { args: args as string[] } : {}),
      ...(env && Object.keys(env).length ? { env: env as Record<string, string> } : {}),
    }
  }
  return { ok: true, value: out }
}

export const hasMcp = (mcp: ConversationMcp | undefined): mcp is ConversationMcp => !!mcp && Object.keys(mcp).length > 0

import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// jep's own toolset, independent of whatever MCP servers the person keeps in
// their harnesses. It is always additive: an adapter adds this server (or the
// guide note) to a run and never replaces the harness's own configuration.
//
//   cli  (default) the context header names the three shell commands: a few
//        tokens once per conversation, nothing per turn
//   mcp  the header, plus the same three as an MCP server (`jep-tools`)
//   off  no server (the header stays; it is not a tool)
export type ToolsMode = "cli" | "mcp" | "off"

export const TOOLS_SERVER = "jep-tools"
export const TOOL_NAMES = ["jep_watch", "jep_restart", "jep_rename", "jep_read", "jep_show"] as const
export const MCP_SERVER_PATH = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "bin", "jep-mcp.mjs")

export function toolsMode(env: Record<string, string | undefined> = process.env): ToolsMode {
  const v = env.JEP_TOOLS?.trim().toLowerCase()
  return v === "mcp" || v === "off" ? v : "cli"
}

/** whether a run gets the MCP server */
export const wantsMcp = (mode: ToolsMode): boolean => mode === "mcp"

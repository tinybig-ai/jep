// PURE — MCP server configuration for the three harnesses, as data.
//
// Each harness keeps its MCP servers somewhere different, in a different
// format, with a different notion of "disabled":
//
//   opencode  ~/.config/opencode/opencode.json   mcp.<name>.enabled (JSON, may
//                                                carry whole-line // comments)
//   codex     ~/.codex/config.toml               [mcp_servers.<name>] enabled =
//   claude    ~/.claude.json                     user-scoped mcpServers (no
//                                                disable — present means on),
//                                                project .mcp.json servers via
//                                                enabled/disabledMcpjsonServers
//
// Reads take a path; writes take the same path and change exactly one thing.
// Every writer preserves the untouched parts of the file — the codex one
// especially, which edits TOML by section lines rather than by re-serialising
// a structure it only partially understands.

import { readFile, writeFile } from "node:fs/promises"

export interface McpServer {
  name: string
  /** local = spawned command, remote = URL */
  kind: "local" | "remote"
  enabled: boolean
  /** the command line or URL, for the list row */
  detail: string
}

// ─── opencode ────────────────────────────────────────────────────────────────

// opencode config is JSONC; drop whole-line // comments (URLs live inside
// quoted strings so they're untouched), then hand the rest to JSON.parse.
function stripJsonc(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
}

export async function readOpencodeMcp(configPath: string): Promise<McpServer[]> {
  let raw: string
  try {
    raw = await readFile(configPath, "utf8")
  } catch {
    return []
  }
  let config: { mcp?: Record<string, { type?: string; command?: string[]; url?: string; enabled?: boolean }> }
  try {
    config = JSON.parse(stripJsonc(raw))
  } catch {
    throw new Error(`couldn't parse ${configPath}`)
  }
  return Object.entries(config.mcp ?? {}).map(([name, s]) => ({
    name,
    kind: s.type === "remote" ? "remote" : "local",
    enabled: s.enabled !== false,
    detail: s.type === "remote" ? (s.url ?? "") : (s.command ?? []).join(" "),
  }))
}

export async function writeOpencodeMcpEnabled(configPath: string, name: string, enabled: boolean): Promise<void> {
  const raw = await readFile(configPath, "utf8")
  const config = JSON.parse(stripJsonc(raw)) as Record<string, unknown>
  const mcp = (config.mcp ?? {}) as Record<string, { enabled?: boolean }>
  const server = mcp[name]
  if (!server) throw new Error(`no MCP server named ${name} in ${configPath}`)
  server.enabled = enabled
  config.mcp = mcp
  // The file may have carried // comments that stripJsonc dropped; a config
  // JSON rarely does, and the alternative (surgical text splice) is how a
  // mismatched brace corrupts the whole config.
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n")
}

// ─── codex ───────────────────────────────────────────────────────────────────

// [mcp_servers.<name>] — exact header match; the name itself never contains
// a quote, and TOML dotted keys in the wild are bare. Section runs until the
// next header of any kind.
function codexSection(toml: string, name: string): { start: number; end: number } | null {
  const lines = toml.split("\n")
  const header = `[mcp_servers.${name}]`
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) {
      if (lines[i]!.trim() === header) start = i
      continue
    }
    // the first header line after the section opens ends it
    if (/^\s*\[/.test(lines[i]!)) return { start, end: i }
  }
  return start === -1 ? null : { start, end: lines.length }
}

export async function readCodexMcp(tomlPath: string): Promise<McpServer[]> {
  let toml: string
  try {
    toml = await readFile(tomlPath, "utf8")
  } catch {
    return []
  }
  const lines = toml.split("\n")
  const out: McpServer[] = []
  for (let i = 0; i < lines.length; i++) {
    // the name must be dot-free: [mcp_servers.x.env] is a sub-table OF a
    // server, not a server called "x.env"
    const m = /^\s*\[mcp_servers\.([^\].]+)\]\s*$/.exec(lines[i]!)
    if (!m) continue
    const name = m[1]!.trim()
    let kind: "local" | "remote" = "local"
    let enabled = true
    const detail: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\[/.test(lines[j]!)) break
      const kv = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(lines[j]!)
      if (!kv) continue
      const [, key, rawValue] = kv
      const value = rawValue!.replace(/^["']|["']$/g, "")
      if (key === "enabled") enabled = value === "true"
      else if (key === "url") {
        kind = "remote"
        detail.push(value)
      } else if (key === "command") detail.push(value)
      else if (key === "args") detail.push(value.replace(/[[\]"']/g, "").trim())
    }
    out.push({ name, kind, enabled, detail: detail.filter(Boolean).join(" ") })
  }
  return out
}

export async function writeCodexMcpEnabled(tomlPath: string, name: string, enabled: boolean): Promise<void> {
  const toml = await readFile(tomlPath, "utf8")
  const lines = toml.split("\n")
  const section = codexSection(toml, name)
  if (!section) throw new Error(`no [mcp_servers.${name}] section in ${tomlPath}`)
  const flag = `enabled = ${enabled}`
  for (let i = section.start + 1; i < section.end; i++) {
    const replaced = lines[i]!.replace(/^\s*enabled\s*=\s*(true|false)\s*$/, flag)
    if (replaced !== lines[i]) {
      lines[i] = replaced
      await writeFile(tomlPath, lines.join("\n"))
      return
    }
  }
  // no existing flag: insert just before the section ends (after the last
  // plain key=value of THIS section — headers and sub-tables like .env come
  // after it and must not be buried inside)
  let insertAt = section.end
  for (let i = section.end - 1; i > section.start; i--) {
    if (/^\s*\[/.test(lines[i]!)) {
      insertAt = i
      break
    }
    if (lines[i]!.trim() !== "" && !/^\s*#/.test(lines[i]!)) {
      insertAt = i + 1
      break
    }
  }
  lines.splice(insertAt, 0, flag)
  await writeFile(tomlPath, lines.join("\n"))
}

// ─── claude ──────────────────────────────────────────────────────────────────

export interface ClaudeMcp {
  user: McpServer[]
  /** project-scoped .mcp.json servers, with jep-visible toggle state */
  project: Array<McpServer & { disabled: boolean }>
}

export async function readClaudeMcp(claudeJsonPath: string, projectDir: string): Promise<ClaudeMcp> {
  let global: ClaudeConfig = {}
  try {
    global = JSON.parse(await readFile(claudeJsonPath, "utf8")) as ClaudeConfig
  } catch {
    /* no config, or unreadable — both read as "none" */
  }
  const user = Object.entries(global.mcpServers ?? {}).map(([name, s]) => ({
    name,
    kind: s.type === "sse" || s.type === "http" ? ("remote" as const) : ("local" as const),
    enabled: true, // user-scoped servers have no disabled state: present = on
    detail: s.type === "sse" || s.type === "http" ? (s.url ?? "") : [s.command ?? "", ...(s.args ?? [])].join(" ").trim(),
  }))

  // project scope: .mcp.json next to the workspace, gated by the
  // enabled/disabledMcpjsonServers arrays in ~/.claude.json's project entry
  let projectConfig: { mcpServers?: Record<string, ClaudeServer> } = {}
  try {
    projectConfig = JSON.parse(await readFile(`${projectDir}/.mcp.json`, "utf8"))
  } catch {
    /* no project file */
  }
  const project = Object.entries(projectConfig.mcpServers ?? {}).map(([name, s]) => ({
    name,
    kind: s.type === "sse" || s.type === "http" ? ("remote" as const) : ("local" as const),
    enabled: !(global.projects?.[projectDir]?.disabledMcpjsonServers ?? []).includes(name),
    disabled: (global.projects?.[projectDir]?.disabledMcpjsonServers ?? []).includes(name),
    detail: s.type === "sse" || s.type === "http" ? (s.url ?? "") : [s.command ?? "", ...(s.args ?? [])].join(" ").trim(),
  }))
  return { user, project }
}

interface ClaudeServer {
  type?: string
  command?: string
  args?: string[]
  url?: string
}

interface ClaudeConfig {
  mcpServers?: Record<string, ClaudeServer>
  projects?: Record<string, { disabledMcpjsonServers?: string[]; enabledMcpjsonServers?: string[] }>
}

export async function writeClaudeProjectEnabled(claudeJsonPath: string, projectDir: string, serverName: string, enabled: boolean): Promise<void> {
  const config = JSON.parse(await readFile(claudeJsonPath, "utf8")) as ClaudeConfig
  const entry = (config.projects ??= {})[projectDir] ??= {}
  const disabled = new Set(entry.disabledMcpjsonServers ?? [])
  if (enabled) disabled.delete(serverName)
  else disabled.add(serverName)
  entry.disabledMcpjsonServers = [...disabled]
  await writeFile(claudeJsonPath, JSON.stringify(config, null, 2))
}

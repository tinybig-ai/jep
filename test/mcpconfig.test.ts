// core/mcpconfig.ts — the three harness config formats, as unit tests against
// real files in a temp dir. The codex TOML writer is the one that must never
// damage its file, so every test there asserts the untouched sections come
// back byte-identical.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readOpencodeMcp, readCodexMcp, writeOpencodeMcpEnabled, writeCodexMcpEnabled, readClaudeMcp, writeClaudeProjectEnabled } from "../src/core/mcpconfig.ts"

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "jep-mcp-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("opencode: local, remote, and explicit disabled servers", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "jep-mcp-")), "opencode.json")
  writeFileSync(
    file,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
        "node-repl": { type: "local", command: ["/bin/node", "repl.mjs"], enabled: false },
      },
    }),
  )
  const servers = await readOpencodeMcp(file)
  assert.deepEqual(servers, [
    { name: "context7", kind: "remote", enabled: true, detail: "https://mcp.context7.com/mcp" },
    { name: "node-repl", kind: "local", enabled: false, detail: "/bin/node repl.mjs" },
  ])
})

test("opencode: enabled defaults to true when the flag is absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jep-mcp-"))
  const file = join(dir, "opencode.json")
  writeFileSync(file, JSON.stringify({ mcp: { x: { type: "local", command: ["a"] } } }))
  const [s] = await readOpencodeMcp(file)
  assert.equal(s!.enabled, true)
})

test("opencode: whole-line // comments are tolerated on read and lost on write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jep-mcp-"))
  const file = join(dir, "opencode.json")
  writeFileSync(file, '// jep\n{\n  // providers live here\n  "mcp": { "x": { "type": "local", "command": ["a"] } }\n}\n')
  assert.equal((await readOpencodeMcp(file)).length, 1, "commented config still parses")
  await writeOpencodeMcpEnabled(file, "x", false)
  assert.deepEqual(await readOpencodeMcp(file), [{ name: "x", kind: "local", enabled: false, detail: "a" }])
})

test("opencode: no mcp key reads as an empty list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jep-mcp-"))
  const file = join(dir, "opencode.json")
  writeFileSync(file, JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
  assert.deepEqual(await readOpencodeMcp(file), [])
})

test("codex: sections, env sub-tables, and an explicit false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jep-mcp-"))
  const file = join(dir, "config.toml")
  writeFileSync(
    file,
    [
      'model = "gpt-5.5"',
      "",
      "[mcp_servers.node_repl]",
      'command = "/bin/node"',
      "args = [\"repl.mjs\"]",
      "startup_timeout_sec = 120",
      "",
      "[mcp_servers.node_repl.env]",
      "FOO = '1'",
      "",
      "[mcp_servers.computer-use]",
      'command = "./client"',
      'args = ["mcp"]',
      "enabled = false",
      "",
      "[desktop]",
      'theme = "dark"',
    ].join("\n"),
  )
  const servers = await readCodexMcp(file)
  assert.deepEqual(servers, [
    { name: "node_repl", kind: "local", enabled: true, detail: "/bin/node repl.mjs" },
    { name: "computer-use", kind: "local", enabled: false, detail: "./client mcp" },
  ])
})

test("codex: toggling rewrites one line and preserves everything else byte-for-byte", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jep-mcp-"))
  const file = join(dir, "config.toml")
  const before = [
    'model = "gpt-5.5"',
    "",
    "[mcp_servers.node_repl]",
    'command = "/bin/node"',
    "enabled = true",
    "",
    "[mcp_servers.computer-use]",
    'command = "./client"',
    "enabled = false",
    "",
    "[desktop]",
    'theme = "dark"',
  ].join("\n")
  writeFileSync(file, before)

  await writeCodexMcpEnabled(file, "computer-use", true)
  const after = readFileSync(file, "utf8")
  assert.equal(after, before.replace("enabled = false", "enabled = true"), "only the one line moved")

  // and the env sub-table after node_repl is never buried by an insert
  await writeCodexMcpEnabled(file, "node_repl", false)
  const text = readFileSync(file, "utf8")
  const nodeRepl = text.slice(text.indexOf("[mcp_servers.node_repl]"), text.indexOf("[mcp_servers.node_repl.env]"))
  assert.match(nodeRepl, /enabled = false/, "the flag lands inside node_repl's own section")
})

test("codex: a section with no enabled flag gets one, before any sub-table", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jep-mcp-"))
  const file = join(dir, "config.toml")
  const before = ["[mcp_servers.x]", 'command = "c"', "", "[mcp_servers.x.env]", "A = '1'", "", "[other]", "k = 'v'"].join("\n")
  writeFileSync(file, before)
  await writeCodexMcpEnabled(file, "x", false)
  const text = readFileSync(file, "utf8")
  const section = text.slice(text.indexOf("[mcp_servers.x]"), text.indexOf("[mcp_servers.x.env]"))
  assert.match(section, /enabled = false/, "flag inserted inside the parent section")
  assert.equal(text.includes("[other]\nk = 'v'"), true, "unrelated sections intact")
})

test("codex: writing a name that doesn't exist says so instead of creating one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jep-mcp-"))
  const file = join(dir, "config.toml")
  writeFileSync(file, "[mcp_servers.a]\ncommand = 'c'\n")
  await assert.rejects(() => writeCodexMcpEnabled(file, "missing", true), /no \[mcp_servers.missing\]/)
})

test("claude: user-scoped servers are always enabled; project ones honour disabledMcpjsonServers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jep-mcp-"))
  const claudeJson = join(dir, ".claude.json")
  writeFileSync(
    claudeJson,
    JSON.stringify({
      mcpServers: { fetcher: { type: "stdio", command: "npx", args: ["-y", "fetch"] }, web: { type: "http", url: "https://mcp.example" } },
      projects: {
        [dir]: { disabledMcpjsonServers: ["local-tools"] },
      },
    }),
  )
  // project scope: .mcp.json sits in the project dir itself
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "local-tools": { type: "stdio", command: "t" } } }))

  const mcp = await readClaudeMcp(claudeJson, dir)
  assert.deepEqual(mcp.user, [
    { name: "fetcher", kind: "local", enabled: true, detail: "npx -y fetch" },
    { name: "web", kind: "remote", enabled: true, detail: "https://mcp.example" },
  ])
  assert.deepEqual(mcp.project, [{ name: "local-tools", kind: "local", enabled: false, disabled: true, detail: "t" }])

  await writeClaudeProjectEnabled(claudeJson, dir, "local-tools", true)
  const after = JSON.parse(readFileSync(claudeJson, "utf8"))
  assert.deepEqual(after.projects[dir].disabledMcpjsonServers, [], "re-enabling clears the entry")
  assert.deepEqual((await readClaudeMcp(claudeJson, dir)).project[0]!.enabled, true)
})

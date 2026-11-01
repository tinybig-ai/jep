// jep's own toolset: the MCP server speaks the protocol, reaches the daemon's
// control socket like the shell commands do, and is added (never swapped in)
// to a harness run only when JEP_TOOLS=mcp.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startControl } from "../src/app/control.ts"
import { MCP_SERVER_PATH, TOOL_NAMES, toolsMode, wantsMcp } from "../src/core/tools.ts"

test("the mode is cli unless asked, and only mcp adds the server", () => {
  assert.equal(toolsMode({}), "cli")
  assert.equal(toolsMode({ JEP_TOOLS: "MCP" }), "mcp")
  assert.equal(toolsMode({ JEP_TOOLS: "off" }), "off")
  assert.equal(toolsMode({ JEP_TOOLS: "nonsense" }), "cli")
  assert.deepEqual(["cli", "mcp", "off"].map((m) => wantsMcp(m as "cli")), [false, true, false])
})

/** talk to jep-mcp.mjs over stdio: one request per call, answers matched by id */
async function server(dataHome: string, args: string[] = []) {
  const child = spawn(process.execPath, [MCP_SERVER_PATH, ...args], { env: { ...process.env, JEP_DATA_HOME: dataHome }, stdio: ["pipe", "pipe", "ignore"] })
  let buf = ""
  const waiting = new Map<number, (m: any) => void>()
  child.stdout.on("data", (c) => {
    buf += c
    let nl
    while ((nl = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      waiting.get(m.id)?.(m)
    }
  })
  let id = 0
  return {
    call: (method: string, params?: unknown) =>
      new Promise<any>((resolve) => {
        const n = ++id
        waiting.set(n, resolve)
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`)
      }),
    notify: (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
    close: () => child.kill(),
  }
}

test("jep-mcp lists exactly the tools tools.ts names, and reaches the daemon like jep-watch", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "jep-tools-"))
  const seen: any[] = []
  const control = await startControl(home, {
    watch: async (req) => (seen.push(req), { ok: true, message: "watching" }),
    restart: (req) => (seen.push(req), { ok: true, message: "restart queued" }),
  })
  const s = await server(home, ["--session", "jep-sess"])
  t.after(() => {
    s.close()
    control.close()
  })

  const init = await s.call("initialize", { protocolVersion: "2025-03-26" })
  assert.equal(init.result.serverInfo.name, "jep-tools")
  s.notify("notifications/initialized")
  const list = await s.call("tools/list")
  assert.deepEqual(list.result.tools.map((x: { name: string }) => x.name), [...TOOL_NAMES])

  const watch = await s.call("tools/call", { name: "jep_watch", arguments: { check: "true", note: "n", every_seconds: 5 } })
  assert.equal(watch.result.content[0].text, "watching")
  assert.equal(seen[0].check, "true")
  assert.equal(seen[0].session, "jep-sess")
  assert.equal(seen[0].every_seconds, 5)

  const restart = await s.call("tools/call", { name: "jep_restart", arguments: {} })
  assert.equal(restart.result.content[0].text, "restart queued")
  assert.equal(seen[1].op, "restart")

  assert.equal((await s.call("tools/call", { name: "jep_watch", arguments: {} })).result.isError, true)
  assert.equal((await s.call("nope")).error.code, -32601)
})

test("jep_show checks the files the way jep-show does", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "jep-tools-"))
  const png = path.join(home, "a.png")
  const txt = path.join(home, "a.txt")
  await writeFile(png, "x")
  await writeFile(txt, "x")
  const s = await server(home)
  t.after(() => s.close())
  const ok = await s.call("tools/call", { name: "jep_show", arguments: { paths: [png] } })
  assert.match(ok.result.content[0].text, /^showing .*a\.png \(1 bytes\)$/)
  const bad = await s.call("tools/call", { name: "jep_show", arguments: { paths: [txt, path.join(home, "missing.png")] } })
  assert.equal(bad.result.isError, true)
  assert.match(bad.result.content[0].text, /not an image type/)
  assert.match(bad.result.content[0].text, /not a file/)
})

test("codex gets the server as dotted keys that add to the person's own, only with JEP_TOOLS=mcp", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "jep-codex-mcp-"))
  const TID = "019a0000-bbbb-7ccc-8ddd-000000000009"
  const argsSeen = path.join(home, "args.txt")
  const bin = path.join(home, "codex")
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsSeen}"\necho '{"type":"thread.started","thread_id":"${TID}"}'\necho '{"type":"turn.completed","usage":{}}'\n`)
  await chmod(bin, 0o755)
  process.env.CODEX_BIN = bin
  process.env.CODEX_HOME = home
  const { CodexAdapter } = await import("../src/harnesses/codex.ts")
  const a = new CodexAdapter(home)
  t.after(() => {
    delete process.env.JEP_TOOLS
    return a.close?.()
  })
  await a.prompt(`codex://${TID}`, "hi")
  assert.ok(!(await readFile(argsSeen, "utf8")).includes("jep-tools"), "off by default")
  process.env.JEP_TOOLS = "mcp"
  await a.prompt(`codex://${TID}`, "hi")
  const args = (await readFile(argsSeen, "utf8")).split("\n")
  assert.ok(args.some((x) => x.startsWith("mcp_servers.jep-tools.command=")))
  assert.ok(args.some((x) => x === 'mcp_servers.jep-tools.tools.jep_show.approval_mode="approve"'))
  assert.ok(!args.some((x) => x === "mcp_servers=" || /^mcp_servers=/.test(x)), "never the whole table: that would replace theirs")
  assert.ok(args.indexOf("exec") < args.indexOf("resume"), "-c belongs to exec, before resume")
  assert.ok(args.lastIndexOf("-c") < args.indexOf("resume"))
})

test("jep-watch --help prints usage and starts nothing", async () => {
  const { execFileSync } = await import("node:child_process")
  const out = execFileSync(process.execPath, [path.join(path.dirname(MCP_SERVER_PATH), "jep-watch.mjs"), "--help"], {
    env: { ...process.env, JEP_DATA_HOME: "/nonexistent" },
    encoding: "utf8",
  })
  assert.match(out, /^usage: jep-watch/)
})

test("a conversation's own MCP servers ride along on codex as added servers, approved", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "jep-codex-conv-"))
  const TID = "019a0000-bbbb-7ccc-8ddd-00000000000a"
  const argsSeen = path.join(home, "args.txt")
  const bin = path.join(home, "codex")
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsSeen}"\necho '{"type":"thread.started","thread_id":"${TID}"}'\necho '{"type":"turn.completed","usage":{}}'\n`)
  await chmod(bin, 0o755)
  process.env.CODEX_BIN = bin
  const { CodexAdapter } = await import(`../src/harnesses/codex.ts?conv=${Date.now()}`)
  const a = new CodexAdapter(home)
  t.after(() => a.close?.())
  await a.prompt(`codex://${TID}`, "hi", { mcp: { mm: { command: "factormost-tools", args: ["--character", "ada"], env: { MM_TOKEN: "tok" } } } })
  const args = (await readFile(argsSeen, "utf8")).split("\n")
  assert.ok(args.includes('mcp_servers.mm.command="factormost-tools"'))
  assert.ok(args.includes('mcp_servers.mm.args=["--character","ada"]'))
  assert.ok(args.includes('mcp_servers.mm.env.MM_TOKEN="tok"'))
  assert.ok(args.includes('mcp_servers.mm.default_tools_approval_mode="approve"'))
  assert.ok(args.lastIndexOf("-c") < args.indexOf("resume"), "-c belongs to exec, before resume")
})

#!/usr/bin/env node
// jep's own tools as an MCP server (stdio): the same three things the `jep-watch`,
// `jep-restart` and `jep-show` commands do, for a harness that is better at
// calling a tool than at finding a shell command. Which conversation it serves
// comes from `--session ID` (or JEP_SESSION); without one the daemon picks the
// only turn running in the agent's directory.
//
// Plain node, no imports from the tree and no dependencies: a harness starts it
// as a child process. The tool names are pinned to src/core/tools.ts by a test.
import { statSync } from "node:fs"
import { resolve } from "node:path"
import { ask } from "./lib/control.mjs"

const argAt = process.argv.indexOf("--session")
const SESSION = (argAt > 0 ? process.argv[argAt + 1] : process.env.JEP_SESSION) ?? ""
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif)$/i

const TOOLS = [
  {
    name: "jep_watch",
    description:
      "Wait for something slow. check is a shell command that exits 0 when done. End your turn after calling this; jep starts a new turn when the check passes.",
    inputSchema: {
      type: "object",
      properties: {
        check: { type: "string" },
        note: { type: "string" },
        every_seconds: { type: "number" },
        max_minutes: { type: "number" },
      },
      required: ["check"],
    },
  },
  {
    name: "jep_restart",
    description: "Queue a jep daemon restart. It runs when every turn has ended, yours included, so end your turn after calling this.",
    inputSchema: { type: "object", properties: { wait_minutes: { type: "number" } } },
  },
  {
    name: "jep_rename",
    description: "Give this conversation a new title, short and about the work.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
  {
    name: "jep_show",
    description: "Show image files to the person in their chat.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
  },
]

const text = (message, isError = false) => ({ content: [{ type: "text", text: message }], ...(isError ? { isError: true } : {}) })

async function call(name, args = {}) {
  if (name === "jep_watch") {
    if (typeof args.check !== "string" || !args.check.trim()) return text("check is required", true)
    const r = await ask({
      check: args.check,
      note: args.note ?? "",
      every_seconds: Number(args.every_seconds) || undefined,
      max_minutes: Number(args.max_minutes) || undefined,
      session: SESSION,
      cwd: process.cwd(),
    })
    return text(r.message, !r.ok)
  }
  if (name === "jep_restart") {
    const r = await ask({ op: "restart", wait_minutes: Number(args.wait_minutes) || undefined, session: SESSION, cwd: process.cwd() })
    return text(r.message, !r.ok)
  }
  if (name === "jep_rename") {
    if (typeof args.title !== "string" || !args.title.trim()) return text("title is required", true)
    const r = await ask({ op: "rename", title: args.title, session: SESSION, cwd: process.cwd() })
    return text(r.message, !r.ok)
  }
  if (name === "jep_show") {
    const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string" && p) : []
    if (!paths.length) return text("paths is required", true)
    const lines = []
    let bad = 0
    for (const p of paths) {
      const abs = resolve(p)
      let size = -1
      try {
        const info = statSync(abs)
        if (info.isFile()) size = info.size
      } catch {}
      if (size < 0) lines.push(`not a file: ${abs}`), bad++
      else if (!IMAGE.test(abs)) lines.push(`not an image type jep can draw: ${abs}`), bad++
      else lines.push(`showing ${abs} (${size} bytes)`)
    }
    return text(lines.join("\n"), bad > 0)
  }
  return text(`unknown tool: ${name}`, true)
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === "initialize")
    return {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "jep-tools", version: "1" },
    }
  if (method === "ping") return {}
  if (method === "tools/list") return { tools: TOOLS }
  if (method === "tools/call") return call(params?.name, params?.arguments)
  if (id === undefined) return undefined // a notification: no answer
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 })
}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg).then(
      (result) => result !== undefined && msg.id !== undefined && process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`),
      (err) =>
        msg.id !== undefined &&
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: err.code ?? -32603, message: err.message } })}\n`),
    )
  }
})
process.stdin.on("end", () => process.exit(0))

// The MCP server Claude Code calls instead of drawing a permission prompt.
//
// In print mode there is no one at a terminal to answer, so Claude Code takes
// `--permission-prompt-tool <tool>` and asks that tool instead: whatever it
// answers is the decision. This is that tool, and all it does is carry the
// question to jep and the answer back.
//
// It is a separate process because Claude Code spawns MCP servers itself, and
// it talks to jep over a unix socket handed to it in the environment: no port
// to allocate, reachable by nothing that cannot already read the socket file,
// and it dies with the directory it lives in.
//
// Plain .mjs, no imports from the tree: this runs under whatever node Claude
// Code was started with, and it is the one file here that must not need
// type-stripping.
import net from "node:net"

const SOCKET = process.env.JEP_ASK_SOCKET
const SESSION = process.env.JEP_ASK_SESSION ?? ""
// A question nobody answers must not pin a turn open forever. Claude Code has
// its own tool timeout as well; this one is the backstop that fails closed.
const TIMEOUT_MS = Number(process.env.JEP_ASK_TIMEOUT_MS ?? 900_000)

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const reply = (id, result) => send({ jsonrpc: "2.0", id, result })

// deny is the safe answer for every failure below: a jep that has gone away, a
// socket that refuses, a question that times out. Allowing on error would mean
// a broken channel silently grants everything.
const denied = (message) => ({ behavior: "deny", message })

function askJep(toolName, input, toolUseID) {
  return new Promise((resolve) => {
    if (!SOCKET) return resolve(denied("jep: no ask socket configured"))
    let settled = false
    const done = (decision) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.destroy()
      resolve(decision)
    }
    const timer = setTimeout(() => done(denied("jep: nobody answered in time")), TIMEOUT_MS)
    const conn = net.createConnection(SOCKET)
    conn.on("connect", () => {
      conn.write(`${JSON.stringify({ id: `${process.pid}-${Date.now()}`, session: SESSION, tool: toolName, input, toolUseID })}\n`)
    })
    let buf = ""
    conn.on("data", (chunk) => {
      buf += chunk.toString()
      let nl
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          done(msg.decision === "allow" ? { behavior: "allow", updatedInput: input } : denied(msg.message ?? "denied from Telegram"))
        } catch {
          done(denied("jep: unreadable answer"))
        }
      }
    })
    conn.on("error", (err) => done(denied(`jep: ${err.message}`)))
    conn.on("close", () => done(denied("jep: the ask channel closed")))
  })
}

const TOOL = {
  name: "ask",
  description: "Ask the person running jep whether this tool call may proceed.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
}

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "jep-ask", version: "1.0.0" },
      })
    case "ping":
      return reply(msg.id, {})
    case "tools/list":
      return reply(msg.id, { tools: [TOOL] })
    case "tools/call": {
      const args = msg.params?.arguments ?? {}
      const decision = await askJep(args.tool_name ?? "a tool", args.input ?? {}, args.tool_use_id)
      // the decision travels as JSON in a text block: that is the shape Claude
      // Code reads a permission-prompt tool's answer out of
      return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(decision) }] })
    }
    default:
      // notifications carry no id and want no answer
      if (msg.id === undefined) return
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
  }
}

let stdin = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  stdin += chunk
  let nl
  while ((nl = stdin.indexOf("\n")) >= 0) {
    const line = stdin.slice(0, nl).trim()
    stdin = stdin.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    void handle(msg)
  }
})
process.stdin.on("end", () => process.exit(0))

// How a command run from an agent's shell reaches the jep daemon: one JSON line
// to the control socket in the data home, one JSON line back. Plain node, no
// imports from the tree: it runs from whatever shell (or MCP host) the agent has.
import net from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"

export const dataHome = () => process.env.JEP_DATA_HOME ?? join(homedir(), ".local", "share", "jep-tg")

/** @returns {Promise<{ ok: boolean, message: string }>} never rejects: a daemon that cannot be reached is an answer */
export function ask(request) {
  return new Promise((resolve) => {
    const conn = net.createConnection(join(dataHome(), "control.sock"))
    let buf = ""
    conn.on("connect", () => conn.write(`${JSON.stringify(request)}\n`))
    conn.on("data", (chunk) => (buf += chunk.toString()))
    conn.on("end", () => {
      try {
        resolve(JSON.parse(buf))
      } catch {
        resolve({ ok: false, message: "unreadable answer from jep" })
      }
    })
    conn.on("error", (err) =>
      resolve({ ok: false, message: `cannot reach the jep daemon (${err.message}); is it running with JEP_DATA_HOME=${dataHome()}?` }),
    )
  })
}

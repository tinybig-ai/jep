import net from "node:net"
import { chmod, rm } from "node:fs/promises"
import { join } from "node:path"
import { detach } from "../core/detach.ts"

// The daemon's control socket: how a command run from an agent's shell
// (`jep-watch`, `jep-restart`) reaches the daemon. It is not an HTTP client and
// belongs to no turn runner: it parses one JSON line, hands it to the handler
// for its `op`, and writes one JSON line back. Mode 0600, in the data home.

export interface ControlReply {
  ok: boolean
  message: string
}

/** one request: `op` names what is asked ("restart", "rename"; absent means a watch) */
export interface ControlRequest {
  op?: unknown
  // a watch (core/watches.ts) and where it comes from
  check?: unknown
  note?: unknown
  every_seconds?: unknown
  max_minutes?: unknown
  session?: unknown
  cwd?: unknown
  // a rename: the new title
  title?: unknown
  // a restart (core/restarts.ts)
  wait_minutes?: unknown
}

export interface ControlHandlers {
  watch(req: ControlRequest): Promise<ControlReply>
  restart(req: ControlRequest): ControlReply
  rename(req: ControlRequest): Promise<ControlReply>
}

export const CONTROL_SOCKET = "control.sock"

export async function startControl(dataHome: string, handlers: ControlHandlers): Promise<{ close(): void }> {
  const sock = join(dataHome, CONTROL_SOCKET)
  const server = net.createServer((conn) => {
    let buf = ""
    const reply = (r: ControlReply): void => void conn.end(`${JSON.stringify(r)}\n`)
    conn.on("data", (chunk: Buffer) => {
      buf += chunk.toString()
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      let req: ControlRequest
      try {
        req = JSON.parse(buf.slice(0, nl))
      } catch {
        return reply({ ok: false, message: "unreadable request" })
      }
      if (req.op === "restart") return reply(handlers.restart(req))
      if (req.op === "rename") return void detach("control rename", handlers.rename(req).then(reply))
      detach("control request", handlers.watch(req).then(reply))
    })
    conn.on("error", () => {})
  })
  // a socket file left by a daemon that died would refuse the bind
  await rm(sock, { force: true })
  await new Promise<void>((resolve) => {
    server.once("error", (err) => {
      console.error(`[control] socket unavailable: ${err.message}`)
      resolve()
    })
    server.listen(sock, () => {
      detach("control socket mode", chmod(sock, 0o600))
      resolve()
    })
  })
  server.unref()
  return { close: () => void server.close() }
}

// A Terminal backed by tmux: the shell outlives the app, reattaches, and comes
// with scrollback. jep feeds it with send-keys and reads the rendered screen
// with capture-pane — so there is no pty library and no VT emulation to own.
// All of that knowledge lives here; callers see only the Terminal port.
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Terminal } from "../core/ports.ts"

const run = promisify(execFile)

// tmux session names come from a session id, which is not name-safe
const nameFor = (sessionID: string) => "jep-" + sessionID.replace(/[^A-Za-z0-9_-]/g, "").slice(-48)

export function tmuxTerminal(opts: { bin: string; cols: number; rows: number }): Terminal {
  const size = ["-x", String(opts.cols), "-y", String(opts.rows)]

  return {
    async open(sessionID, dir) {
      const name = nameFor(sessionID)
      const has = await run(opts.bin, ["has-session", "-t", name]).then(
        () => true,
        () => false,
      )
      if (!has) {
        await run(opts.bin, ["new-session", "-d", "-s", name, "-c", dir, ...size])
      } else {
        // an existing shell may have been created at another size
        await run(opts.bin, ["resize-window", "-t", name, ...size]).catch(() => {})
      }
    },

    async frame(sessionID) {
      const { stdout } = await run(opts.bin, ["capture-pane", "-p", "-t", nameFor(sessionID), "-S", "-200"])
      return stdout
    },

    async send(sessionID, input) {
      const name = nameFor(sessionID)
      if (input.key) await run(opts.bin, ["send-keys", "-t", name, input.key])
      else if (input.text != null) await run(opts.bin, ["send-keys", "-t", name, "-l", input.text])
    },

    async close(sessionID) {
      await run(opts.bin, ["kill-session", "-t", nameFor(sessionID)]).catch(() => {})
    },
  }
}

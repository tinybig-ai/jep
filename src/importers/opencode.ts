// A driven adapter for the one harness jep keeps its own store for.
//
// jep runs opencode against an isolated data home, so a conversation you have
// in your own `opencode` isn't visible here. This bridges the two: it reads the
// user's store to say what could come over, and forks one across on request.
// The gateway only ever sees the SessionImport port — none of this storage or
// CLI knowledge leaks out of here.
import { spawn, execFile } from "node:child_process"
import { closeSync, existsSync, openSync, readSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { DatabaseSync } from "node:sqlite"
import type { ImportableSession, SessionImport } from "../core/ports.ts"

const run = promisify(execFile)

export function opencodeSessionImport(opts: { bin: string; from: string; into: string }): SessionImport {
  const dbPath = (home: string) => join(home, "opencode", "opencode.db")

  return {
    harness: "opencode",

    async list(): Promise<ImportableSession[]> {
      const out: ImportableSession[] = []
      try {
        const db = new DatabaseSync(dbPath(opts.from), { readOnly: true })
        // parent_id IS NULL: a subagent's session is a child of the turn that
        // spawned it, not a conversation you'd want to bring over
        const rows = db
          .prepare("SELECT id, title, directory, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC")
          .all() as Array<Record<string, unknown>>
        db.close()
        for (const r of rows) {
          out.push({
            harness: "opencode",
            id: String(r.id),
            title: String(r.title ?? ""),
            dir: String(r.directory ?? ""),
            updatedAt: Number(r.time_updated ?? 0),
          })
        }
      } catch {
        // no store to import from
      }
      // anything jep already has (an earlier import keeps the id) isn't offered
      const have = new Set<string>()
      try {
        const db = new DatabaseSync(dbPath(opts.into), { readOnly: true })
        for (const r of db.prepare("SELECT id FROM session").all() as Array<Record<string, unknown>>) have.add(String(r.id))
        db.close()
      } catch {
        /* jep's store may not exist yet — then nothing is imported */
      }
      return out.filter((s) => !have.has(s.id))
    },

    async fork(id: string): Promise<{ ok: boolean; dir?: string }> {
      const file = join(tmpdir(), `jep-import-${Date.now()}-${id}.json`)
      try {
        // a real fd, opened first — spawn rejects a WriteStream whose fd is null.
        // A long session exports to ~100 MB, so it goes straight to disk.
        const fd = openSync(file, "w")
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(opts.bin, ["export", id], {
              env: { ...process.env, XDG_DATA_HOME: opts.from },
              stdio: ["ignore", fd, "ignore"],
            })
            child.once("error", reject)
            child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`export exited ${code}`))))
          })
        } finally {
          closeSync(fd)
        }

        // opencode derives the project from the *cwd* of import, not the file,
        // so it must run in the session's own directory or the import lands
        // under a "global" project no workspace lists. The export's head has it.
        const buf = Buffer.alloc(8192)
        const rfd = openSync(file, "r")
        const n = readSync(rfd, buf, 0, buf.length, 0)
        closeSync(rfd)
        const dir = /"directory"\s*:\s*"([^"]+)"/.exec(buf.subarray(0, n).toString("utf8"))?.[1]

        await run(opts.bin, ["import", file], {
          cwd: dir && existsSync(dir) ? dir : undefined,
          env: { ...process.env, XDG_DATA_HOME: opts.into },
          maxBuffer: 16 * 1024 * 1024,
        })
        return { ok: true, dir }
      } catch {
        return { ok: false }
      } finally {
        await unlink(file).catch(() => {})
      }
    },
  }
}

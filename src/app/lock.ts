import { execFileSync } from "node:child_process"
import { openSync, readFileSync, unlinkSync, writeSync, closeSync } from "node:fs"
import { join } from "node:path"

// One daemon per data home. Two daemons on one bot token take turns at
// Telegram's long poll (409 "terminated by other getUpdates request"), each
// eats the updates the other was waiting for, and both write store.json from
// their own stale copy. That happened (four at once) when two agents each
// restarted the bot, and nothing in the process stopped it. This file is the
// stop: the pid of the daemon that owns the data home.
export const LOCK_FILE = "daemon.pid"

/** Is `pid` alive and a jep daemon? A pid the OS reused for anything else is not. */
export function isJepDaemon(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (err) {
    // EPERM: alive, but someone else's. Not ours to call stale.
    if ((err as NodeJS.ErrnoException)?.code !== "EPERM") return false
  }
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5_000 })
    return /app[/\\]tg\.(ts|js)\b/.test(cmd)
  } catch {
    return false
  }
}

function readHolder(file: string): number {
  try {
    return Number(readFileSync(file, "utf8").trim())
  } catch {
    return NaN
  }
}

export type LockResult = { ok: true; release: () => void } | { ok: false; holder: number }

/**
 * Claim the data home for this process. A lock left by a daemon that died
 * (kill -9, a crash, a reboot) is taken over, so a hard stop never wedges the
 * next boot. The lock is released on exit, but only if it is still ours.
 */
export function acquireDaemonLock(dataHome: string, alive: (pid: number) => boolean = isJepDaemon): LockResult {
  const file = join(dataHome, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      fd = openSync(file, "wx")
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err
      const holder = readHolder(file)
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && alive(holder)) return { ok: false, holder }
      // stale: its owner is gone. Remove it and race for it once more.
      try {
        unlinkSync(file)
      } catch {
        /* another booting daemon removed it first */
      }
      continue
    }
    writeSync(fd, `${process.pid}\n`)
    closeSync(fd)
    const release = () => {
      try {
        if (readHolder(file) === process.pid) unlinkSync(file)
      } catch {
        /* gone already */
      }
    }
    process.once("exit", release)
    return { ok: true, release }
  }
  // lost the takeover race twice: whoever won owns it now
  return { ok: false, holder: readHolder(file) }
}

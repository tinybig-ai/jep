import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ChatDirectory, HarnessAdapter, TurnHost } from "../core/ports.ts"
import { addGrant, hasGrant, parseGrants, pickChat, serializeGrants } from "../core/chatgrants.ts"
import { renderForRead } from "../core/carryover.ts"
import { detach } from "../core/detach.ts"
import { parseJournal, parseSavedWatches, restartWaitMs, RESUME_TEXT, toResume } from "../core/restarts.ts"
import { lookAtWatch, parseWatch, watchText, WATCH_MAX_PER_SESSION, type WatchOutcome, type WatchSpec } from "../core/watches.ts"
import { startControl, type ControlReply, type ControlRequest } from "./control.ts"

/**
 * What keeps work from being lost across a restart, and what lets an agent hand
 * off a wait or a restart. It is the daemon's, not any client's: it sees the
 * turns only through `TurnHost`, so the same service covers whichever client
 * runs them.
 *
 *   - a journal of running turns, so the next start picks up the ones a restart
 *     or a crash cut off (core/restarts.ts)
 *   - watches (`jep-watch`), kept on disk so a restart does not forget them
 *   - restart on request (`jep-restart`): waits until no turn is busy
 */
export interface ContinuityOpts {
  dataHome: string
  turns: TurnHost
  /** restart the daemon, cleanly. Absent, `jep-restart` says it cannot. */
  restart?(): void
  /** retitle a conversation. Absent, `jep-rename` says it cannot. */
  rename?(key: string, title: string): Promise<void>
  /** the conversations an agent may be allowed to read (`jep-read`). Absent, `jep-read` says it cannot. */
  chats?: ChatDirectory
  /** how long a read waits for the person (default 10 min) */
  readWaitMs?: number
  /** how long after start the saved watches and cut-off turns are picked up
   * (default 2 s: the workspaces must be up first) */
  restoreAfterMs?: number
}

export async function startContinuity(opts: ContinuityOpts): Promise<{ close(): void }> {
  const { turns, dataHome } = opts

  // ─── journal ────────────────────────────────────────────────────────
  // Written as turns start and struck out as they end. A turn that ends because
  // the daemon is going down was cut off, not finished, so it stays.
  const journalFile = join(dataHome, "interrupted.json")
  const journal = new Map<string, boolean>()
  try {
    // what the last run left behind stays in the file until it has been picked up
    for (const key of toResume(parseJournal(readFileSync(journalFile, "utf8")))) journal.set(key, false)
  } catch {
    // no file: the last run ended cleanly
  }
  const leftover = [...journal.keys()]
  const saveJournal = (): void => {
    try {
      writeFileSync(journalFile, JSON.stringify([...journal].map(([key, resume]) => ({ key, resume }))))
    } catch (err) {
      console.error(`[restart] could not write the turn journal: ${(err as Error)?.message ?? err}`)
    }
  }
  turns.observe({
    started: (key, resume) => {
      journal.set(key, resume)
      saveJournal()
    },
    ended: (key, cutOff) => {
      if (cutOff) return
      journal.delete(key)
      saveJournal()
    },
  })

  // ─── watches ────────────────────────────────────────────────────────
  // An agent waiting on something slow hands the wait here (core/watches.ts).
  // The check runs outside any turn; when it passes, or time runs out, one new
  // turn starts in that conversation.
  type Watch = { spec: WatchSpec; startedAt: number; timer: ReturnType<typeof setTimeout> | null }
  const watches = new Map<string, Set<Watch>>()
  const watchFile = join(dataHome, "watches.json")
  const saveWatches = (): void => {
    const rows = [...watches].flatMap(([key, set]) => [...set].map((w) => ({ key, spec: w.spec, startedAt: w.startedAt })))
    try {
      writeFileSync(watchFile, JSON.stringify(rows))
    } catch (err) {
      console.error(`[watch] could not save watches: ${(err as Error)?.message ?? err}`)
    }
  }
  const startWatch = (key: string, adapter: HarnessAdapter, spec: WatchSpec, startedAt = Date.now()): string | null => {
    const mine = watches.get(key) ?? new Set<Watch>()
    watches.set(key, mine)
    if (mine.size >= WATCH_MAX_PER_SESSION) return `${mine.size} watches are already waiting in this conversation`
    const watch: Watch = { spec, startedAt, timer: null }
    mine.add(watch)
    saveWatches()
    console.error(`[watch] ${startedAt < Date.now() - 1000 ? "restored" : "start"} "${spec.note}" every ${spec.everyMs / 1000}s (gateway session ${key})`)
    const finish = (outcome: WatchOutcome): void => {
      mine.delete(watch)
      if (!mine.size) watches.delete(key)
      saveWatches()
      console.error(`[watch] ${outcome.kind} "${spec.note}" (gateway session ${key})`)
      // marked a notice: this turn is the daemon's, not the person's, so it is
      // drawn as a boundary and never as one of their queued messages
      turns.enqueue(key, watchText(spec, outcome), { notice: true })
    }
    const look = async (): Promise<void> => {
      if (!mine.has(watch) || turns.closing()) return
      const verify = await lookAtWatch(spec, adapter.workspace)
      if (!mine.has(watch)) return
      if (verify.ok) return finish({ kind: "done", verify })
      if (Date.now() - watch.startedAt >= spec.maxMs) return finish({ kind: "timeout", verify })
      watch.timer = setTimeout(() => detach(`watch ${key}`, look()), spec.everyMs)
      watch.timer.unref()
    }
    watch.timer = setTimeout(() => detach(`watch ${key}`, look()), spec.everyMs)
    watch.timer.unref()
    return null
  }
  const watchRequest = async (req: ControlRequest): Promise<ControlReply> => {
    const spec = parseWatch(req)
    if (!spec) return { ok: false, message: "give a check command (a flag is not a command — run the tool with --help for usage)" }
    const owner = await turns.resolve(typeof req.session === "string" ? req.session : undefined, typeof req.cwd === "string" ? req.cwd : undefined)
    if (typeof owner === "string") return { ok: false, message: owner }
    const refused = startWatch(owner.key, owner.adapter, spec)
    return { ok: !refused, message: refused ?? "jep is watching; end this turn and say what you are waiting for" }
  }

  // ─── restart on request ─────────────────────────────────────────────
  // `jep-restart` asks and returns at once; the daemon restarts when no turn is
  // busy (the caller's own turn included), or at the deadline, after which the
  // journal lets the cut-off turns resume. The agent says nothing more than
  // "end this turn": it never schedules, sleeps or polls around the death of
  // its own process.
  let restartDeadline = 0
  let restartTimer: ReturnType<typeof setInterval> | null = null
  const checkRestart = (): void => {
    if (!restartDeadline || turns.closing()) return
    const busy = turns.busy()
    if (busy > 0 && Date.now() < restartDeadline) return
    console.error(busy > 0 ? `[restart] ${busy} turn(s) still busy at the deadline: restarting anyway, they resume after` : "[restart] every turn has ended: restarting")
    restartDeadline = 0
    if (restartTimer) clearInterval(restartTimer)
    restartTimer = null
    // a beat for the last reply to reach its client
    setTimeout(() => opts.restart?.(), 1_500).unref()
  }
  const restartRequest = (req: ControlRequest): ControlReply => {
    if (!opts.restart) return { ok: false, message: "this daemon cannot restart itself" }
    if (restartDeadline) return { ok: true, message: "a restart is already queued; end this turn" }
    const waitMs = restartWaitMs(req)
    restartDeadline = Date.now() + waitMs
    restartTimer = setInterval(checkRestart, 1_000)
    restartTimer.unref()
    const minutes = Math.round(waitMs / 60_000)
    console.error(`[restart] queued: waits for ${turns.busy()} turn(s), up to ${minutes} min`)
    return {
      ok: true,
      message: `restart queued: the daemon restarts when every turn has ended (at most ${minutes} min). End this turn now and do not wait for it. Any turn it cuts off is picked up again.`,
    }
  }

  // `jep-rename`: the agent titles its own conversation
  const renameRequest = async (req: ControlRequest): Promise<ControlReply> => {
    if (!opts.rename) return { ok: false, message: "this daemon cannot rename conversations" }
    const title = typeof req.title === "string" ? req.title.replace(/\s+/g, " ").trim().slice(0, 120) : ""
    if (!title) return { ok: false, message: "give a title" }
    const owner = await turns.resolve(typeof req.session === "string" ? req.session : undefined, typeof req.cwd === "string" ? req.cwd : undefined)
    if (typeof owner === "string") return { ok: false, message: owner }
    await opts.rename(owner.key, title)
    return { ok: true, message: `renamed to "${title}"` }
  }

  // ─── read another conversation ──────────────────────────────────────
  // `jep-read` lets an agent look at a different conversation, but only with the person's yes: a
  // card in the asking conversation names both and waits. "Always" is remembered for that pair.
  const grantsFile = join(dataHome, "chat-grants.json")
  const grants = (() => {
    try {
      return parseGrants(readFileSync(grantsFile, "utf8"))
    } catch {
      return parseGrants("")
    }
  })()
  const saveGrants = (): void => {
    try {
      writeFileSync(grantsFile, serializeGrants(grants))
    } catch (err) {
      console.error(`[read] could not save grants: ${(err as Error)?.message ?? err}`)
    }
  }
  const readRequest = async (req: ControlRequest): Promise<ControlReply> => {
    const dir = opts.chats
    if (!dir) return { ok: false, message: "this daemon cannot share conversations" }
    const all = await dir.list()
    if (req.list === true) {
      const rows = [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40)
      return { ok: true, message: rows.map((c) => `${c.id}  ${c.harness}  ${c.title.slice(0, 60)}`).join("\n") || "no conversations" }
    }
    const asker = await turns.resolve(typeof req.session === "string" ? req.session : undefined, typeof req.cwd === "string" ? req.cwd : undefined)
    if (typeof asker === "string") return { ok: false, message: asker }
    const picked = pickChat(all, typeof req.target === "string" ? req.target : "")
    if (!picked.ok) return { ok: false, message: picked.message }
    const target = picked.chat
    if (target.id === asker.key) return { ok: false, message: "that is this conversation" }
    const last = typeof req.last === "number" && req.last > 0 ? Math.min(500, Math.floor(req.last)) : 40
    if (!hasGrant(grants, asker.key, target.id)) {
      const mine = all.find((c) => c.id === asker.key)
      const answer = await dir.askPerson(
        asker.key,
        {
          title: "Read another conversation?",
          detail: `${mine ? `"${mine.title.slice(0, 60)}"` : "This conversation"} wants to read "${target.title.slice(0, 60)}" (${target.harness}, ${target.workspace.split("/").pop() ?? ""}).`,
          options: [
            { id: "allow", label: "Allow once", style: "success" },
            { id: "always", label: "Always allow this one" },
            { id: "reject", label: "Deny", style: "danger" },
          ],
        },
        opts.readWaitMs ?? 10 * 60_000,
      )
      if (answer === null) return { ok: false, message: "nobody answered the request to read that conversation; it was not read" }
      if (answer === "reject") return { ok: false, message: "the person said no: that conversation was not shared" }
      if (answer === "always") {
        addGrant(grants, asker.key, target.id)
        saveGrants()
      }
    }
    const got = await dir.read(target.id, last)
    if (!got) return { ok: false, message: "that conversation is gone" }
    console.error(`[read] ${asker.key} read ${target.id} (last ${last})`)
    return { ok: true, message: renderForRead(got.messages, { title: got.info.title, harness: got.info.harness, workspace: got.info.workspace, last }) }
  }

  const control = await startControl(dataHome, { watch: watchRequest, restart: restartRequest, rename: renameRequest, read: readRequest })

  // ─── pick up what the last run left ─────────────────────────────────
  // Watches that were waiting, and turns a restart or a crash cut off. After a
  // short beat, so the workspaces are up.
  const restore = async (): Promise<void> => {
    let saved: ReturnType<typeof parseSavedWatches> = []
    try {
      saved = parseSavedWatches(readFileSync(watchFile, "utf8"))
    } catch {
      // none were waiting
    }
    for (const w of saved) {
      const adapter = await turns.find(w.key)
      if (!adapter) continue
      const refused = startWatch(w.key, adapter, w.spec, w.startedAt)
      if (refused) console.error(`[watch] not restored (${w.key}): ${refused}`)
    }
    for (const key of leftover) {
      if (!(await turns.find(key))) {
        journal.delete(key)
        console.error(`[restart] cannot pick up ${key}: the conversation is gone`)
        continue
      }
      console.error(`[restart] picking up the turn a restart cut off (${key})`)
      turns.enqueue(key, RESUME_TEXT, { resume: true, notice: true })
    }
    saveJournal()
  }
  const restoreTimer = setTimeout(() => detach("restore after start", restore()), opts.restoreAfterMs ?? 2_000)
  restoreTimer.unref()

  return {
    close: () => {
      clearTimeout(restoreTimer)
      if (restartTimer) clearInterval(restartTimer)
      for (const set of watches.values()) for (const w of set) if (w.timer) clearTimeout(w.timer)
      watches.clear()
      control.close()
    },
  }
}

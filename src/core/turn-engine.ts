import type { ConversationMcp } from "./mcp.ts"
import { readGuest, readLoopMarker, readNoticeMarker, stripInjectedContext } from "./transcript.ts"
import type { HarnessAdapter, TurnHost, TurnListener } from "./ports.ts"
import type { DomainEvent, HarnessError, Message } from "./types.ts"
import { eventSession, isAborted } from "./types.ts"
import { judgeTurn, type LivenessConfig } from "./liveness.ts"
import { describeError } from "./errors.ts"
import { quoteBlock } from "./transcript.ts"
import {
  continuationText,
  evaluateLoop,
  isTransientError,
  retryDelayMs,
  runVerifier,
  LOOP_RETRY_MAX,
  type LoopState,
  type LoopVerify,
} from "./loops.ts"
import { detach } from "./detach.ts"
import { TurnLedger } from "./ledger.ts"

/**
 * The turn engine: one turn in flight per conversation, plus whatever waits
 * behind it. It is what makes "send while it works" real: a prompt that arrives
 * mid-turn waits, and is steered in at the next tool boundary, or forced when
 * the client asks to end the running turn and run it now. It also owns the
 * loops (a chat that keeps going until a check passes), the watchdog that gives
 * up on a silent turn, and the record of running turns that the daemon's own
 * services read (`TurnHost`).
 *
 * It knows no client. The gateway feeds it events from the harnesses and calls
 * it from its routes; anything else that runs turns can do the same. Everything
 * it needs from the rest of the daemon comes in through `TurnEnv`.
 */

export type TurnResult = { status: number; message?: Message; aborted?: boolean; cancelled?: boolean; error?: string }

export type PendingTurn = {
  text: string
  filePaths: string[]
  model?: { providerID: string; modelID: string }
  agent?: string
  /** steer at the next tool boundary (the default) or wait for the turn to end */
  steer: boolean
  /** asked to run ahead of everything else, aborting the running turn */
  force?: boolean
  /** the client's own handle, so it can edit / cancel / force this while it waits */
  clientID?: string
  /** the words this answers; the adapter hands it to its harness */
  quote?: string
  /** queued by a loop, so this turn advances it and never merges with a
   * person's waiting words */
  loop?: boolean
  /** queued by the daemon on its own account (a watch's wake-up): it runs
   * alone, never merges with a person's waiting words, and is not theirs to
   * edit or reorder */
  notice?: boolean
  /** a pick-up of a turn a restart cut off (core/restarts.ts) */
  resume?: boolean
  resolve: (r: TurnResult) => void
  /** set on a turn built from several waiting prompts: every handle in it */
  clientIDs?: string[]
}

// How a turn ended when something other than prompt() decided it. The runner
// reads this after the abort lands, so a stalled or failed turn reports what
// actually happened instead of the bare "aborted" every abort used to become.
export type TurnEnd =
  /** the harness said session.idle; the answer is streamed, prompt() just hung */
  | { kind: "idle" }
  /** a provider failure the harness logged but never put on the event stream */
  | { kind: "provider"; error: HarnessError }
  /** the harness's own session.error */
  | { kind: "error"; message: string }
  /** nothing came back at all for a whole ceiling */
  | { kind: "stall"; elapsedMs: number; tool?: string }

export type TurnState = {
  running: PendingTurn | null
  waiting: PendingTurn[]
  signal?: AbortController
  /** when this session last produced any harness event — the watchdog's clock */
  lastActivity: number
  /** tools the harness says are running now, so a stall can name the culprit */
  runningTools: Map<string, { name: string; startedAt: number }>
  /** set by the watchdog or the event stream, read by the runner */
  ending?: TurnEnd
  /** armed by session.idle, cleared when the turn settles */
  idleGrace?: ReturnType<typeof setTimeout>
  /** the running turn produced an event of its own (not an end marker) */
  sawActivity?: boolean
  /** the harness already said idle for the running turn */
  idleSeen?: boolean
  /** between turns: waiting for the last one's session.idle */
  settling?: boolean
  /** ends the settle wait early, when that idle arrives */
  settled?: () => void
  /** the running turn is being ended to let a waiting prompt in */
  handover?: boolean
}

/** what the engine needs of the rest of the daemon */
export interface TurnEnv {
  /** the harness a conversation lives in, when it is known */
  adapterOf(id: string): HarnessAdapter | undefined
  /** find it, scanning the harnesses when it was never listed */
  find(id: string): Promise<HarnessAdapter | null>
  /** the conversation's per-session settings (also carries them to a new id) */
  settingsOf(adapter: HarnessAdapter, id: string): Record<string, boolean> | undefined
  /** the MCP servers a client defined for the conversation (also carried to a new id) */
  mcpOf?(adapter: HarnessAdapter, id: string): ConversationMcp | undefined
  /** permission asks open on a conversation: a turn parked on one waits on a person */
  openAsks(id: string): number
  /** the record changed: drop any snapshot of it */
  recordChanged(id: string): void
  /** a loop's state changed: keep it, and tell every client to read it again */
  loopChanged(loops: Map<string, LoopState>, sessionID: string): void
}

export interface TurnEngineOpts {
  liveness: LivenessConfig
  loops: Map<string, LoopState>
  ledger?: TurnLedger
}

/** why a queued prompt could not be acted on, in the HTTP words the gateway uses */
export type QueueRefusal = { status: 400 | 404 | 409; error: string }

export class TurnEngine implements TurnHost {
  readonly loops: Map<string, LoopState>
  readonly ledger: TurnLedger
  #env: TurnEnv
  #liveness: LivenessConfig
  #turns = new Map<string, TurnState>()
  #watchdog: ReturnType<typeof setInterval>

  constructor(env: TurnEnv, opts: TurnEngineOpts) {
    this.#env = env
    this.#liveness = opts.liveness
    this.loops = opts.loops
    this.ledger = opts.ledger ?? new TurnLedger()
    // The liveness the gateway used to be missing entirely. Every turn runs with
    // timeoutMs: 0, so without this a turn whose harness went silent (a 429, a
    // usage cap, a dropped upstream socket) stayed "running" forever, and every
    // prompt queued behind it waited with it. The only way out was the human
    // hitting stop.
    this.#watchdog = setInterval(() => this.#watch(), opts.liveness.tickMs)
    this.#watchdog.unref()
  }

  // ─── who is running what ──────────────────────────────────────────────

  // One conversation, one line. Claude names a new conversation with a
  // placeholder and learns its real id mid-turn; clients move to the real id
  // then, and its events carry the real id from then on. Keyed by the raw id,
  // a turn started under the placeholder and a prompt sent under the real id
  // were two lines: two harness processes writing one record at once, a
  // watchdog and a steer that never saw the first, and a stop that reached
  // only one of them.
  turnKey(id: string): string {
    if (this.#turns.has(id)) return id
    const canon = (x: string): string => this.#env.adapterOf(x)?.canonicalId?.(x) ?? x
    const want = canon(id)
    for (const key of this.#turns.keys()) if (key === want || canon(key) === want) return key
    return id
  }
  turnOf(id: string): TurnState | undefined {
    return this.#turns.get(this.turnKey(id))
  }
  isActive(id: string): boolean {
    return this.turnOf(id)?.running != null
  }
  /** a turn running, settling, or anything waiting behind it */
  isBusy(id: string): boolean {
    const st = this.turnOf(id)
    return st != null && (st.running != null || st.settling === true || st.waiting.length > 0)
  }
  /** what waits behind the running turn, as a client draws it */
  queueOf(id: string): Array<{ clientID: string | null; text: string; steer: boolean; notice: boolean; noticeKind?: string; loop?: { iteration: number; max: number } }> {
    return (this.turnOf(id)?.waiting ?? []).map((p) => {
      const kind = p.notice === true ? (readNoticeMarker(p.text)?.kind ?? (readGuest(p.text) ? "guest" : undefined)) : undefined
      // a loop's next step waits in the line like anything else, but it is jep's, not the person's: say so
      const loop = p.loop === true ? readLoopMarker(stripInjectedContext(p.text)) : null
      return { clientID: p.clientID ?? null, text: p.text, steer: p.steer, notice: p.notice === true, ...(kind ? { noticeKind: kind } : {}), ...(loop ? { loop } : {}) }
    })
  }
  /** the conversation did something (a person answered an ask): the watchdog's clock restarts */
  touch(id: string): void {
    const st = this.turnOf(id)
    if (st) st.lastActivity = Date.now()
  }

  // ─── what the daemon's own services see (TurnHost) ────────────────────

  async resolve(session: string | undefined, cwd: string | undefined): Promise<{ key: string; adapter: HarnessAdapter } | string> {
    if (session) {
      const adapter = await this.#env.find(session)
      return adapter ? { key: this.loopKey(session), adapter } : `jep does not know a conversation called ${session}`
    }
    const here: { key: string; adapter: HarnessAdapter }[] = []
    for (const [key, st] of this.#turns) {
      const adapter = st.running ? this.#env.adapterOf(key) : undefined
      if (adapter && cwd && (cwd === adapter.workspace || cwd.startsWith(`${adapter.workspace}/`))) here.push({ key, adapter })
    }
    if (here.length === 1) return here[0]!
    return here.length ? "several conversations are running here; pass --session" : "no conversation is running in this directory; pass --session"
  }
  find(key: string): Promise<HarnessAdapter | null> {
    return this.#env.find(key)
  }
  enqueue(key: string, text: string, opts?: { resume?: boolean; notice?: boolean }): void {
    const st = this.#state(key)
    st.waiting.push({
      text,
      filePaths: [],
      steer: false,
      // `notice` is the handle's own word for what this is: clients read it and
      // draw jep's own note as a boundary, not as one of the person's prompts
      clientID: `${opts?.resume ? "resume" : opts?.notice ? "notice" : "queued"}-${Date.now().toString(36)}`,
      ...(opts?.resume ? { resume: true } : {}),
      ...(opts?.notice ? { notice: true } : {}),
      resolve: () => {},
    })
    this.#run(key)
  }
  // a turn some other client runs (the bot) counts too: it is on the ledger
  busy(): number {
    return Math.max(this.ledger.running(), [...this.#turns.values()].filter((st) => st.running || st.settling || st.waiting.length > 0).length)
  }
  observe(listener: TurnListener): void {
    this.ledger.observe(listener)
  }
  closing(): boolean {
    return this.ledger.closing()
  }

  /** the daemon is going down: stop watching, and mark every turn that ends from here as cut off */
  close(): void {
    this.ledger.close()
    clearInterval(this.#watchdog)
    for (const st of this.#turns.values()) if (st.idleGrace) clearTimeout(st.idleGrace)
  }

  // ─── the queue ────────────────────────────────────────────────────────

  #state(key: string): TurnState {
    const st = this.#turns.get(key) ?? { running: null, waiting: [], lastActivity: Date.now(), runningTools: new Map() }
    this.#turns.set(key, st)
    return st
  }
  #run(key: string): void {
    detach(`turn queue ${key}`, this.#runNext(key))
  }

  /**
   * A client's prompt. It waits behind the running turn (and is steered in at
   * the next tool boundary); `force` ends the running turn cleanly, so that
   * prompt gets its answer from the transcript, and runs this one next.
   */
  submit(id: string, pending: PendingTurn, force = false): void {
    const key = this.turnKey(id)
    const st = this.#state(key)
    if (force) {
      pending.force = true
      st.waiting.unshift(pending)
      if (st.running && !st.ending) st.handover = true
      if (st.running) this.#endTurn(id, st, { kind: "idle" }, "force")
      st.signal?.abort()
    } else {
      st.waiting.push(pending)
    }
    this.#run(key)
  }

  /**
   * Stop. `all`: the prompts waiting behind the turn stop too, instead of the
   * next one starting the moment this one ends; their words come back so the
   * client can hand them to its composer. Stop also stops the loop (all of it,
   * or the loop's own running turn): otherwise the next continuation is already
   * in line and the stop did nothing visible. A turn a person started is theirs
   * to finish.
   */
  async stop(id: string, all: boolean, adapter: HarnessAdapter): Promise<{ stopped: boolean; dropped: string[] }> {
    const st = this.turnOf(id)
    if (all || st?.running?.loop) this.stopLoop(this.turnKey(id), "stopped")
    const dropped = all && st ? st.waiting.splice(0) : []
    for (const p of dropped) p.resolve({ status: 200, cancelled: true })
    const stopped = await adapter.abort(id).catch(() => false)
    // jep's own turns (a loop's next step, a watch's wake-up) stop with the
    // rest, but their words are not the person's: handing them back would paste
    // jep's scaffolding into their message box as if they had typed it
    return { stopped, dropped: dropped.filter((p) => !p.notice && !p.loop).map((p) => p.text) }
  }

  // Acting on a queued prompt the client still holds a handle to (a clientID).
  // Once it is running it is too late, and the client is told so.
  #queued(id: string, clientID: string): { st: TurnState; idx: number; entry: PendingTurn } | QueueRefusal {
    const st = this.turnOf(id)
    if (st?.running?.clientID === clientID || st?.running?.clientIDs?.includes(clientID)) return { status: 409, error: "already running" }
    const idx = st ? st.waiting.findIndex((p) => p.clientID === clientID) : -1
    if (!st || idx < 0) return { status: 404, error: "not queued" }
    return { st, idx, entry: st.waiting[idx]! }
  }
  cancelQueued(id: string, clientID: string): QueueRefusal | null {
    const q = this.#queued(id, clientID)
    if ("error" in q) return q
    q.st.waiting.splice(q.idx, 1)
    q.entry.resolve({ status: 200, cancelled: true })
    // dropping the continuation is dropping the loop's next step
    if (q.entry.loop) this.stopLoop(this.turnKey(id), "stopped")
    return null
  }
  editQueued(id: string, clientID: string, text: string): QueueRefusal | null {
    const q = this.#queued(id, clientID)
    if ("error" in q) return q
    // a continuation's text is jep's instruction, marker and all;
    // rewriting it would break the boundary the clients draw
    if (q.entry.loop) return { status: 409, error: "a loop turn cannot be edited" }
    // and a notice is jep's own account of a finished wait, not a draft
    if (q.entry.notice) return { status: 409, error: "jep's own note cannot be edited" }
    if (!text.trim()) return { status: 400, error: "text required" }
    q.entry.text = text
    return null
  }
  // Put it at another place in the line. The waiting prompts run as one turn,
  // their words in this order. A forced prompt runs first and alone, so nothing
  // moves ahead of one, and one does not move.
  moveQueued(id: string, clientID: string, to: unknown): QueueRefusal | { queue: ReturnType<TurnEngine["queueOf"]> } {
    const q = this.#queued(id, clientID)
    if ("error" in q) return q
    if (typeof to !== "number" || !Number.isInteger(to)) return { status: 400, error: "to required" }
    if (q.entry.force) return { status: 409, error: "runs next" }
    // a notice is placed by the daemon, not dragged by a reader
    if (q.entry.notice) return { status: 409, error: "jep's own note is not in your line" }
    q.st.waiting.splice(q.idx, 1)
    const first = q.st.waiting.findIndex((p) => !p.force)
    const lo = first < 0 ? q.st.waiting.length : first
    q.st.waiting.splice(Math.min(q.st.waiting.length, Math.max(lo, to)), 0, q.entry)
    return { queue: this.queueOf(id) }
  }
  // Run it next, ending the running turn cleanly so it gets the answer from the
  // transcript, then abort so the forced prompt runs next.
  forceQueued(id: string, clientID: string): QueueRefusal | null {
    const q = this.#queued(id, clientID)
    if ("error" in q) return q
    // forcing jep's own note would abort the person's running turn for it
    if (q.entry.notice) return { status: 409, error: "jep's own note is not yours to run now" }
    q.st.waiting.splice(q.idx, 1)
    q.entry.force = true
    q.st.waiting.unshift(q.entry)
    if (q.st.running && !q.st.ending) q.st.handover = true
    if (q.st.running) this.#endTurn(id, q.st, { kind: "idle" }, "queue-force")
    q.st.signal?.abort()
    return null
  }

  // ─── ending a turn ────────────────────────────────────────────────────

  // End the running turn for a reason that is not a client stop. The abort is
  // what unblocks prompt(); `ending` is what tells the runner why, so the phone
  // gets a named failure rather than a silent stop.
  #endTurn(id: string, st: TurnState, end: TurnEnd, origin: string): void {
    if (!st.running || st.ending) return
    st.ending = end
    console.error(`[stop] origin=${origin} (gateway session ${id})`)
    st.signal?.abort()
  }

  #watch(): void {
    for (const [id, st] of this.#turns) {
      if (!st.running || !st.signal || st.ending) continue
      const adapter = this.#env.adapterOf(id)
      // A provider failure opencode logs to its own stderr and never emits as an
      // event (a 429, a usage cap). This is the one place that failure is
      // legible, so prefer it over waiting out the ceiling for an unexplained
      // stall: the turn is not coming back, and now we can say why.
      const pe = adapter?.providerError?.(id)
      if (pe) {
        console.error(`[watchdog] provider error (gateway session ${id}): ${describeError(pe)}`)
        this.#endTurn(id, st, { kind: "provider", error: pe }, "watchdog-provider-error")
        detach(`abort ${id}`, adapter?.abort(id))
        continue
      }
      const v = judgeTurn({
        now: Date.now(),
        lastActivity: st.lastActivity,
        // parked on a permission ask: waiting on the human, not stalled
        waitingOnHuman: this.#env.openAsks(id) > 0,
        tools: [...st.runningTools.values()],
        config: this.#liveness,
      })
      if (!v.stalled) continue
      console.error(
        `[watchdog] turn stalled ${Math.round(v.elapsedMs / 1000)}s (ceiling ${Math.round(v.ceilingMs / 1000)}s, tools=${st.runningTools.size}${v.wedgedMs !== undefined ? `, ${v.tool} wedged ${Math.round(v.wedgedMs / 60_000)}m` : ""}, gateway session ${id})`,
      )
      this.#endTurn(id, st, { kind: "stall", elapsedMs: v.elapsedMs, ...(v.tool ? { tool: v.tool } : {}) }, "watchdog-stall")
      detach(`abort ${id}`, adapter?.abort(id))
    }
  }

  // ─── the harness's event feed ─────────────────────────────────────────

  /**
   * Every event a harness emits passes through here first. It keeps the
   * watchdog's clock, notices a turn ending on the stream, steers a waiting
   * prompt in, and returns the event a client should see (a stop jep made to
   * hand the session to a waiting prompt is tagged, so a client keeps the turn
   * on screen as running instead of announcing "the turn was stopped").
   */
  onEvent(evt: DomainEvent, adapter: HarnessAdapter): DomainEvent {
    // every event on a session pushes that session's watchdog deadline out: a
    // turn producing anything at all has not stalled
    const sid = eventSession(evt)
    const live = sid ? this.turnOf(sid) : undefined
    if (live) live.lastActivity = Date.now()
    // what the running turn itself produced, as opposed to the end markers
    // a turn that was just cancelled still has in flight
    const ending = evt.type === "session.idle" || evt.type === "turn.aborted" || evt.type === "session.error" || evt.type === "session.changed"
    if (live?.running && !ending) {
      live.sawActivity = true
      // the harness said idle and then kept working: that idle belonged to
      // something else (a cancelled turn's tail), not to this one
      if (live.idleGrace) {
        clearTimeout(live.idleGrace)
        live.idleGrace = undefined
      }
    }
    if (evt.type === "session.idle" && live) {
      if (live.running) live.idleSeen = true
      // the turn before is fully over: the next one may start
      live.settled?.()
    }
    // what the turn is doing decides which ceiling applies, so track the
    // tools the harness reports as running (and when each one started)
    if (evt.type === "part.updated" && evt.part?.kind === "tool" && live) {
      if (evt.part.status === "running") {
        if (!live.runningTools.has(evt.partID)) {
          live.runningTools.set(evt.partID, { name: evt.part.name, startedAt: evt.part.startedAt ?? Date.now() })
        }
      } else live.runningTools.delete(evt.partID)
    }
    // the turn is over and the record is settled: drop the snapshot so the
    // next read is the finished one
    if (evt.type === "session.idle" || evt.type === "turn.aborted" || evt.type === "session.changed") this.#env.recordChanged(evt.sessionID)
    // The harness says the turn is done. prompt() normally returns right
    // about now, but that POST can hang even with the answer fully
    // streamed, which pinned the turn (and everything queued behind it)
    // forever. Give it a grace period, then finalize from the transcript.
    // Only for a turn that has produced something: an idle that arrives
    // before that is the previous turn's, and finalizing on it killed the
    // steered-in turn five seconds after it started.
    if (evt.type === "session.idle" && live?.running && live.sawActivity && !live.ending && live.idleGrace === undefined) {
      live.idleGrace = setTimeout(() => {
        live.idleGrace = undefined
        this.#endTurn(evt.sessionID, live, { kind: "idle" }, "idle-grace")
      }, this.#liveness.idleGraceMs)
    }
    // The harness's own account of a failed turn, delivered on the stream
    // rather than by prompt() rejecting. Left unhandled it vanished and the
    // turn sat until somebody hit stop.
    if (evt.type === "session.error" && live?.running) {
      console.error(`[turn] session.error (gateway session ${evt.sessionID}): ${evt.message}`)
      this.#endTurn(evt.sessionID, live, { kind: "error", message: evt.message || "the harness reported an error" }, "session-error")
      void adapter.abort(evt.sessionID).catch(() => {})
    }
    // steer: a prompt waiting behind this turn is folded in at the next tool
    // boundary. End the turn cleanly (so the running prompt gets the answer
    // from the transcript) and the runner starts the waiting prompt.
    // The boundary is the harness's own step end where it reports one (opencode's step-finish,
    // after every tool of the step is done); for the others, any tool call that has finished.
    // Matching opencode's event alone meant a steer never folded in on claude, codex, goose or pi:
    // it waited for the whole turn to end.
    const stepEnd = evt.type === "part.updated" && evt.part?.kind === "other" && evt.part.nativeType === "step-finish"
    const toolDone =
      evt.type === "part.updated" &&
      evt.part?.kind === "tool" &&
      (evt.part.status === "completed" || evt.part.status === "error") &&
      adapter.reportsSteps !== true
    if (stepEnd || toolDone) {
      const st = this.turnOf(evt.sessionID)
      // only a prompt that asked to steer interrupts the running turn; one
      // that asked to wait for the end is left alone
      if (st?.running && st.waiting.some((p) => p.steer)) {
        st.handover = true
        this.#endTurn(evt.sessionID, st, { kind: "idle" }, "steer-in")
        st.signal?.abort()
      }
    }
    if (evt.type === "turn.aborted" && live?.handover) {
      live.handover = false
      return { ...evt, reason: "handover" }
    }
    return evt
  }

  // ─── loops ────────────────────────────────────────────────────────────
  // A loop is one chat that keeps going: a goal, a stop condition that runs
  // outside the model, and a cap. The engine owns the queue, so it owns the
  // next turn; the decisions live in core/loops.ts so the bot can drive the
  // same loop without copying them.

  loopKey(id: string): string {
    return this.#env.adapterOf(id)?.canonicalId?.(id) ?? id
  }
  loopOf(id: string): LoopState | null {
    return this.loops.get(this.loopKey(id)) ?? null
  }
  #putLoop(loop: LoopState): void {
    this.loops.set(loop.sessionID, loop)
    // the iteration and the ending are state a client cannot infer from the
    // record; one nudge makes every open tab read history again
    this.#env.loopChanged(this.loops, loop.sessionID)
  }
  #adapterFor(id: string): HarnessAdapter | undefined {
    return this.#env.adapterOf(id) ?? this.#env.adapterOf(this.loopKey(id))
  }

  /** a loop is begun: its state, and the goal as an ordinary turn the person can read */
  startLoop(loop: LoopState, first: PendingTurn): void {
    this.#putLoop(loop)
    this.#state(loop.sessionID).waiting.push(first)
    this.#run(loop.sessionID)
  }

  /** the person stops a loop; only the loop's own running turn is cut short */
  stopLoopByPerson(id: string): LoopState | null {
    const key = this.turnKey(id)
    const loop = this.loops.get(key)
    if (loop?.status === "running") {
      const running = this.#turns.get(key)?.running
      this.stopLoop(key, "stopped")
      // only the loop's own turn: a person's turn is theirs to finish
      if (running?.loop) this.#turns.get(key)?.signal?.abort()
    }
    return this.loops.get(key) ?? null
  }

  clearLoop(id: string): void {
    const key = this.turnKey(id)
    if (!this.loops.has(key)) return
    if (this.loops.get(key)?.status === "running") this.stopLoop(key, "stopped")
    this.loops.delete(key)
    this.#env.loopChanged(this.loops, key)
  }

  // Stop the loop and take back everything it queued, so a Stop is not
  // immediately followed by the next continuation.
  stopLoop(key: string, status: LoopState["status"], error?: string): LoopState | null {
    const loop = this.loops.get(key)
    if (!loop) return null
    loop.status = status
    loop.updatedAt = Date.now()
    if (error) loop.error = error
    const st = this.#turns.get(key)
    if (st) {
      for (let i = st.waiting.length - 1; i >= 0; i--) {
        const waiting = st.waiting[i]!
        if (!waiting.loop) continue
        st.waiting.splice(i, 1)
        waiting.resolve({ status: 200, cancelled: true })
      }
    }
    this.#putLoop(loop)
    return loop
  }

  #textOf(m: Message | undefined): string {
    return (m?.parts ?? []).map((p) => (p.kind === "text" ? p.text : "")).join("\n")
  }

  // A turn killed by a dropped socket, a 429 or a gateway 5xx says nothing
  // about the goal. Retry the same turn after backoff instead of ending the
  // loop; the turn counter does not move, so the cap still means turns, not
  // attempts. Only repeated failure is a failure.
  #retryLoop(key: string, reason: string): boolean {
    const loop = this.loops.get(key)
    if (!loop || loop.status !== "running") return false
    const attempts = loop.attempts ?? 0
    if (attempts >= LOOP_RETRY_MAX) return false
    loop.attempts = attempts + 1
    loop.updatedAt = Date.now()
    delete loop.error
    this.#putLoop(loop)
    const delay = retryDelayMs(loop.attempts)
    console.error(
      `[loop] transient failure, retry ${loop.attempts}/${LOOP_RETRY_MAX} in ${Math.round(delay / 1000)}s (gateway session ${key}): ${reason}`,
    )
    const timer = setTimeout(() => {
      if (this.loops.get(key) !== loop || loop.status !== "running") return
      this.#state(key).waiting.push({
        text: continuationText(loop, loop.lastVerify),
        filePaths: [],
        steer: false,
        loop: true,
        clientID: `loop-retry-${loop.attempts}-${Date.now().toString(36)}`,
        resolve: () => {},
      })
      this.#run(key)
    }, delay)
    timer.unref()
    return true
  }

  // The turn that just ended is the loop's; say whether it goes on, and if it
  // does, put the next instruction in line. The verifier runs here, outside
  // the model: an agent never grades its own work.
  async #advanceLoop(key: string, loop: LoopState, answer: Message | undefined): Promise<void> {
    if (this.loops.get(key) !== loop || loop.status !== "running") return
    loop.iteration += 1
    // the turn reached the harness and came back: the provider is healthy again
    loop.attempts = 0
    loop.updatedAt = Date.now()
    let verify: LoopVerify | undefined
    if (loop.spec.verify) {
      if (!this.#adapterFor(key)) {
        this.stopLoop(key, "failed", "the harness went away")
        return
      }
      verify = await runVerifier(loop.spec.verify, loop.workspace)
      loop.lastVerify = verify
    }
    const verdict = evaluateLoop({ iteration: loop.iteration, spec: loop.spec, lastText: this.#textOf(answer), ...(verify ? { verify } : {}) })
    if (verdict.done) {
      loop.status = verdict.reason === "verified" || verdict.reason === "marker" ? "done" : "exhausted"
      this.#putLoop(loop)
      return
    }
    // between the verifier and this push the person may have stopped it
    if (this.loops.get(key) !== loop || loop.status !== "running") return
    this.#state(key).waiting.push({
      text: continuationText(loop, verify),
      filePaths: [],
      steer: false,
      loop: true,
      clientID: `loop-${loop.iteration}-${Date.now().toString(36)}`,
      resolve: () => {},
    })
    this.#putLoop(loop)
  }

  // ─── running the line ─────────────────────────────────────────────────

  // Everything waiting runs as one turn. Three messages typed while the agent
  // worked are one thought; running them one by one cost three turns, and each
  // steer-in aborted the one before. The first quote rides as the quote, any
  // later one goes in as words, ahead of the message it belongs to.
  #mergeWaiting(batch: PendingTurn[]): PendingTurn {
    if (batch.length === 1) return batch[0]!
    const head = batch[0]!
    const quote = batch.find((p) => p.quote?.trim())?.quote
    const text = batch
      .map((p) => (p.quote?.trim() && p.quote !== quote ? `${quoteBlock(p.quote)}\n\n${p.text}` : p.text))
      .join("\n\n")
    return {
      ...head,
      text,
      filePaths: batch.flatMap((p) => p.filePaths),
      ...(quote ? { quote } : {}),
      steer: batch.some((p) => p.steer),
      clientIDs: batch.flatMap((p) => (p.clientID ? [p.clientID] : [])),
      resolve: (r) => {
        for (const p of batch) p.resolve(r)
      },
    }
  }

  // After a turn ends, hold the next one until the harness says the session is
  // idle (or a short while passes). A cancelled turn's own idle event and its
  // "Aborted" log line used to land on the turn started right after it.
  #settle(st: TurnState): Promise<void> {
    if (st.idleSeen) return Promise.resolve()
    st.settling = true
    return new Promise<void>((done) => {
      const finish = (): void => {
        clearTimeout(timer)
        st.settling = false
        st.settled = undefined
        done()
      }
      const timer = setTimeout(finish, this.#liveness.settleMs)
      st.settled = finish
    })
  }

  async #runNext(id: string): Promise<void> {
    const st = this.#turns.get(id)
    if (!st || st.running || st.settling) return
    if (st.waiting.length === 0) {
      this.#turns.delete(id)
      return
    }
    // a forced prompt runs on its own: it was asked for ahead of the rest.
    // A loop turn does too, and a notice too (jep's own wake-up): neither is
    // the person's words, so neither may merge into their batch, and a person's
    // prompts ahead of one never merge across it.
    const head = st.waiting[0]!
    const solo = st.waiting.findIndex((p) => p.loop === true || p.notice === true)
    const take = head.force || solo === 0 ? 1 : solo > 0 ? solo : st.waiting.length
    const next = this.#mergeWaiting(st.waiting.splice(0, take))
    const adapter = await this.#env.find(id)
    if (!adapter) {
      next.resolve({ status: 404, error: "no such session" })
      this.#run(id)
      return
    }
    st.running = next
    const turnOver = this.ledger.begin(id, next.resume === true)
    st.ending = undefined
    st.sawActivity = false
    st.idleSeen = false
    st.handover = false
    st.runningTools.clear()
    st.lastActivity = Date.now()
    const ac = new AbortController()
    st.signal = ac
    let answer: Message | undefined
    // a retried loop turn is not an iteration: the finally block must not
    // advance the loop and queue a second continuation beside the retry
    let retried = false
    try {
      const message = await adapter.prompt(id, next.text, {
        timeoutMs: 0,
        filePaths: next.filePaths,
        ...(next.model ? { model: next.model } : {}),
        ...(next.agent ? { agent: next.agent } : {}),
        harnessSettings: this.#env.settingsOf(adapter, adapter.canonicalId?.(id) ?? id) ?? {},
        ...(() => {
          const mcp = this.#env.mcpOf?.(adapter, adapter.canonicalId?.(id) ?? id)
          return mcp && Object.keys(mcp).length ? { mcp } : {}
        })(),
        ...(next.quote ? { quote: next.quote } : {}),
        signal: ac.signal,
      })
      answer = message
      next.resolve({ status: 200, message })
    } catch (err) {
      // An abort with a reason behind it is not a client stop: the watchdog or
      // the event stream ended this turn, and the reason is the whole point.
      // (read through a function: the assignment above narrows the property to
      // undefined for the rest of this method, and the abort path sets it behind our back)
      const end = this.#endingOf(st)
      if (end && isAborted(err)) {
        const result = await this.#settleEnded(adapter, id, end)
        answer = result.message
        // an idle is a finish; every other ending is the loop's stop condition,
        // unless the provider itself failed — then the turn is retried
        if (next.loop && end.kind !== "idle") {
          retried = this.#retryLoop(this.turnKey(id), result.error ?? end.kind)
          if (!retried) this.stopLoop(this.turnKey(id), "failed", result.error)
        }
        next.resolve(result)
      }
      // a stop is not a failure: it is the turn ending because somebody asked
      else if (isAborted(err)) {
        if (next.loop) this.stopLoop(this.turnKey(id), "stopped")
        next.resolve({ status: 200, aborted: true })
      } else {
        const message = String((err as Error)?.message ?? err)
        if (next.loop) {
          retried = isTransientError(message) && this.#retryLoop(this.turnKey(id), message)
          if (!retried) this.stopLoop(this.turnKey(id), "failed", message)
        }
        next.resolve({ status: 502, error: message })
      }
    } finally {
      turnOver()
      st.running = null
      st.signal = undefined
      st.ending = undefined
      st.runningTools.clear()
      if (st.idleGrace) clearTimeout(st.idleGrace)
      st.idleGrace = undefined
      // the turn wrote to the record; a snapshot from during it must not outlive it
      this.#env.recordChanged(id)
      // A first turn can give the session its real id, and the phone moves to
      // it. Settings left under the placeholder were lost from then on: the
      // second turn ran without "skip permissions" and stopped at every tool.
      const real = adapter.canonicalId?.(id)
      let key = id
      if (real && real !== id) {
        this.#env.settingsOf(adapter, real)
        // the line moves with them, so it is found by the id clients use now
        if (this.#turns.get(id) === st && !this.#turns.has(real)) {
          this.#turns.delete(id)
          this.#turns.set(real, st)
          key = real
        }
      }
      // The loop sees the turn's own record before the queue settles, so the
      // continuation it queues is next in line, not a race with it.
      if (next.loop && !retried) {
        const running = this.loops.get(key)
        if (running?.status === "running") {
          try {
            await this.#advanceLoop(key, running, answer)
          } catch (err) {
            console.error(`[loop] advance failed (gateway session ${key}): ${(err as Error)?.message ?? err}`)
            this.stopLoop(key, "failed", String((err as Error)?.message ?? err))
          }
        }
      }
      detach(`turn queue ${key}`, this.#settle(st).then(() => this.#runNext(key)))
    }
  }

  #endingOf(state: TurnState): TurnEnd | undefined {
    return state.ending
  }

  // Turn a watchdog/stream ending into the answer the phone gets. `idle` is a
  // success: the harness finished and only the blocking POST hung, so the
  // streamed answer is read back off the transcript. The rest are real
  // failures, named as precisely as the harness let us name them.
  async #settleEnded(adapter: HarnessAdapter, id: string, end: TurnEnd): Promise<TurnResult> {
    if (end.kind === "idle") {
      this.#env.recordChanged(id)
      const rows = await adapter.messages(id, { limit: 8 }).catch(() => [] as Message[])
      const last = [...rows].reverse().find((m) => m.role === "assistant")
      // the harness said the turn is done; if the record somehow has no
      // assistant message, a bare stop is still truer than inventing one
      return last ? { status: 200, message: last } : { status: 200, aborted: true }
    }
    if (end.kind === "provider") return { status: 502, error: describeError(end.error) }
    if (end.kind === "error") return { status: 502, error: end.message }
    const secs = Math.round(end.elapsedMs / 1000)
    const forHowLong = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`
    return {
      status: 504,
      error: end.tool
        ? `tool ${end.tool} ran ${forHowLong} with no progress — turn abandoned`
        : `no activity for ${forHowLong} — turn abandoned`,
    }
  }
}

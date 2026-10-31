import type { TurnListener } from "./ports.ts"

/**
 * Every client that runs a turn reports it here, so the daemon knows what is
 * running whoever started it: the phone's gateway and the Telegram bot both
 * begin a turn on this ledger and end it when it is over. The daemon's own
 * services (the journal, the restart drain) read it and never ask a client.
 *
 * A conversation counts once however many clients report it. `started` fires
 * when it goes from idle to running, `ended` when it goes back; and once the
 * daemon is closing, an end means the turn was cut off, not finished.
 */
export class TurnLedger {
  #open = new Map<string, number>()
  #listeners = new Set<TurnListener>()
  #closing = false

  /** a turn begins; the function it returns ends it (calling it twice is harmless) */
  begin(key: string, resume = false): () => void {
    const n = this.#open.get(key) ?? 0
    this.#open.set(key, n + 1)
    if (n === 0) this.#tell("started", key, resume)
    let over = false
    return () => {
      if (over) return
      over = true
      const left = (this.#open.get(key) ?? 1) - 1
      if (left > 0) return void this.#open.set(key, left)
      this.#open.delete(key)
      this.#tell("ended", key, this.#closing)
    }
  }

  /** conversations with a turn running right now */
  running(): number {
    return this.#open.size
  }

  observe(listener: TurnListener): void {
    this.#listeners.add(listener)
  }

  closing(): boolean {
    return this.#closing
  }

  /** the daemon is going down: the turns that end from here on were cut off */
  close(): void {
    this.#closing = true
  }

  #tell(what: "started" | "ended", key: string, flag: boolean): void {
    for (const l of this.#listeners) {
      try {
        l[what]?.(key, flag)
      } catch (err) {
        console.error(`[ledger] turn listener threw: ${(err as Error)?.message ?? err}`)
      }
    }
  }
}

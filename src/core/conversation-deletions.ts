import { readFileSync, writeFileSync, renameSync } from "node:fs"
import type { ConversationDeletionPort } from "./ports.ts"

/** Retain unsuccessful client cleanup so a daemon restart can retry it. */
export class ConversationDeletions implements ConversationDeletionPort {
  #file: string | null
  #pending = new Set<string>()
  #listeners = new Set<(id: string) => Promise<void> | void>()

  constructor(file: string | null) {
    this.#file = file
    if (file) {
      try {
        const saved: unknown = JSON.parse(readFileSync(file, "utf8"))
        if (Array.isArray(saved)) for (const id of saved) if (typeof id === "string") this.#pending.add(id)
      } catch { /* first start */ }
    }
  }

  onDeleted(listener: (id: string) => Promise<void> | void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  async deleted(id: string): Promise<void> {
    this.#pending.add(id)
    this.#save()
    const results = await Promise.allSettled([...this.#listeners].map(async (listener) => listener(id)))
    for (const result of results) if (result.status === "rejected") console.error(`[delete] client cleanup pending for ${id}: ${String(result.reason)}`)
    if (this.#listeners.size > 0 && results.every((r) => r.status === "fulfilled")) {
      this.#pending.delete(id)
      this.#save()
    }
  }

  async retryPending(): Promise<void> {
    for (const id of [...this.#pending]) await this.deleted(id)
  }

  #save(): void {
    if (!this.#file) return
    writeFileSync(this.#file + ".tmp", JSON.stringify([...this.#pending]), { mode: 0o600 })
    renameSync(this.#file + ".tmp", this.#file)
  }
}

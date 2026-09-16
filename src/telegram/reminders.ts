import { readFileSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

export interface ReminderRecord {
  id: string
  chatID: number
  what: string
  // epoch ms this reminder is next due
  nextAt: number
  // present + > 0 => recurring, reschedules itself after firing
  everyMs?: number
}

export class ReminderStore {
  #items: ReminderRecord[]
  #file: string | null

  constructor(items: ReminderRecord[], file: string | null) {
    this.#items = items
    this.#file = file
  }

  static load(file: string | null): ReminderStore {
    if (!file) return new ReminderStore([], null)
    try {
      const items = JSON.parse(readFileSync(file, "utf8")) as ReminderRecord[]
      return new ReminderStore(Array.isArray(items) ? items : [], file)
    } catch {
      return new ReminderStore([], file)
    }
  }

  list(): ReminderRecord[] {
    return [...this.#items]
  }

  add(chatID: number, what: string, nextAt: number, everyMs?: number): ReminderRecord {
    const r: ReminderRecord = { id: randomUUID(), chatID, what, nextAt, ...(everyMs ? { everyMs } : {}) }
    this.#items.push(r)
    this.#save()
    return r
  }

  remove(id: string): void {
    this.#items = this.#items.filter((r) => r.id !== id)
    this.#save()
  }

  reschedule(id: string, nextAt: number): void {
    const r = this.#items.find((x) => x.id === id)
    if (!r) return
    r.nextAt = nextAt
    this.#save()
  }

  #save(): void {
    if (!this.#file) return
    writeFileSync(this.#file, JSON.stringify(this.#items, null, 2))
  }
}

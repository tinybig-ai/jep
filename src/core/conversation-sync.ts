import type { ConversationSyncPort, ConversationSyncSource } from "./ports.ts"

/** One conversation source, with notifications reaching gateway and Telegram. */
export class ConversationSync implements ConversationSyncPort {
  #source: ConversationSyncSource | undefined
  #listeners = new Set<(id: string) => Promise<void> | void>()
  get ready(): boolean { return !!this.#source }
  connect(source: ConversationSyncSource): void { this.#source = source }
  #get(): ConversationSyncSource {
    if (!this.#source) throw new Error("Conversation sync is not connected")
    return this.#source
  }
  list(): ReturnType<ConversationSyncSource["list"]> { return this.#get().list() }
  read(...args: Parameters<ConversationSyncSource["read"]>): ReturnType<ConversationSyncSource["read"]> { return this.#get().read(...args) }
  async update(...args: Parameters<ConversationSyncSource["update"]>): Promise<void> {
    await this.#get().update(...args)
    await this.changed(args[0])
  }
  prompt(...args: Parameters<ConversationSyncSource["prompt"]>): ReturnType<ConversationSyncSource["prompt"]> { return this.#get().prompt(...args) }
  stop(id: string): Promise<boolean> { return this.#get().stop(id) }
  onChanged(listener: (id: string) => Promise<void> | void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
  async changed(id: string): Promise<void> {
    const results = await Promise.allSettled([...this.#listeners].map(async (listener) => listener(id)))
    for (const result of results) if (result.status === "rejected") console.error(`[sync] ${id}: ${String(result.reason)}`)
  }
}

import { readFileSync, writeFileSync } from "node:fs"

export interface StoreData {
  // session id -> display-name override (client-side; never touches the harness)
  titles: Record<string, string>
  // chat id -> "provider/model"
  models: Record<string, string>
}

export class ChatStore {
  #titles: Record<string, string>
  #models: Record<string, string>
  #file: string | null

  constructor(titles: Record<string, string>, models: Record<string, string>, file: string | null) {
    this.#titles = titles
    this.#models = models
    this.#file = file
  }

  static load(file: string | null): ChatStore {
    if (!file) return new ChatStore({}, {}, null)
    try {
      const d = JSON.parse(readFileSync(file, "utf8")) as StoreData
      return new ChatStore(d.titles ?? {}, d.models ?? {}, file)
    } catch {
      return new ChatStore({}, {}, file)
    }
  }

  title(id: string): string | null {
    return this.#titles[id] ?? null
  }

  model(chatID: number): string | null {
    return this.#models[String(chatID)] ?? null
  }

  setTitle(id: string, title: string): void {
    if (title.trim()) this.#titles[id] = title.trim()
    else delete this.#titles[id]
    this.#save()
  }

  setModel(chatID: number, model: string): void {
    this.#models[String(chatID)] = model
    this.#save()
  }

  clearModel(chatID: number): void {
    delete this.#models[String(chatID)]
    this.#save()
  }

  clearAll(chatID: number): void {
    delete this.#models[String(chatID)]
    this.#titles = {}
    this.#save()
  }

  #save(): void {
    if (!this.#file) return
    writeFileSync(this.#file, JSON.stringify({ titles: this.#titles, models: this.#models }, null, 2))
  }
}
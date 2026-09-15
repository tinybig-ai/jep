import { readFileSync, writeFileSync } from "node:fs"

/** how much of a part (thinking / tool call) to show */
export type DetailMode = "off" | "collapsed" | "expanded"
/** how reasoning + tool calls are grouped in the reply. "minimal" ignores
 * collapse entirely — just an icon+name line up front, then the answer. */
export type InternalsLayout = "per-step" | "per-section" | "combined" | "minimal"

export interface InternalsSettings {
  thinking: DetailMode
  tools: DetailMode
  layout: InternalsLayout
}

export const DEFAULT_INTERNALS: InternalsSettings = {
  thinking: "collapsed",
  tools: "collapsed",
  layout: "per-step",
}

export interface StoreData {
  // session id -> display-name override (client-side; never touches the harness)
  titles: Record<string, string>
  // chat id -> "provider/model"
  models: Record<string, string>
  // chat id -> how much agent internals (thinking / tool calls) to show
  internals?: Record<string, InternalsSettings>
}

export class ChatStore {
  #titles: Record<string, string>
  #models: Record<string, string>
  #internals: Record<string, InternalsSettings>
  #file: string | null

  constructor(
    titles: Record<string, string>,
    models: Record<string, string>,
    internals: Record<string, InternalsSettings>,
    file: string | null,
  ) {
    this.#titles = titles
    this.#models = models
    this.#internals = internals
    this.#file = file
  }

  static load(file: string | null): ChatStore {
    if (!file) return new ChatStore({}, {}, {}, null)
    try {
      const d = JSON.parse(readFileSync(file, "utf8")) as StoreData
      return new ChatStore(d.titles ?? {}, d.models ?? {}, d.internals ?? {}, file)
    } catch {
      return new ChatStore({}, {}, {}, file)
    }
  }

  title(id: string): string | null {
    return this.#titles[id] ?? null
  }

  model(chatID: number): string | null {
    return this.#models[String(chatID)] ?? null
  }

  internals(chatID: number): InternalsSettings {
    return { ...DEFAULT_INTERNALS, ...(this.#internals[String(chatID)] ?? {}) }
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

  setInternals(chatID: number, settings: InternalsSettings): void {
    this.#internals[String(chatID)] = settings
    this.#save()
  }

  clearAll(chatID: number): void {
    delete this.#models[String(chatID)]
    this.#titles = {}
    this.#save()
  }

  #save(): void {
    if (!this.#file) return
    writeFileSync(
      this.#file,
      JSON.stringify({ titles: this.#titles, models: this.#models, internals: this.#internals }, null, 2),
    )
  }
}
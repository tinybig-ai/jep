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
  // chat id -> primary agent name (e.g. "build", "plan")
  agents?: Record<string, string>
  // chat id -> message id of the pinned live status message
  statusMsgs?: Record<string, number>
  // chat id -> whether a fresh session's first prompt gets the jep context
  // header prepended (default: on — see StoreData.injectContext)
  injectContext?: Record<string, boolean>
}

export class ChatStore {
  #titles: Record<string, string>
  #models: Record<string, string>
  #internals: Record<string, InternalsSettings>
  #agents: Record<string, string>
  #statusMsgs: Record<string, number>
  #injectContext: Record<string, boolean>
  #file: string | null

  constructor(
    titles: Record<string, string>,
    models: Record<string, string>,
    internals: Record<string, InternalsSettings>,
    agents: Record<string, string>,
    statusMsgs: Record<string, number>,
    injectContext: Record<string, boolean>,
    file: string | null,
  ) {
    this.#titles = titles
    this.#models = models
    this.#internals = internals
    this.#agents = agents
    this.#statusMsgs = statusMsgs
    this.#injectContext = injectContext
    this.#file = file
  }

  static load(file: string | null): ChatStore {
    if (!file) return new ChatStore({}, {}, {}, {}, {}, {}, null)
    try {
      const d = JSON.parse(readFileSync(file, "utf8")) as StoreData
      return new ChatStore(
        d.titles ?? {},
        d.models ?? {},
        d.internals ?? {},
        d.agents ?? {},
        d.statusMsgs ?? {},
        d.injectContext ?? {},
        file,
      )
    } catch {
      return new ChatStore({}, {}, {}, {}, {}, {}, file)
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

  agent(chatID: number): string | null {
    return this.#agents[String(chatID)] ?? null
  }

  setAgent(chatID: number, name: string): void {
    this.#agents[String(chatID)] = name
    this.#save()
  }

  statusMsg(chatID: number): number | null {
    return this.#statusMsgs[String(chatID)] ?? null
  }

  setStatusMsg(chatID: number, messageID: number): void {
    this.#statusMsgs[String(chatID)] = messageID
    this.#save()
  }

  injectContext(chatID: number): boolean {
    return this.#injectContext[String(chatID)] ?? true
  }

  setInjectContext(chatID: number, on: boolean): void {
    this.#injectContext[String(chatID)] = on
    this.#save()
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
      JSON.stringify(
        {
          titles: this.#titles,
          models: this.#models,
          internals: this.#internals,
          agents: this.#agents,
          statusMsgs: this.#statusMsgs,
          injectContext: this.#injectContext,
        },
        null,
        2,
      ),
    )
  }
}
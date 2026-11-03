// Which conversations may read which, once a person has said "always". A grant is a pair: this
// conversation may read that one. Keys are canonical session ids, and the file is the person's
// decision, so a corrupt one is ignored rather than trusted: no grants means every read asks.

export type Grants = Set<string>

/** what a grant lets one conversation do to another: read it, or send it messages */
export type GrantAction = "read" | "tell"

// reads keep the original key, so a grants file written before `tell` existed still means what it did
const key = (reader: string, target: string, action: GrantAction = "read"): string => `${action === "tell" ? "tell:" : ""}${reader}→${target}`

export const hasGrant = (grants: Grants, reader: string, target: string, action: GrantAction = "read"): boolean => grants.has(key(reader, target, action))

export const addGrant = (grants: Grants, reader: string, target: string, action: GrantAction = "read"): void => void grants.add(key(reader, target, action))

export const revokeGrant = (grants: Grants, reader: string, target: string, action: GrantAction = "read"): void => void grants.delete(key(reader, target, action))

/** messages one conversation may send another in an hour, however often it has been allowed */
export const TELL_PER_HOUR = 12

/**
 * A sliding hour per sender and receiver. Returns whether one more message may go now, and records it
 * when it may. An agent told "reply with jep-tell" can answer an agent told the same, so this is the
 * stop on two of them keeping each other busy while nobody watches.
 */
export const tellAllowed = (log: Map<string, number[]>, reader: string, target: string, now: number, max = TELL_PER_HOUR): boolean => {
  const k = `${reader}→${target}`
  const recent = (log.get(k) ?? []).filter((t) => now - t < 3_600_000)
  if (recent.length >= max) {
    log.set(k, recent)
    return false
  }
  log.set(k, [...recent, now])
  return true
}

export const parseGrants = (raw: string): Grants => {
  try {
    const v = JSON.parse(raw)
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.includes("→")) : [])
  } catch {
    return new Set()
  }
}

export const serializeGrants = (grants: Grants): string => JSON.stringify([...grants].sort())

/** which conversation a name means: an id, an id prefix, or a unique piece of the title */
export interface ChatRef {
  id: string
  title: string
}

export type Pick<T extends ChatRef = ChatRef> = { ok: true; chat: T } | { ok: false; message: string }

export const pickChat = <T extends ChatRef>(chats: T[], name: string): Pick<T> => {
  const wanted = name.trim()
  if (!wanted) return { ok: false, message: "name a conversation: an id, the start of an id, or part of its title" }
  const exact = chats.find((c) => c.id === wanted)
  if (exact) return { ok: true, chat: exact }
  const byId = chats.filter((c) => c.id.replace(/^[a-z]+:\/\//, "").startsWith(wanted.replace(/^[a-z]+:\/\//, "")))
  if (byId.length === 1) return { ok: true, chat: byId[0]! }
  const lower = wanted.toLowerCase()
  const byTitle = chats.filter((c) => c.title.toLowerCase().includes(lower))
  const found = byId.length > 1 ? byId : byTitle
  if (found.length === 1) return { ok: true, chat: found[0]! }
  if (found.length === 0) return { ok: false, message: `no conversation matches "${wanted}" (jep-read --list shows them)` }
  return {
    ok: false,
    message: `"${wanted}" matches ${found.length} conversations: ${found.slice(0, 5).map((c) => `${c.title.slice(0, 40)} [${c.id}]`).join("; ")}. Use an id.`,
  }
}

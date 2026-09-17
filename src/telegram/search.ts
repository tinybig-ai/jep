// PURE — finding a term in a conversation and showing where it was found.
// No I/O: bot.ts fetches the transcripts, this decides what matched and what
// the row says about it.

/** case-insensitive, whitespace-tolerant "does this contain that" */
export const matches = (haystack: string, term: string): boolean =>
  haystack.toLowerCase().includes(term.trim().toLowerCase())

/**
 * The matched text with enough either side to recognise it, on one line.
 *
 * A transcript is many lines of which one matters, and a phone row is one
 * line — so the window is centred on the hit rather than taken from the
 * start, which is what made the first version show the same opening sentence
 * for every result. The term is wrapped in ** so the row can point at it.
 */
export function snippet(text: string, term: string, width = 90): string {
  const flat = text.replace(/\s+/g, " ").trim()
  const needle = term.trim()
  const at = flat.toLowerCase().indexOf(needle.toLowerCase())
  if (at === -1) return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
  // keep the hit off the very edge: a match with no left context reads as if
  // the quote started there
  const pad = Math.max(0, Math.floor((width - needle.length) / 2))
  const from = Math.max(0, at - pad)
  const to = Math.min(flat.length, from + width)
  const body = flat.slice(from, to)
  // ** around the hit, at its position *within the window*
  const hitAt = at - from
  const marked = `${body.slice(0, hitAt)}**${body.slice(hitAt, hitAt + needle.length)}**${body.slice(hitAt + needle.length)}`
  return `${from > 0 ? "…" : ""}${marked}${to < flat.length ? "…" : ""}`
}

export interface Hit {
  sessionID: string
  /** the workspace the conversation belongs to */
  ws: string
  /** set when that project has no server running yet */
  dir?: string
  title: string
  updatedAt: number
  /** where the term was found */
  where: "title" | "message"
  /** the matching line, for a message hit */
  snippet?: string
}

/**
 * Hits, best first: a title match beats a body match (you searched for what
 * you called it), then most recently touched. Ordering is separate from
 * finding so it can be checked without a harness.
 */
export const rankHits = (hits: Hit[]): Hit[] =>
  [...hits].sort((a, b) => (a.where === b.where ? b.updatedAt - a.updatedAt : a.where === "title" ? -1 : 1))

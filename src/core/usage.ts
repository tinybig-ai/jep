// PURE — what a conversation has spent. Tokens and cost in, one summary out.
//
// Cost is *reported*, never computed: opencode prices each call and Claude Code
// returns total_cost_usd, and either beats jep multiplying tokens by a rate
// card it would have to keep current. The consequence is that cost can be
// unknown, which is not the same as zero — a harness that says nothing (codex)
// must not be rendered as free.

import type { Message } from "./types.ts"

export interface Usage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** every token the turn touched, cache included */
  total: number
  /** dollars, summed over the turns that reported a price */
  cost: number
  /** turns that reported a price, and turns that didn't */
  priced: number
  unpriced: number
  /** assistant turns seen */
  turns: number
  /** models that produced them, most recent first */
  models: string[]
}

export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
  priced: 0,
  unpriced: 0,
  turns: 0,
  models: [],
})

export function usageOf(messages: Message[]): Usage {
  const u = emptyUsage()
  const models: string[] = []
  for (const m of messages) {
    // a user message has no usage to report, and a failed turn's tokens still
    // cost money — both are handled by asking only "did it report any?"
    if (!m.tokens && m.cost === undefined) continue
    u.turns++
    if (m.tokens) {
      u.input += m.tokens.input
      u.output += m.tokens.output
      u.reasoning += m.tokens.reasoning
      u.cacheRead += m.tokens.cache.read
      u.cacheWrite += m.tokens.cache.write
    }
    if (typeof m.cost === "number") {
      u.cost += m.cost
      u.priced++
    } else {
      u.unpriced++
    }
    if (m.model) models.push(m.model)
  }
  u.total = u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite
  // most recent first, deduped: a conversation can change model halfway
  u.models = [...new Set(models.reverse())]
  return u
}

export interface UsageDay extends Usage {
  /** local calendar day, YYYY-MM-DD */
  day: string
}

export interface UsageRank extends Usage {
  key: string
}

export interface UsageStats {
  /** the requested window, oldest first, with empty days kept (a chart needs them) */
  days: UsageDay[]
  /** by model, most tokens first */
  models: UsageRank[]
  /** by harness, most tokens first */
  harnesses: UsageRank[]
  today: Usage
  week: Usage
  all: Usage
  /** conversations that held at least one priced or token-counted turn */
  sessions: number
  /** conversations read to build this answer */
  scanned: number
  /** the first and last counted turn, epoch ms */
  first: number | null
  last: number | null
  busiest: UsageDay | null
}

export interface UsageSample {
  harness: string
  messages: Message[]
}

const dayKey = (t: number): string => {
  const d = new Date(t)
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${month}-${day}`
}

const startOfDay = (t: number): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function tally(u: Usage, m: Message): void {
  u.turns++
  if (m.tokens) {
    u.input += m.tokens.input
    u.output += m.tokens.output
    u.reasoning += m.tokens.reasoning
    u.cacheRead += m.tokens.cache.read
    u.cacheWrite += m.tokens.cache.write
    u.total = u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite
  }
  if (typeof m.cost === "number") {
    u.cost += m.cost
    u.priced++
  } else {
    u.unpriced++
  }
  if (m.model && !u.models.includes(m.model)) u.models.push(m.model)
}

const finish = (u: Usage): Usage => {
  u.total = u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite
  return u
}

/**
 * Usage across conversations, by day, model and harness. The transcripts are
 * the only ledger jep keeps, so this is a pure roll-up of what they already
 * hold — open a stats view rarely, and let it read the conversations it can
 * reach; it does not invent history it never saw.
 */
export function statsOf(samples: UsageSample[], opts: { days?: number; now?: number } = {}): UsageStats {
  const now = opts.now ?? Date.now()
  const span = Math.max(1, Math.min(366, Math.floor(opts.days ?? 30)))
  const byDay = new Map<string, Usage>()
  const byModel = new Map<string, Usage>()
  const byHarness = new Map<string, Usage>()
  const all = emptyUsage()
  let sessions = 0
  let scanned = 0
  let first: number | null = null
  let last: number | null = null

  for (const sample of samples) {
    scanned++
    let counted = false
    const harness = sample.harness || "unknown"
    for (const m of sample.messages) {
      if (!m.tokens && m.cost === undefined) continue
      const key = dayKey(m.time)
      const day = byDay.get(key) ?? emptyUsage()
      const model = m.model || "unreported"
      const modelUsage = byModel.get(model) ?? emptyUsage()
      const harnessUsage = byHarness.get(harness) ?? emptyUsage()
      tally(day, m)
      tally(modelUsage, m)
      tally(harnessUsage, m)
      tally(all, m)
      byDay.set(key, day)
      byModel.set(model, modelUsage)
      byHarness.set(harness, harnessUsage)
      counted = true
      if (first === null || m.time < first) first = m.time
      if (last === null || m.time > last) last = m.time
    }
    if (counted) sessions++
  }

  // a real calendar walk, so a DST change does not slide the labels
  const days: UsageDay[] = []
  const midnight = startOfDay(now)
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(midnight)
    d.setDate(d.getDate() - i)
    const bucket = byDay.get(dayKey(d.getTime())) ?? emptyUsage()
    days.push({ day: dayKey(d.getTime()), ...finish(bucket) })
  }

  const weekStart = new Date(midnight)
  weekStart.setDate(weekStart.getDate() - 6)
  const week = emptyUsage()
  for (const d of days) {
    if (new Date(d.day + "T00:00:00").getTime() < weekStart.getTime()) continue
    // add without touching model lists (the ranks carry those)
    week.input += d.input
    week.output += d.output
    week.reasoning += d.reasoning
    week.cacheRead += d.cacheRead
    week.cacheWrite += d.cacheWrite
    week.total += d.total
    week.cost += d.cost
    week.priced += d.priced
    week.unpriced += d.unpriced
    week.turns += d.turns
  }

  const today = days[days.length - 1] ?? { day: dayKey(now), ...emptyUsage() }
  const rank = (map: Map<string, Usage>): UsageRank[] =>
    [...map].map(([key, u]) => ({ key, ...finish(u) })).sort((a, b) => b.total - a.total)

  return {
    days,
    models: rank(byModel),
    harnesses: rank(byHarness),
    today,
    week,
    all: finish(all),
    sessions,
    scanned,
    first,
    last,
    // on a tie the more recent day wins: "busiest" should read as "latest best"
    busiest: days.reduce<UsageDay | null>((best, d) => (!best || d.total >= best.total ? d : best), null),
  }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
    cost: a.cost + b.cost,
    priced: a.priced + b.priced,
    unpriced: a.unpriced + b.unpriced,
    turns: a.turns + b.turns,
    models: [...new Set([...a.models, ...b.models])],
  }
}

/**
 * Money, at the precision the number deserves. A coding agent's turn often
 * costs a fraction of a cent, and rounding that to "$0.00" is the same as not
 * reporting it — while four decimals on a $12 bill is noise.
 */
export function fmtMoney(usd: number): string {
  if (!(usd > 0)) return "$0"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd)}`
}

/**
 * The one-line form, for the pinned status. Empty when there is nothing
 * anybody would act on: no turns, or a free local model — the pin has four
 * other things to say and "$0" is not one of them.
 */
export function usageChip(u: Usage): string {
  if (u.cost > 0) return fmtMoney(u.cost)
  // priced at zero is a fact (a free model); unpriced is an absence, and worth
  // a mark so "no cost shown" is never read as "no cost incurred"
  if (u.priced === 0 && u.unpriced > 0) return "$?"
  return ""
}

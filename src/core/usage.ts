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

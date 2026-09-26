// `/model <text>`: find the model someone meant from what they typed —
// a typo, part of a name, the bare model id or the full provider/model.
// Pure, so the rules can be tested without a bot.

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "")
const modelPart = (label: string): string => label.slice(label.lastIndexOf("/") + 1)

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length]!
}

export interface ModelMatch {
  /** the one it confidently means, if any */
  model?: string
  /** otherwise, the nearest few to offer */
  close: string[]
}

export function matchModel(query: string, labels: string[]): ModelMatch {
  const q = query.trim()
  const nq = norm(q)
  if (!nq) return { close: [] }
  // exact: the full label, or the model id alone
  const exact = labels.find((l) => l.toLowerCase() === q.toLowerCase())
    ?? labels.find((l) => modelPart(l).toLowerCase() === q.toLowerCase())
  if (exact) return { model: exact, close: [] }
  // part of a name ("opus", "gpt5") — separators ignored. Several can contain
  // it: one whose model id is exactly it wins, else the first in the list.
  // "/model opus" should just work, not ask which opus.
  const containing = labels.filter((l) => norm(l).includes(nq))
  if (containing.length > 0) {
    return { model: containing.find((l) => norm(modelPart(l)) === nq) ?? containing[0]!, close: [] }
  }
  // a typo: nearest model id by edit distance, if clearly nearest
  const ranked = labels
    .map((l) => ({ l, d: Math.min(distance(nq, norm(modelPart(l))), distance(nq, norm(l))) }))
    .sort((a, b) => a.d - b.d)
  const best = ranked[0]
  const runnerUp = ranked[1]
  const allowed = Math.max(1, Math.floor(nq.length / 4))
  if (best && best.d <= allowed && (!runnerUp || runnerUp.d > best.d)) {
    return { model: best.l, close: [] }
  }
  return { close: ranked.map((r) => r.l).slice(0, 3) }
}

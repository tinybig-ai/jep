// Search names and provider-qualified ids without requiring their punctuation.
// Typo matching is a fallback: it must never dilute an exact/partial result.
const JepModelSearch = (() => {
  const norm = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  // Damerau edit distance to the closest substring, including transpositions.
  const distance = (query, text, allowed) => {
    if (query.length > text.length + allowed) return allowed + 1
    let previous = Array.from({ length: query.length + 1 }, (_, i) => i)
    let older = previous
    let best = query.length
    for (let i = 1; i <= text.length; i++) {
      const row = [0]
      for (let j = 1; j <= query.length; j++) {
        row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (query[j - 1] === text[i - 1] ? 0 : 1))
        if (i > 1 && j > 1 && query[j - 1] === text[i - 2] && query[j - 2] === text[i - 1]) row[j] = Math.min(row[j], older[j - 2] + 1)
      }
      best = Math.min(best, row[query.length])
      older = previous
      previous = row
    }
    return best
  }
  const search = (query, models) => {
    const q = norm(query)
    if (!q) return { models: query.trim() ? [] : models, fuzzy: false }
    const terms = query.toLowerCase().trim().split(/\s+/).map(norm).filter(Boolean)
    const entries = models.map((model, index) => {
      const fields = [`${model.providerID}/${model.modelID}`, model.modelID, model.name || ""].map(norm).filter(Boolean)
      const exact = fields.includes(q)
      const partial = terms.every((term) => fields.some((field) => field.includes(term)))
      const rank = exact ? 0 : fields.some((field) => field.startsWith(q)) ? 1 : 2
      return { model, fields, exact, partial, rank, index }
    })
    const direct = entries.filter((entry) => entry.exact || entry.partial).sort((a, b) => a.rank - b.rank || a.index - b.index)
    if (direct.length) return { models: direct.map((entry) => entry.model), fuzzy: false }
    const close = entries.flatMap((entry) => {
      let score = 0
      for (const term of terms) {
        const allowed = term.length < 3 ? 0 : Math.min(3, Math.max(1, Math.floor(term.length / 4)))
        const d = Math.min(...entry.fields.map((field) => distance(term, field, allowed)))
        if (d > allowed) return []
        score += d / term.length
      }
      return [{ ...entry, score }]
    }).sort((a, b) => a.score - b.score || a.index - b.index)
    return { models: close.slice(0, 20).map((entry) => entry.model), fuzzy: close.length > 0 }
  }
  return { search }
})()

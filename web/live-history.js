// A history page can lag the event stream. Keep each visible part until the
// record contains its contents, rather than treating its parent id as proof.
// This file is also exercised directly by the regression tests.
const JepTranscript = (() => {
  const key = (p, i) => p.id || (p.kind === "file" ? `file:${p.filePath || p.url}` : `${i}:${p.kind}`)
  const fuller = (old, next) => {
    if (!old || old.kind !== next.kind) return next
    const out = { ...old, ...next }
    for (const field of ["text", "output"]) {
      if (typeof old[field] === "string" && typeof next[field] === "string" && old[field].startsWith(next[field])) out[field] = old[field]
    }
    if (old.kind === "tool" && ["completed", "error"].includes(old.status) && ["pending", "running"].includes(next.status)) out.status = old.status
    return out
  }
  const parts = (prior, incoming) => {
    const out = prior.map((p) => ({ ...p }))
    const indices = new Map(out.map((p, i) => [key(p, i), i]))
    incoming.forEach((p, i) => {
      const at = indices.get(key(p, i))
      if (at === undefined) { indices.set(key(p, i), out.length); out.push(p) }
      else out[at] = fuller(out[at], p)
    })
    return out
  }
  const find = (rows, messageID, partID) => {
    const own = rows.find((m) => m.id === messageID)
    return own?.parts.find((p) => p.id === partID) || rows.flatMap((m) => m.parts).find((p) => p.id === partID)
  }
  const covers = (saved, streamed) => {
    if (!saved || saved.kind !== streamed.kind) return false
    if (["text", "reasoning"].includes(saved.kind)) return saved.text?.startsWith(streamed.text || "") === true
    if (saved.kind === "tool") {
      if (["completed", "error"].includes(streamed.status) && saved.status !== streamed.status) return false
      return typeof streamed.output === "string" ? typeof saved.output === "string" && saved.output.startsWith(streamed.output) : JSON.stringify(saved.output) === JSON.stringify(streamed.output)
    }
    return JSON.stringify(saved) === JSON.stringify(streamed)
  }
  const recorded = (rows, entry) => {
    const identified = find(rows, entry.messageID, entry.part.id)
    if (identified) return covers(identified, entry.part)
    // Print-mode harnesses can use event ids that their native transcript does
    // not retain. Match only id-less text in the current reply, never old turns.
    if (entry.part.kind !== "text" || !entry.part.text) return false
    const lastUser = rows.findLastIndex((m) => m.role === "user")
    return rows.slice(lastUser + 1).some((m) => m.role === "assistant" && m.parts.some((p) => !p.id && p.kind === "text" && p.text === entry.part.text))
  }
  const withLive = (rows, live) => {
    const out = rows.map((m) => ({ ...m, parts: [...m.parts] }))
    for (const entry of live.values()) {
      if (recorded(rows, entry)) continue
      let message = out.find((m) => m.id === entry.messageID) || out.find((m) => m.parts.some((p) => p.id && p.id === entry.part.id))
      if (!message) {
        message = { id: entry.messageID, role: "assistant", time: entry.at, parts: [], streamOnly: true }
        out.push(message)
      }
      message.parts = parts(message.parts, [entry.part])
    }
    return out
  }
  const reconcile = (rows, live, snapshot) => {
    const buffered = withLive(rows, live)
    // A print-mode block can contain both a saved answer and a tool whose
    // native id differs. Retire each covered live part before merging history;
    // keeping or dropping the whole block either duplicates or hides text.
    const retained = buffered.map((m) => ({ ...m, parts: m.parts.filter((p) =>
      !(m.streamOnly || live.has(p.id)) || !recorded(snapshot, { messageID: m.id, part: p }),
    ) })).filter((m) => !m.streamOnly || m.parts.length)
    for (const [id, entry] of live) if (recorded(snapshot, entry)) live.delete(id)
    // A paged or lagging response is not a deletion. Preserve already visible
    // messages and parts, including a completed step omitted by this page.
    const out = new Map(retained.map((m) => [m.id, m]))
    for (const message of snapshot) {
      const prior = out.get(message.id)
      out.set(message.id, prior ? { ...prior, ...message, streamOnly: false, parts: parts(prior.parts, message.parts) } : message)
    }
    return [...out.values()].sort((a, b) => (a.time || 0) - (b.time || 0))
  }
  const update = (rows, live, event) => {
    if (!event.partID || !event.messageID) return
    const prior = live.get(event.partID)
    const base = prior?.part || find(rows, event.messageID, event.partID)
    const part = event.type === "part.delta"
      ? { ...(base?.kind === "text" ? base : { kind: "text", text: "" }), text: (base?.kind === "text" ? base.text : "") + event.text, id: event.partID }
      : fuller(base, { ...event.part, id: event.partID })
    live.set(event.partID, { messageID: event.messageID, at: prior?.at || Date.now(), part })
  }
  return { reconcile, withLive, update }
})()

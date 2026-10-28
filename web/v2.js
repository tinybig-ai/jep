"use strict"
// jep v2: the next look, on top of index.html, loaded only with ?v=2. It runs
// after the page's own script and reuses its state and helpers ($, el,
// sessions, current, busy…). Where it changes behavior it wraps one of the
// page's functions, so every caller inside the page gets the new one, and the
// page without this file is unchanged.
;(() => {
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform)
  const scroller = $("scroll")
  const header = document.querySelector("header")
  const svg = (d, cls = "") => `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ""}><path d="${d}"/></svg>`
  const COPY = svg("M9 9h10v10H9zM5 15V5h10")
  const CHECK = svg("M5 12l5 5L20 7")

  // ── the header: the title over its harness and folder ───────────────────
  const heading = el("div", "heading")
  const sub = el("div")
  sub.id = "sub"
  const title = $("title")
  title.replaceWith(heading)
  heading.append(title, sub)

  function renderHeading() {
    const s = sessions.find((x) => x.id === current)
    sub.hidden = !s
    if (!s) return
    const state = busy() ? [el("span", "state", "working")] : []
    sub.replaceChildren(harnessMark(s.harness), el("span", "", s.adapter), ...state)
    sync(sub)
  }

  // today's unread count in the tab, so a background tab says when a reply came
  function renderTabTitle() {
    const unread = sessions.filter((s) => s.id !== current && s.updatedAt > (s.seenAt || 0)).length
    const title = sessions.find((s) => s.id === current)?.title
    document.title = (unread ? `(${unread}) ` : "") + (title ? `${title} · jep` : "jep")
  }

  // ── the session list: a search box and days ─────────────────────────────
  const findBox = el("div", "find")
  findBox.innerHTML = svg("M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4-4")
  const find = el("input")
  find.id = "find"; find.type = "search"; find.placeholder = "Search"; find.autocomplete = "off"; find.spellcheck = false
  find.setAttribute("aria-label", "Search conversations")
  findBox.append(find, el("kbd", "", MAC ? "⌘K" : "Ctrl K"))
  document.querySelector(".brand").after(findBox)

  const DAY = 86_400_000
  function dayOf(t) {
    const today = new Date().setHours(0, 0, 0, 0)
    if (t >= today) return "Today"
    if (t >= today - DAY) return "Yesterday"
    if (t >= today - 6 * DAY) return "This week"
    if (t >= today - 29 * DAY) return "This month"
    return "Older"
  }

  const baseRenderSessions = renderSessions
  renderSessions = function () {
    baseRenderSessions()
    const q = find.value.trim().toLowerCase()
    // the page draws one row per session, in the list's order
    const rows = [...$("sessions").children]
    let group = null
    let shown = 0
    rows.forEach((row, i) => {
      const s = sessions[i]
      row.hidden = !!q && !`${s.title || "untitled"} ${s.adapter} ${s.harness}`.toLowerCase().includes(q)
      if (row.hidden) return
      shown++
      const g = s.pinned ? "Pinned" : dayOf(s.updatedAt)
      if (g !== group) row.before(el("div", "group", (group = g)))
    })
    if (!shown) $("sessions").append(el("div", "none", q ? `Nothing matches "${find.value.trim()}"` : "No conversations yet"))
    sync($("sessions"))
    renderHeading()
    renderTabTitle()
  }

  const visibleRows = () => [...document.querySelectorAll("#sessions a.session:not([hidden])")]
  find.oninput = () => renderSessions()
  find.onkeydown = (e) => {
    if (e.key === "Escape") {
      if (find.value) { find.value = ""; renderSessions() } else find.blur()
    } else if (e.key === "Enter") {
      const first = visibleRows()[0]
      if (!first) return
      find.value = ""
      location.hash = first.getAttribute("href")
      find.blur()
    } else if (e.key === "ArrowDown") {
      e.preventDefault()
      visibleRows()[0]?.focus()
    }
  }
  // up and down walk the rows once one has focus
  $("sessions").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    const rows = visibleRows()
    const i = rows.indexOf(document.activeElement)
    if (i < 0) return
    e.preventDefault()
    if (e.key === "ArrowUp" && i === 0) find.focus()
    else rows[Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))].focus()
  })

  // ── nothing open ────────────────────────────────────────────────────────
  const empty = el("div")
  empty.id = "empty"
  const logo = document.querySelector(".brand svg").cloneNode(true)
  // its own gradient id: the sidebar's one is gone with the sidebar on a phone
  logo.querySelector("linearGradient").id = "v2logo"
  for (const p of logo.querySelectorAll("[fill='url(#b)']")) p.setAttribute("fill", "url(#v2logo)")
  const start = el("button", "", "New conversation")
  start.type = "button"
  start.onclick = () => { location.hash = "new" }
  const keys = el("div", "keys")
  keys.innerHTML = `<span><kbd>${MAC ? "⌘" : "Ctrl"}</kbd> <kbd>K</kbd> search</span><span><kbd>${MAC ? "⌥" : "Alt"}</kbd> <kbd>↑</kbd> <kbd>↓</kbd> switch</span><span><kbd>Esc</kbd> stop a turn</span>`
  empty.append(logo, el("h2", "", "jep"), el("p", "", "Pick a conversation, or start a new one."), start, keys)
  scroller.before(empty)

  // ── opening a conversation ──────────────────────────────────────────────
  const baseOpen = open
  open = function (id) {
    // the page's open sets current and clears the log before its first wait
    const opening = baseOpen(id)
    empty.hidden = !!current || id === "new"
    if (!current && id !== "new") scroller.hidden = true
    updateSend()
    header.classList.remove("scrolled")
    down.hidden = true
    lastLength = 0
    fresh = true
    if (current) {
      const skeleton = el("div", "skeleton")
      skeleton.append(el("i"), el("i"), el("i"), el("i"))
      $("log").replaceChildren(skeleton)
      sync($("log"))
    }
    renderHeading()
    renderTabTitle()
    return opening
  }

  // ── the composer ────────────────────────────────────────────────────────
  const send = $("compose").querySelector(".box > button:not(#stop)")
  send.classList.add("send")
  send.title = "Send (Enter)"
  send.setAttribute("aria-label", "Send")
  send.innerHTML = svg("M12 19V5M5 12l7-7 7 7")
  const updateSend = () => send.classList.toggle("empty", !$("input").value.trim())
  $("input").placeholder = "Message"
  $("input").addEventListener("input", updateSend)
  $("stop").title = "Stop the running turn (Esc)"

  const baseSubmit = $("compose").onsubmit
  $("compose").onsubmit = (e) => {
    baseSubmit(e)
    updateSend()
  }

  // ── back to the newest ──────────────────────────────────────────────────
  const down = el("button", "to-bottom")
  down.type = "button"; down.hidden = true; down.title = "Newest"; down.setAttribute("aria-label", "Scroll to the newest")
  down.innerHTML = svg("M12 5v14M5 12l7 7 7-7")
  down.onclick = () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" })
  $("compose").append(down)
  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
  scroller.addEventListener("scroll", () => {
    header.classList.toggle("scrolled", scroller.scrollTop > 4)
    if (atBottom()) { down.hidden = true; down.classList.remove("news") }
    else down.hidden = false
  }, { passive: true })

  // ── every redraw of the log ─────────────────────────────────────────────
  const sources = new WeakMap() // a reply's text node → its Markdown
  const baseTextNode = textNode
  textNode = function (src) {
    const n = baseTextNode(src)
    sources.set(n, src)
    return n
  }

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // the clipboard API is only on secure pages; over http://<lan-ip> the old way still works
      const t = el("textarea")
      t.value = text
      t.style.cssText = "position:fixed;opacity:0;pointer-events:none"
      document.body.append(t)
      t.select()
      document.execCommand("copy")
      t.remove()
    }
    button.classList.add("done")
    const label = button.querySelector("span")
    button.querySelector("svg").outerHTML = CHECK
    if (label) label.textContent = "Copied"
  }

  function copyButton(text, label) {
    const b = el("button", "copy")
    b.type = "button"
    b.title = "Copy"
    b.innerHTML = COPY + (label ? `<span>${label}</span>` : "")
    b.onclick = (e) => { e.stopPropagation(); copy(text(), b).catch(() => {}) }
    return b
  }

  let lastLength = 0
  let fresh = true // a conversation just opened starts at its newest message
  const baseRender = render
  render = function (follow = true) {
    const wasAtBottom = atBottom()
    baseRender(follow)
    const log = $("log")
    for (const pre of log.querySelectorAll(".text pre")) {
      const code = pre.querySelector("code")
      const wrap = el("div", "code")
      const bar = el("div", "bar")
      const lang = /language-([\w+#.-]+)/.exec(code?.className || "")?.[1]
      bar.append(el("span", "lang", lang || ""), copyButton(() => (code || pre).textContent, "Copy"))
      pre.replaceWith(wrap)
      wrap.append(bar, pre)
    }
    for (const body of log.querySelectorAll(".msg.assistant > .body")) {
      const text = body.querySelector(":scope > .text")
      if (text) body.append(copyButton(() => sources.get(text) ?? text.innerText))
    }
    const spin = log.querySelector(":scope > .spin")
    if (spin) spin.textContent = "Working"
    if (current && !log.querySelector(".msg, .ask, .spin")) log.append(el("div", "hello", "Say something to start."))
    sync(log)
    // at the bottom stays at the bottom, even through a redraw that does not
    // follow (code colors arriving make the page taller)
    if (fresh && messages.length) { scroller.scrollTop = scroller.scrollHeight; fresh = false }
    else if (wasAtBottom && !loadingOlder) scroller.scrollTop = scroller.scrollHeight
    // something new while scrolled up: the button lights
    const length = scroller.scrollHeight
    if (follow && !wasAtBottom && length > lastLength && !atBottom()) { down.hidden = false; down.classList.add("news") }
    lastLength = length
    renderHeading()
  }

  // Each redraw makes new nodes, and a new node starts its animation from the
  // beginning; start every loop at the same point of one clock instead, so the
  // dots and the shimmer run on smoothly through a streaming reply.
  function sync(root) {
    const delay = `-${Math.round(performance.now() % 1600)}ms`
    for (const n of root.querySelectorAll(".spin, details.work.active > summary, .session .live, .skeleton i, #sub .state")) n.style.animationDelay = delay
  }

  // ── keys ────────────────────────────────────────────────────────────────
  addEventListener("keydown", (e) => {
    const mod = MAC ? e.metaKey : e.ctrlKey
    if (mod && !e.shiftKey && (e.key || "").toLowerCase() === "k") {
      e.preventDefault()
      if (matchMedia("(max-width: 700px)").matches && current) location.hash = ""
      find.focus()
      find.select()
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault()
      const rows = visibleRows()
      const i = rows.findIndex((r) => r.classList.contains("open"))
      const next = rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowUp" ? -1 : 1)))]
      if (next && next.getAttribute("href") !== location.hash) location.hash = next.getAttribute("href")
    } else if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open]")) {
      if (!$("menu").hidden) { $("menu").hidden = true; return }
      if (document.activeElement === find || $("input").value.trim()) return
      // a running turn stops on Esc, as in the terminal harnesses, but never
      // while there are words in the composer that Esc might mean to dismiss
      if (current && busy() && !$("stop").hidden) $("stop").click()
    }
  })

  // the page drew before this file loaded; draw again in the new look
  renderSessions()
  const id = decodeURIComponent(location.hash.slice(1)) || null
  empty.hidden = !!id
  if (!id) scroller.hidden = true
  if (current) render(false)
  updateSend()
})()

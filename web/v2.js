"use strict"
// jep's web client behavior. It runs after index.html's own script and reuses
// that script's state and helpers ($, el, sessions, current, busy…). Where it
// changes behavior it wraps one of the page's functions, so every caller inside
// the page gets the new one.
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
  keys.innerHTML = `<span><kbd>${MAC ? "⌘" : "Ctrl"}</kbd> <kbd>K</kbd> search</span><span><kbd>${MAC ? "⌥" : "Alt"}</kbd> <kbd>↑</kbd> <kbd>↓</kbd> switch</span><span><kbd>${MAC ? "⌘" : "Ctrl"}</kbd> <kbd>/</kbd> all shortcuts</span>`
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
  textNode = function (...args) {
    const n = baseTextNode(...args)
    sources.set(n, args[0])
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
    if (!button) return
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
    if (spin) placeSpinner(log, spin)
    if (current && !log.querySelector(".msg, .ask, .spinner")) log.append(el("div", "hello", "Say something to start."))
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
    updateSend()
  }

  // A turn running: a small spinner where the words end, not a row of its own.
  // It sits at the end of the last line said, or on the title of the work
  // running; after a code block, a table, or your own message, on a line by
  // itself on the reply's side.
  const INLINE = new Set(["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6"])
  const DESCEND = new Set(["UL", "OL", "BLOCKQUOTE", "LI"])
  function lastLine(text) {
    let n = text.lastElementChild
    while (n && DESCEND.has(n.tagName) && n.lastElementChild && !(n.tagName === "LI" && !n.lastElementChild.matches("p, ul, ol"))) n = n.lastElementChild
    return n && INLINE.has(n.tagName) ? n : null
  }
  function placeSpinner(log, spin) {
    spin.remove()
    const spinner = el("span", "spinner")
    spinner.setAttribute("role", "status")
    spinner.setAttribute("aria-label", "Working")
    // the newest thing said, not a message still waiting for the next turn
    let last = log.lastElementChild
    while (last?.matches(".queued-msg")) last = last.previousElementSibling
    const host = !last?.matches(".msg.assistant") ? null
      : last.querySelector(":scope > details > summary, :scope > div.tool .toolhead")
        ?? (last.querySelector(":scope > .body > .text.plain") || lastLine(last.querySelector(":scope > .body > .text") ?? last))
    if (host) return void host.append(spinner)
    const row = el("div", "msg assistant spinning")
    row.append(spinner)
    if (last) last.after(row)
    else log.prepend(row)
  }

  // Each redraw makes new nodes, and a new node starts its animation from the
  // beginning; start every loop at the same point of one clock instead, so the
  // dots and the shimmer run on smoothly through a streaming reply.
  function sync(root) {
    const delay = `-${Math.round(performance.now() % 1600)}ms`
    for (const n of root.querySelectorAll(".spinner, details.work.active > summary, .session .live, .skeleton i, #sub .state")) n.style.animationDelay = delay
  }

  // ── keys ────────────────────────────────────────────────────────────────
  // One table: the handler, the sheet (⌘/) and the buttons' tooltips all read
  // it. ⌘⇧ plus a letter, as ChatGPT's web app taught people, and as browsers
  // leave to the page; Ctrl in place of ⌘ off a Mac. Option only with arrows
  // and Enter, where it types nothing: Option with a letter types characters
  // some layouts need (@ is Option+Q on a Turkish Mac).
  const CMD = MAC ? "⌘" : "Ctrl", SHIFT = MAC ? "⇧" : "Shift", ALT = MAC ? "⌥" : "Alt"
  const mine = (e) => (MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey
  const typing = () => document.activeElement?.matches("input, textarea, select, [contenteditable]")
  const toast = (text) => {
    const n = el("div", "v2-toast", text)
    document.body.append(n)
    setTimeout(() => n.remove(), 1400)
  }
  const lastReply = () => [...$("log").querySelectorAll(".msg.assistant > .body > .text")].pop()
  // send with a mode for this one message, then put the chosen one back
  const sendAs = (mode) => {
    if (!busy()) return $("compose").requestSubmit()
    const was = $("compose").querySelector("input[name=mode]:checked")
    $("compose").querySelector(`input[name=mode][value=${mode}]`).checked = true
    $("compose").requestSubmit()
    if (was) was.checked = true
  }
  const KEYS = [
    { keys: [CMD, "K"], label: "Search conversations", at: () => findBox, match: (e) => mine(e) && !e.shiftKey && e.code === "KeyK",
      run: () => { if (matchMedia("(max-width: 700px)").matches && current) location.hash = ""; find.focus(); find.select() } },
    { keys: [CMD, SHIFT, "O"], label: "New conversation", button: () => document.querySelector(".plus"), at: () => document.querySelector(".plus"), match: (e) => mine(e) && e.shiftKey && e.code === "KeyO",
      run: () => { location.hash = "new" } },
    { keys: [ALT, "↑"], label: "Previous conversation", at: () => neighbour(-1), match: (e) => e.altKey && !e.metaKey && !e.ctrlKey && e.key === "ArrowUp", run: () => step(-1) },
    { keys: [ALT, "↓"], label: "Next conversation", at: () => neighbour(1), match: (e) => e.altKey && !e.metaKey && !e.ctrlKey && e.key === "ArrowDown", run: () => step(1) },
    { keys: [SHIFT, "Esc"], label: "Focus the message box", match: (e) => e.shiftKey && e.key === "Escape", run: () => $("input").focus() },
    { keys: ["Enter"], label: "Send (into a running turn: the mode picked)" },
    { keys: [ALT, "Enter"], label: "Send after this turn", at: () => current && busy() && send, match: (e) => e.altKey && !e.metaKey && !e.ctrlKey && e.key === "Enter" && e.target === $("input"), run: () => sendAs("after") },
    { keys: [CMD, SHIFT, "Enter"], label: "Send now, stopping the running turn", at: () => current && busy() && send, match: (e) => mine(e) && e.shiftKey && e.key === "Enter" && e.target === $("input"), run: () => sendAs("now") },
    { keys: ["Esc"], label: "Stop the running turn (message box empty)", button: () => $("stop") },
    { keys: [CMD, SHIFT, "U"], label: "Attach files", button: () => $("attachInput") && $("newHere"), at: () => current && $("attachInput") && $("newHere"), match: (e) => mine(e) && e.shiftKey && e.code === "KeyU",
      run: () => { if (current && $("attachInput")) $("attachInput").click() } },
    { keys: [CMD, SHIFT, "E"], label: "Change the model", button: () => $("model"), at: () => current && $("model"), match: (e) => mine(e) && e.shiftKey && e.code === "KeyE",
      run: () => { if (current && !$("model").hidden) $("model").click() } },
    { keys: [CMD, SHIFT, ","], label: "Conversation settings", button: () => $("gear"), at: () => current && $("gear"), match: (e) => mine(e) && e.shiftKey && e.code === "Comma",
      run: () => { if (current) $("gear").click() } },
    { keys: [CMD, SHIFT, "C"], label: "Copy the last reply", at: () => lastReply(), corner: "bottom", match: (e) => mine(e) && e.shiftKey && e.code === "KeyC",
      run: () => { const t = lastReply(); if (t) copy(sources.get(t) ?? t.innerText, null).then(() => toast("Reply copied")) } },
    { keys: [CMD, SHIFT, ";"], label: "Copy the last code block", at: () => [...$("log").querySelectorAll(".text .code")].pop(), match: (e) => mine(e) && e.shiftKey && e.code === "Semicolon",
      run: () => { const c = [...$("log").querySelectorAll(".text pre")].pop(); if (c) copy(c.textContent, null).then(() => toast("Code copied")) } },
    { keys: ["↑"], label: "Edit the last queued message (message box empty)" },
    { keys: [CMD, "/"], label: "Keyboard shortcuts", match: (e) => (mine(e) && e.code === "Slash") || (e.key === "?" && !typing()), run: () => sheet() },
  ]

  // the row Option with an arrow would open
  function neighbour(dir) {
    const rows = visibleRows()
    const i = rows.findIndex((r) => r.classList.contains("open"))
    const n = rows[i < 0 ? 0 : i + dir]
    return n && !n.classList.contains("open") ? n : null
  }

  function step(dir) {
    const rows = visibleRows()
    const i = rows.findIndex((r) => r.classList.contains("open"))
    const next = rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + dir))]
    if (next && next.getAttribute("href") !== location.hash) location.hash = next.getAttribute("href")
  }

  // the shortcuts, on ⌘/ or ?
  const help = el("dialog", "keys-sheet")
  help.append(el("h2", "", "Keyboard shortcuts"), ...KEYS.map((k) => {
    const row = el("div", "key-row")
    const combo = el("span", "combo")
    combo.innerHTML = k.keys.map((x) => `<kbd>${x}</kbd>`).join("")
    row.append(el("span", "", k.label), combo)
    return row
  }))
  help.addEventListener("click", (e) => { if (e.target === help) help.close() })
  document.body.append(help)
  const sheet = () => (help.open ? help.close() : help.showModal())

  // every button with a shortcut says so in its tooltip
  for (const k of KEYS) {
    const b = k.button?.()
    if (b) b.title = `${(b.title || k.label).replace(/ \(.*\)$/, "")} (${k.keys.join(MAC ? "" : "+")})`
  }

  // Hold ⌘ (Ctrl) or ⌥ for a moment and every shortcut shows, on its own
  // button, the keys still to press: ⇧O on the + while ⌘ is down, O once ⇧
  // joins it. Shift alone shows nothing (it is held all the time while
  // typing), and any real key press hides them at once, so ⌘C never flashes.
  const hintLayer = el("div", "hint-layer")
  document.body.append(hintLayer)
  let hintTimer = null
  const MODS = new Set([CMD, SHIFT, ALT])
  const held = (e) => new Set([
    ...((MAC ? e.metaKey : e.ctrlKey) ? [CMD] : []),
    ...(e.shiftKey ? [SHIFT] : []),
    ...(e.altKey ? [ALT] : []),
  ])
  function hideHints() {
    clearTimeout(hintTimer)
    hintTimer = null
    hintLayer.replaceChildren()
  }
  function showHints(down) {
    if (help.open || document.querySelector("dialog[open]")) return
    const badges = []
    for (const k of KEYS) {
      const mods = k.keys.filter((x) => MODS.has(x))
      if (![...down].every((m) => mods.includes(m))) continue
      const target = k.at?.()
      const r = target?.getBoundingClientRect?.()
      if (!r || !r.width || r.bottom < 0 || r.top > innerHeight) continue
      const badge = el("kbd", "hint", k.keys.filter((x) => !down.has(x)).join(MAC ? "" : "+"))
      // a small button wears it on its middle; a large target in a corner,
      // the bottom one for a reply, where its own copy button sits
      if (r.width < 60) {
        badge.style.left = `${r.left + r.width / 2}px`
        badge.style.top = `${r.top + r.height / 2}px`
      } else {
        badge.classList.add("corner")
        badge.style.left = `${Math.min(innerWidth - 8, r.right - 6)}px`
        badge.style.top = `${k.corner === "bottom" ? Math.min(innerHeight - 8, r.bottom) : Math.max(28, r.top + 6)}px`
        if (k.corner === "bottom") badge.classList.add("bottom")
      }
      badges.push(badge)
    }
    hintLayer.replaceChildren(...badges)
  }
  addEventListener("keydown", (e) => {
    const down = held(e)
    const onlyMods = ["Meta", "Control", "Shift", "Alt"].includes(e.key)
    if (!onlyMods || !(down.has(CMD) || down.has(ALT))) return hideHints()
    if (hintLayer.childElementCount) return showHints(down) // ⇧ joined: what is left changes
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => showHints(down), 350)
  }, true)
  addEventListener("keyup", (e) => {
    const down = held(e)
    if (!(down.has(CMD) || down.has(ALT))) return hideHints()
    if (hintLayer.childElementCount) showHints(down)
  }, true)
  addEventListener("blur", hideHints)
  addEventListener("mousedown", hideHints, true)
  document.addEventListener("visibilitychange", hideHints)

  // capture: ahead of the message box's own Enter, which would send first
  addEventListener("keydown", (e) => {
    if (e.isComposing) return
    const k = KEYS.find((x) => x.match?.(e))
    if (k && !(help.open && k.run !== sheet)) {
      e.preventDefault()
      e.stopPropagation()
      k.run()
      return
    }
    if (e.key === "Escape" && !e.shiftKey && !e.defaultPrevented && !document.querySelector("dialog[open]")) {
      if (!$("menu").hidden) { $("menu").hidden = true; return }
      if (document.activeElement === find || $("input").value.trim()) return
      // a running turn stops on Esc, as in the terminal harnesses, but never
      // while there are words in the composer that Esc might mean to dismiss
      if (current && busy() && !$("stop").hidden) $("stop").click()
    }
  }, true)

  // the page drew before this file loaded; draw again in the new look
  renderSessions()
  const id = decodeURIComponent(location.hash.slice(1)) || null
  empty.hidden = !!id
  if (!id) scroller.hidden = true
  if (current) render(false)
  updateSend()
})()

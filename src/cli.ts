import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output, stderr } from "node:process"
import { basename, join } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { startOpenCodeServer } from "./adapters/opencode.ts"
import { runComplianceSuite, assertAdapterImplements } from "./core/compliance.ts"
import type { HarnessAdapter } from "./core/ports.ts"

const FIXTURE = join(import.meta.dirname, "..", "fixture")
const DEFAULT_WORKSPACES = ["workspace-alpha", "workspace-beta"].map((n) => join(FIXTURE, n))
const DATA_HOME = process.env.JEP_DATA_HOME ?? mkdtempSync(join(tmpdir(), "jep-cli-"))

interface Ws {
  name: string
  dir: string
  adapter: HarnessAdapter | null
}

let workspaces: Ws[]
let activeWs: Ws
let activeSession: string | null = null
let running: { controller: AbortController; sessionID: string } | null = null
let pendingApprovals: Array<{ id: string; sessionID: string }> = []
const isDone = { value: false }

const say = (...args: unknown[]) => console.log(...args)

function sessionLabel(ws: Ws) {
  return `${ws.name}/${activeSession?.slice(0, 8) ?? "-"}`
}

const HELP = `
  status           adapter health + endpoint
  ws               list workspaces
  ws <name>        switch active workspace
  ls               list sessions in active workspace
  new [title]      create a session (and make it active)
  use <id>         make a session active
  info             details of the active session
  talk <text>      send a prompt to the active session (streams tokens live)
  log              show full message history of the active session
  del [id]         delete session (default: active)
  abort            stop the in-flight turn
  approve [id]     allow the pending permission request (default: newest)
  deny [id]        reject the pending permission request (default: newest)
  ver              run adapter compliance suite (feature-parity gate)
  help             this help
  quit / exit      close servers and leave
`

async function startAll() {
  for (const ws of workspaces) {
    const ad = await startOpenCodeServer(ws.dir, { dataHome: DATA_HOME })
    assertAdapterImplements(ad)
    ws.adapter = ad
  }
  watchApprovals()
}

async function watchApprovals() {
  for (;;) {
    if (isDone.value) return
    for (const ws of workspaces) {
      const ad = ws.adapter
      if (!ad) continue
      try {
        for await (const evt of ad.events()) {
          if (isDone.value) return
          if (evt.type !== "ask.requested") continue
          pendingApprovals.push({ id: evt.ask.id, sessionID: evt.sessionID })
          say(`┌─ [ask] ${ws.name}: ${evt.ask.title}${evt.ask.detail ? ` — ${evt.ask.detail.split("\n")[0]}` : ""}`)
          say(`│   run: approve | deny [id]   (options: ${evt.ask.options.map((o) => o.id).join(" | ")})`)
          say(`└─`)
        }
      } catch {
        // server closing
      }
    }
  }
}

async function handle(cmd: string, arg: string) {
  switch (cmd) {
    case "status": {
      const ad = activeWs.adapter!
      const h = await ad.health()
      say(`  healthy=${h.healthy} version=${h.version} endpoint=${ad.endpoint}`)
      break
    }
    case "ws": {
      if (!arg) {
        for (const ws of workspaces) say(`  ${ws.name}${ws === activeWs ? "  ◀ active" : ""}  (${ws.dir})`)
        break
      }
      const target = workspaces.find((w) => w.name === arg || w.dir === arg)
      if (!target) return say(`  no workspace '${arg}'`)
      activeWs = target
      activeSession = null
      say(`  active workspace: ${target.name}`)
      break
    }
    case "ls": {
      const ad = activeWs.adapter!
      const sessions = await ad.listSessions()
      if (!sessions.length) return say("  (no sessions)")
      for (const s of sessions) {
        const marker = s.id === activeSession ? "  ◀ active" : ""
        say(`  ${s.id}  "${s.title}"${marker}`)
      }
      break
    }
    case "new": {
      const ad = activeWs.adapter!
      const s = await ad.createSession(arg || undefined)
      activeSession = s.id
      say(`  created ${s.id}`)
      break
    }
    case "use": {
      const ad = activeWs.adapter!
      const s = await ad.getSession(arg)
      if (!s) return say(`  no session '${arg}'`)
      activeSession = s.id
      say(`  active session: ${s.id}`)
      break
    }
    case "info": {
      const ad = activeWs.adapter!
      if (!activeSession) return say("  (no active session — use `new` or `use <id>`)")
      const s = await ad.getSession(activeSession)
      say(`  id: ${s?.id}`)
      say(`  title: ${s?.title ?? ""}`)
      say(`  workspace: ${s?.workspace ?? ""}`)
      say(`  created: ${s ? new Date(s.createdAt).toISOString() : ""}`)
      break
    }
    case "ask": {
      const ad = activeWs.adapter!
      if (!arg.trim()) return say("  usage: ask <text>")
      let sessionID = activeSession
      if (!sessionID) {
        const s = await ad.createSession("cli-session")
        sessionID = s.id
        activeSession = s.id
        say(`  (auto-created session ${s.id})`)
      }
      say(`  ${sessionLabel(activeWs)} › ${arg}`)
      const reply = await ad.prompt(sessionID, arg, { timeoutMs: 180_000 })
      say(`  a ✎ ${reply.parts.filter((p) => p.kind === "text").map((p) => p.text).join("")}`)
      for (const p of reply.parts) if (p.kind === "tool") say(`  a ⌁ [${p.name}]`)
      break
    }
    case "talk": {
      const ad = activeWs.adapter!
      if (!arg.trim()) return say("  usage: talk <text>")
      let sessionID = activeSession
      if (!sessionID) {
        const s = await ad.createSession("cli-session")
        sessionID = s.id
        activeSession = s.id
        say(`  (auto-created session ${s.id})`)
      }
      const controller = new AbortController()
      running = { controller, sessionID }
      say(`  ${sessionLabel(activeWs)} › ${arg}`)
      void runTurn(ad, sessionID, arg, controller)
      break
    }
    case "log": {
      const ad = activeWs.adapter!
      if (!activeSession) return say("  (no active session)")
      const msgs = await ad.messages(activeSession)
      if (!msgs.length) return say("  (empty)")
      for (const m of msgs) {
        const text = m.parts
          .map((p) => (p.kind === "text" || p.kind === "reasoning" ? p.text : `[${p.kind}]`))
          .join(" ")
        say(`  ${m.role === "user" ? "u" : "a"} (${m.id.slice(0, 8)}) ${text}`)
      }
      break
    }
    case "del": {
      const ad = activeWs.adapter!
      const id = arg || activeSession
      if (!id) return say("  usage: del [session-id]")
      const ok = await ad.deleteSession(id)
      if (activeSession === id) activeSession = null
      say(`  deleted ${id}: ${ok}`)
      break
    }
    case "abort": {
      const r = running
      if (!r) return say("  (no turn in flight)")
      await activeWs.adapter!.abort(r.sessionID)
      r.controller.abort()
      say(`  aborting ${r.sessionID.slice(0, 8)}…`)
      break
    }
    case "approve":
    case "deny": {
      const ad = activeWs.adapter!
      const allow = cmd === "approve"
      const pending = arg
        ? pendingApprovals.find((p) => p.id === arg)
        : pendingApprovals[pendingApprovals.length - 1]
      if (!pending) return say(`  (no pending approval${arg ? ` '${arg}'` : ""})`)
      const ok = await ad.respondAsk(pending.sessionID, pending.id, allow ? "once" : "reject")
      pendingApprovals = pendingApprovals.filter((p) => p.id !== pending.id)
      say(`  ${allow ? "allowed" : "rejected"} ${pending.id}: ${ok}`)
      break
    }
    case "ver": {
      say(`  running compliance suite against ${activeWs.name}…`)
      const rows = await runComplianceSuite(activeWs.adapter!)
      for (const r of rows) {
        const mark = r.ok === true ? "ok  " : r.ok === "manual" ? "man " : "FAIL"
        say(`  [${mark}] ${r.method}${r.note ? `  (${r.note})` : ""}`)
      }
      break
    }
    case "help":
      say(HELP)
      break
    case "quit":
    case "exit":
      isDone.value = true
      say("bye.")
      process.exit(0)
      break
    default:
      say(`  unknown command '${cmd}' (try: help)`)
  }
}

async function runTurn(ad: HarnessAdapter, sessionID: string, text: string, controller: AbortController) {
  const sub = new AbortController()
  let streamed = 0
  const deltaLoop = (async () => {
    try {
      for await (const evt of ad.events(sub.signal)) {
        if (isDone.value) return
        if (evt.type === "part.delta" && evt.sessionID === sessionID && evt.text) {
          streamed += evt.text.length
          process.stdout.write(evt.text)
        }
      }
    } catch {
      /* subscription torn down */
    }
  })()
  process.stdout.write(`  ${activeWs.name}/${sessionID.slice(0, 8)} · `)
  try {
    const reply = await ad.prompt(sessionID, text, { signal: controller.signal })
    running = null
    for (const p of reply.parts) if (p.kind === "tool") say(`  [tool] ${p.name}`)
    const finalText = reply.parts.filter((p) => p.kind === "text").map((p) => p.text).join("")
    if (streamed === 0 && finalText) say(`  a ✎ ${finalText}`)
  } catch (err) {
    if (controller.signal.aborted) say(`\n  (aborted)`)
    else say(`\n  err: ${(err as Error).message}`)
  } finally {
    sub.abort()
    await deltaLoop
    running = null
    process.stdout.write("\n")
  }
}

const rl = createInterface({ input, output })
const isTTY = !!input.isTTY

// Incremental line source — works for both a TTY and piped/slow-feeder input,
// so commands are processed as they arrive (never buffered all at once).
const lineWaiters: Array<(line: string | null) => void> = []
const lineBuffer: string[] = []
let inputClosed = false

rl.on("line", (line) => {
  const waiter = lineWaiters.shift()
  if (waiter) waiter(line)
  else lineBuffer.push(line)
})
rl.on("close", () => {
  inputClosed = true
  for (const waiter of lineWaiters.splice(0)) waiter(null)
})

function nextLine(): Promise<string | null> {
  if (inputClosed) return Promise.resolve(null)
  if (lineBuffer.length) return Promise.resolve(lineBuffer.shift()!)
  return new Promise((resolve) => lineWaiters.push(resolve))
}

process.on("SIGINT", () => {
  process.exit(130)
})

process.on("exit", () => {
  for (const ws of workspaces) void ws.adapter?.close()
})

async function main() {
  const dirs = process.argv.slice(2)
  workspaces = (dirs.length ? dirs : DEFAULT_WORKSPACES).map((dir) => ({
    name: basename(dir),
    dir,
    adapter: null,
  }))
  activeWs = workspaces[0]!

  stderr.write(`jep cli  ·  data home: ${DATA_HOME}\n`)
  stderr.write(`workspaces: ${workspaces.map((w) => w.name).join(", ")}\n`)
  stderr.write(`starting headless servers…\n`)
  await startAll()
  say(HELP)
  say(`ready. active workspace: ${activeWs.name}`)

  while (!isDone.value) {
    if (!running) {
      const promptStr = `jep:${sessionLabel(activeWs)}> `
      if (isTTY) {
        rl.setPrompt(promptStr)
        rl.prompt()
      } else {
        process.stdout.write(promptStr)
      }
    }
    const line = await nextLine()
    if (line === null || isDone.value) break
    if (!line.trim()) continue
    const [cmd = "", ...rest] = line.trim().split(/\s+/)
    await handle(cmd, rest.join(" ")).catch((err) => say(`  err: ${err.message}`))
  }

  isDone.value = true
  for (const ws of workspaces) await ws.adapter?.close()
  process.stdout.write("bye.\n")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
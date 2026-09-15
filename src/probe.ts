import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOpenCodeServer } from "./adapters/opencode.ts"
import type { DomainEvent } from "./core/types.ts"

const FIXTURE = join(import.meta.dirname, "..", "fixture")
const ALPHA = join(FIXTURE, "workspace-alpha")
const BETA = join(FIXTURE, "workspace-beta")

const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`)
  return ok
}

const textOf = (parts: ReadonlyArray<{ kind: string; text?: string }>) =>
  parts.filter((p) => p.kind === "text").map((p) => p.text ?? "").join("")

async function collectEvents(
  adapter: { events(): AsyncIterable<DomainEvent> },
  sessionID: string,
  stop: { flag: boolean },
) {
  const counts = new Map<string, number>()
  for await (const evt of adapter.events()) {
    if (stop.flag) break
    const key = evt.type === "other" ? `other:${evt.eventType}` : evt.type
    if (evt.type === "other" || evt.sessionID === sessionID || evt.type === "server.connected") {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

async function main() {
  const dataHome = mkdtempSync(join(tmpdir(), "jep-probe-"))
  console.log(`\n[0] probe data dir: ${dataHome}\n`)

  // [1] bootstrap two workspace servers, prove isolation
  console.log("[1] spawn one headless server per workspace")
  const alpha = await startOpenCodeServer(ALPHA, { dataHome })
  const beta = await startOpenCodeServer(BETA, { dataHome })
  check("alpha server up", (await alpha.health()).healthy, alpha.endpoint)
  check("beta server up", (await beta.health()).healthy, beta.endpoint)

  // [2] session create
  console.log("\n[2] session create")
  const sA = await alpha.createSession("jep-probe alpha")
  const sB = await beta.createSession("jep-probe beta")
  check("session created in alpha", !!sA.id, `${sA.id!.slice(0, 12)}…`)
  check("session created in beta", !!sB.id, `${sB.id!.slice(0, 12)}…`)

  // [3] event stream background listener
  console.log("\n[3] live event stream (SSE)")
  const stopEvents = { flag: false }
  const evts = collectEvents(alpha, sA.id!, stopEvents)
  await new Promise((r) => setTimeout(r, 300))
  const connected = await new Promise<boolean>((resolve) => {
    (async () => {
      for await (const e of alpha.events()) {
        if (e.type === "server.connected") resolve(true)
        break
      }
    })().catch(() => resolve(false))
    setTimeout(() => resolve(false), 5_000)
  })
  check("server.connected seen", connected)

  // [4] multi-turn persistent conversation on alpha
  console.log("\n[4] multi-turn conversation (context carried between turns)")
  const turn1 = await alpha.prompt(sA.id!, "Reply with exactly one word: ping")
  check("turn 1 received a reply", (textOf(turn1.parts).trim()).length > 0, `"${textOf(turn1.parts).trim()}"`)

  const turn2 = await alpha.prompt(sA.id!, "What was that single word I just asked you to reply with? Reply with exactly that one word.")
  const turn2Text = textOf(turn2.parts).trim().toLowerCase()
  const remembers = turn2Text.includes("ping")
  check("turn 2 remembered turn 1 (persistent context)", remembers, `"${textOf(turn2.parts).trim()}"`)

  // [5] history is queryable & ordered
  console.log("\n[5] session history")
  const history = await alpha.messages(sA.id!)
  const roles = history.map((m) => m.role).join(",")
  check("history in order (user,assistant×2 in sequence)", roles.includes("user,assistant,user,assistant"), roles)

  // [6] beta session stays orthogonal (multi-directory isolation)
  console.log("\n[6] cross-workspace isolation")
  const alphaList = await alpha.listSessions()
  const betaList = await beta.listSessions()
  check("alpha sees only its own session", alphaList.length === 1, `${alphaList.length} session(s)`)
  check("beta sees only its own session", betaList.length === 1, `${betaList.length} session(s)`)
  check("ids differ across workspaces", alphaList[0]!.id !== betaList[0]!.id)

  // [7] restart alpha -> session must survive (same disk store the TUI uses)
  console.log("\n[7] persistence across server restart (same sessions usable from desktop TUI)")
  await alpha.close()
  const alpha2 = await startOpenCodeServer(ALPHA, { dataHome })
  const after = await alpha2.listSessions()
  const survived = after.length === 1 && after[0]!.id === sA.id
  check("session survived restart with same id", survived, `${after.length} session(s)`)
  const hist2 = await alpha2.messages(sA.id!)
  check("conversation history survived restart", hist2.length >= 4, `${hist2.length} messages`)

  stopEvents.flag = true
  const eventCounts = await evts
  console.log("\n[7b] event types observed during conversation")
  for (const [k, v] of [...eventCounts.entries()].sort()) console.log(`      ${k}: ${v}`)

  // [8] delete
  console.log("\n[8] session delete")
  const del = await alpha2.deleteSession(sA.id!)
  check("alpha session deleted", del === true)
  const afterDel = await alpha2.listSessions()
  check("alpha list empty after delete", afterDel.length === 0)
  await beta.deleteSession(sB.id!)

  await alpha2.close()
  await beta.close()
  console.log("\nprobe done.")
}

main().catch((err) => {
  console.error("\nprobe failed:", err)
  process.exit(1)
})
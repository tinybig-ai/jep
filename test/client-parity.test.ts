import test from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// jep has four kinds of client (Telegram, web, Android, iOS) and one daemon. A feature the daemon
// raises reaches a person only if every client takes it, and nothing used to check that: a
// permission card reached web and never Telegram, and nobody noticed until a person was left
// waiting. This table is the check. Every event the daemon can send (the DomainEvent union in
// core/types.ts) has a decision for every client, written down here:
//
//   handled         the client's source names the event and does something with it
//   n/a: <why>      the client has no need for it, and says why
//   gap: <why>      the client should take it and does not yet. A gap is allowed, but it is
//                   listed, so it is a known debt and not a surprise
//
// Adding an event type fails the first test until each client has a decision. Marking an event
// handled when the client's source never names it, or leaving a gap that has since been closed,
// fails the others, so the table cannot drift from the code either.

type Client = "telegram" | "web" | "android" | "ios"
const CLIENTS: Client[] = ["telegram", "web", "android", "ios"]

const PARITY: Record<string, Record<Client, string>> = {
  "server.connected": {
    telegram: "n/a: the handshake of the gateway's stream, which Telegram does not use",
    web: "n/a: the stream handshake carries nothing to show",
    android: "n/a: the stream handshake carries nothing to show",
    ios: "n/a: the stream handshake carries nothing to show",
  },
  "message.created": {
    telegram: "handled",
    web: "n/a: the web client re-reads the conversation when a turn changes",
    android: "handled",
    ios: "handled",
  },
  "message.updated": {
    telegram: "handled",
    web: "n/a: the web client re-reads the conversation when a turn changes",
    android: "handled",
    ios: "handled",
  },
  "part.updated": { telegram: "handled", web: "handled", android: "handled", ios: "handled" },
  "part.delta": { telegram: "handled", web: "handled", android: "handled", ios: "handled" },
  "session.idle": { telegram: "handled", web: "handled", android: "handled", ios: "handled" },
  "session.changed": {
    telegram: "n/a: Telegram lists conversations on request, not from a pushed change",
    web: "handled",
    android: "handled",
    ios: "handled",
  },
  "ask.requested": { telegram: "handled", web: "handled", android: "handled", ios: "handled" },
  "ask.resolved": {
    telegram: "handled",
    web: "n/a: any event in the open conversation re-reads its record, and the record's asks carry their state (the history tag covers them), so a card answered elsewhere clears",
    android: "handled",
    ios: "handled",
  },
  "session.error": { telegram: "handled", web: "handled", android: "handled", ios: "handled" },
  "turn.aborted": { telegram: "handled", web: "handled", android: "handled", ios: "handled" },
  other: { telegram: "handled", web: "handled", android: "handled", ios: "handled" },
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

/** every source file under the paths, so "the client names the event" is a fact read from the code */
function sources(paths: string[]): string {
  const out: string[] = []
  const walk = (path: string): void => {
    let info
    try {
      info = statSync(path)
    } catch {
      return
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) {
        if (name === "node_modules" || name === ".build" || name === "build" || name.startsWith(".")) continue
        walk(join(path, name))
      }
    } else if (/\.(ts|js|html|kt|swift)$/.test(path)) {
      out.push(readFileSync(path, "utf8"))
    }
  }
  for (const path of paths) walk(join(root, path))
  return out.join("\n")
}

const CLIENT_SOURCES: Record<Client, string[]> = {
  telegram: ["src/clients/telegram"],
  web: ["web/index.html", "web/v2.js"],
  android: ["android/app/src/main/kotlin"],
  ios: ["ios/JepKit/Sources", "ios/Jep/Jep"],
}

const eventTypes = (): string[] => {
  const types = readFileSync(join(root, "src/core/types.ts"), "utf8")
  return [...types.matchAll(/^\s*\| \{ type: "([a-z.]+)"/gm)].map((m) => m[1]!)
}

test("every event the daemon can send has a decision for every client", () => {
  const known = Object.keys(PARITY).sort()
  const actual = eventTypes().sort()
  assert.ok(actual.length > 0, "the event types were read from core/types.ts")
  const missing = actual.filter((t) => !known.includes(t))
  const gone = known.filter((t) => !actual.includes(t))
  assert.deepEqual(
    missing,
    [],
    `new event type(s) ${missing.join(", ")}: add a row to PARITY in test/client-parity.test.ts and decide, for Telegram, web, Android and iOS, whether each handles it, does not need it, or has a gap`,
  )
  assert.deepEqual(gone, [], `PARITY names event type(s) ${gone.join(", ")} that core/types.ts no longer has: remove the row`)
  for (const [type, row] of Object.entries(PARITY)) {
    for (const client of CLIENTS) {
      assert.match(row[client] ?? "", /^(handled|n\/a: .+|gap: .+)$/, `${type} for ${client} needs "handled", "n/a: why" or "gap: why"`)
    }
  }
})

test("a client marked as handling an event names it in its source", () => {
  for (const client of CLIENTS) {
    const code = sources(CLIENT_SOURCES[client])
    assert.ok(code.length > 1000, `read the ${client} client's source`)
    for (const [type, row] of Object.entries(PARITY)) {
      if (row[client] !== "handled") continue
      assert.ok(code.includes(`"${type}"`), `${client} is marked as handling "${type}", but its source never names it`)
    }
  }
})

test("a gap that has been closed is taken out of the table", () => {
  for (const client of CLIENTS) {
    const code = sources(CLIENT_SOURCES[client])
    for (const [type, row] of Object.entries(PARITY)) {
      if (!row[client]!.startsWith("gap:")) continue
      assert.ok(!code.includes(`"${type}"`), `${client} now names "${type}": if it handles it, change its row from "gap" to "handled"`)
    }
  }
})

test("the known gaps are listed, so they are debt in view and not a surprise", (t) => {
  const gaps = Object.entries(PARITY).flatMap(([type, row]) => CLIENTS.filter((c) => row[c]!.startsWith("gap:")).map((c) => `${c} / ${type}: ${row[c]!.slice(5).trim()}`))
  for (const gap of gaps) t.diagnostic(gap)
  assert.ok(gaps.length < 20, "a long list of gaps means the clients have drifted: close some before adding more")
})

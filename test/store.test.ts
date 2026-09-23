// telegram/store.ts — the part of a chat that has to outlive the process.
// Everything here is checked by writing a file, loading it again, and asking
// the fresh instance what it knows: a restart is the only interesting case.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChatStore } from "../src/clients/telegram/store.ts"

function withStore(fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "jep-store-"))
  try {
    fn(join(dir, "store.json"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("queued prompts survive a restart, in order", () => {
  withStore((file) => {
    const a = ChatStore.load(file)
    a.setPending(1, [
      { text: "first", queuedAt: 100 },
      { text: "second", filePaths: ["/tmp/x.png"], queuedAt: 200 },
    ])
    const b = ChatStore.load(file)
    assert.deepEqual(
      b.pending(1).map((p) => p.text),
      ["first", "second"],
    )
    assert.deepEqual(b.pending(1)[1]!.filePaths, ["/tmp/x.png"], "attachments come back too")
    assert.deepEqual(b.pending(2), [], "and a chat with nothing waiting has nothing")
  })
})

test("verbosity is minimal by default", () => {
  withStore((file) => {
    const s = ChatStore.load(file).verbosity(7)
    assert.equal(s.layout, "minimal")
    assert.equal(s.thinking, "collapsed")
    assert.equal(s.tools, "collapsed")
  })
})

test("a store written before the rename keeps its tuning", () => {
  withStore((file) => {
    writeFileSync(file, JSON.stringify({ internals: { "7": { thinking: "off", tools: "expanded", layout: "combined" } } }))
    assert.deepEqual(ChatStore.load(file).verbosity(7), { thinking: "off", tools: "expanded", layout: "combined" })
  })
})

test("clearing the queue clears the file, not just the memory", () => {
  withStore((file) => {
    const a = ChatStore.load(file)
    a.setPending(1, [{ text: "x", queuedAt: 1 }])
    a.setPending(1, [])
    assert.deepEqual(ChatStore.load(file).pending(1), [])
  })
})

test("allPending names every chat with something waiting", () => {
  withStore((file) => {
    const a = ChatStore.load(file)
    a.setPending(7, [{ text: "seven", queuedAt: 1 }])
    a.setPending(9, [{ text: "nine", queuedAt: 2 }])
    const all = ChatStore.load(file).allPending()
    assert.deepEqual(
      all.map((p) => p.chatID).sort((x, y) => x - y),
      [7, 9],
    )
  })
})

test("an identical write is not a write — this runs on every message", () => {
  withStore((file) => {
    const s = ChatStore.load(file)
    const items = [{ text: "same", queuedAt: 1 }]
    s.setPending(1, items)
    const before = ChatStore.load(file).pending(1)
    s.setPending(1, [{ text: "same", queuedAt: 1 }])
    assert.deepEqual(ChatStore.load(file).pending(1), before)
  })
})

test("a held message survives, and clearing it sticks", () => {
  withStore((file) => {
    const a = ChatStore.load(file)
    a.setHeld(1, { sessionID: "ses_1", text: "the undelivered one" })
    assert.equal(ChatStore.load(file).held(1)!.text, "the undelivered one")
    a.setHeld(1, null)
    assert.equal(ChatStore.load(file).held(1), null, "or the ⏹ button comes back from the dead")
  })
})

test("the rest of a chat's context still round-trips", () => {
  withStore((file) => {
    const a = ChatStore.load(file)
    a.setTitle("ses_1", "my thread")
    a.setModel(5, "opencode", "zen/qwen")
    a.setChatContext(5, "/code/jep", "ses_1", "opencode")
    a.setIndexedSessions("/code/jep", "opencode", [{ id: "ses_1", title: "my thread", updatedAt: 9 }])
    const b = ChatStore.load(file)
    assert.equal(b.title("ses_1"), "my thread")
    assert.equal(b.model(5, "opencode"), "zen/qwen")
    assert.deepEqual(b.chatContext(5), { dir: "/code/jep", sessionID: "ses_1", harness: "opencode" })
    assert.equal(b.indexedSessions("/code/jep", "opencode")[0]!.id, "ses_1")
  })
})

test("draft ids never repeat across a restart", () => {
  withStore((file) => {
    const a = ChatStore.load(file)
    const first = [a.nextDraftID(1), a.nextDraftID(1)]
    const next = ChatStore.load(file).nextDraftID(1)
    assert.deepEqual(first, [1, 2])
    assert.equal(next, 3, "a reused draft id is accepted by Telegram and then never rendered")
  })
})

test("a corrupt store is an empty store, not a crash", () => {
  withStore((file) => {
    const s = ChatStore.load(file) // the file does not exist yet
    assert.deepEqual(s.pending(1), [])
    assert.equal(s.held(1), null)
  })
})

import test from "node:test"
import assert from "node:assert/strict"
import { addGrant, hasGrant, parseGrants, pickChat, revokeGrant, serializeGrants } from "../src/core/chatgrants.ts"
import { renderForRead } from "../src/core/carryover.ts"
import type { Message } from "../src/core/types.ts"

test("a grant is one conversation reading one other, and survives a round trip", () => {
  const g = parseGrants("")
  assert.equal(g.size, 0, "nothing granted by default")
  addGrant(g, "claude://a", "goose://b")
  assert.ok(hasGrant(g, "claude://a", "goose://b"))
  assert.ok(!hasGrant(g, "goose://b", "claude://a"), "not the other way round")
  assert.ok(hasGrant(parseGrants(serializeGrants(g)), "claude://a", "goose://b"))
  revokeGrant(g, "claude://a", "goose://b")
  assert.ok(!hasGrant(g, "claude://a", "goose://b"))
})

test("a corrupt grants file grants nothing", () => {
  assert.equal(parseGrants("{not json").size, 0)
  assert.equal(parseGrants('{"a":1}').size, 0)
  assert.equal(parseGrants('["no-arrow", 3]').size, 0)
})

const chats = [
  { id: "goose://ee2fae32-8e45", title: "Map render blank" },
  { id: "claude://46ab2afd-bbc2", title: "Zones HUD" },
  { id: "claude://46ab9999-0000", title: "Zones audit" },
]

test("a conversation is named by id, id start, or a unique piece of its title", () => {
  assert.deepEqual(pickChat(chats, "goose://ee2fae32-8e45"), { ok: true, chat: chats[0] })
  assert.deepEqual(pickChat(chats, "ee2fae32"), { ok: true, chat: chats[0] })
  assert.deepEqual(pickChat(chats, "render"), { ok: true, chat: chats[0] })
})

test("an ambiguous or unknown name is refused with the way out", () => {
  const two = pickChat(chats, "zones")
  assert.equal(two.ok, false)
  assert.match((two as { message: string }).message, /matches 2 conversations/)
  const none = pickChat(chats, "nope")
  assert.match((none as { message: string }).message, /jep-read --list/)
  assert.equal(pickChat(chats, "  ").ok, false)
})

test("a read says whose conversation it is and how much of it is shown", () => {
  const m = (id: string, role: "user" | "assistant", time: number, text: string): Message => ({ id, sessionID: "s", role, time, parts: [{ kind: "text", text }] })
  const out = renderForRead([m("1", "user", 1, "first"), m("2", "assistant", 2, "second"), m("3", "user", 3, "third")], { title: "Map render", harness: "goose", last: 2 })
  assert.match(out, /^# Another conversation: Map render/)
  assert.match(out, /read-only/)
  assert.match(out, /Showing 2 of 3 messages/)
  assert.ok(!out.includes("first"), "only the newest two")
  assert.ok(out.includes("second") && out.includes("third"))
})

import { guestText, readGuest, transcriptText, isScaffold } from "../src/core/transcript.ts"
import { tellAllowed } from "../src/core/chatgrants.ts"

test("a message from another conversation carries its sender, and its words stay readable", () => {
  const text = guestText({ id: "goose://b", title: 'Map "render" blank', harness: "goose" }, "the build is done")
  const got = readGuest(text)
  assert.equal(got?.from.id, "goose://b")
  assert.equal(got?.from.harness, "goose")
  assert.equal(got?.body, "the build is done")
  // the model reads who it is from and that it is not the person
  assert.match(text, /not from the person/)
  assert.match(text, /jep-tell/)
  // a client shows the words; unlike a loop step they are not scaffolding to hide
  assert.equal(transcriptText(text), "the build is done")
  assert.equal(isScaffold(text), false)
  assert.equal(readGuest("plain words"), null)
  assert.equal(readGuest("<!-- jep:from not-json!! -->\nx"), null)
})

test("a grant to read is not a grant to tell, and a file from before tell still reads", () => {
  const g = parseGrants('["claude://a→goose://b"]')
  assert.ok(hasGrant(g, "claude://a", "goose://b"))
  assert.ok(!hasGrant(g, "claude://a", "goose://b", "tell"))
  addGrant(g, "claude://a", "goose://b", "tell")
  assert.ok(hasGrant(g, "claude://a", "goose://b", "tell"))
  revokeGrant(g, "claude://a", "goose://b", "tell")
  assert.ok(hasGrant(g, "claude://a", "goose://b"), "revoking tell leaves read")
})

test("a pair gets a few messages an hour, then waits", () => {
  const log = new Map<string, number[]>()
  for (let i = 0; i < 3; i++) assert.ok(tellAllowed(log, "a", "b", 1000 + i, 3))
  assert.ok(!tellAllowed(log, "a", "b", 2000, 3), "the fourth is held")
  assert.ok(tellAllowed(log, "b", "a", 2000, 3), "the other direction has its own count")
  assert.ok(tellAllowed(log, "a", "b", 1000 + 3_600_001, 3), "an hour later it may again")
})

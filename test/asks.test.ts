import { test } from "node:test"
import assert from "node:assert/strict"
import { describeAsk, permissionTitle } from "../src/core/asks.ts"
import type { AskRequest } from "../src/core/types.ts"

const permission = (over: Partial<AskRequest> = {}): AskRequest => ({
  id: "per_1",
  sessionID: "s1",
  title: "external_directory",
  detail: "/Users/me/other\n/Users/me/shared",
  kind: "permission",
  options: [
    { id: "once", label: "Allow once", style: "success" },
    { id: "always", label: "Always allow" },
    { id: "reject", label: "Deny", style: "danger" },
  ],
  ...over,
})

test("a permission reads as a sentence, with the path under it", () => {
  const shown = describeAsk(permission())
  assert.equal(shown.title, "Access a folder outside the project?")
  assert.equal(shown.body, "/Users/me/other\n/Users/me/shared")
  assert.equal(shown.allow, "once")
  assert.equal(shown.reject, "reject")
  assert.deepEqual(
    shown.actions.map((a) => [a.id, a.role]),
    [
      ["once", "allow"],
      ["always", "always"],
      ["reject", "reject"],
    ],
  )
})

test("an unknown permission name is still readable", () => {
  assert.equal(permissionTitle("doom_loop"), "Doom loop?")
  assert.equal(describeAsk(permission({ title: "custom-thing", detail: undefined })).title, "Custom thing?")
})

test("a permission with no detail has no body — the client says waiting", () => {
  const shown = describeAsk(permission({ detail: undefined }))
  assert.equal(shown.body, "")
})

test("a question keeps its own words and offers no yes/no button", () => {
  const shown = describeAsk({
    id: "que_1",
    sessionID: "s1",
    title: "which database",
    kind: "question",
    detail: "the one the tests already use",
    options: [
      { id: "a", label: "Postgres" },
      { id: "b", label: "SQLite" },
    ],
  })
  assert.equal(shown.title, "Which database")
  assert.equal(shown.body, "the one the tests already use")
  assert.equal(shown.allow, undefined)
  assert.equal(shown.reject, undefined)
})

test("a multi-question ask cannot be answered by one notification button", () => {
  const shown = describeAsk({
    id: "que_2",
    sessionID: "s1",
    title: "two things",
    kind: "question",
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    questions: [
      { title: "one", options: [{ id: "yes", label: "Yes" }] },
      { title: "two", options: [{ id: "no", label: "No" }] },
    ],
  })
  assert.equal(shown.allow, undefined)
  assert.equal(shown.reject, undefined)
})

test("a long detail is clipped so a notification stays a notification", () => {
  const shown = describeAsk(permission({ detail: "x".repeat(900) }))
  assert.ok(shown.body.length <= 300)
  assert.ok(shown.body.endsWith("…"))
})

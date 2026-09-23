// core/types.ts + adapters/opencode.ts — a stop is not a failure. The harness
// spells it as an error, the domain has its own word for it, and every client
// used to re-guess it from the error's prose (which is how pressing stop once
// raised a "harness failed" notification carrying raw JSON).

import { test } from "node:test"
import assert from "node:assert/strict"
import { TurnAbortedError, isAborted } from "../src/core/types.ts"
import { isAbortPayload } from "../src/harnesses/opencode.ts"

test("opencode's spelling of a stop is recognised", () => {
  assert.equal(isAbortPayload({ name: "MessageAbortedError", data: { message: "Aborted" } }), true)
  assert.equal(isAbortPayload({ name: "MessageAbortedError", message: "Aborted" }), true)
  assert.equal(isAbortPayload("Aborted"), true)
  assert.equal(isAbortPayload("MessageAbortedError"), true)
})

test("a real failure is not mistaken for a stop", () => {
  assert.equal(isAbortPayload({ name: "ProviderError", message: "429 rate limited" }), false)
  assert.equal(isAbortPayload("fetch failed"), false)
  assert.equal(isAbortPayload(undefined), false)
})

test("isAborted forgives a harness's own abort error", () => {
  assert.equal(isAborted(new TurnAbortedError()), true)
  assert.equal(isAborted(Object.assign(new Error("x"), { name: "AbortError" })), true)
  assert.equal(isAborted(Object.assign(new Error("x"), { aborted: true })), true)
})

test("a timeout or a real failure is not a stop", () => {
  assert.equal(isAborted(new Error("prompt timed out after 180000ms")), false)
  assert.equal(isAborted(new Error("429 rate limited")), false)
  assert.equal(isAborted(undefined), false)
})

// core/errors.ts — one rendering of a HarnessError, so every client says a
// provider failure the same way: the class, the provider/model that produced
// it, and the provider's own words.

import { test } from "node:test"
import assert from "node:assert/strict"
import { describeError } from "../src/core/errors.ts"

test("names the failure, the provider/model and the reason", () => {
  assert.equal(
    describeError({
      name: "ProviderHeaderTimeoutError",
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      message: "Provider response headers timed out after 300000ms",
    }),
    "ProviderHeaderTimeoutError (opencode-go/deepseek-v4.1-flash): Provider response headers timed out after 300000ms",
  )
})

test("a useless 'error' name is dropped and a status is kept", () => {
  assert.equal(describeError({ name: "error", status: 429, message: "rate limited" }), "rate limited (HTTP 429)")
})

test("a bare message is just the message", () => {
  assert.equal(describeError({ message: "every candidate model failed" }), "every candidate model failed")
})

test("a provider with no model still reads", () => {
  assert.equal(describeError({ name: "APIError", provider: "opencode", message: "boom" }), "APIError (opencode): boom")
})

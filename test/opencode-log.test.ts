// harnesses/opencode-log.ts — the one place a provider failure opencode never
// turned into a session.error event is legible. These pin the parsing that
// lets a stalled turn say "Rate limit exceeded" instead of "no activity", and
// that keeps the provider/model opencode names on the same line.

import { test } from "node:test"
import assert from "node:assert/strict"
import { parseOpencodeLogError } from "../src/harnesses/opencode-log.ts"

const STREAM_ERROR =
  'timestamp=2026-09-20T20:57:43.088Z level=ERROR run=5c47da41 message="stream error" ' +
  "providerID=opencode modelID=big-pickle session.id=ses_f515fbd8dffectwLAwVYSm9F1p " +
  'small=false agent=build mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."'

test("a stream error yields its session, provider/model and the provider's words", () => {
  assert.deepEqual(parseOpencodeLogError(STREAM_ERROR), {
    sessionID: "ses_f515fbd8dffectwLAwVYSm9F1p",
    error: {
      name: "AI_APICallError",
      message: "Rate limit exceeded. Please try again later.",
      provider: "opencode",
      model: "big-pickle",
    },
  })
})

test("a usage cap reads the same way", () => {
  const line = STREAM_ERROR.replace("Rate limit exceeded. Please try again later.", "Go usage limit exceeded")
  const parsed = parseOpencodeLogError(line)
  assert.equal(parsed?.error.name, "AI_APICallError")
  assert.equal(parsed?.error.message, "Go usage limit exceeded")
})

test("a provider SDK timeout keeps its class and provider", () => {
  const line =
    'timestamp=2026-09-23T08:25:47.899Z level=ERROR run=856afa4e message="stream error" ' +
    "providerID=opencode-go modelID=deepseek-v4.1-flash session.id=ses_f3567af08ffe7pUV3r06FfC5DH " +
    'small=false agent=build mode=primary error.error="ProviderHeaderTimeoutError: Provider response headers timed out after 300000ms"'
  assert.deepEqual(parseOpencodeLogError(line)?.error, {
    name: "ProviderHeaderTimeoutError",
    message: "Provider response headers timed out after 300000ms",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
  })
})

test("a status code rides along when the line carries one", () => {
  assert.equal(parseOpencodeLogError(`${STREAM_ERROR} statusCode=429`)?.error.status, 429)
})

test("INFO noise is ignored", () => {
  const line =
    'timestamp=2026-09-20T20:40:07.425Z level=INFO run=5c47da41 message=loop ' +
    "session.id=ses_f515fbd8dffectwLAwVYSm9F1p step=31"
  assert.equal(parseOpencodeLogError(line), null)
})

test("an error with no session can't be attributed to a turn", () => {
  const line = 'timestamp=2026-09-20T20:40:00.000Z level=ERROR message="boom"'
  assert.equal(parseOpencodeLogError(line), null)
})

test("a session error with no name is not a provider failure", () => {
  const line =
    "timestamp=2026-09-20T20:40:00.000Z level=ERROR session.id=ses_abc message=detached"
  assert.equal(parseOpencodeLogError(line), null)
})

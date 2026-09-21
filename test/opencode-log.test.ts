// adapters/opencode-log.ts — the one place a provider failure opencode never
// turned into a session.error event is legible. These pin the parsing that
// lets a stalled turn say "Rate limit exceeded" instead of "no activity".

import { test } from "node:test"
import assert from "node:assert/strict"
import { parseOpencodeLogError } from "../src/adapters/opencode-log.ts"

const STREAM_ERROR =
  'timestamp=2026-09-20T20:57:43.088Z level=ERROR run=5c47da41 message="stream error" ' +
  "providerID=opencode modelID=big-pickle session.id=ses_f515fbd8dffectwLAwVYSm9F1p " +
  'small=false agent=build mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."'

test("a stream error yields its session and the provider's own words", () => {
  assert.deepEqual(parseOpencodeLogError(STREAM_ERROR), {
    sessionID: "ses_f515fbd8dffectwLAwVYSm9F1p",
    message: "AI_APICallError: Rate limit exceeded. Please try again later.",
  })
})

test("a usage cap reads the same way", () => {
  const line = STREAM_ERROR.replace(
    "Rate limit exceeded. Please try again later.",
    "Go usage limit exceeded",
  )
  assert.equal(parseOpencodeLogError(line)?.message, "AI_APICallError: Go usage limit exceeded")
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

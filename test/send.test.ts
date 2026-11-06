import test from "node:test"
import assert from "node:assert/strict"
import { sentFrom, sentPaths } from "../src/core/send.ts"

test("sentPaths reads the files a jep-send call names", () => {
  assert.deepEqual(sentPaths("jep-send /tmp/a.pdf /tmp/b.txt"), ["/tmp/a.pdf", "/tmp/b.txt"])
  assert.deepEqual(sentPaths(`node ~/code/jep/bin/jep-send.mjs "/tmp/my file.zip"`), ["/tmp/my file.zip"])
})

test("sentPaths stops at the end of the call", () => {
  assert.deepEqual(sentPaths("jep-send out.pdf && rm out.pdf; ls other.pdf"), ["out.pdf"])
  assert.deepEqual(sentPaths("jep-show a.png"), [])
})

test("a finished call sends only what jep-send said it sent", () => {
  const output = "sending /tmp/ok.txt (4 bytes)\nnot a file: /tmp/missing\n"
  assert.deepEqual(sentFrom("bash", { command: "jep-send /tmp/ok.txt /tmp/missing" }, output), ["/tmp/ok.txt"])
  assert.deepEqual(sentFrom("mcp__jep-tools__jep_send", { paths: ["/tmp/ok.txt", "/tmp/missing"] }, output), ["/tmp/ok.txt"])
})

test("before the command prints, the named paths are the ones to send", () => {
  assert.deepEqual(sentFrom("bash", { command: "jep-send /tmp/a.txt" }), ["/tmp/a.txt"])
  assert.deepEqual(sentFrom("jep_send", { paths: ["/tmp/a.txt", ""] }), ["/tmp/a.txt"])
  assert.deepEqual(sentFrom("bash", { command: "ls" }), [])
})

import test from "node:test"
import assert from "node:assert/strict"
import { shownPaths } from "../src/core/show.ts"

test("shownPaths reads the files a jep-show call names", () => {
  assert.deepEqual(shownPaths("jep-show /tmp/a.png /tmp/b.jpg"), ["/tmp/a.png", "/tmp/b.jpg"])
  assert.deepEqual(shownPaths(`node ~/code/jep/bin/jep-show.mjs "/tmp/my pic.png"`), ["/tmp/my pic.png"])
})

test("shownPaths stops at the end of the call and ignores other commands", () => {
  assert.deepEqual(shownPaths("jep-show out.png && rm out.png; ls other.png"), ["out.png"])
  assert.deepEqual(shownPaths("cat /etc/passwd"), [])
  assert.deepEqual(shownPaths("echo jep-show-not /etc/passwd"), [])
})

test("shownPaths: a flag is not a path", () => {
  assert.deepEqual(shownPaths("jep-show --x a.png"), ["a.png"])
})

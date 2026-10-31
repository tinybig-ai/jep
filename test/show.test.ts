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

test("the jep_show tool shows its paths, however a harness prefixes the name", async () => {
  const { shownFrom } = await import("../src/core/show.ts")
  for (const name of ["jep_show", "mcp__jep-tools__jep_show", "jep-tools_jep_show", "jep-tools__jep_show"])
    assert.deepEqual(shownFrom(name, { paths: ["/a.png", "", 3, "/b.jpg"] }), ["/a.png", "/b.jpg"])
  assert.deepEqual(shownFrom("bash", { command: "jep-show /a.png" }), ["/a.png"])
  assert.deepEqual(shownFrom("read", { filePath: "/a.png" }), [])
})

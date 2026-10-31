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

test("withShown names what a tool call showed, and leaves every other part alone", async () => {
  const { withShown } = await import("../src/core/show.ts")
  const bash = { kind: "tool", id: "1", name: "bash", input: { command: "jep-show /a.png" }, output: "" }
  assert.deepEqual((withShown(bash) as { shown?: string[] }).shown, ["/a.png"])
  const mcp = { kind: "tool", id: "2", name: "mcp__jep-tools__jep_show", input: { paths: ["/b.jpg"] }, output: "" }
  assert.deepEqual((withShown(mcp) as { shown?: string[] }).shown, ["/b.jpg"])
  const plain = { kind: "tool", id: "3", name: "bash", input: { command: "ls" }, output: "" }
  assert.equal(withShown(plain), plain)
  const text = { kind: "text", text: "jep-show /a.png" }
  assert.equal(withShown(text), text)
})

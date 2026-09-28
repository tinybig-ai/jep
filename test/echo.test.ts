import test from "node:test"
import assert from "node:assert/strict"
import { startEchoAdapter } from "../src/harnesses/echo.ts"
import { runComplianceSuite } from "../src/core/compliance.ts"

test("echo harness passes the port's compliance suite", async () => {
  const rows = await runComplianceSuite(startEchoAdapter("/tmp/ws"))
  assert.deepEqual(rows.filter((r) => r.ok === false), [])
})

test("echo harness streams the reply it returns", async () => {
  const ad = startEchoAdapter("/tmp/ws")
  const s = await ad.createSession()
  const ac = new AbortController()
  const seen: string[] = []
  const done = (async () => {
    for await (const evt of ad.events(ac.signal)) {
      seen.push(evt.type === "part.delta" ? evt.text : evt.type)
      if (evt.type === "session.idle") ac.abort()
    }
  })()
  await new Promise((r) => setImmediate(r))
  const reply = await ad.prompt(s.id, "hi")
  await done
  assert.deepEqual(reply.parts, [{ kind: "text", text: "echo: hi" }])
  assert.deepEqual(seen, ["server.connected", "message.created", "echo: hi", "session.idle"])
  assert.equal((await ad.messages(s.id)).length, 2)
})

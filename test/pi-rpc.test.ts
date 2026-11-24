// harnesses/pi.ts — piRpc sends one command to a short-lived `pi --mode rpc`
// and returns Pi's answer. A fake child stands in for pi (node -e), so no model
// and no pi install is needed.

import { test } from "node:test"
import assert from "node:assert/strict"
import { piRpc } from "../src/harnesses/pi.ts"

const run = (script: string, cmd: Record<string, unknown> = { type: "get_commands" }, ms = 5000) =>
  piRpc(process.execPath, ["-e", script], process.cwd(), process.env, cmd, ms)

// reads one line from stdin, then answers with the same id
const echo = (extra: string) => `
  let b=""; process.stdin.on("data", c => { b+=c; if(!b.includes("\\n")) return;
  const m=JSON.parse(b.split("\\n")[0]);
  process.stdout.write(JSON.stringify({type:"compaction_start",reason:"manual"})+"\\n");
  ${extra} })`

test("returns the data of the response that carries our id, skipping events", async () => {
  const r = await run(echo(`process.stdout.write(JSON.stringify({type:"response",id:m.id,success:true,data:{commands:[{name:"a"}]}})+"\\n")`))
  assert.deepEqual(r, { success: true, data: { commands: [{ name: "a" }] } })
})

test("a response with another id is not our answer", async () => {
  const r = await run(echo(`process.stdout.write(JSON.stringify({type:"response",id:"other",success:true})+"\\n")`), undefined, 600)
  assert.equal(r.success, false)
  assert.match(r.error ?? "", /no answer within/)
})

test("a refusal carries Pi's reason", async () => {
  const r = await run(echo(`process.stdout.write(JSON.stringify({type:"response",id:m.id,success:false,error:"Nothing to compact"})+"\\n")`), { type: "compact" })
  assert.deepEqual(r, { success: false, error: "Nothing to compact" })
})

test("pi exiting before it answers is a failure, not a hang", async () => {
  const r = await run(`process.exit(0)`)
  assert.equal(r.success, false)
  assert.match(r.error ?? "", /exited before/)
})

test("a missing binary is a failure, not a throw", async () => {
  const r = await piRpc("/nonexistent/pi", [], process.cwd(), process.env, { type: "get_commands" }, 2000)
  assert.equal(r.success, false)
})

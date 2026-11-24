import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { compactCodexThread } from "../src/harnesses/codex-compact.ts"

const fake = `
const fs = require('node:fs');
const readline = require('node:readline');
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
if(process.argv.includes('exec')) {
 send({type:'thread.started',thread_id:'resolved'});
 send({type:'turn.completed',usage:{}});
 process.exit(0);
}
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(process.env.COMPACT_TRACE) fs.appendFileSync(process.env.COMPACT_TRACE, line+'\\n');
 if(m.method==='initialize') return send({id:m.id,result:{}});
 if(m.method==='thread/resume') {
  if(process.env.COMPACT_SCENARIO==='resume-error') return send({id:m.id,error:{message:'thread not found'}});
  return send({id:m.id,result:{thread:{id:m.params.threadId,status:{type:'idle'}}}});
 }
 if(m.method!=='thread/compact/start') return;
 const threadId=m.params.threadId;
 const turn={id:'compact-turn',status:'inProgress'};
 if(process.env.COMPACT_SCENARIO==='unsupported') return send({id:m.id,error:{message:'Unknown method thread/compact/start'}});
 send({id:m.id,result:{}});
 if(process.env.COMPACT_SCENARIO==='ack-only') return;
 if(process.env.COMPACT_SCENARIO==='exit') return process.exit(1);
 send({method:'turn/started',params:{threadId,turn}});
 send({method:'item/started',params:{threadId,turnId:turn.id,item:{type:'contextCompaction',id:'compact'}}});
 setTimeout(()=>{
  // Other threads and unrelated turns must never settle this operation.
  send({method:'turn/completed',params:{threadId:'other',turn:{id:turn.id,status:'completed'}}});
  send({method:'turn/completed',params:{threadId,turn:{id:'unrelated',status:'completed'}}});
  send({method:'item/completed',params:{threadId,turnId:turn.id,item:{type:'contextCompaction',id:'compact'}}});
  send({method:'turn/completed',params:{threadId,turn:{id:turn.id,status:process.env.COMPACT_SCENARIO==='failure'?'failed':'completed',error:{message:'quota exceeded'}}}});
 },100);
});
`

test("Codex compaction waits for the native operation and preserves session ownership", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "jep-codex-compact-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const bin = path.join(home, "codex")
  await writeFile(bin, `#!${process.execPath}\n${fake}`)
  await chmod(bin, 0o755)
  process.env.CODEX_BIN = bin
  process.env.CODEX_HOME = home
  const { CodexAdapter } = await import("../src/harnesses/codex.ts")
  const run = (scenario: string, timeout = 2_000) => compactCodexThread(
    spawn(process.execPath, ["-e", fake], { env: { ...process.env, COMPACT_SCENARIO: scenario }, stdio: ["pipe", "pipe", "pipe"] }),
    "thread-a", home, timeout,
  )

  await t.test("the empty start acknowledgement is not success", async () => {
    const result = await run("ack-only", 250)
    assert.equal(result.ok, false)
    assert.match(result.error!, /timed out/)
  })
  await t.test("a completed compaction turn succeeds", async () => {
    assert.deepEqual(await run("success"), { ok: true })
  })
  await t.test("RPC refusals and failed turns reach the caller", async () => {
    assert.deepEqual(await run("resume-error"), { ok: false, error: "thread not found" })
    assert.deepEqual(await run("unsupported"), { ok: false, error: "Unknown method thread/compact/start" })
    assert.deepEqual(await run("failure"), { ok: false, error: "quota exceeded" })
  })
  await t.test("early exit and missing executables are failures", async () => {
    assert.match((await run("exit")).error!, /exited before compaction finished/)
    const child = spawn(path.join(home, "missing"), [], { stdio: ["pipe", "pipe", "pipe"] })
    assert.match((await compactCodexThread(child, "thread-a", home)).error!, /ENOENT/)
  })
  await t.test("adapter uses the same thread and blocks simultaneous writers", async () => {
    const trace = path.join(home, "trace.jsonl")
    process.env.COMPACT_TRACE = trace
    const adapter = new CodexAdapter(home)
    try {
      const started = await adapter.createSession("A conversation")
      assert.match((await adapter.compact(started.id)).error!, /send a message/)
      await adapter.prompt(started.id, "Remember marigold")
      const first = adapter.compact(started.id)
      assert.deepEqual(await adapter.compact("codex://resolved"), { ok: false, error: "a turn is running on this session" })
      await assert.rejects(adapter.prompt(started.id, "another message"), /compacting/)
      assert.deepEqual(await first, { ok: true })
      const messages = (await readFile(trace, "utf8")).trim().split("\n").map((s) => JSON.parse(s))
      assert.deepEqual(messages.map((m) => m.method), ["initialize", "initialized", "thread/resume", "thread/compact/start"])
      assert.equal(messages[2].params.threadId, "resolved")
      assert.equal(messages[2].params.excludeTurns, true)
      assert.equal(messages[3].params.threadId, "resolved")
      // The reservation is released after compaction, so normal turns work.
      await adapter.prompt("codex://resolved", "continue")
    } finally {
      delete process.env.COMPACT_TRACE
      await adapter.close()
    }
  })
})

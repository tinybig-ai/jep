// harnesses/pi.ts — a slash command must reach Pi as the first thing in its
// prompt. Jep's context header, when due, goes first as its own message that is
// stopped after Pi records it. A fake `pi` stands in, logging each prompt.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const dir = await mkdtemp(path.join(os.tmpdir(), "pi-slash-"))
const log = path.join(dir, "prompts.log")
const fake = path.join(dir, "fakepi.mjs")
await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs"
const prompt = process.argv[process.argv.length - 1]
appendFileSync(${JSON.stringify(log)}, JSON.stringify(prompt) + "\\n")
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: prompt }] } })
// a header-only run would now sit waiting for the model; hang until killed
if (!prompt.startsWith("/") && !prompt.endsWith("hello")) setTimeout(() => {}, 60000)
else { out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }); process.exit(0) }
`)
await chmod(fake, 0o755)
process.env.JEP_PI_BIN = fake
const { PiAdapter } = await import("../src/harnesses/pi.ts")

const prompts = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as string)

test("brief() records the header alone, once", async () => {
  const a = new PiAdapter(dir, { dataHome: dir })
  const before = (await prompts()).length
  assert.equal(await a.brief("pi://s1"), true)
  const got = await prompts()
  assert.equal(got.length, before + 1)
  assert.match(got.at(-1)!, /jep/i)
  assert.equal(await a.brief("pi://s1"), true)
  assert.equal((await prompts()).length, before + 1)
  await a.close()
})

test("after brief(), a command goes out clean", async () => {
  const a = new PiAdapter(dir, { dataHome: dir })
  await a.brief("pi://s2")
  const before = (await prompts()).length
  await a.prompt("pi://s2", "/marker now")
  const got = await prompts()
  assert.equal(got.length, before + 1)
  assert.equal(got.at(-1), "/marker now")
  await a.close()
})

test("without brief(), a command still goes clean and the next message carries the header", async () => {
  const a = new PiAdapter(dir, { dataHome: dir })
  await a.prompt("pi://s3", "/marker")
  assert.equal((await prompts()).at(-1), "/marker")
  await a.prompt("pi://s3", "hello")
  const last = (await prompts()).at(-1)!
  assert.match(last, /jep/i)
  assert.match(last, /hello$/)
  await a.close()
})

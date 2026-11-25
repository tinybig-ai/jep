import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import { tmpdir } from "node:os"

const exec = promisify(execFile)
const launcher = join(import.meta.dirname, "../scripts/jep-daemon.sh")

test("the daemon launcher exports operator settings and rereads them on restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jep-launcher-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const node = join(root, "node")
  const envFile = join(root, "daemon.env")
  await writeFile(node, '#!/bin/sh\n[ "$1" = "-e" ] && exit 0\nprintf "%s" "${JEP_TERMINAL:-unset}"\n', { mode: 0o755 })
  const boot = async () => (await exec("/bin/sh", [launcher], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, JEP_ROOT: root, JEP_NODE: node, JEP_GW_PORT: "0", JEP_ENV_FILE: envFile, JEP_TERMINAL: "0" },
    timeout: 5_000,
  })).stdout
  assert.equal(await boot(), "0", "missing file preserves the inherited setting")
  await writeFile(envFile, "JEP_TERMINAL=1\n", { mode: 0o600 })
  assert.equal(await boot(), "1", "settings reach the launched daemon without export statements")
  await writeFile(envFile, "JEP_TERMINAL=0\n")
  assert.equal(await boot(), "0", "a later launch reads the new value")
})

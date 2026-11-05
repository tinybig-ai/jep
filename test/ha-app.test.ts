// The Home Assistant app's entry point, tested like any other module of this
// repo: run.sh is exec'd against a sandbox fake of the container layout,
// with every path parameterized (the overrides the container never sets),
// asserting what the daemon ends up running under.
import { execFile } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import assert from "node:assert/strict"

const runsh = join(import.meta.dirname, "..", "homeassistant", "run.sh")
const run = promisify(execFile)

function sandbox(options: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "jep-ha-"))
  mkdirSync(join(root, "options"), { recursive: true })
  mkdirSync(join(root, "config"))
  mkdirSync(join(root, "src", "src", "app"), { recursive: true })
  writeFileSync(join(root, "src", "src", "app", "tg.ts"), "")
  writeFileSync(join(root, "options", "options.json"), JSON.stringify(options))
  return root
}

async function boot(root: string): Promise<{ status: number; out: string }> {
  try {
    const { stdout, stderr } = await run(runsh, {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        JEP_OPTIONS_FILE: join(root, "options", "options.json"),
        JEP_DATA_DIR: join(root, "data", "jep"),
        JEP_APP_CONFIG: join(root, "config"),
        JEP_SRC_DIR: join(root, "src"),
        JEP_HA_DRY_RUN: "1",
      },
    })
    return { status: 0, out: stdout + stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { status: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") }
  }
}

const envFor = (root: string): string => readFileSync(join(root, "data", "jep", "opts.env"), "utf8")

test("both clients on: the daemon's env and the pasted auth are in place", async () => {
  const ws = join(mkdtempSync(join(tmpdir(), "jep-")), "ws")
  const root = sandbox({
    telegram_token: "123:xyz",
    gateway_enabled: true,
    gateway_port: 8099,
    workspace_dir: ws,
    opencode_auth: '{"a.b":{"token":"<<>"}}',
  })
  const r = await boot(root)
  assert.equal(r.status, 0, r.out)
  assert.match(envFor(root), /export JEP_TG_TOKEN=.*xyz/)
  assert.match(envFor(root), /export JEP_GW_PORT=8099/)
  // run.sh creates the workspace dir before the daemon boots, so a boot with
  // zero workspaces can never come out of an empty options form
  assert.ok(existsSync(ws))
  // jep copies $XDG_DATA_HOME/opencode/auth.json into its isolated store at
  // boot (syncOpenCodeAuth) — so run.sh must land the paste there
  assert.match(readFileSync(join(root, "data", "jep", "xdg", "opencode", "auth.json"), "utf8"), /"token"/)
})

test("gateway only: no token, no bot, the gateway port still set", async () => {
  const root = sandbox({ telegram_token: "", gateway_enabled: true, gateway_port: 9000 })
  const r = await boot(root)
  assert.equal(r.status, 0, r.out)
  assert.match(envFor(root), /export JEP_GW_PORT=9000/)
  assert.doesNotMatch(envFor(root), /JEP_TG_TOKEN/)
})

test("telegram only: gateway switch off means no JEP_GW_PORT", async () => {
  const root = sandbox({ telegram_token: "1:a", gateway_enabled: false })
  const r = await boot(root)
  assert.equal(r.status, 0, r.out)
  assert.match(envFor(root), /JEP_TG_TOKEN/)
  assert.doesNotMatch(envFor(root), /export JEP_GW_PORT/)
})

test("both clients off refuses to start", async () => {
  const root = sandbox({ telegram_token: "", gateway_enabled: false })
  const r = await boot(root)
  assert.equal(r.status, 78)
  assert.match(r.out, /nothing to serve/)
})

test("a pasted file that is not JSON is a sentence, not a stack trace", async () => {
  const root = sandbox({ telegram_token: "1:a", opencode_auth: "not json" })
  const r = await boot(root)
  assert.equal(r.status, 1)
  assert.match(r.out, /opencode_auth is not valid JSON/)
  assert.doesNotMatch(r.out, /Traceback/)
})

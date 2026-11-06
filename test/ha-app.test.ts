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

test("a github token is handed to gh and never printed", async () => {
  const root = sandbox({ telegram_token: "1:a", github_token: "ghp-test-token" })
  const r = await boot(root)
  assert.equal(r.status, 0, r.out)
  assert.match(envFor(root), /export GH_TOKEN=ghp-test-token/)
  assert.match(r.out, /GH_TOKEN=<redacted>/)
  assert.doesNotMatch(r.out, /ghp-test-token/)
})

test("the openrouter key rides through as opencode's own env", async () => {
  const root = sandbox({ telegram_token: "1:a", openrouter_api_key: "sk-or-test" })
  const r = await boot(root)
  assert.equal(r.status, 0, r.out)
  assert.match(envFor(root), /export OPENROUTER_API_KEY=sk-or-test/)
})

test("forum topics: the switch reaches the daemon's env", async () => {
  const root = sandbox({ telegram_token: "1:a", telegram_forum: "off" })
  const r = await boot(root)
  assert.equal(r.status, 0, r.out)
  assert.match(envFor(root), /export JEP_TG_FORUM=off/)
})

test("ingress is on, so HA can mount the web client without any open port", () => {
  const cfg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "homeassistant", "config.json"), "utf8")) as {
    ingress: boolean
    ingress_port: number
    webui?: string
    watchdog?: string
    ports: Record<string, number | null>
    options: { ingress_trust: boolean }
    schema: { ingress_trust: string }
  }
  assert.equal(cfg.ingress, true, "the Supervisor's ingress proxy is the /api/hassio_ingress/... route")
  assert.equal(cfg.ingress_port, 8099)
  assert.equal(cfg.ports["8099/tcp"], null, "an unpublished host port is what makes the ingress header unforgeable")
  assert.equal(cfg.webui, undefined)
  assert.equal(cfg.watchdog, undefined)
  assert.equal(cfg.options.ingress_trust, true)
  assert.equal(cfg.schema.ingress_trust, "bool")
  // the web client it proxies must have no site-absolute URLs: ingress mounts
  // the app under /api/hassio_ingress/<token>/ and does not rewrite paths
  const page = readFileSync(join(import.meta.dirname, "..", "web", "index.html"), "utf8")
  for (const ref of [/src="\/[^"]/, /href="\/[^"]/, /fetch\("\/[^"]/, /EventSource\(`\//]) {
    const hit = ref.exec(page)?.[0] ?? null
    assert.equal(hit, null, `absolute URL in web/index.html breaks ingress: ${hit}`)
  }
  assert.match(page, /trustedIngress/)
})

test("the published image clones this repo, not upstream", () => {
  const wf = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ha-app.yml"), "utf8")
  const df = readFileSync(join(import.meta.dirname, "..", "homeassistant", "Dockerfile"), "utf8")
  assert.match(wf, /JEP_REPO=https:\/\/github.com\/\$\{\{ github\.repository \}\}/)
  assert.match(wf, /JEP_SHA=\$\{\{ github\.sha \}\}/)
  assert.match(df, /ARG JEP_SHA/)
})

test("ingress trust reaches the daemon only when the option is on", async () => {
  const on = sandbox({ telegram_token: "1:a", ingress_trust: true })
  assert.equal((await boot(on)).status, 0)
  assert.match(envFor(on), /export JEP_GW_INGRESS_TRUST=1/)
  const off = sandbox({ telegram_token: "1:a", ingress_trust: false })
  assert.equal((await boot(off)).status, 0)
  assert.doesNotMatch(envFor(off), /JEP_GW_INGRESS_TRUST/)
  // an update that has not rewritten options.json yet must not fall back to pairing
  const unset = sandbox({ telegram_token: "1:a" })
  assert.equal((await boot(unset)).status, 0)
  assert.match(envFor(unset), /export JEP_GW_INGRESS_TRUST=1/)
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

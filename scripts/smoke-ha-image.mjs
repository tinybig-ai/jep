// Exercise the actual HA image with a fresh data directory and no credentials.
// No model prompt is sent: this does not spend provider credits.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"

const [image, platform] = process.argv.slice(2)
if (!image || !/^linux\/(amd64|arm64)$/.test(platform ?? "")) throw new Error("Usage: node scripts/smoke-ha-image.mjs IMAGE linux/amd64|linux/arm64")
const config = JSON.parse(readFileSync(new URL("../homeassistant/config.json", import.meta.url)))
const name = `jep-ha-smoke-${process.pid}`
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 180_000, stdio: "pipe" }).trim()
const inside = (code, ...args) => docker("exec", name, "node", "--input-type=module", "-e",
  `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n${code}`, ...args)
const request = (path, body, token) => JSON.parse(inside(`
  const [path, body, token] = process.argv.slice(1);
  const res = await fetch('http://127.0.0.1:8099' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? {authorization: 'Bearer ' + token} : {}) },
    ...(body ? {body} : {}), signal: AbortSignal.timeout(30_000)
  });
  console.log(JSON.stringify({status:res.status, body:await res.json()}));
`, path, body ? JSON.stringify(body) : "", token ?? ""))
async function ready() {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (docker("inspect", "--format", "{{.State.Running}}", name) !== "true") throw new Error("HA container exited before gateway became ready")
    try {
      assert.equal(request("/health").body.ok, true)
      return
    } catch {}
    await delay(2_000)
  }
  throw new Error("Gateway did not become healthy within 3 minutes")
}
try {
  const labels = JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Labels}}", image))
  assert.equal(labels["io.hass.version"], config.version)
  assert.equal(labels["io.hass.arch"], platform === "linux/arm64" ? "aarch64" : "amd64")
  assert.equal(labels["io.hass.type"], "app")
  const options = Buffer.from(JSON.stringify({...config.options, gateway_pair_code: "SMOKE-ONLY"})).toString("base64")
  docker("run", "--detach", "--name", name, "--platform", platform,
    "--env", `JEP_SMOKE_OPTIONS=${options}`, "--entrypoint", "/bin/sh", image, "-c",
    `node -e "require('node:fs').writeFileSync('/data/options.json', Buffer.from(process.env.JEP_SMOKE_OPTIONS, 'base64'))" && exec /run.sh`)
  await ready()
  assert.match(docker("exec", name, "opencode", "--version"), /\d+\.\d+\.\d+/)
  assert.equal(docker("exec", name, "jep", "--version"), config.version)
  for (const tool of ["jep-watch", "jep-send", "jep-show", "jep-rename", "jep-read", "jep-tell", "jep-restart"]) {
    docker("exec", name, "test", "-x", `/usr/local/bin/${tool}`)
  }
  assert.equal(request("/workspaces", {}).status, 401)
  const spoof = JSON.parse(inside(`
    const headers = {'x-remote-user-id':'spoof','content-type':'application/json'};
    const health = await fetch('http://127.0.0.1:8099/health', {headers}).then(r=>r.json());
    const pair = await fetch('http://127.0.0.1:8099/pair', {method:'POST',headers,body:'{}'});
    console.log(JSON.stringify({trusted:health.trustedIngress, status:pair.status}));
  `))
  assert.deepEqual(spoof, {trusted:false, status:403})
  const pairing = request("/pair", {code:"SMOKE-ONLY"})
  assert.equal(pairing.status, 200)
  const token = pairing.body.token
  const workspaces = request("/workspaces", {}, token)
  assert.equal(workspaces.status, 200)
  assert.ok(workspaces.body.items.some(w=>w.harness === "opencode" && w.dir === config.options.workspace_dir))
  const created = request("/new", {title:"HA restart smoke"}, token)
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = created.body.session.id
  inside(`
    for (const path of ['/', '/v2.js', '/v2.css', '/marked.js', '/purify.min.js']) {
      const res = await fetch('http://127.0.0.1:8099' + path);
      if (!res.ok || !(await res.text()).length) throw new Error('Missing web asset ' + path);
    }
    require('node:fs').writeFileSync('/data/jep/workspace/restart-check', 'retained');
  `)
  docker("restart", "--time", "30", name)
  await ready()
  assert.equal(inside("console.log(require('node:fs').readFileSync('/data/jep/workspace/restart-check','utf8'))"), "retained")
  const sessions = request("/sessions", {}, token)
  assert.equal(sessions.status, 200)
  assert.ok(sessions.body.items.some(s=>s.id === id), "OpenCode conversation was lost after restart")
  console.log(`HA smoke passed: ${image} (${platform}), default boot, pairing, web assets, tools and restart persistence`)
} catch (err) {
  try {
    console.error(docker("inspect", "--format", "{{json .State}}", name))
    execFileSync("docker", ["logs", name], { stdio: "inherit", timeout: 10_000 })
  } catch {}
  throw err
} finally {
  try { docker("rm", "--force", name) } catch {}
}

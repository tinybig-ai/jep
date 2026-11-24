import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExecutionPolicy, applyExecutionPolicy } from "../src/core/execution-policy.ts"
import { startGateway } from "../src/clients/gateway/index.ts"
import { fakeAdapter, pair } from "./support/gateway.ts"

test("the global override applies at each turn and disabling it restores conversation choices", async () => {
  const home = mkdtempSync(join(tmpdir(), "jep-execution-"))
  const policy = new ExecutionPolicy(home)
  const settings = { dangerouslySkipPermissions: false, injectContext: false }
  const seen: Array<Record<string, boolean> | undefined> = []
  const original = fakeAdapter()
  const prompt = original.prompt.bind(original)
  original.prompt = (id, text, opts) => {
    seen.push(opts?.harnessSettings)
    return prompt(id, text, opts)
  }
  const adapter = applyExecutionPolicy(original, policy)
  await adapter.prompt("s1", "before", { harnessSettings: settings })
  policy.setEnabled(true)
  await adapter.prompt("s1", "enabled", { harnessSettings: settings })
  assert.equal(new ExecutionPolicy(home).enabled(), true, "persists across daemon restart")
  policy.setEnabled(false)
  await adapter.prompt("s1", "disabled", { harnessSettings: settings })
  assert.deepEqual(seen, [settings, { ...settings, dangerouslySkipPermissions: true }, settings])
  assert.equal(settings.dangerouslySkipPermissions, false, "the override never rewrites per-conversation choices")
  assert.equal(policy.apply({ dangerouslySkipPermissions: true })?.dangerouslySkipPermissions, true)
})

test("paired clients share the durable toggle and prompts receive its effective setting", async () => {
  const home = mkdtempSync(join(tmpdir(), "gw-execution-"))
  const adapter = fakeAdapter()
  adapter.settings = () => [
    { id: "dangerouslySkipPermissions", label: "No sandbox", description: "", default: false },
    { id: "injectContext", label: "Context", description: "", default: true },
  ]
  const observed: boolean[] = []
  const prompt = adapter.prompt.bind(adapter)
  adapter.prompt = (id, text, opts) => {
    observed.push(opts?.harnessSettings?.dangerouslySkipPermissions === true)
    return prompt(id, text, opts)
  }
  const g = await startGateway({ adapters: () => [{ name: "ws", adapter }], dataHome: home, port: 0, pairCode: "TESTCODE" })
  const base = `http://127.0.0.1:${g.port}`
  try {
    const anonymous = await fetch(`${base}/set-execution-setting`, { method: "POST", body: JSON.stringify({ key: "mostPermissive", enabled: true }) })
    assert.equal(anonymous.status, 401)
    const token = await pair(base, "TESTCODE")
    const call = async (path: string, body = {}) => {
      const res = await fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
      assert.equal(res.status, 200, await res.clone().text())
      return res.json() as Promise<{ values: Record<string, boolean> }>
    }
    assert.equal((await call("/execution-settings")).values.mostPermissive, false)
    await call("/set-execution-setting", { key: "mostPermissive", enabled: true })
    assert.equal((await call("/harness-settings", { id: "s1" })).values.dangerouslySkipPermissions, true)
    await call("/set-harness-setting", { id: "s1", key: "injectContext", enabled: false })
    const stored = JSON.parse(readFileSync(join(home, "gateway-harness-settings.json"), "utf8"))
    assert.equal(stored.s1.dangerouslySkipPermissions, false, "editing another setting must not save the forced value")
    await call("/prompt", { id: "s1", text: "on" })
    await call("/set-execution-setting", { key: "mostPermissive", enabled: false })
    await call("/prompt", { id: "s1", text: "off" })
    assert.deepEqual(observed, [true, false])
    const invalid = await fetch(`${base}/set-execution-setting`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ key: "mostPermissive", enabled: "false" }) })
    assert.equal(invalid.status, 400)
  } finally { await g.close() }
})

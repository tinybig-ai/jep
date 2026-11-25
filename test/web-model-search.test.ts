import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

type Model = { providerID: string; modelID: string; name?: string }
const { search } = runInNewContext(readFileSync(new URL("../web/model-search.js", import.meta.url), "utf8") + "; JepModelSearch") as {
  search(query: string, models: readonly Model[]): { models: readonly Model[]; fuzzy: boolean }
}
const models: Model[] = [
  { providerID: "litellm", modelID: "gpt-6.1-sol-mini" },
  { providerID: "litellm", modelID: "gpt-6.1-sol" },
  { providerID: "anthropic", modelID: "claude-sonnet-4", name: "Claude Sonnet" },
  { providerID: "anthropic", modelID: "claude-opus-4", name: "Claude Opus" },
  { providerID: "litellm", modelID: "go/kimi-k3", name: "Kimi K3" },
  { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4" },
]
const refs = (query: string, catalogue = models) => Array.from(search(query, catalogue).models, (m) => `${m.providerID}/${m.modelID}`)

test("model search ranks exact ids before partial matches and ignores punctuation and case", () => {
  assert.deepEqual(refs("GPT61SOL"), ["litellm/gpt-6.1-sol", "litellm/gpt-6.1-sol-mini"])
  assert.deepEqual(refs("litellm/go/kimi-k3"), ["litellm/go/kimi-k3"])
  assert.equal(search("gpt-6.1-sol", models).fuzzy, false)
})

test("model search accepts provider names, display names, and separate query words", () => {
  assert.equal(refs("litellm").length, 3)
  assert.deepEqual(refs("LITELLM kimi"), ["litellm/go/kimi-k3"])
  assert.deepEqual(refs("Kimi K3"), ["litellm/go/kimi-k3"])
  assert.equal(refs("sonnet").length, 2)
})

test("model search falls back to typo and transposition matches only without direct hits", () => {
  assert.equal(search("sonet", models).fuzzy, true)
  assert.equal(refs("sonet")[0], "anthropic/claude-sonnet-4")
  assert.deepEqual(refs("opuss"), ["anthropic/claude-opus-4"])
  assert.equal(refs("cluade").length, 3)
  assert.equal(search("cluade", models).fuzzy, true)
  const catalogue = [...models, { providerID: "test", modelID: "sonet" }]
  assert.deepEqual(refs("sonet", catalogue), ["test/sonet"])
  assert.equal(search("sonet", catalogue).fuzzy, false)
})

test("model search handles empty queries and no matches without changing the catalogue", () => {
  assert.equal(search("  ", models).models, models)
  for (const query of ["????", "xyzqvzzz", "xy"]) {
    assert.deepEqual(refs(query), [])
    assert.equal(search(query, models).fuzzy, false)
  }
  const before = JSON.stringify(models)
  search("gpt61sol", Object.freeze([...models]))
  assert.equal(JSON.stringify(models), before)
})

test("model search keeps provider identity and bounds fuzzy results", () => {
  const catalogue = Array.from({ length: 60 }, (_, i) => ({ providerID: `provider${i}`, modelID: "claude-sonnet-4" }))
  assert.equal(refs("sonnet", catalogue).length, 60)
  assert.equal(new Set(refs("sonnet", catalogue)).size, 60)
  assert.equal(refs("sonet", catalogue).length, 20)
})

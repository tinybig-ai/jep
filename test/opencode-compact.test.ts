import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { OpenCodeAdapter } from "../src/harnesses/opencode.ts"
import type { ModelRef } from "../src/core/ports.ts"

test("OpenCode compaction always names the conversation's model", async (t) => {
  for (const scenario of [
    { name: "selected model wins without reading history", selected: { providerID: "opencode", modelID: "hy4-flash-free" }, rows: [], config: {}, expected: { providerID: "opencode", modelID: "hy4-flash-free" } },
    { name: "latest user choice wins over the previous assistant", rows: [
      { info: { role: "assistant", providerID: "old", modelID: "previous", time: { created: 1 } } },
      { info: { role: "user", model: { providerID: "litellm", modelID: "nested/model" }, time: { created: 2 } } },
    ], config: {}, expected: { providerID: "litellm", modelID: "nested/model" } },
    { name: "assistant metadata supplies a model for older sessions", rows: [
      { info: { role: "user", time: { created: 2 } } },
      { info: { role: "assistant", providerID: "opencode", modelID: "hy4-flash-free", time: { created: 1 } } },
    ], config: {}, expected: { providerID: "opencode", modelID: "hy4-flash-free" } },
    { name: "a fresh session uses the configured OpenCode model", rows: [], config: { model: "litellm/nested/model" }, expected: { providerID: "litellm", modelID: "nested/model" } },
    { name: "missing model is explained without sending an invalid summarize", rows: [], config: {}, expected: undefined },
  ]) {
    await t.test(scenario.name, async () => {
      const requests: string[] = []
      let sent: unknown
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://local")
        requests.push(url.pathname)
        let body = ""
        req.on("data", (chunk) => { body += chunk })
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" })
          if (url.pathname.endsWith("/message")) {
            assert.equal(url.searchParams.get("limit"), "8")
            res.end(JSON.stringify(scenario.rows))
          } else if (url.pathname === "/config") res.end(JSON.stringify(scenario.config))
          else {
            sent = JSON.parse(body)
            res.end("true")
          }
        })
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      try {
        const adapter = new OpenCodeAdapter({} as never, "/tmp/workspace", `http://127.0.0.1:${(server.address() as { port: number }).port}`)
        const selected = "selected" in scenario ? scenario.selected as ModelRef : undefined
        const result = await adapter.compact("opencode://ses_compact", selected ? { model: selected } : undefined)
        assert.equal(result.ok, Boolean(scenario.expected))
        assert.deepEqual(sent, scenario.expected)
        if (selected) assert.deepEqual(requests, ["/session/ses_compact/summarize"])
        if (!scenario.expected) assert.match(result.error ?? "", /Choose a model/)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  }
})

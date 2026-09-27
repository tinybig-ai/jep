// opencode takes a quote as a part of its own, tagged jep's in its metadata,
// and gives it back as a quote without anyone reading its words.
import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { OpenCodeAdapter } from "../src/harnesses/opencode.ts"

test("a quote is its own tagged part going in, and a quote part coming out", async () => {
  let stored: any[] = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      res.writeHead(200, { "content-type": "application/json" })
      if (req.method === "POST" && url.pathname === "/session/ses_q/message") {
        stored = JSON.parse(body).parts
        res.end(JSON.stringify({ info: { id: "msg_a", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "ok" }] }))
      } else if (url.pathname === "/session/ses_q/message") {
        res.end(JSON.stringify([{ info: { id: "msg_u", role: "user", time: { created: 1 } }, parts: stored }]))
      } else res.end("{}")
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as { port: number }).port
  try {
    const a = new OpenCodeAdapter({} as any, "/ws", `http://127.0.0.1:${port}`)
    await a.prompt("opencode://ses_q", "yes, that", { quote: "shall I?", timeoutMs: 0 })
    assert.deepEqual(stored.slice(0, 2), [
      { type: "text", text: "[in reply to]\n> shall I?", metadata: { jep: "quote", quote: "shall I?" } },
      { type: "text", text: "yes, that" },
    ])
    const [m] = await a.messages("opencode://ses_q")
    assert.deepEqual(m!.parts, [
      { kind: "quote", text: "shall I?" },
      { kind: "text", text: "yes, that" },
    ])
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

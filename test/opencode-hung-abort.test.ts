// The crash of 2026-09-28: opencode lost its provider and stopped answering,
// the gateway's watchdog stopped the stuck turn, and the adapter's abort to
// that hung server failed with nobody listening. Node ended the daemon over
// it, and Telegram, the phone and every other harness went with it.
import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { OpenCodeAdapter } from "../src/harnesses/opencode.ts"

test("a stop the hung server cannot answer is logged, not a crash", async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (err: unknown) => unhandled.push(err)
  process.on("unhandledRejection", onUnhandled)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    // the turn never ends on its own, and the abort fails outright
    if (url.pathname === "/session/ses_h/message") return
    if (url.pathname === "/session/ses_h/abort") {
      res.writeHead(500)
      res.end("provider gone")
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{}")
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as { port: number }).port
  try {
    const a = new OpenCodeAdapter({} as any, "/ws", `http://127.0.0.1:${port}`)
    const stop = new AbortController()
    const turn = a.prompt("opencode://ses_h", "hi", { signal: stop.signal, timeoutMs: 0 })
    await new Promise((r) => setTimeout(r, 100))
    stop.abort()
    await assert.rejects(turn)
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(unhandled, [], "the failed abort reached nobody")
  } finally {
    process.off("unhandledRejection", onUnhandled)
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

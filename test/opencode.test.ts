// harnesses/opencode.ts — session listing has to survive opencode minting a
// second project row for the same worktree. Its project id follows repo
// identity, so adding/renaming a remote or rewriting history strands every
// earlier session under the old id; /session is scoped to the one project this
// serve instance resolved, which is why those threads silently vanished from
// /ls. /experimental/session lists across projects, and listSessions unions the
// two. No real opencode here: a tiny HTTP server stands in for `opencode serve`.

import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { OpenCodeAdapter, mergeSessionRows } from "../src/harnesses/opencode.ts"

const WS = "/Users/me/jep"

const row = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: id,
  directory: WS,
  time: { created: 1, updated: 2 },
  ...extra,
})

test("mergeSessionRows: project view wins a tie, cross-project only adds", () => {
  const merged = mergeSessionRows(
    [row("a"), row("b", { title: "from project" })],
    [row("b", { title: "from experimental" }), row("c")],
  )
  assert.deepEqual(
    merged.map((s) => s.id),
    ["a", "b", "c"],
  )
  assert.equal(merged.find((s) => s.id === "b")!.title, "from project")
})

// stand-in for `opencode serve`: a route returns undefined to mean 404
async function serve(
  route: (pathname: string, params: URLSearchParams) => unknown,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const body = route(url.pathname, url.searchParams)
    if (body === undefined) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end("{}")
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  const port = typeof addr === "object" && addr ? addr.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

test("listSessions unions the project list with the cross-project one", async () => {
  const seen: string[] = []
  const srv = await serve((pathname, params) => {
    seen.push(`${pathname}?${params.toString()}`)
    if (pathname === "/session") return [row("ses_a"), row("ses_b")]
    if (pathname === "/experimental/session") {
      // it must scope the request to this workspace's own directory
      return params.get("directory") === WS
        ? [row("ses_b", { title: "dup" }), row("ses_c"), row("ses_child", { parentID: "ses_a" })]
        : undefined
    }
    return undefined
  })
  try {
    const adapter = new OpenCodeAdapter({} as any, WS, srv.base)
    const list = await adapter.listSessions()
    assert.deepEqual(
      list.map((s) => s.id),
      ["opencode://ses_a", "opencode://ses_b", "opencode://ses_c"],
    )
    // the project-scoped entry won: the cross-project duplicate did not overwrite it
    assert.equal(list.find((s) => s.id === "opencode://ses_b")!.title, "ses_b")
    // a child seen only cross-project still folds into its parent's count, and never lists
    assert.equal(list.find((s) => s.id === "opencode://ses_a")!.subagents, 1)
    assert.equal(list.some((s) => s.id === "opencode://ses_child"), false)
    assert.ok(seen.some((s) => s.startsWith("/experimental/session?directory=")))
  } finally {
    await srv.close()
  }
})

test("listSessions falls back to the project list when the route is missing", async () => {
  const srv = await serve((pathname) => (pathname === "/session" ? [row("ses_a")] : undefined))
  try {
    const adapter = new OpenCodeAdapter({} as any, WS, srv.base)
    const list = await adapter.listSessions()
    assert.deepEqual(
      list.map((s) => s.id),
      ["opencode://ses_a"],
    )
  } finally {
    await srv.close()
  }
})

test("recovers a user attachment's real path from opencode's synthetic part", async () => {
  // opencode stores a user attachment as an inline data: URL with no name, and
  // marks its own "Called the Read tool … {\"filePath\":…}" scaffolding
  // `synthetic`. Recover the real path (and name) from that scaffolding and drop
  // it, rather than showing it to anyone as the user's words.
  const srv = await serve((pathname) => {
    if (pathname !== "/session/ses_a/message") return undefined
    return [
      {
        info: { id: "msg_1", role: "user", time: { created: 10 } },
        parts: [
          { type: "text", text: "see the attached file" },
          {
            type: "text",
            text: 'Called the Read tool with the following input: {"filePath":"/tmp/x.jpg"}',
            synthetic: true,
          },
          { type: "file", url: "data:image/jpeg;base64,AAAA", mime: "image/jpeg" },
        ],
      },
    ]
  })
  try {
    const adapter = new OpenCodeAdapter({} as any, WS, srv.base)
    const parts = (await adapter.messages("opencode://ses_a"))[0]!.parts
    assert.deepEqual(parts.map((p) => p.kind), ["text", "file"], "the synthetic scaffolding is gone")
    const text = parts[0]!
    assert.equal(text.kind === "text" ? text.text : "", "see the attached file")
    const file = parts[1]!
    assert.equal(file.kind === "file" ? file.filePath : "", "/tmp/x.jpg", "the real path, from the scaffolding")
    assert.equal(file.kind === "file" ? file.fileName : "", "x.jpg")
    assert.equal(file.kind === "file" ? file.mimeType : "", "image/jpeg")
  } finally {
    await srv.close()
  }
})

test("names a data: attachment from its mime when there is no scaffolding", async () => {
  // fallback for a message with no synthetic part: still never treat the data:
  // URL as a path (it used to become "<workspace>/data:image/jpeg;base64,…")
  const srv = await serve((pathname) => {
    if (pathname !== "/session/ses_a/message") return undefined
    return [
      {
        info: { id: "msg_1", role: "user", time: { created: 10 } },
        parts: [
          { type: "text", text: "see the attached file" },
          { type: "file", url: "data:image/jpeg;base64,AAAA", mime: "image/jpeg" },
        ],
      },
    ]
  })
  try {
    const adapter = new OpenCodeAdapter({} as any, WS, srv.base)
    const parts = (await adapter.messages("opencode://ses_a"))[0]!.parts
    const file = parts.find((p) => p.kind === "file")
    assert.ok(file && file.kind === "file")
    assert.equal(file.fileName, "attached.jpeg")
    assert.equal(file.mimeType, "image/jpeg")
    assert.equal(file.filePath.startsWith(WS) || file.filePath.includes("data:"), false)
  } finally {
    await srv.close()
  }
})

test("responding to an ask opencode has forgotten is a no-op, not an error", async () => {
  // a 404 means the permission request is gone: answered elsewhere, timed out,
  // or re-issued. Treating it as a failure left the turn blocked on a prompt
  // that no longer existed.
  const srv = await serve(() => undefined) // every route 404s
  try {
    const adapter = new OpenCodeAdapter({} as any, WS, srv.base)
    assert.equal(await adapter.respondAsk("opencode://ses_a", "per_1", "always"), true)
  } finally {
    await srv.close()
  }
})

test("close() returns even when an event feed is parked on a stream that never ends", async () => {
  // This is what wedged the daemon's shutdown: a reader blocked in read() on a
  // feed that never sends a frame left reader.cancel() pending forever, so
  // "stopping N workspace server(s)" was the last line in the log and the
  // process never exited. close() must return regardless.
  let open: { feed?: import("node:http").ServerResponse } = {}
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(": keepalive\n\n") // headers only: the reader parks in read()
    open.feed = res
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as { port: number }).port
  const child = { kill: () => true, exitCode: 0, once: () => true } as any
  const adapter = new OpenCodeAdapter(child, WS, `http://127.0.0.1:${port}`)
  const ac = new AbortController()
  try {
    // take the reader: events() is now blocked waiting for a frame
    const stream = adapter.events(ac.signal) as AsyncGenerator<import("../src/core/types.ts").DomainEvent>
    void stream.next() // parked in read(): no frame will ever arrive
    await new Promise((r) => setTimeout(r, 100)) // let it subscribe and park
    const started = Date.now()
    await adapter.close()
    assert.ok(Date.now() - started < 5_000, `close() must be bounded, took ${Date.now() - started}ms`)
  } finally {
    ac.abort()
    open.feed?.end()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test("a question ask is answered by its label, on the questions route", async () => {
  // The `question` tool parks the turn on a human. Its ask is NOT a permission:
  // it is answered on a different route, and by LABEL — jep's option id carries
  // a truncated label and a question index, which opencode would not recognise.
  // Answering it through the permissions route failed, leaving the turn parked.
  const asked = {
    type: "question.asked",
    properties: {
      sessionID: "ses_a",
      id: "que_1",
      questions: [{ header: "Next up", question: "Which?", options: [{ label: "Yes, do that" }, { label: "No" }] }],
    },
  }
  const posts: Array<{ path: string; body: string }> = []
  const open: { feed?: import("node:http").ServerResponse } = {}
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify(asked)}\n\n`)
      open.feed = res // left open: the feed is a stream, not a response
      return
    }
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      posts.push({ path: url.pathname, body })
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as { port: number }).port
  const adapter = new OpenCodeAdapter({} as any, WS, `http://127.0.0.1:${port}`)
  const ac = new AbortController()
  try {
    // one event is enough: the ask surfaces, and its real labels are remembered
    for await (const evt of adapter.events(ac.signal)) {
      assert.equal(evt.type, "ask.requested")
      break
    }
    assert.equal(await adapter.respondAsk("opencode://ses_a", "que_1", "0:Yes, do that"), true)
    assert.equal(posts.length, 1, "the reply must be exactly one post")
    assert.equal(posts[0]!.path, "/question/que_1/reply", "questions do not go through the permissions route")
    assert.deepEqual(JSON.parse(posts[0]!.body), { answers: [["Yes, do that"]] }, "answered by label, whole")
  } finally {
    ac.abort()
    open.feed?.end()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

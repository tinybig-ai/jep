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

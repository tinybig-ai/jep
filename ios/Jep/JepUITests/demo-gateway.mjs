// A canned gateway for the screenshot tour: every route the app calls, fixed
// answers, no harness behind it. Run: node demo-gateway.mjs [port]
import http from "node:http"

const port = Number(process.argv[2] ?? 8931)
const now = Date.now()
const min = 60_000

const session = (id, title, workspace, harness, ago, extra = {}) => ({
  id, title, workspace: `~/code/${workspace}`, harness, adapter: workspace, subagents: 0, active: false,
  createdAt: now - ago - 3600_000, updatedAt: now - ago, seenAt: now - ago - min, ...extra,
})
const sessions = [
  session("s1", "Fix flaky login test", "api", "opencode", 2 * min, { active: true, subagents: 2 }),
  session("s2", "Add dark mode to settings", "web", "claude", 25 * min),
  session("s3", "Profile the image pipeline", "media", "codex", 3 * 3600_000, { seenAt: now }),
  session("s4", "Write release notes for 0.4", "docs", "opencode", 26 * 3600_000, { seenAt: now }),
]

const tool = (id, name, title, input, output, status = "completed") => ({ kind: "tool", id, name, title, status, input, output })
const messages = [
  { id: "m1", role: "user", time: now - 9 * min, parts: [{ kind: "text", text: "The login test fails about one run in five on CI. Can you find out why and fix it?" }] },
  {
    id: "m2", role: "assistant", time: now - 8 * min, model: "anthropic/claude-sonnet-4", cost: 0.042, durationMs: 48_000,
    parts: [
      { kind: "reasoning", text: "Flaky one in five smells like a race. Look at how the test waits for the session cookie.", durationMs: 6000 },
      tool("t1", "read", "src/auth/session.ts", { filePath: "src/auth/session.ts" }, "export async function login(…)"),
      tool("t2", "read", "test/login.test.ts", { filePath: "test/login.test.ts" }, "it('logs in', …)"),
      tool("t3", "read", "src/auth/cookie.ts", { filePath: "src/auth/cookie.ts" }, "export function setCookie(…)"),
      tool("t4", "bash", "npm test -- login --repeat 20", { command: "npm test -- login --repeat 20" }, "✖ 4 of 20 runs failed: expected cookie, got undefined"),
      tool("t5", "edit", "src/auth/session.ts", {
        filePath: "src/auth/session.ts",
        oldString: "  setCookie(res, token)\n  return user",
        newString: "  await setCookie(res, token)\n  return user",
      }, "Edit applied"),
      {
        kind: "text",
        text: "Found it. `login()` in [session.ts](src/auth/session.ts) returned before the cookie write finished, so the test sometimes read the response too early.\n\n### What changed\n- `setCookie` is now awaited\n- the test waits on the cookie, not a timer\n\n```ts\nawait setCookie(res, token)\nreturn user\n```\n\n| run | before | after |\n|---|---|---|\n| 20× login | 4 failed | 0 failed |\n",
      },
    ],
  },
  { id: "m3", role: "user", time: now - 3 * min, parts: [{ kind: "quote", text: "the test waits on the cookie, not a timer" }, { kind: "text", text: "Nice. Should we also push this to the release branch?" }] },
  {
    id: "m4", role: "assistant", time: now - 2 * min,
    parts: [tool("t6", "question", "Push to release?", {}, "", "running")],
  },
]
// a second conversation: one long run of work, and links to an HTML page
const steps = Array.from({ length: 20 }, (_, i) => i % 3 === 2
  ? tool(`w${i}`, "bash", `npm run build -- --step ${i}`, { command: `npm run build -- --step ${i}` }, "ok")
  : tool(`w${i}`, "read", `src/theme/part${i}.ts`, { filePath: `src/theme/part${i}.ts` }, "export …"))
const themeMessages = [
  { id: "d1", role: "user", time: now - 30 * min, parts: [{ kind: "text", text: "Add a dark mode and show me a preview page." }] },
  {
    id: "d2", role: "assistant", time: now - 29 * min, durationMs: 95_000,
    parts: [...steps, { kind: "text", text: "Done. Open the [preview page](out/preview.html), or the same file as a [file link](file:///Users/demo/code/web/out/preview.html)." }],
  },
]
const previewHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{font:16px -apple-system,system-ui;margin:0;padding:24px;background:#f6f5f2;color:#111}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.card{background:#1c1c1e}}
h1{font-size:26px;margin:0 0 16px}.card{background:#fff;border-radius:16px;padding:16px;margin:12px 0;box-shadow:0 1px 4px #0002}
.bar{height:12px;border-radius:6px;background:linear-gradient(90deg,#2a78d6,#eb6834)}</style></head>
<body><h1>Dark mode preview</h1><div class="card"><b>Surface</b><p>Cards, sheets and bars follow the system theme.</p><div class="bar"></div></div>
<div class="card"><b>Rendered HTML</b><p>This page is drawn, not shown as source.</p></div></body></html>`

const asks = [{
  id: "a1", sessionID: "s1", kind: "question", title: "Push the fix to release/0.4 too?",
  detail: "The branch is 3 commits behind main.", messageID: "m4", callID: "t6", at: now - 2 * min, state: "pending",
  options: [{ id: "yes", label: "Yes, cherry-pick it" }, { id: "no", label: "No, main only" }, { id: "wait", label: "After CI is green" }],
  questions: [],
}]

const routes = {
  "/pair": () => ({ token: "demo-token", nextCode: "482913" }),
  "/health": () => ({ ok: true }),
  "/sessions": () => ({ items: [...sessions].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt) }),
  "/archived": () => ({ items: [session("s9", "Spike: websocket transport", "api", "claude", 9 * 86400_000)] }),
  "/importable": () => ({ sessions: [
    { harness: "claude", id: "ext1", title: "Refactor billing webhooks", directory: "~/code/billing", updated: now - 5 * 3600_000 },
    { harness: "codex", id: "ext2", title: "Migrate to pnpm", directory: "~/code/web", updated: now - 2 * 86400_000 },
  ] }),
  "/workspaces": () => ({ items: [
    { name: "api", harness: "opencode", dir: "~/code/api" },
    { name: "web", harness: "claude", dir: "~/code/web" },
    { name: "media", harness: "codex", dir: "~/code/media" },
  ] }),
  "/harnesses": () => ({ harnesses: ["opencode", "claude", "codex"], default: "opencode" }),
  "/harness-settings": () => ({
    options: [
      { id: "auto-approve", label: "Auto-approve edits", description: "Apply file edits without asking.", default: false },
      { id: "yolo", label: "Skip all permissions", description: "Run any command without asking.", default: false, danger: true },
    ],
    values: { "auto-approve": true }, compact: true,
  }),
  "/browse": () => ({ cwd: "~/code", root: "~", parent: "~", dirs: [
    { name: "api", git: true }, { name: "web", git: true }, { name: "media", git: true }, { name: "scratch", git: false },
  ] }),
  "/history": (b) => b.id === "s2" ? { messages: themeMessages, hasMore: false, asks: [], etag: "e2" } : { messages, hasMore: false, asks, etag: "e1" },
  "/models": () => ({
    models: [
      { providerID: "anthropic", modelID: "claude-sonnet-4", image: true, contextLimit: 200000 },
      { providerID: "anthropic", modelID: "claude-opus-4", image: true, contextLimit: 200000 },
      { providerID: "openai", modelID: "gpt-5", image: true, contextLimit: 400000 },
    ],
    current: "anthropic/claude-sonnet-4", default: "anthropic/claude-sonnet-4", contextLimit: 200000,
  }),
  "/agent": () => ({ current: "build" }),
  "/agents": () => ({ agents: [{ id: "build", label: "build", detail: "Full tool access" }, { id: "plan", label: "plan", detail: "Read-only, proposes changes" }] }),
  "/usage": () => ({ usage: { input: 182_340, output: 12_880, reasoning: 3_120, cacheRead: 640_000, cacheWrite: 41_000, total: 879_340, cost: 1.84, priced: 14, unpriced: 0, turns: 14, models: ["anthropic/claude-sonnet-4"] } }),
  "/diff": () => ({ files: [{ file: "src/auth/session.ts", additions: 1, deletions: 1 }, { file: "test/login.test.ts", additions: 6, deletions: 3 }] }),
  "/git": () => {
    const c = (h, subject, author, ago) => ({ hash: h.repeat(8), shortHash: h.repeat(7).slice(0, 7), subject, author, time: now - ago })
    return { isRepository: true, branch: "fix/flaky-login", head: c("a", "auth: await the cookie write", "jep", 2 * min), changedFiles: 2,
      commits: [c("a", "auth: await the cookie write", "jep", 2 * min), c("b", "test: repeat login 20×", "jep", 6 * min), c("c", "Merge pull request #41", "Cemre", 86400_000)] }
  },
  "/subagents": () => ({ items: [session("sub1", "Search for other unawaited cookie writes", "api", "opencode", 4 * min), session("sub2", "Run the auth suite 100×", "api", "opencode", 3 * min, { active: true })] }),
  "/skills": () => ({ toggleable: true, skills: [
    { name: "release-notes", description: "Draft notes from merged PRs", scope: "project", path: ".agents/skills/release-notes" },
    { name: "db-migrate", description: "Write and check a migration", scope: "user", path: "~/.agents/skills/db-migrate" },
  ] }),
  "/mcp": () => ({ servers: [{ name: "github", kind: "remote", enabled: true, detail: "api.githubcopilot.com" }, { name: "postgres", kind: "local", enabled: false, detail: "npx @mcp/postgres" }] }),
  "/read": (b) => String(b.path ?? "").endsWith(".html") ? { text: previewHtml } : ({ text: "import { setCookie } from \"./cookie\"\n\nexport async function login(req, res) {\n  const user = await verify(req.body)\n  const token = sign(user)\n  await setCookie(res, token)\n  return user\n}\n" }),
  "/term": () => ({ allowed: true, authorized: true }),
  "/term/frame": () => ({ text: "~/code/api (fix/flaky-login) $ npm test -- login --repeat 20\n\n  ✔ logs in (20/20)\n\n  1 passing (3s)\n\n~/code/api (fix/flaky-login) $ █" }),
  "/seen": () => ({ ok: true }),
}

http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname
  if (path === "/pin" || path === "/unpin") {
    let body = ""
    for await (const chunk of req) body += chunk
    const { id } = JSON.parse(body || "{}")
    const item = sessions.find(s => s.id === id)
    if (item) item.pinned = path === "/pin"
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, pinned: !!item?.pinned }))
    return
  }
  if (path === "/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.write(": ok\n\n")
    const beat = setInterval(() => res.write(": beat\n\n"), 10_000)
    req.on("close", () => clearInterval(beat))
    return
  }
  let raw = ""
  for await (const chunk of req) raw += chunk
  let body = {}
  try { body = JSON.parse(raw || "{}") } catch {}
  // a slow first reply, so the tour can see what the app shows while it waits
  if (path === "/prompt") {
    await new Promise(r => setTimeout(r, 6000))
    res.writeHead(200, { "content-type": "application/json" })
    const t = Date.now()
    const reply = { id: `r${t}`, role: "assistant", time: t, parts: [{ kind: "text", text: "On it." }] }
    // the record keeps the turn, as the real gateway's does, so a refresh after the reply still shows it
    if (body.id === "s2") themeMessages.push({ id: `u${t}`, role: "user", time: t - 6000, parts: [{ kind: "text", text: String(body.text ?? "") }] }, reply)
    res.end(JSON.stringify({ message: reply }))
    return
  }
  const route = routes[path]
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(route ? route(body) : { ok: true }))
}).listen(port, "127.0.0.1", () => console.log(`demo gateway on :${port}`))

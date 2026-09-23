# Add a harness

This is the contribution jep was built for. The core defines exactly one
contract for an agent backend, `HarnessAdapter` in
[`src/core/ports.ts`](../src/core/ports.ts), and every client in the repo
(Telegram, the [gateway](GATEWAY.md), the Android app) is written against that
one contract. Implement it for the agent you love and every client works
unchanged.

You do **not** need to touch the core, the bot, or the gateway. If you find
yourself widening `ports.ts`, stop and open an issue: the seam is supposed to be
enough, and the first adapter that needs it stretched is telling us something
worth discussing.

## The shape

```
             HarnessAdapter (the port)
client ────────────────────────────────▶ your harness
        sessions · prompt · messages
        events() stream · asks · close()
```

The adapter is a **driven adapter**: the frontend drives it. It never imports
Telegram, the gateway, or another harness. Copy that discipline and your file
stays independently testable.

## What the port requires

`assertAdapterImplements` (`src/core/compliance.ts`) is the source of truth for
"required". Every adapter must implement:

| Method | Contract |
|---|---|
| `health()` | `{ healthy, version }`: cheap; used to decide if the harness is installed |
| `createSession(title?)` | returns a `SessionSummary` with a stable `id` |
| `getSession(id)` | the summary, or `null` when it doesn't exist |
| `listSessions()` | newest-first summaries; **filter out subagent/child sessions**, count them in `subagents` |
| `prompt(sessionID, text, opts?)` | run a turn, return the assistant `Message` |
| `messages(sessionID, opts?)` | the conversation history as `Message[]` |
| `deleteSession(id)` | returns whether it deleted |
| `abort(sessionID)` | stop the in-flight turn; return whether it stopped |
| `respondAsk(sessionID, askID, optionID)` | answer a pending ask with one of *its* option ids |
| `events(signal?)` | `AsyncIterable<DomainEvent>`: the live stream (see below) |
| `close()` | stop whatever you spawned; sessions stay on disk |

And some are optional but high-value; implement them when your harness can,
because clients surface them:

- `agents()`: the harness's primary agents (opencode's build/plan), for pickers.
- `models()` / `defaultModel()` / `capabilities()`: the model picker and
  image-capability marks.
- `listProjects()`: sessions outside the active workspace, so they're still
  reachable.
- `sessionHold()` / `releaseHold()`: when another process owns a session.
- `providerError()`: name a rate limit/usage cap that never surfaced as an event.
- `skillDirs()`: where the harness loads skills from.
- `subagents()`: the child sessions you filtered out of `listSessions()`.
- `diff()`: files the session changed.

Every optional method is documented on the interface itself. Read it; it's
short and it says *why* each exists.

## The event contract

`events()` is what makes the frontends streaming and live. Emit
`DomainEvent`s (`src/core/types.ts`) as the turn runs:

- `{ type: "server.connected" }` **first**, always; a client blocks on it.
- `message.created` / `message.updated` as a turn's messages appear.
- `part.updated` for a part's shape, then `part.delta` with the text as it
  streams. (`part.delta` carries a `partID`, so stamp `partType` on it from the
  preceding `part.updated`; the Telegram adapter's `#partTypes` map shows why.)
- `session.idle` when the session is quiet again.
- `ask.requested` when the harness needs a person (see below).
- `turn.aborted` when a stop ended the turn; it is not an error, and every
  client used to misread it as one.
- `session.error` for a real failure; `other` for anything you don't model yet.

If your harness is request/response with no stream (like a one-shot CLI), you
can still satisfy this: emit `server.connected`, then `message.created` /
`part.updated` / `session.idle` around the run. The codex adapter does exactly
that.

### Asks (permission prompts, and questions)

When the harness stops and needs a decision, emit **one** shape:

```ts
{ type: "ask.requested", sessionID, ask: { id, title, detail?, options: [{ id, label, style? }] } }
```

and answer it through `respondAsk(sessionID, askID, optionID)`. The option ids
are **the harness's own vocabulary**: carry them through untouched. opencode
answers `once` / `always` / `reject`, and flattening those to yes/no would drop
`always`, the only answer that outlives the call. See
[PROCESSES §10](../docs/PROCESSES.md) for how the Claude adapter bridges its
permission-prompt tool over an MCP server.

## Step by step

### 1. Write the adapter

Create `src/harnesses/<id>.ts`. Export a supervisor-shaped starter that returns
a ready adapter and throws when the harness isn't runnable (the registry's
`available()` relies on this):

```ts
// src/harnesses/my-harness.ts
import type { HarnessAdapter } from "../core/ports.ts"
import type { DomainEvent, Message, SessionSummary } from "../core/types.ts"

export async function startMyHarness(workspace: string): Promise<HarnessAdapter> {
  const proc = await spawnServer(workspace)          // your process, or an HTTP client
  return {
    id: "my-harness",
    workspace,
    endpoint: proc.url,
    async health() { return { healthy: true, version: "0.1.0" } },
    async createSession(title): Promise<SessionSummary> { /* … */ },
    async getSession(id) { /* … */ },
    async listSessions() { /* … */ },
    async prompt(sessionID, text, opts): Promise<Message> { /* run the turn */ },
    async messages(sessionID) { /* … */ },
    async deleteSession(id) { /* … */ },
    async abort(sessionID) { /* … */ },
    async respondAsk(sessionID, askID, optionID) { /* … */ },
    async *events(): AsyncIterable<DomainEvent> { /* server.connected, deltas, idle */ },
    async close() { await proc.kill() },
  }
}
```

`id` is the bare harness id (`"my-harness"`): jep namespaces session ids
itself, so you never prefix them.

### 2. Register it

Add **one row** to `defineHarnesses()` in
[`src/core/harnesses.ts`](../src/core/harnesses.ts):

```ts
{
  id: "my-harness",
  icon: "🟢",
  start: (dir) => startMyHarness(dir),
  available: async () => probeCli("my-harness"),   // cheap: `my-harness --version`
}
```

Two rules the registry enforces at startup:

- **`id` is unique**: it routes sessions.
- **`icon` is unique and single-glyph**, kept to Unicode 6.0 or older
  (`U+1F535–1F53A`). It stands alone on every `/ls` row, so a distinct *shape*
  matters more than a subtle colour, and a newer emoji renders as a missing-glyph
  box on fonts that never shipped it. The code comment in `harnesses.ts` says
  this too; believe it.

### 3. Prove it

The compliance suite boots your adapter against a throwaway workspace, creates a
session, prompts it, reads history back, and prints a per-method matrix, no
test to write:

```sh
npm run probe:harness -- my-harness
```

Aim for every required row `PASS`. `abort` and `respondAsk` report `MANUAL`:
they're correct by construction and proven live when you exercise a real abort
or a tool-gated permission. That's fine for a PR; just say you did it.

Add a unit test for any pure helper you extract (parsers, id mapping, event
translation), the way [`test/codex.test.ts`](../test/codex.test.ts) and
`test/claude.test.ts` do. The adapters themselves are exercised by the suite.

### 4. Open the PR

`npm run check` (typecheck + unit tests) must be green. Then open the PR with
the probe output pasted in. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Gotchas that will cost you an afternoon

- **Type-stripping is not type-checking.** Node runs the `.ts` directly, and
  `--experimental-strip-types` crashes at *runtime* (`ERR_INVALID_TYPESCRIPT_SYNTAX`)
  on inline type literals with `?:` inside a generic call argument, even though
  it passes `--check`. Hoist such shapes to a module-level `interface`/`type`
  and pass the name as the generic; see `ProviderRoot` in `opencode.ts`.
- **`close()` must not orphan a child.** The daemon gets `SIGTERM` on restart and
  relies on every adapter closing its children. A leaked `my-harness serve` per
  restart is the bug that motivated explicit `close()`.
- **Isolated data home, mirrored credentials.** jep runs harnesses against its
  own `XDG_DATA_HOME` (`JEP_DATA_HOME`) so the user's CLI store is untouched. If
  your harness needs the user's credentials to run models, follow
  `syncOpenCodeAuth`'s pattern: **mirror** the credential in, don't point the
  whole data home at the user's.
- **No cross-layer imports.** Your adapter must not import from `clients/`. The
  hexagon is the whole design (see [PHILOSOPHY.md](PHILOSOPHY.md) §1).
- **Keep the turn in flight alive.** Long runs against slow/free models are
  normal, not errors. Don't impose a short wall-clock timeout; liveness is the
  caller's idle watchdog.

## Checklist

- [ ] `src/harnesses/<id>.ts` implements every required method
- [ ] `events()` emits `server.connected` first, then deltas, then `session.idle`
- [ ] asks are surfaced and answered with the harness's own option ids
- [ ] `close()` stops everything you spawned
- [ ] one row added to `defineHarnesses()`, unique `id` and `icon`
- [ ] `npm run probe:harness -- <id>` shows required rows passing
- [ ] `npm run check` green
- [ ] PR links this doc and pastes the probe output

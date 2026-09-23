<div align="center">

<img src="docs/images/jep.png" alt="jep" width="120" />

# jep

**One interface for every coding agent. On whatever device you're on.**

jep is a remote control for **opencode**, **codex** and **claude**, reachable
from **Telegram**, the **Android app**, or any client behind the
[gateway](docs/GATEWAY.md). Your code stays on your machine.

[![](https://img.shields.io/badge/version-0.1.0-3d6aa8)](package.json)
[![](https://img.shields.io/badge/Node-%E2%89%A526-339933)](package.json)
[![](https://img.shields.io/badge/adapters-opencode%20%C2%B7%20codex%20%C2%B7%20claude-26a269)](src/core/harnesses.ts)
[![](https://img.shields.io/badge/clients-Telegram%20%C2%B7%20Android-643891)](docs/GATEWAY.md)
[![](https://img.shields.io/badge/license-mit-576b91)](LICENSE)

<!-- CI badge: paste your GitHub Actions URL once CI exists:
[![CI](https://github.com/<owner>/jep/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/jep/actions/workflows/ci.yml)
-->

</div>

<div align="center">

<img src="docs/images/architecture.png" alt="jep architecture: clients (Telegram, Android, gateway) on the left, a hexagonal core wrapping the HarnessAdapter port in the middle, and harnesses (opencode, Claude Code, Codex) on the right" width="820" />

<sub>Clients on one side, harnesses on the other, the hexagonal core in between.</sub>

</div>

<!--
HERO IMAGE: the single most important asset. A screenshot that captures the
whole promise in ~5 seconds. Drop real captures from a client here:

docs/images/screens-telegram.png   a Telegram chat: a streamed turn with a
                                   native Stop button, a 💭 thinking line,
                                   collapsible tool calls, a markdown table
docs/images/screens-android.png    an Android chat: the same turn, Compose UI,
                                   the pinned conversation + notifications
docs/images/screens-gateway.png    optional: a web dashboard pixel proof

Pick one wide 16:9 crop (≈1280 wide) for the hero, or a 2-up side-by-side of
the Telegram and Android chats. Everything else goes in the client READMEs
(docs/clients/telegram.md, docs/clients/android.md).
-->

---

## Why jep

Every agent ships its own CLI, its own models, and its own way of working away
from a desk: Claude Code has a polished mobile app, opencode and codex meet you
at the terminal. Reaching one from another device means bolting a *specific*
app onto a *specific* harness, duplicated per harness, and you still switch
harnesses to reach a given model.

jep is the shared layer: one harness contract, one set of clients, every agent.
It's a framework too, so a new harness or client drops in without touching the
rest.

- **🧠 One core, every harness.** A single `HarnessAdapter` port normalizes each
  agent: **opencode** as the flagship, full adapters for **Claude Code** and
  **Codex**, so any harness behind the layer is reachable from any device.
- **📱 Clients wherever you are.** A **Telegram bot** with native rich messages
  (tables, collapsible thinking and tool calls, stop buttons, permission
  prompts) and a **Jetpack Compose Android app**. The
  [gateway](docs/GATEWAY.md) makes a web dashboard, Slack bot, or desktop
  widget a client too.
- **⚡ Live from the first word.** Turns stream into an animated draft: a 💭
  thinking line, expandable tool calls, the answer tail updating every ~700 ms.
  Tap **stop** to cut a turn, **steer** to replace it.
- **🎙 Speak your prompt.** Voice notes are transcribed with whisper and land as
  real prompts, with a receipt of what was *heard*.
- **🖥 The repo, from your client.** Read-only git screens (status, log, diff),
  one confirmed **push**, and config-as-data toggles for **MCP servers and
  skills**.
- **💸 Spend you can see.** A usage screen and pinned cost chip report what the
  harness priced each turn: tokens, model, USD. **Free by default** until you
  pick a paid model.
- **🔒 Private by default.** Sessions live in an isolated data home, your CLI's
  store untouched; the daemon serves Tailscale or your LAN. Self-hosted,
  account-free.

---

## Quick start

Two minutes to your first agent reply from wherever you are.

### Requirements

- **Node ≥ 26** (the daemon runs native TypeScript, no build step)
- at least one agent CLI installed: **opencode**, **codex**, or **claude**

### 0. One command, no checkout

```sh
JEP_TG_TOKEN=<from @BotFather> npx --yes github:tinybig-ai/jep
```

Runs the daemon straight from git against the current directory. The clone below
is what you want for the launchd daemon, the Android build, or hacking on jep.

### 1. Install

```sh
git clone https://github.com/tinybig-ai/jep.git && cd jep
npm install
```

### 2. Run the daemon

```sh
# point at a workspace (defaults to the current directory)
export JEP_WORKSPACES="$HOME/your-project"

npm start
```

> On macOS, `sh scripts/install.sh` installs it as a **launchd daemon** that
> survives reboots, crashes and full-disk-access quirks. See
> [docs/PROCESSES.md](docs/PROCESSES.md). For a quick dev loop, `npm start`
> is all you need.

### 3. Pick a client

jep runs as one daemon and reaches you through whatever client you prefer.
Each client has its own setup and command surface:

- **Telegram bot** → [clients/telegram](docs/clients/telegram.md):
  pair it from your chat, then text it. Rich messages, voice notes, git and
  usage screens, and a streaming stop/steer loop.
- **Android app** → [clients/android](docs/clients/android.md):
  Point it at the gateway, pair, and you have conversations, streaming turns,
  and notifications in a native Compose client.
- **Anything else** → the [gateway](docs/GATEWAY.md): a token-authenticated
  HTTP + SSE door that any client (web dashboard, Slack bot, desktop widget)
  can speak to.

Telegram reaches you from anywhere, since the daemon polls out and nothing is
exposed. The **Android app** and every **gateway** client instead talk *to* your
machine, so they need a network path to it: **Tailscale**, another VPN, or the
LAN. The gateway has no TLS of its own, so it rides the network's encryption
(WireGuard), like SSH.

Client setup lives in those READMEs so the top of this file stays the same
whichever client you choose.

---

## How it works

jep is a **hexagonal / ports-and-adapters** system. The core defines one
contract (`HarnessAdapter`, domain events, and message types) and two kinds of
adapter plug into it.

```mermaid
flowchart LR
    subgraph Core["Hexagonal core"]
        PORTS["Ports: HarnessAdapter · DomainEvent · Message · Ask<br/>(src/core/ports.ts, types.ts)"]
        PURE["Pure satellites<br/>git · usage · skills · mcpconfig · transcribe"]
        COMP["Compliance suite<br/>feature-parity gate"]
    end

    subgraph Harnesses["Agent harnesses (driven adapters)"]
        OP["🔵 opencode serve<br/>spawn · SSE · approval"]
        CX["🔺 Codex"]
        CL["🔶 Claude Code<br/>+ MCP ask bridge"]
        YO["🟢 yours → plugins/adapters ⤵"]
    end

    subgraph Frontends["Presentation (driving adapters)"]
        TG["📱 Telegram bot<br/>rich blocks · HTML · streaming"]
        GW["🌐 Gateway (HTTP + SSE)<br/>JEP_GW_PORT"]
        AND["🤖 Android app<br/>Compose, via Gateway"]
    end

    TG --> PORTS
    GW --> PORTS
    AND --> GW
    PORTS --> OP
    PORTS --> CX
    PORTS --> CL
    PORTS -.-> YO
    PURE -.-> PORTS
    COMP -.-> PORTS
```

<!--
The rendered version of this graph lives near the top of the README as
docs/images/architecture.png; the Mermaid diagram below always renders.
-->

### The hexagon in practice

- **The core doesn't know Telegram or opencode.** Frontends see only the port
  type, a `provider/model` string, a `Message`, an `AskRequest`. Harnesses emit
  `DomainEvent`s; the client decides how to present them.
- **Every reply degrades, never fails.** The render pipeline is
  *Rich Message blocks → Telegram HTML (box-drawn tables) → plain text*, and a
  rejected parse retries without markup. A fancy feature breaking looks a little
  worse; it doesn't crash the bot.
- **State is isolated, credentials are shared.** The daemon runs each harness in
  its own `XDG_DATA_HOME` so your CLI's sessions are untouchable, but mirrors
  your `auth.json` in so every model in the picker actually runs.
- **Turn ownership follows the caller.** The session started it is the session
  that owns it. One process, shared ports, no cross-talk.

Rules and rationales live in [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md).

---

## Write your own integration

This is the whole point of the architecture: **the seam is small, provable, and
the same on both sides.**

### Add an agent harness (driven side)

Implement `HarnessAdapter` (`src/core/ports.ts`) for your favorite agent, it
doesn't need to run over HTTP, or even be a server.

```ts
// src/harnesses/my-harness.ts
import type { HarnessAdapter } from "../core/ports.ts"
import type { DomainEvent, Message, SessionSummary } from "../core/types.ts"

export async function startMyHarness(workspace: string): Promise<HarnessAdapter> {
  const proc = spawn(`my-harness serve ${workspace}`)
  return {
    id: "my-harness",
    workspace,
    endpoint: proc.url,
    health: async () => ({ healthy: true, version: "0.1.0" }),
    createSession: async (title): Promise<SessionSummary> => /* … */,
    prompt: async (sessionID, text, { signal, model, filePaths }): Promise<Message> => {
      /* run the actual turn */
    },
    messages: async (sessionID) => /* history */,
    abort: async (sessionID) => /* cancel the in-flight turn */,
    respondAsk: async (sessionID, askID, optionID) => /* answer permission prompts */,
    events: async function* () { yield { type: "server.connected" } /* stream deltas */ },
    close: async () => proc.kill(),
  }
}
```

Register it in the harness registry, **one row, and nothing else**:

```ts
// src/core/harnesses.ts
{ id: "my-harness", icon: "🟢",
  start: (dir) => startMyHarness(dir),
  available: async () => probeCli("my-harness") }
```

Then prove it. jep ships a **compliance suite** (`src/core/compliance.ts`) that
boots your adapter, creates a session, prompts it, reads history back, and
reports a per-method feature-parity matrix, no boilerplate test to write:

```sh
npm run probe:harness -- my-harness
```

Every client is written against the same list, so **full parity for your
harness means every client works, unchanged.**

### Build a new client (driving side)

Telegram and the Android app are just two consumers of the core. The
[gateway](docs/GATEWAY.md) is a thin token-authenticated HTTP + SSE surface over
the *same* ports: sessions, history, prompts, streaming events, asks, usage,
diffs, even a tmux terminal. A web dashboard, a Slack bot, or a desktop widget
is a third consumer behind the same door (`JEP_GW_PORT`), with the full
endpoint reference in [docs/GATEWAY.md](docs/GATEWAY.md).

When a client grows its own surface (commands, screens, flows), document it in
its own README under [docs/clients/](docs/clients/). Adapters can live in this
repo today and in their own repos tomorrow, without touching the core.

---

## Development

```sh
npm install          # dev deps: typescript, @types/node · runtime: undici
npm run check        # tsc typecheck + node --test suite (~1s, no network)
npm run test:e2e     # opt-in: replays fixtures against a REAL harness (~45s)
npm run tg:mock      # replay a Telegram fixture, dump every wire call
```

The rendering pipeline is pure and deterministic (markdown → HTML/rich blocks,
string in, blocks out) so the unit tests pin down escape-ordering, box-table
geometry and streaming safety at every prefix. The full verification ritual and
deploy rules: [docs/PROCESSES.md](docs/PROCESSES.md).

### Repository layout

```
src/
  app/                  entry points (tg.ts composition root, probe, pair)
  core/                 hexagonal core: ports, types, compliance, pure satellites
  harnesses/            harness adapters: opencode · codex · claude
  clients/
    telegram/           the Telegram face: bot · api · renderers · store · pair
    gateway/            HTTP/SSE transport for native clients
  push/                 FCM push for the Android client
  importers/ · terminals/   cross-store session import · tmux shell
android/                the native Android client (Kotlin · Jetpack Compose)
docs/                   PHILOSOPHY · GATEWAY · PROCESSES · clients/
```

## Contributing

jep is new, small, and built on a deliberate seam, so the surest way to help is
to **implement the port for a harness you love**, or to **build a client** on
top of the gateway. Issues and PRs welcome.

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — dev setup, the change loop, house
  rules, review and governance.
- **[docs/ADD_A_HARNESS.md](docs/ADD_A_HARNESS.md)** — the harness-adapter
  on-ramp, start to proven PR.
- **[docs/GATEWAY.md](docs/GATEWAY.md)** — build a client on the same ports.

Before opening a PR, skim [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md), because
"never move on from a broken state" applies to the bot that runs on people's
devices.

## Security

Please don't open a public issue for a vulnerability — see
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

<div align="center">

<sub>One layer. Every harness. Runs on your machine.</sub>

</div>
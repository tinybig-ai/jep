# Contributing to jep

Thanks for being here. jep is a control plane for coding agents: one harness
contract, several clients (Telegram, Android, the gateway). It's early, the
seams are deliberate, and contributions that respect the seams land fast.

This file is the practical guide. The *why* behind the design lives in
[docs/PHILOSOPHY.md](docs/PHILOSOPHY.md); the build/test/deploy ritual lives in
[docs/PROCESSES.md](docs/PROCESSES.md). Skim both before a non-trivial PR.

## Pick an on-ramp

The surest way to help, roughly in order of how self-contained the work is:

1. **Add a harness adapter** — the contribution jep was built for. One file, one
   registry row, a compliance suite that proves it. → **[docs/ADD_A_HARNESS.md](docs/ADD_A_HARNESS.md)**
2. **Build a client** on the gateway (web dashboard, Slack bot, desktop widget).
   The API is documented end to end in [docs/GATEWAY.md](docs/GATEWAY.md), and
   per-client notes live under [docs/clients/](docs/clients/).
3. **Improve a pure module** — the renderers (`html.ts`, `rich.ts`), the git
   views, formatters, search. These are deterministic, string-in/blocks-out, and
   have cheap unit tests. If you like test-driven work, start here.
4. **Docs** — the client READMEs, the harness guide, a worked example. Docs are
   load-bearing here, not an afterthought.
5. **Report a bug or request a feature** — a good issue is a real contribution.
   For a bug, say what you expected, what happened, and how to reproduce.

New to the project and want something scoped? Say so in an issue and we'll find
a bounded first task.

## Set up

Requirements: **Node ≥ 26** (the daemon runs native TypeScript, no build step)
and at least one agent CLI installed (`opencode`, `codex`, or `claude`).

```sh
git clone https://github.com/tinybig-ai/jep.git && cd jep
npm install

# run the daemon against a workspace (defaults to the current directory)
export JEP_WORKSPACES="$HOME/your-project"
npm start
```

On macOS, `sh scripts/install.sh` installs it as a launchd daemon; for a dev
loop `npm start` is all you need. Run the Telegram client in mock mode, or the
Android client against the gateway — see [README](README.md) and
[docs/clients/](docs/clients/).

The daemon is also packaged as a `jep` command (`bin/jep.mjs`), so
`npx --yes github:tinybig-ai/jep` runs it straight from git without a clone.
That launcher only exists to add the Node flag npm's bin shim won't; treat it as
the run entry point, and `npm start` as the dev one.

### The commands you'll live in

```sh
npm run check          # tsc typecheck + node --test, ~1s, no network — the gate
npm run test:e2e       # opt-in: replays fixtures against a REAL harness (~45s)
npm run tg:mock        # replay a Telegram fixture, dump every wire call
npm run probe:harness -- <id>   # run the port compliance suite against a harness
```

`npm run check` is the one that must be green before a PR. Use
`node --experimental-strip-types --check <file>` for a fast syntax-only answer
mid-edit.

## How to make a change

1. **Open an issue first** for anything non-trivial, so we agree on the shape
   before you write code. Small fixes can go straight to a PR.
2. **Branch off `main`**, keep the change to **one concern**. Two unrelated
   changes is two PRs.
3. **Add or update a test.** Pure modules get unit tests
   (`test/*.test.ts`); a new harness goes through `npm run probe:harness`. If
   you can't test it, say why in the PR — that's a conversation, not a dealbreaker.
4. **Make `npm run check` green.**
5. **Open the PR** and paste the evidence (test output, probe matrix, a mock
   dump line, a screenshot for a client change).

### House rules that actually matter

- **Never move on from a broken state.** Partial features are fine; a broken
  `main` is not. (PHILOSOPHY §11.)
- **Mock-first.** The render pipeline is verified by replaying a fixture and
  reading the `CALL …` dump *before* anything touches a live device
  (PHILOSOPHY §8). A prompt in a fixture is really run by a real agent against
  this checkout — keep fixture prompts inert.
- **Escape-first, degrade-never-fail.** A fancy path that breaks should look a
  little worse, not crash. Every reply degrades rich → HTML → plain text.
- **Comments explain _why_.** This codebase documents decisions, not mechanics.
  Match the voice of the file you're editing.
- **No secrets, ever.** Not in code, tests, fixtures, or commit history. If you
  need one, read it from the environment.
- **Respect the hexagon.** No cross-layer imports; the core doesn't know about
  Telegram or opencode (PHILOSOPHY §1).

### Commit messages

Conventional-commit style, imperative subject, lowercase type:

```
feat: harness-owned agents, so a foreign id can't reach the wrong CLI
fix: list opencode sessions across projects, so a split project id can't hide threads
docs: tighten intro and Why jep
refactor: hexagonal layout, shared pairing/transcript/error seams
```

Subject is the "what"; body is the "why" and what the change replaced. Keep it
honest about trade-offs.

## Review

A maintainer reviews every PR and may ask for changes — usually about the seam,
the tests, or the scope. Reviews are about the change, not you. When it's
mergeable, the maintainer merges; contributors don't self-merge.

If a PR goes quiet, a polite nudge on the thread is welcome.

## Governance

jep is currently maintained by its author, who has the final say on design and
merges (**BDFL**). That's a statement of fact while the project is young, not a
promise for forever. Big changes — widening the port, a new top-level concept —
start as an issue so the design is agreed before code exists. Everything smaller
is decided in the PR.

## Release & versioning

- Versions are [semver](https://semver.org). The project is pre-`1.0`
  (`0.1.x`), so a minor bump may carry a breaking change; it will be called out
  in the release notes.
- Releases are cut from `main`. There are no long-lived branches.
- **Known gap:** the Android client is currently built and installed by hand
  (debug APK). Release automation, signing, and a tagged release process are
  open work — a great thing to help with if build/release tooling is your bent.

## Reporting security issues

Do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is covered by the [Contributor Covenant](CODE_OF_CONDUCT.md).
Report unacceptable behavior to **cemre@tinybig.ai**.

## Getting help

Open a GitHub issue (or Discussion, where enabled). Say what you tried, what you
expected, and what happened. We'd rather answer a "dumb" question than have you
guess — and a confused newcomer is the best documentation bug report there is.

# jep — Processes

How this project actually runs, gets tested, and gets shipped to the live bot.
Written so a future session can reorient from scratch.

## 1. What this is

`jep` is a phone-first control plane for coding agents. A Telegram bot (front
end) talks to opencode serve (the agent backend). You text the bot, the bot
turns your words into a prompt on a workspace, the agent does the work, and the
bot renders the reply — markdown, tables, and all — in Telegram.

No git repo. Everything lives in `/Users/user/Documents/code/jep`.

## 2. File map (separation at a glance)

```
src/
  cli.ts                  // TUI harness (probe / scratch builds)
  probe.ts                // quick adapter probes
  tg.ts                   // ENTRYPOINT — dependency wiring, env, mock/live, auth sync
  core/
    ports.ts              // hexagonal seam: HarnessAdapter + ModelRef surface
    types.ts              // Message, DomainEvent, SessionSummary, ApprovalRequest
    compliance.ts         // assertAdapterImplements + compliance suites
    git.ts                // READ-ONLY GIT — porcelain v2 status, numstat, log,
                          // per-file + whole-tree patches (backs /git)
    transcribe.ts         // SPEECH → TEXT — decode (ffmpeg | afconvert) then
                          // whisper; serialized, one model load at a time
  adapters/
    claude-ask-mcp.mjs    // MCP server Claude Code calls instead of a permission
                          // prompt; relays to jep over a unix socket
    opencode.ts           // the one real harness: opencode serve session lifecycle,
                          // prompt/events/models, spawn + health + close
  telegram/
    bot.ts                // ORCHESTRATION ONLY — chat state, commands, callbacks,
                          // streaming placeholder, #recording choke point, pickers
    api.ts                // TELEGRAM WIRE — raw/fallback calls, parse modes,
                          // getUpdates + allowed_updates, TelegramApi interface
    html.ts               // PURE RENDERER — markdown → Telegram HTML (box tables)
    rich.ts               // PURE RENDERER — markdown → Rich Message blocks
    gitview.ts            // PURE RENDERER — GitStatus → the /git screens' markdown
    fmt.ts                // PURE FORMATTERS — durations, counts, ages, paths
    media.ts              // PURE — what is in a message (audio/image/sticker)
                          // and what to name the file it carries
    store.ts              // PERSISTENCE — titles + per-chat model pick, JSON file
    pair.ts               // OWNERSHIP — pairing codes, owner lock, rotation
scripts/
  transcribe.py           // whisper driver: 16k mono WAV in, transcript out
  install.sh              // writes the plist, but proves a launchd job can read
                          // the checkout first (see section 5)
  jep-daemon.sh           // the plist's entry point: same probe at every launch
test/
  *.test.ts               // node --test, no framework. The pure modules get unit
                          // tests; core/git.ts also builds real repos in a temp
                          // dir; e2e.test.ts replays fixtures (opt-in, JEP_E2E=1)
fixture/
  workspace-alpha/        // test working directories for the two harness workspaces
  workspace-beta/
  telegram-mock*.jsonl    // mock update fixtures (pair, settings, callbacks,
                          // internals, git)
```

## 3. Runtime model

- Node v26 native TypeScript, run with `--experimental-strip-types`.
- One harness per workspace. The bot owns a list of workspaces; the first is
  the default. Each workspace gets its own `HarnessAdapter` (a spawned
  `opencode serve` child). Sessions live on disk and survive bot restarts.
- All sessions run inside an **isolated data home** so the bot never touches the
  user's CLI/opencode store. The user's `auth.json` is mirrored there at boot
  so registry models (zen + opencode-go) still run (see `syncOpenCodeAuth` in
  `src/tg.ts:37`).

## 4. Environment variables

| Var | Meaning |
|-----|---------|
| `JEP_TG_TOKEN` | Telegram bot token (live mode) |
| `JEP_DATA_HOME` | data dir (pairing.json, store.json, opencode/). Default: temp dir |
| `JEP_TG_MOCK=1` | mock mode — reads JSON-lines updates from stdin, dumps calls |
| `JEP_WORKSPACES` | `:`-separated workspace dirs (default: `process.cwd()` — mock mode: the two fixtures) |
| `JEP_TG_PAIR_CODE` | fixed pairing code (default: generated) |
| `JEP_TG_OWNER` | seed the owner (default: 000000000 via pairing.json) |
| `JEP_TG_PAIR_MAX/WINDOW/ROTATE` | pairing-attempt limits, window, rotation |
| `JEP_TG_MODELS` | comma-separated extra model labels appended to the picker |
| `OPENCODE_BIN` | path to the opencode CLI (default: `opencode` on PATH) |
| `JEP_WHISPER_DIR` | whisper-local checkout, for voice notes (default: `~/Documents/code/whisper-local`) |
| `JEP_WHISPER_MODEL` | whisper model (default: `medium` — the one already cached there) |
| `JEP_TRANSCRIBE_CMD` | replaces whisper entirely: run with the decoded WAV path appended, stdout is the transcript |
| `JEP_TRANSCRIBE_TIMEOUT` | seconds before a transcription is given up on (default: 300) |
| `JEP_VOICE_MAX_SEC` | longest voice note accepted (default: 600) |

## 5. Commands

Install (or reinstall) it with:

```sh
sh scripts/install.sh          # JEP_TG_TOKEN=… on a first run; re-runs reuse it
```

It writes the plist, loads the job and waits for the boot banner — but only
after proving a launchd job can read this checkout (see the failure mode
below), because that is the one thing that cannot be checked from your own
shell.

The live bot runs under **launchd** (`~/Library/LaunchAgents/com.jep.tg.plist`),
so it survives crashes and the "silent daemon death" failure mode (a transient
Telegram `getUpdates` 502 used to `process.exit(1)` — now the poll loop retries
with backoff, and launchd `KeepAlive` restarts anything that still dies):

```sh
# reload after a code change: SIGKILL it, launchd brings it back with new code
pkill -9 -f 'src/tg.ts'; sleep 5; pgrep -fl 'src/tg.ts'   # expect a running node
```

Manual management (only if you edit the plist):

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.jep.tg.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jep.tg.plist
launchctl list | grep 'com.jep.tg'                        # expect loaded, exit 0
tail -3 ~/Library/Logs/jep-tg.log  # expect "mode: live · owner: 000000000 · paired chats: 1"
```

The plist pins the env (token, `JEP_DATA_HOME=~/.local/share/jep-tg`, `PATH` so
the `opencode` CLI is found) and appends `StandardOutPath`/`StandardErrorPath`
to `~/Library/Logs/jep-tg.log`. The live bot **re-attaches to the existing
pairing** (no re-pair, no new pairing code) because the owner is already
persisted in the data home.

### Failure mode: the relaunch hangs with an empty log

The source lives under `~/Documents`, which macOS protects with TCC. A
launchd-spawned `node` has no Documents grant of its own, so its very first
`open()` — module resolution walking up for `package.json` — blocks forever,
with no prompt (`tccd` logs
`service="kTCCServiceSystemPolicyDocumentsFolder"` against the process). The
symptom is exact: the process is alive, `%CPU` is 0, and **nothing at all is
written to the log**, where a healthy boot banners in about a second.

```sh
sample $(pgrep -f 'src/tg.ts') 3 -mayDie | grep -m1 -B2 'open '   # hung in __open
log show --last 5m --predicate 'process == "tccd"' | grep DocumentsFolder
```

**A grant belongs to one binary.** `/bin/sh` and `/bin/cat` reading the tree
prove nothing about `node`, and on this machine they now disagree: node has
the grant, the shell does not (a `/bin/sh` wrapper with `WorkingDirectory`
inside the tree logs `getcwd: cannot access parent directories`). So both the
installer's preflight and the daemon wrapper probe with the *same node binary*
that will run the bot, and the plist's working directory is the data home, not
the checkout.

The plist runs `scripts/jep-daemon.sh` (copied into the data home, so it stays
readable when the tree is not) rather than node directly. It does that probe
with a watchdog, and on a hang writes the diagnosis to the log and holds for
five minutes so `KeepAlive` cannot spin on it. An install-time failure refuses
to write the plist at all.

Recovery for a bot already stuck — run it from a shell that *does* have the
grant (a terminal the user has already allowed), detached so it outlives the
session, and unload the launchd job first so it stops respawning hung copies:

```sh
launchctl bootout gui/$(id -u)/com.jep.tg; pkill -9 -f 'src/tg.ts'
python3 -c 'import os,plistlib,subprocess
d=plistlib.load(open(os.path.expanduser("~/Library/LaunchAgents/com.jep.tg.plist"),"rb"))
env=dict(os.environ); env.update(d["EnvironmentVariables"])
log=open(os.path.expanduser("~/Library/Logs/jep-tg.log"),"a")
print(subprocess.Popen(d["ProgramArguments"],env=env,stdout=log,stderr=log,
    cwd="/Users/user/Documents/code/jep",start_new_session=True).pid)'
```

That loses `KeepAlive`, so it is a stopgap. The durable fixes are to grant
`/opt/homebrew/bin/node` Full Disk Access (System Settings → Privacy &
Security), or to move the repo out of `~/Documents` — `~/Desktop` and
`~/Downloads` are protected the same way, anywhere else is not.

Mock replay of a fixture:

```sh
JEP_DATA_HOME=/tmp/jep-tg-mock JEP_TG_PAIR_CODE=TESTCODE JEP_TG_MOCK=1 \
  node --experimental-strip-types src/tg.ts < fixture/telegram-mock-settings.jsonl
```

Syntax check any single file:

```sh
node --experimental-strip-types --check src/telegram/rich.ts
```

**Type-stripping gotcha:** `--experimental-strip-types` (amaro) crashes at
*runtime* with `ERR_INVALID_TYPESCRIPT_SYNTAX` on inline type literals that use
`?:` inside a generic call argument (e.g.
`#json<{ all?: Array<{ models?: ... }> }>(...)`). It even passes `--check`.
Keep such shapes as module-level `interface`/`type` aliases and pass the name
as the generic — see `ProviderRoot` in `src/adapters/opencode.ts`.

## 6. The render pipeline

Two routes, one choke point.

1. **Choke point `#recording`** (`src/telegram/bot.ts:98`) — every outbound
   `sendMessage`/`editMessageText` text passes through `mdToHtml()` with
   `parseMode: "HTML"`. This is why menu text, status, help, and errors all
   render markdown correctly with zero per-call code. `sendRichMessage` passes
   through untouched (rich blocks are already structured).
2. **Streaming + finalize** (`#freeText`, `bot.ts`) — on Bot API 9.4+ clients the
   turn opens an animated draft (`sendMessageDraft` with `can_stop: true` and an
   empty text, which renders a native "Thinking…" placeholder plus a stop
   button). Every ~700 ms the latest answer tail is pushed to the same draft.
   Reasoning deltas are **not** appended to the answer: `message.part.delta`
   carries only a `partID` (no type), so the adapter learns each part's type from
   its `message.part.updated` event (the `#partTypes` map in `opencode.ts`) and
   stamps `partType` on the delta. While reasoning streams and Internals thinking
   ≠ off, the draft shows `💭 thinking…` (then the answer tail). On completion the
   draft is replaced by a message built from `reply.parts` **in order** (see
   *Agent internals*): thinking/tool `details` blocks + answer blocks + embedded
   files. Older clients fall back to the legacy "…" placeholder +
   `editMessageText`. The native stop button delivers
   `stopped_message_generation`, aborting the turn.
   - Rich path: `buildRich(parts, internals)` → `sendRichMessage`. Produced files
     (assistant `file` parts) are embedded as `photo`/`document` blocks with
     `attach://f0` multipart uploads (Bot API 10.3), capped at `MAX_RICH_FILES`.
   - Fallback: `partsToMarkdown(parts, internals)` → `clearPlaceholder` (HTML) +
     files as separate `sendPhoto`/`sendDocument` messages.
   - The HTML renderer's fallback (`callWithFallback` in `api.ts`): if Telegram
     rejects the parsed entities, retry the same call **without** `parse_mode`;
     `"message is not modified"` is swallowed silently.

So the degrade chain for any reply is always:
**rich blocks → HTML (box-drawn tables) → plain text.** The user never sees a
400.

### HTML renderer (`html.ts`)
- Escapes everything **first**, then applies markup, so malformed input
  degrades to plain text.
- Supports: `**bold**`, `__underline__`, `~~strike~~`, `_em_`, `\`code\``,
  links, checkboxes (☑/☐), bullets (•), quotes, headings 1–4 as `<b>`,
  fenced code, and tables.
- Tables have no native Telegram form → drawn as a box grid with `─│┌┬┐`
  characters inside a `<pre>`.
- Streaming-safe: inline tags never span markdown line boundaries, so
  mid-stream slices of the placeholder never break markup.

### Rich renderer (`rich.ts`)
Emits genuine Telegram Rich Message blocks: `paragraph`, `heading`
(`size` 1–6, 1 = largest), `pre` (+ `language`), `divider`, `list` (bullets /
ordered `1`,`a`,`A`,`i`,`I` / checkboxes `has_checkbox`+`is_checked`),
`blockquote` (nested blocks), `table` (`cells`, `is_bordered/striped/compact`,
≤ 20 columns), and inline `bold/italic/underline/code/strikethrough/url`
parts. `RichBlock` also carries `buttons` (RichBlockButtons, 10.3), `align`,
and `credit`. Used only in `finalize()`; everything degrades to the HTML render
if the client or API rejects it.

Two more 10.3 shapes are built directly by `bot.ts` (not `rich.ts`):
`expandable_blockquote` (the folded `/log` history) and the `photo`/`document`
file blocks above.

**Menus are rich too.** `bot.ts #menu` renders the settings tree (root, model,
rename) and picker bodies as Rich Messages — `paragraph` lines plus
`RichBlockButtons` rows — so options render natively in Nagram X, with
`style: "success"` on the active model and `disabled: {}` on out-of-bounds
pagination arrows. `editRichMessage` = `editMessageText` + `rich_message`
(10.1+). Every `#menu` call has a classic text + `inline_keyboard` fallback, so
menus work on clients that reject rich messages.

Block shapes were confirmed verbatim from the official Bot API docs dumps at
`~/.local/share/opencode/tool-output/tool_0a2df4a92001bKbjWmUGtbPVSl` (10.3)
and `tool_0a2534d4e001pFWxYwQchV6S7v` (9.x) (do not trust memory for new
shapes — re-check those references).

### Agent internals (thinking + tool calls)
Reasoning and tool calls render as collapsible **`details` blocks**
(`InputRichBlockDetails`, Bot API 10.3: `summary` header always shown, `blocks`
body, `is_open` for default-expanded). They are tap-to-expand natively, so
"collapsed" is still fully readable on demand.

Per-chat policy lives in `store.json` (`InternalsSettings`, via `ChatStore`):
- `thinking` / `tools`: `off` | `collapsed` | `expanded` (defaults `collapsed`).
- `layout`: `per-step` (default) | `per-section` | `combined`.
  - `per-step` — one `details` per opencode step (`splitSteps` on
    `step-start`/`step-finish`), holding that step's reasoning + tool calls;
    answer text follows each step.
  - `per-section` — one `details` per reasoning run and per tool call,
    interleaved with the answer; auto-rolls up to `combined` past `MAX_DETAILS`
    (12) so the message still sends.
  - `combined` — one `💭 Thinking` + one `⚙ Tools` above the answer.
- Tool bodies are `input` + `output` (JSON-stringified), head+tail capped at
  `MAX_TOOL_CHARS` (1500).

UI: `/settings → 🔎 Internals` (rich menu). Three **presets** — Simple
(off/off), Detailed (collapsed/collapsed/per-step, default), Debug
(expanded/expanded/per-section) — set all three at once (active preset shown
green); each row also cycles independently. HTML fallback uses `> ` blockquotes
(not collapsible).


## 7. Model picker

Sources, in priority order (merged, deduped, default always first):

1. Default `localfree-models-proxy/auto` (the free proxy; engine picks) —
   `MODEL_REF` in `src/adapters/opencode.ts`.
2. Config providers + their `models` maps from
   `~/.config/opencode/opencode.json` (`providers.*.models`).
3. Registry models from the **`opencode models` CLI** — provider lines
   `opencode/*` (7 free "zen" models, incl. `opencode/big-pickle`) and
   `opencode-go/*` (27 paid, Go subscription, authenticated in `auth.json`).
   Only `opencode`, `opencode-go`, and config-registered providers are merged.
   15 s timeout, swallowed on failure, 60 s cache.

A per-chat pick (`mdl:...`) is persisted in `store.json`; the next message in
that chat runs on it. Clear back to engine-picked with `mdl:off`. The pick is
passed to `prompt()` as `{ providerID, modelID }` — never pinned globally.

Vision capability: `GET /provider` reports every model's
`capabilities.{ attachment, input.image }`; the picker marks accepted-image
models with `🖼` (legend in the body) via `adapter.capabilities()`. The same
map drives the one-time suggestion (`#suggestImageModel`) that appears when a
photo/document lands on a model that can't read it — it offers up to 3
vision-capable models as direct `mdl:` buttons plus "All models ›".

**Live constraint:** the bot's isolated opencode only runs auth'd models if
`auth.json` is mirrored in (done automatically at boot). Verify after restart:
`/tmp/jep-tg-data/opencode/auth.json` exists and matches the user's real
`~/.local/share/opencode/auth.json` (keys: `['opencode-go']`).

## 8. Ownership / pairing

- New bots print a pairing code; `/pair <code>` claims the bot and locks it to
  that chat id. The owner is persisted to `pairing.json`, so restarts keep
  ownership (live: owner 000000000, no re-pair).
- Pairing has attempt limits and code rotation (env-tunable).
- Commands and even plain free text are ignored for non-owner chats.

## 9. Media flow (both directions)

The bot's one message pipeline is text-first, but attachments pass through the
same hexagonal port:

- **In — user sends a photo/document**: `#gatedMessage` detects `photo` /
  `document`, downloads bytes via `getFileContent` (Telegram `getFile` +
  binary fetch), writes them to `<data home>/uploads/upl-*`, and hands the
  absolute path to `adapter.prompt(..., { filePaths })`. The opencode adapter
  converts each path to a `FilePartInput`-shaped part:
  `{ type: "file", mime, url: fileURL(path) }`. The schema **rejects
  `file_path`** — extra keys 400. Output parts carry a `file://` `url`, not a
  path, so `mapPart` maps `url` → path via `fileURLToPath`.
- **Out — the agent produces a file**: assistant `file` parts prefer to ride
  **inside** the text reply as rich `photo`/`document` blocks with
  `attach://f<n>` multipart uploads (Bot API 10.3, up to 4). If that isn't
  supported, each file goes as its own message — image extensions through
  `sendPhoto`, everything else `sendDocument` (multipart `FormData` upload).
  A media-only reply skips the text placeholder and deletes it after sending.
- The default model is text-only: it receives the image file but declares it
  cannot read it. When that happens the bot offers the vision-capable models
  right away (`#suggestImageModel`, once per current model) — or switch
  manually in /settings, where `🖼` marks models that accept images.

## 10. Asks (permission prompts, and questions)

When a harness stops and needs a person — a tool waiting on permission, a
question the model asked outright — it emits **one** event shape, whatever the
harness is:

```ts
{ type: "ask.requested", sessionID, ask: { id, title, detail?, options: [{ id, label, style? }] } }
```

and is answered with `adapter.respondAsk(sessionID, askID, optionID)`. The
option ids are the *harness's own vocabulary*, carried through untouched:
opencode answers `once` / `always` / `reject`, and `always` writes a standing
rule, so flattening the three into a boolean would drop the only answer that
outlives the call.

`bot.ts #askPrompt` renders it: title, the command or path fenced underneath,
one button per option (green for the safe one, red for the destructive one),
ephemeral in groups so the prompt is scoped to whoever is being asked. The
pending ask remembers **which adapter** it came from — an ask can arrive from a
workspace the chat is no longer looking at — and is dropped from the map before
the round trip, so a second tap cannot answer twice.

| Harness | Channel |
|---------|---------|
| opencode | `permission.updated` over SSE → `POST /session/:id/permissions/:permID` with `{response}` |
| claude | `--permission-prompt-tool` → an MCP tool jep hosts (below) |
| codex | none — `codex exec` decides with a sandbox policy; approvals live in the TUI and the app-server protocol, which this adapter doesn't speak |

### The claude channel

`claude -p` has nobody to ask, so anything gated is simply refused and the turn
comes back having quietly not done the thing. `--permission-prompt-tool <tool>`
replaces the prompt with a tool call, and whatever that tool answers is the
decision. jep supplies it:

- `src/adapters/claude-ask-mcp.mjs` — a stdio MCP server Claude Code spawns
  itself (hence a file, and plain `.mjs`: it runs under Claude Code's node and
  must not need type-stripping). It relays the question to jep over a unix
  socket handed to it in `JEP_ASK_SOCKET`, with the jep session id in
  `JEP_ASK_SESSION`, and **fails closed** — a missing socket, a broken channel
  or 15 minutes of silence all come back as `deny`.
- The adapter opens that socket lazily (one per adapter, in a temp dir), turns
  each line into an `ask.requested`, and parks the turn until `respondAsk`
  writes the decision back. `close()` denies everything still parked rather
  than leaving turns waiting on a server that has stopped.

**Argument order matters.** `--mcp-config` is variadic ("JSON files or
strings", space-separated), so it swallows anything after it — including the
positional prompt, which then reads as a missing config file and kills the run
before it starts. The prompt goes first; the ask flags go last.

The flag is checked once against `claude --help`: a build without it would
reject the whole command line and take every turn with it.

## 10. The turn queue (`/queue`, `/steer`)

Turns within a chat run strictly in order — they share a harness session, so
overlapping them would interleave two prompts in one conversation. That queue
used to exist only as a promise chain, which meant nothing could *look* at it:
a queued message got a 👀 reaction saying "received" and nothing more.

`ChatState.queue` is now the same queue as data, `queue[0]` being the turn in
flight. `#runTurn` records an item (id, the prompt as its label, when it was
queued) and removes it in a `finally`.

- `/queue` — one screen, redrawn in place: what is running and for how long,
  what is waiting and in what order, an `✕` per waiting item, `🧹 Clear
  waiting` and `⏹ Stop`.
- The pinned status line carries `⏳<n>` whenever anything is waiting. That is
  the always-visible half: the pin is the one place a phone can hold ambient
  state, and "two things are behind this" changes what you do next.
- `/steer <text>` — stops the running turn and sends that text **ahead of**
  anything queued. No harness will take a second prompt into a running turn
  (opencode reports the session held; codex and claude answer one prompt per
  process), so this is the honest version of dropping a note into a turn:
  what Esc-then-type does in a terminal. The conversation is kept; only that
  one run ends.

Two things that are easy to get wrong, and were:

- **Dropping must both flag and remove.** The flag (`cancelled`) is what makes
  the chained runner skip the turn — unpicking a promise chain mid-flight is
  how you lose the turns behind it — but the removal is what the user actually
  asked for. With the flag alone, a dropped turn sat in the list looking
  queued.
- **Waiting is not running.** `🧹 Clear waiting` never touches `queue[0]`, and
  an `✕` on the running turn answers "that one is already running". Ending a
  turn in flight is `⏹ Stop`, which is a different decision with a different
  cost.

Items are addressed by id, never by position: the list shifts under you the
moment the running turn finishes.

## 10b. Voice notes

A voice note is a prompt you spoke, so it lands exactly where a typed one
does. What is different is the waiting, and everything below follows from it.

The chain: download → sniff the container → decode to 16 kHz mono WAV →
whisper → post what was heard → run it as a prompt.

- **It runs detached from the update loop** (`#detach`). Whisper takes about
  eight seconds even for a two-second note, almost all of it loading the
  1.5 GB medium model; awaiting that inside `handleUpdate` would stop the bot
  reading updates for the duration. `drain()` waits for detached work, which
  is also what makes a fixture replay deterministic instead of a race against
  the dump.
- **And outside the turn queue.** Transcribing needs nothing from the agent,
  so a note sent into a working agent is transcribed immediately and only the
  resulting prompt queues (with the same 👀 as a typed message).
- **Transcriptions are serialized** inside `core/transcribe.ts`: the model is
  1.5 GB resident, and the natural way to correct a voice note is to send
  another one straight after it.
- **The decode is a separate step, on purpose.** whisper's own loader shells
  out to ffmpeg, so on a machine without ffmpeg it can read nothing at all —
  and there is no ffmpeg on this one. macOS's `afconvert` reads the Ogg
  container and the Opus codec natively (`afconvert --help-formats` lists
  `'Oggf' = Ogg (.opus, .ogg, .oga)` with data format `opus`), so
  `scripts/transcribe.py` takes an already-decoded WAV and hands whisper the
  samples directly.
- **The extension is sniffed from the bytes**, because the decoder picks its
  parser from the file *name*: a CAF named `.oga` is refused, not sniffed.
- **The receipt is what was *heard*.** A misheard prompt is then visible
  instead of mysterious, and the turn it started can be stopped from its own
  draft. A transcript is never treated as a command, even if it begins with a
  slash — a spoken prompt is a prompt.
- **Every failure says something.** The bug this replaced was silence: a voice
  note produced no reply, no error and no log line, which on a phone is
  indistinguishable from a message that never sent. Too long says the limit
  and the variable that changes it; a missing decoder or venv says what to
  install or set.

`JEP_TRANSCRIBE_CMD` swaps the engine out (it gets the WAV path appended and
its stdout is the transcript), which is how the e2e test asserts jep's
handling without depending on what whisper heard.

## 10c. The git view (`/git`)

Workspace-scoped, read-only, and **not** the same thing as `/diff`: `/diff`
asks the harness what *it* touched this session, `/git` reads the repo, so it
also sees your own edits, what is already staged, and where the branch stands
against its upstream. `src/core/git.ts` holds every git call (porcelain v2,
`--numstat -z`, `log`, `diff`); `bot.ts` only renders.

Three screens, one message, redrawn in place (`#gitDraw` — rich blocks, classic
text + inline keyboard as the fallback, same degradation as `#menu`):

| Screen | Shows | Buttons |
|--------|-------|---------|
| status | branch · upstream ±, N changed +/−, a table of up to 12 files, latest 5 commits in a `details` block | one per changed file (up to 6), ⌗ Full diff, 📜 Log, ⟳ |
| log | 15 commits per page, `hash · age · subject` in a `pre` block | ‹ Newer, Older ›, ‹ Status |
| diff | one file's patch or the whole tree, 2400 chars per page, `pre` with `language: "diff"` | ⋯ More, 📎 As file, ‹ Status |

Load-bearing details, each one a bug that was there first:

- **Everything pages, nothing grows.** A "see more" that appends walks one
  message into the wire limit, and a message Telegram rejects shows *nothing*.
  Log pages via `git log --skip`, diffs via a character offset cut on a line
  boundary. Every screen measured under 3 KB.
- **The repo root, not the workspace.** Porcelain paths are relative to the
  root, so `repoStatus` resolves it first and the snapshot is anchored there —
  a workspace one level down would otherwise name files it can't find.
- **Files are addressed by index** into the snapshot behind `c.git`, because
  `callback_data` caps at 64 bytes (same reason as the conversation pickers).
  Every view redraws the message whose button was tapped, not `c.git.messageID`,
  so an older `/git` further up the chat still behaves like a screen.
- **Untracked files are counted, not staged.** `git add -N` would make them
  diffable and is exactly the quiet mutation a status command must not do, so
  new files get their line count read off disk (2 MB cap, NUL sniff for binary)
  and their patch from `diff --no-index` — which exits 1 precisely when it has
  output, so `ok` is not the test there.
- **`--numstat -z`**, because a rename otherwise prints as `old => new`, matches
  no status path, and silently drops the edit that came with the rename.
- **No commits yet is not an error**: an unborn HEAD compares against the index
  instead, and `log` returning nothing is a normal answer.

Writing (commit / branch / push) is deliberately absent: it should be an
explicit action, not a side effect of looking. That is the next thing to build.

## 11. Verification ritual

0. `npm install` once (the only dependencies are typescript and @types/node,
   both dev-only — nothing the daemon runs at runtime has a dependency).
1. `npm run check` — `tsc` then `node --test "test/*.test.ts"`. Roughly a
   second, no network, no harness. **`--experimental-strip-types` strips
   annotations without checking them and `node --check` sees only syntax, so
   this is the only thing that reads the types at all.** Use
   `node --experimental-strip-types --check <file>` for a fast syntax-only
   answer mid-edit.
2. Mock end-to-end through a fixture (pair → act → assert the `CALL ...` dump).
   `npm run test:e2e` does it as assertions (opt-in: it boots a real harness
   per workspace, ~45s). By hand when you want to *read* the dump:
   `JEP_DUMP_CHARS=20000` when a rich payload is longer than the 2000-char
   cap — the git views are, and their buttons sit at the end.
   The mock reads JSON-lines updates from stdin and prints
   `CALL <method> chat=<id> msg=<id> mode=<HTML> [rich=<json>] text="..."`
   plus one indented `keyboard: ...` line per callback reply.

   **A prompt in a fixture is really run, by a real agent, with the jep
   checkout in its context.** Keep fixture prompts inert ("Reply with the
   single word: yes"). A replay driven with a working prompt once left a new
   TUI command and a broken test file behind in this repo — the mock is only
   mock on the *Telegram* side.
3. Live restart (section 5) + `tail` the log + a real Telegram check by the
   user. After the user confirms, the feature is "shipped".

What the tests actually cover — the pure modules, which is where the
determinism is (PHILOSOPHY §7), plus the git grammars:

| File | What it pins down |
|------|-------------------|
| `html.test.ts` | escape-before-markup, no inline tag spans a line, every stream prefix renders, box tables line up |
| `rich.test.ts` | block shapes, the 20-column table bail-out, and the streaming-table invariant at every prefix |
| `gitview.test.ts` | every tracking state, the row cap, and that paging a patch reproduces it exactly |
| `git.test.ts` | porcelain v2 + `numstat -z` by hand, then real repos in a temp dir (unborn HEAD, rename+edit, subdirectory reads) |
| `fmt.test.ts` | durations, counts, ages, `~` folding |
| `media.test.ts` | every audio shape Telegram sends, and the container/image signatures |

`e2e.test.ts` covers the four screens end to end: /git's three views, a voice
note, the queue, and a plain paired conversation.

Three bugs fell out of writing them, all of them live before that:

- markup leaked into code spans — `` `__init__.py` `` rendered with an
  underlined `init`, and `` `a ** b` `` bolded inside the span.
- a link's href was escaped twice, so one `&` in a URL became `&amp;amp;`.
- box tables padded on the *string* length, so a cell containing markup or an
  escaped `&` bent the right-hand border. Columns are now measured on what the
  reader sees.
- (and a fourth, narrower: a single-column table kept its `|---|` separator as
  a data row, because the separator filter required two columns.)

Never move on from a broken state: partial features are fine, broken live bot
is not.

## 12. Client truth

- The user's Telegram client is **Nagram X** (its rendering drove the rich
  message work: plain `<pre>`/HTML tables looked bad, native Rich Blocks look
  right).
- The model cannot read images — user feedback arrives as text.
- The `e2e` checks above, and any numeric/behaviour tweak, were driven by this
  client; re-verify against it when rendering changes.

## 13. Bot API 10.2/10.3 features in use

| Feature | Where | Notes |
|---------|-------|-------|
| Rich menus (`RichBlockButtons`) | `#menu` | settings tree; `style`/`disabled`; classic fallback |
| `disabled` buttons | `#settingsModel`/`#settingsRename`/`#wipePick` | pagination arrows are inert at the bounds |
| `expandable_blockquote` | `/log` | history folded until tapped; plain-text fallback |
| `RichBlockDocument`/`photo` + `attach://` | `present()` | agent files embedded in the reply (multipart) |
| `is_compact` tables | `rich.ts` | compact rich tables |
| `details` + `pre language="diff"` | `/git` | commits fold away; patches syntax-highlight |
| Ephemeral messages | `#permissionPrompt` | group permission prompts scoped to the sender (`ephemeral_message_parameters.receiver_user_id`); cleaned up with `deleteEphemeralMessage`; plain fallback |
| `force_reply` | pair-code + bare `/use` prompts | reply bar forced on the user |
| `can_stop` + `stopped_message_generation` | `#freeText` | native stop button on streaming drafts |
| `details` blocks (thinking/tools) | `buildRich` | collapsible per-part; per-step/per-section/combined; auto-rollup |
| Internals toggles | `/settings → 🔎 Internals` | presets Simple/Detailed/Debug + cyclers, per-chat in `store.json` |

`/remind <5s–7d> <what>` schedules a silent (`disable_notification`) nudge via
an **in-process** `setTimeout` (`timer.unref()` so it never keeps the process
alive). They do survive a restart: `ReminderStore` persists them to
`reminders.json` and the constructor re-schedules every one at boot, so one
that came due while the bot was down fires immediately (the delay clamps to
0). Bot API `schedule_date` is not used (unsupported in private chats).

**Deploy:** after these changes, reload the daemon (section 5) — `pkill -9 -f
'src/tg.ts'` — and confirm from the log that it returns in live mode.
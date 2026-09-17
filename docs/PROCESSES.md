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
  adapters/
    opencode.ts           // the one real harness: opencode serve session lifecycle,
                          // prompt/events/models, spawn + health + close
  telegram/
    bot.ts                // ORCHESTRATION ONLY — chat state, commands, callbacks,
                          // streaming placeholder, #recording choke point, pickers
    api.ts                // TELEGRAM WIRE — raw/fallback calls, parse modes,
                          // getUpdates + allowed_updates, TelegramApi interface
    html.ts               // PURE RENDERER — markdown → Telegram HTML (box tables)
    rich.ts               // PURE RENDERER — markdown → Rich Message blocks
    store.ts              // PERSISTENCE — titles + per-chat model pick, JSON file
    pair.ts               // OWNERSHIP — pairing codes, owner lock, rotation
fixture/
  workspace-alpha/        // test working directories for the two harness workspaces
  workspace-beta/
  telegram-mock*.jsonl    // mock update fixtures (pair, settings, callbacks, internals)
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

## 10. Verification ritual

1. `node --experimental-strip-types --check <file>` on every edited file.
2. Mock end-to-end through a fixture (pair → act → assert the `CALL ...` dump).
   The mock reads JSON-lines updates from stdin and prints
   `CALL <method> chat=<id> msg=<id> mode=<HTML> [rich=<json>] text="..."`
   plus one indented `keyboard: ...` line per callback reply.
3. Live restart (section 5) + `tail` the log + a real Telegram check by the
   user. After the user confirms, the feature is "shipped".

Never move on from a broken state: partial features are fine, broken live bot
is not.

## 11. Client truth

- The user's Telegram client is **Nagram X** (its rendering drove the rich
  message work: plain `<pre>`/HTML tables looked bad, native Rich Blocks look
  right).
- The model cannot read images — user feedback arrives as text.
- The `e2e` checks above, and any numeric/behaviour tweak, were driven by this
  client; re-verify against it when rendering changes.

## 12. Bot API 10.2/10.3 features in use

| Feature | Where | Notes |
|---------|-------|-------|
| Rich menus (`RichBlockButtons`) | `#menu` | settings tree; `style`/`disabled`; classic fallback |
| `disabled` buttons | `#settingsModel`/`#settingsRename`/`#wipePick` | pagination arrows are inert at the bounds |
| `expandable_blockquote` | `/log` | history folded until tapped; plain-text fallback |
| `RichBlockDocument`/`photo` + `attach://` | `present()` | agent files embedded in the reply (multipart) |
| `is_compact` tables | `rich.ts` | compact rich tables |
| Ephemeral messages | `#permissionPrompt` | group permission prompts scoped to the sender (`ephemeral_message_parameters.receiver_user_id`); cleaned up with `deleteEphemeralMessage`; plain fallback |
| `force_reply` | pair-code + bare `/use` prompts | reply bar forced on the user |
| `can_stop` + `stopped_message_generation` | `#freeText` | native stop button on streaming drafts |
| `details` blocks (thinking/tools) | `buildRich` | collapsible per-part; per-step/per-section/combined; auto-rollup |
| Internals toggles | `/settings → 🔎 Internals` | presets Simple/Detailed/Debug + cyclers, per-chat in `store.json` |

`/remind <5s–7d> <what>` schedules a silent (`disable_notification`) nudge via
an **in-process** `setTimeout` (`timer.unref()` so it never keeps the process
alive). Reminders are not persisted: a daemon restart drops them. Bot API
`schedule_date` is not used (unsupported in private chats).

**Deploy:** after these changes, reload the daemon (section 5) — `pkill -9 -f
'src/tg.ts'` — and confirm from the log that it returns in live mode.
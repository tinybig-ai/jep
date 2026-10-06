# Gateway: native-client transport

The gateway is jep's second presentation adapter (the first is Telegram). It
lets a native client speak to the same core the Telegram bot speaks to: same
`HarnessAdapter` port, same `opencode serve` children, same process. It is
OPTIONAL. jep-tg boots and runs without it.

## Shape

One process hosts both adapters (`src/app/tg.ts` composition root). The gateway is
`src/clients/gateway/index.ts: startGateway(deps)`, enabled when `JEP_GW_PORT` is set, bound
on 0.0.0.0 so a phone reaches it over Tailscale or the LAN (`JEP_GW_BIND` narrows
it to one interface, e.g. your Tailscale IP or `127.0.0.1`). No TLS: the
transport rides inside the network's own encryption (WireGuard), like SSH.

Tokens live in `<DATA_HOME>/gateway-tokens.json`; the pairing code prints once
at boot and is readable any time with `npm run pair` (env `JEP_GW_PAIR_CODE`
pins it). `npm run unpair` forgets every paired device at once; the running
gateway refuses their tokens from the next request. Every endpoint except `/health` and `/pair` wants
`Authorization: Bearer <token>` (also accepted as `?token=` on the stream, for
plain clients).

## Commands (JSON POSTs)

| route | body | returns |
|---|---|---|
| `POST /pair` | `{code}` | `{token}` (5 tries / 60 s) |
| `GET /health` | (none) | `{ok,paired}` |
| `POST /sessions` | (none) | `{items[]}` all sessions, every adapter merged, client renames applied; each carries `adapter` (workspace name), `harness` (engine id) and `pod` (its workspace is a daemon-conjured throwaway dir) for display |
| `POST /workspaces` | (none) | `{items[]}` of `{name,harness,dir,pod}`: what a conversation may be created in, for creation-time selection; `pod` marks a daemon-conjured throwaway directory |
| `POST /harnesses` | (none) | `{harnesses[],default}`: the harnesses installed here |
| `POST /browse` | `{path?}` | `{cwd,root,parent,dirs[]}`: folders under `cwd` (`{name,git}`), bounded to `JEP_BROWSE_ROOT` (default `$HOME`); `parent` is null at the root |
| `POST /new` | `{title?,workspace?,path?,harness?,harnessSettings?,pod?}` | `{session}`: created in a named workspace, at an absolute `path` (spawning that workspace under `harness` if it isn't served yet), and/or under a harness; with none, the first served workspace. `pod: true` asks for a throwaway directory instead — the daemon conjures one under `<DATA_HOME>/pods/` and serves it under `harness`, so a quick conversation needs no folder of its own. `harnessSettings` (`{key: bool}`) must name settings the harness declares, or 400. The returned session carries `adapter`+`harness`+`pod` |
| `POST /mkdir` | `{path?,name}` | `{ok,path}`: create a folder inside the browse root (409 if it exists), so a conversation can start in a new one |
| `POST /harness-settings` | `{id}` or `{harness}` | `{options[],values,compact?}`: the boolean settings a harness declares (`{id,label,description,default,danger?}`) and, by session, that conversation's values (by harness, the defaults) plus `compact`, whether its harness can compact (so a client offers the control only where it works) |
| `POST /set-harness-setting` | `{id,key,enabled}` | `{ok,values}`: flip one declared setting for this conversation; persisted in `<DATA_HOME>/gateway-harness-settings.json` and handed to every prompt |
| `POST /history` | `{id,limit?,before?,etag?}` | `{messages[],hasMore,asks[]}`: the newest `limit` messages (or, when `before` is a time, the newest `limit` older than it); `hasMore` says older pages exist; `asks` is every ask the conversation raised (the `ask.requested` shape plus `state`: `pending`/`answered`/`closed`, and `answer`, the option picked). Every answer carries an `etag`; send it back as `etag` and an unchanged window answers `{unchanged:true,etag}` instead |
| `POST /prompt` | `{id,text,files?,clientID?,steer?,force?}` | resolves when *this* prompt's turn ends: `{message}`, `{aborted:true}`, `{cancelled:true}`, or an error. `files` are `attach` ids sent to the harness as `filePaths`; runs on the session's model and agent if set. A prompt into a busy session is queued, never refused: by default it steers in at the next tool boundary (`steer:false` waits for the turn to end), and `force:true` aborts the running turn and runs it next. `clientID` is the handle `/queue/*` acts on. A turn has no absolute deadline — see [Turn liveness](#turn-liveness) |
| `POST /queue/cancel` | `{id,clientID}` | `{ok}`: drop a prompt still waiting (its `/prompt` resolves `{cancelled:true}`); 404 not queued, 409 already running |
| `POST /queue/edit` | `{id,clientID,text}` | `{ok}`: change a waiting prompt's words |
| `POST /queue/force` | `{id,clientID}` | `{ok}`: run a waiting prompt now, aborting the running turn |
| `POST /respond` | `{askID,optionID}` | `{ok}` or 409 already answered. Keyed by the ask alone (no `id` needed) |
| `POST /reject` | `{askID,id?}` | `{ok}`: stand an ask down without choosing (the person answered in their own words), so the turn can finish |
| `POST /stop` | `{id}` | `{stopped}` |
| `POST /models` | `{id}` | `{models[],current,default,contextLimit}`: the models this conversation's harness can run on, each with `image`/`attachment`/`contextLimit`; `current` is the set one (null = harness default); `default` is what "default" resolves to; `contextLimit` is the window of the model the conversation actually runs on (0 when unknown) |
| `POST /setmodel` | `{id,model?}` | `{ok,model}`: set (`"provider/model"`) or clear (omit) this conversation's model; persisted in `<DATA_HOME>/gateway-models.json`, applied to the next `/prompt` |
| `POST /agents` | `{id}` | `{agents[],current,default}`: the primary agents this conversation's harness offers (`{id,label,detail,default?}`), the current choice, and the harness default; the adapter owns the ids, so the client renders whatever it declares |
| `POST /agent` | `{id}` | `{current}`: the primary agent set for this conversation (null = harness default) |
| `POST /setagent` | `{id,agent?}` | `{ok,agent}`: set or clear this conversation's primary agent; a harness that names its agents refuses one it doesn't offer (400 `unknown agent`), one that names none accepts the id and ignores it. Persisted in `<DATA_HOME>/gateway-agents.json`, applied to the next `/prompt` |
| `POST /usage` | `{id}` | `{usage}`: tokens (in/out/thinking/cache) and reported cost summed over the conversation, plus turns and models (`core/usage.ts`) |
| `POST /diff` | `{id}` | `{files[]}`: files this conversation changed (`{file,additions,deletions,status?}`) |
| `POST /git` | `{id}` | `{isRepository,branch,head,changedFiles,commits[]}`: the conversation's workspace repo, read through `core/git.ts` like Telegram's /git: branch, changed files (untracked included), last 30 commits (`{hash,shortHash,subject,author,time}`, hash is the short one, time in seconds). The client supplies no command and no path |
| `POST /compact` | `{id}` | `{ok}`: compress the conversation's context (opencode's summarize, Claude Code's `/compact`). 501 when the harness has no such control, 409 when it refused (a turn in flight), 504 when the summarize ran out of time |
| `POST /subagents` | `{id}` | `{items[]}`: the subagent sessions this conversation spawned |
| `POST /read` | `{id,path}` | `{path,text}`: a file the transcript linked to, as text; relative paths resolve in the conversation's workspace; only under served roots (403), at most `READ_MAX` (413) |
| `GET /file` | `?p=<base64url path>` | the file's bytes, for inline images; only uploaded files (`attachments/`, `uploads/`) or a served workspace, symlinks resolved (403) |
| `POST /term` | (none) | `{authorized}`: whether *this* device token may open a shell (see below) |
| `POST /term/unlock` | `{code}` | `{ok}` or 403: prove the pairing code a second time to allow a terminal from this device |
| `POST /term/lock` | (none) | `{ok}`: drop that grant |
| `POST /term/open` | `{id}` | `{ok,name}`: start (or reattach) the conversation's tmux shell in its workspace |
| `POST /term/frame` | `{id}` | `{text}`: the shell's screen as rendered text |
| `POST /term/input` | `{id,text?,key?}` | `{ok}`: type `text`, or press a named `key` (Enter/Tab/C-c/…) |
| `POST /term/close` | `{id}` | `{ok}`: kill the shell |
| `POST /skills` | `{id}` | `{skills[],toggleable}`: the SKILL.md dirs this harness loads (`{name,description,scope,path,disableModelInvocation}`) |
| `POST /setskill` | `{id,path,disabled}` | `{ok}`: hide (or allow) a skill for the model; flips `disable-model-invocation` in its frontmatter |
| `POST /mcp` | `{id}` | `{servers[]}`: the MCP servers this harness will start (`{name,kind,enabled,detail}`), read from its config |
| `POST /setmcp` | `{id,name,enabled}` | `{ok}`: enable/disable an MCP server in the harness's own config |
| `POST /rename` | `{id,title}` | `{ok}`: a client-side title override (Telegram-style chat rename), persisted in `<DATA_HOME>/gateway-titles.json`, overlaid on `/sessions` |
| `POST /importable` | (none) | `{sessions[]}`: sessions in the *user's own* opencode store (in a folder jep serves) that jep doesn't have, offered for import |
| `POST /import` | `{id}` | `{ok,id,output}`: fork one in via `opencode export` from the user's store, then `opencode import` into jep's. A copy; the original is untouched |
| `POST /seen` | `{id,at?}` | `{ok,seenAt}`: the conversation was looked at (`at` defaults to now; the later time is kept); `at: 0` marks it unread. Persisted in `<DATA_HOME>/gateway-seen.json`, and every `/sessions` item carries `seenAt` |
| `POST /archive` | `{id}` | `{ok,archived}`: hide a conversation from `/sessions` without deleting it; persisted in `<DATA_HOME>/gateway-archived.json` |
| `POST /unarchive` | `{id}` | `{ok,archived}`: put it back |
| `POST /archived` | (none) | `{items[]}`: the archived conversations, same shape as `/sessions` |
| `POST /delete` | `{id}` | `{ok}`: removes the session from the harness |
| `POST /attach` | raw octets, `?id=<session>&name=<name>` | `{id,name}`: buffers up to 32 MB under `<DATA_HOME>/attachments`; the id feeds the next `/prompt`'s `files` |
| `POST /push/register` | `{token}` | `{ok,devices}`: remember this device's push token: an FCM token, or `apns:<hex>` from iOS (503 without push configured) |
| `POST /push/unregister` | `{token}` | `{ok,devices}`: forget it |
| `POST /restart` | `{quiet?,maxWait?}` | `{ok,quietMs,maxWaitMs}`: arm a restart; the daemon exits once no turn has been active for `quiet` s (default 5), or at `maxWait` s (default 180), and launchd brings it back |
| `GET /stream` | (none) | SSE, never ends |

Errors are a bare `{error}` with a fitting status. A second prompt into a
running session is queued (see `/prompt`), not refused.

## Turn liveness

A `/prompt` turn runs with **no absolute deadline** (`timeoutMs: 0`): a real
agent turn can legitimately work for half an hour, and any fixed ceiling
eventually cuts one off mid-task. Liveness is owned by inactivity instead, and
four things can end a turn the harness stopped talking about:

| what | the client sees |
| --- | --- |
| a provider failure the harness logged but never emitted as an event (a 429, a usage cap) | `502 {error}`, the failure named with its provider/model |
| the harness's own `session.error` | `502 {error}`, the harness's words |
| `session.idle` while the blocking POST hangs | `200 {message}` — the turn *finished*; the answer is read back off the transcript |
| nothing at all for a whole ceiling | `504 {error}` naming how long it was silent, and the tool if one was running |

The ceilings: `JEP_TURN_IDLE_MS` (default 5m) for a turn awaiting tokens, and
`JEP_TOOL_IDLE_MS` (default 20m) while the harness reports a running tool,
because a build or a test run is legitimately silent for minutes. A tool that
has run for `JEP_TOOL_WILDERNESS_MS` (default 6m) with no event at all is
wedged, and the turn is given up on then, naming it. The rule lives in
`core/liveness.ts`, which the Telegram client uses too, so the two give up at
the same moment. A turn parked on an unanswered permission ask is *not* stalled — it is
waiting on a human — and no ceiling applies until the ask is answered or stood
down.

Every event on a session pushes its deadline out, so only a genuinely silent
turn is ever abandoned.

## Stream (SSE, GET /stream)

`data: {event}` frames, one per DomainEvent, every adapter's feed merged and
forwarded as-is:

- `message.created` / `message.updated`: a turn is materializing
- `part.delta`: live streaming text (append to the part it names)
- `part.updated`: a part finalized (tool call landed, text settled)
- `session.idle`: the harness went quiet (turn root stop marker)
- `session.changed`: the conversation's record changed outside a turn this
  daemon runs (a Claude conversation continued on the desktop); read `/history`
  again
- `ask.requested`: an ask; options ride along, answer via `/respond`. It may
  carry `messageID`/`callID` (the tool call it holds up, for placing the card)
  and `at` (when it was raised, on the harness's clock)
- `ask.resolved`: that ask is over — answered on any client, stood down, or
  outlived by its turn; take the card down
- `session.error`: the harness said something failed

The client owns rendering: it opens `/stream` at startup, keeps it for the
process lifetime (foreground service), and renders whatever arrives for the
session it has open. Notifications are made on-device from the same feed; the
server pushes nothing down on its own.

## What the server does NOT do

No chat-store reads/writes, no Telegram cross-talk: the gateway reflects the
harness ports; the only state it keeps is the tokens and the client-side
rename overrides. Sessions prompted from a device are invisible to
Telegram's live view (the bot only renders turns it starts itself) and vice
versa. Turn ownership follows whoever called `prompt()`.
# Gateway: native-client transport

The gateway is jep's second presentation adapter (the first is Telegram). It
lets a native client speak to the same core the Telegram bot speaks to: same
`HarnessAdapter` port, same `opencode serve` children, same process. It is
OPTIONAL. jep-tg boots and runs without it.

## Shape

One process hosts both adapters (`src/app/tg.ts` composition root). The gateway is
`src/clients/gateway/index.ts: startGateway(deps)`, enabled when `JEP_GW_PORT` is set, bound
on 0.0.0.0 so a phone reaches it over Tailscale or the LAN. No TLS: the
transport rides inside the network's own encryption (WireGuard), like SSH.

Tokens live in `<DATA_HOME>/gateway-tokens.json`; the pairing code prints once
at boot and is readable any time with `npm run pair` (env `JEP_GW_PAIR_CODE`
pins it). Every endpoint except `/health` and `/pair` wants
`Authorization: Bearer <token>` (also accepted as `?token=` on the stream, for
plain clients).

## Commands (JSON POSTs)

| route | body | returns |
|---|---|---|
| `POST /pair` | `{code}` | `{token}` (5 tries / 60 s) |
| `GET /health` | (none) | `{ok,paired}` |
| `POST /sessions` | (none) | `{items[]}` all sessions, every adapter merged, client renames applied; each carries `adapter` (workspace name) and `harness` (engine id) for display |
| `POST /workspaces` | (none) | `{items[]}` of `{name,harness,dir}`: what a conversation may be created in, for creation-time selection |
| `POST /harnesses` | (none) | `{harnesses[],default}`: the harnesses installed here |
| `POST /browse` | `{path?}` | `{cwd,root,parent,dirs[]}`: folders under `cwd` (`{name,git}`), bounded to `JEP_BROWSE_ROOT` (default `$HOME`); `parent` is null at the root |
| `POST /new` | `{title?,workspace?,path?,harness?}` | `{session}`: created in a named workspace, at an absolute `path` (spawning that workspace under `harness` if it isn't served yet), and/or under a harness; with none, the first served workspace. The returned session carries `adapter`+`harness` |
| `POST /history` | `{id,limit?,before?}` | `{messages[],hasMore}`: the newest `limit` messages (or, when `before` is a time, the newest `limit` older than it); `hasMore` says older pages exist |
| `POST /prompt` | `{id,text,files?}` | `{message}` resolves when the turn ends; `files` are `attach` ids sent to the harness as `filePaths`; runs on the session's model if one was set |
| `POST /respond` | `{askID,optionID}` | `{ok}` |
| `POST /stop` | `{id}` | `{stopped}` |
| `POST /models` | `{id}` | `{models[],current,default}`: the models this conversation's harness can run on, each with `image`/`attachment`/`contextLimit`; `current` is the set one (null = harness default); `default` is what "default" resolves to |
| `POST /setmodel` | `{id,model?}` | `{ok,model}`: set (`"provider/model"`) or clear (omit) this conversation's model; persisted in `<DATA_HOME>/gateway-models.json`, applied to the next `/prompt` |
| `POST /agent` | `{id}` | `{current}`: the primary agent set for this conversation (null = harness default) |
| `POST /setagent` | `{id,agent?}` | `{ok,agent}`: set (`"build"`/`"plan"`) or clear this conversation's primary agent; persisted in `<DATA_HOME>/gateway-agents.json`, applied to the next `/prompt` |
| `POST /usage` | `{id}` | `{usage}`: tokens (in/out/thinking/cache) and reported cost summed over the conversation, plus turns and models (`core/usage.ts`) |
| `POST /diff` | `{id}` | `{files[]}`: files this conversation changed (`{file,additions,deletions,status?}`) |
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
| `POST /archive` | `{id}` | `{ok,archived}`: hide a conversation from `/sessions` without deleting it; persisted in `<DATA_HOME>/gateway-archived.json` |
| `POST /unarchive` | `{id}` | `{ok,archived}`: put it back |
| `POST /delete` | `{id}` | `{ok}`: removes the session from the harness |
| `POST /attach` | raw octets, `?id=<session>&name=<name>` | `{id,name}`: buffers up to 32 MB under `<DATA_HOME>/attachments`; the id feeds the next `/prompt`'s `files` |
| `GET /stream` | (none) | SSE, never ends |

Errors are a bare `{error}` with a fitting status. A second prompt into a
running session answers `409 {error:"busy"}`.

## Stream (SSE, GET /stream)

`data: {event}` frames, one per DomainEvent, every adapter's feed merged and
forwarded as-is:

- `message.created` / `message.updated`: a turn is materializing
- `part.delta`: live streaming text (append to the part it names)
- `part.updated`: a part finalized (tool call landed, text settled)
- `session.idle`: the harness went quiet (turn root stop marker)
- `ask.requested`: an ask; options ride along, answer via `/respond`
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
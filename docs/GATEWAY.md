# Gateway — native-client transport

The gateway is jep's second presentation adapter (the first is Telegram). It
lets a native phone client speak to the same core the Telegram bot speaks to:
same `HarnessAdapter` port, same `opencode serve` children, same process. It is
 OPTIONAL — jep-tg boots and runs without it.

## Shape

One process hosts both adapters (`src/tg.ts` composition root). The gateway is
`src/gateway.ts: startGateway(deps)`, enabled when `JEP_GW_PORT` is set, bound
on 0.0.0.0 so a phone reaches it over Tailscale or the LAN. No TLS: the
transport rides inside the network's own encryption (WireGuard), like SSH.

Tokens live in `<DATA_HOME>/gateway-tokens.json`; the pairing code prints once
at boot (env `JEP_GW_PAIR_CODE` pins it). Every endpoint except `/health` and
`/pair` wants `Authorization: Bearer <token>` (also accepted as `?token=` on
the stream, for plain clients).

## Commands (JSON POSTs)

| route | body | returns |
|---|---|---|
| `POST /pair` | `{code}` | `{token}` — 5 tries / 60 s |
| `GET /health` | — | `{ok,paired}` |
| `POST /sessions` | — | `{items[]}` all sessions, every adapter merged, client renames applied |
| `POST /new` | `{title?}` | `{session}` |
| `POST /history` | `{id}` | `{messages[]}` full replay from the harness |
| `POST /prompt` | `{id,text,files?}` | `{message}` resolves when the turn ends; `files` are `attach` ids sent to the harness as `filePaths` |
| `POST /respond` | `{askID,optionID}` | `{ok}` |
| `POST /stop` | `{id}` | `{stopped}` |
| `POST /rename` | `{id,title}` | `{ok}` — a client-side title override (Telegram-style chat rename), persisted in `<DATA_HOME>/gateway-titles.json`, overlaid on `/sessions` |
| `POST /delete` | `{id}` | `{ok}` — removes the session from the harness |
| `POST /attach` | raw octets, `?id=<session>&name=<name>` | `{id,name}` — buffers up to 32 MB under `<DATA_HOME>/attachments`; the id feeds the next `/prompt`'s `files` |
| `GET /stream` | — | SSE, never ends |

Errors are a bare `{error}` with a fitting status. A second prompt into a
running session answers `409 {error:"busy"}`.

## Stream (SSE, GET /stream)

`data: {event}` frames, one per DomainEvent, every adapter's feed merged and
forwarded as-is:

- `message.created` / `message.updated` — a turn is materializing
- `part.delta` — live streaming text (append to the part it names)
- `part.updated` — a part finalized (tool call landed, text settled)
- `session.idle` — the harness went quiet (turn root stop marker)
- `ask.requested` — an ask: options ride along, answer via `/respond`
- `session.error` — harness said something failed

The client owns rendering: it opens `/stream` at startup, keeps it for the
process lifetime (foreground service), and renders whatever arrives for the
session it has open. Notifications are made on-device from the same feed — the
server pushes nothing down on its own.

## What the server does NOT do

No chat-store reads/writes, no Telegram cross-talk: the gateway reflects the
harness ports; the only state it keeps is the tokens and the client-side
rename overrides. Sessions prompted from the phone are invisible to
Telegram's live view (the bot only renders turns it starts itself) and vice
versa — turn ownership follows whoever called `prompt()`.

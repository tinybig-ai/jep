# Telegram client

jep as a Telegram bot: pair it from your chat, then text it. Rich native
messages, voice notes, git and usage screens, and a streaming stop/steer loop.

<!--
SCREENSHOTS: drop real captures here (1280 wide, up to 2).

docs/images/telegram-pair.png     the pairing flow: /pair <code> → locked
docs/images/telegram-chat.png     a streamed turn: thinking line, tool call,
                                  markdown table, Stop button, cost chip
docs/images/telegram-git.png      the /git screen: status · log · diff
-->

## Requirements

- the jep daemon running (see [the README](../README.md#quick-start))
- a bot token from [@BotFather](https://t.me/BotFather)

## Setup

Two things, then you're paired.

### 1. Start the daemon with your token

```sh
export JEP_TG_TOKEN=123456:ABC-DEF...   # from @BotFather
export JEP_WORKSPACES="$HOME/your-project"

npm run tg
```

> On macOS, `sh scripts/install.sh` installs it as a **launchd daemon** that
> survives reboots and crashes; see [docs/PROCESSES.md](../PROCESSES.md).
> For a quick dev loop, `npm run tg` is all you need.

### 2. Pair your chat

Message the bot. It replies with a **pairing code**. Send

```
/pair <code>
```

to lock the bot to that chat, then just text it. Plain text is a prompt. The
owner is persisted, so restarts keep ownership (no re-pairing).

Want to check who is paired? `/pair_status` shows the owner and code.

## Commands

| Command | What it does |
|---|---|
| `text` | a prompt on the current conversation |
| `voice note` | transcribed with whisper, then run as a prompt |
| `/pair <code>` | lock the bot to this chat |
| `/pair_status` | owner, paired chats, current code |
| `/new <title>` | start a new conversation |
| `/ls` | list every conversation, across all projects |
| `/use <title\|id>` | switch to another conversation |
| `/log` | this conversation's history |
| `/diff` | files changed this session |
| `/git` | repo screens: status, log, diff |
| `/queue` | what is running, what is waiting |
| `/steer <text>` | stop the running turn and send that text ahead of the queue |
| `/abort` | stop the turn in flight |
| `/find <text>` | search titles and recent transcripts |
| `/usage` (alias `/cost`) | spend by the harness itself: tokens, model, USD |
| `/remind <5s to 7d> <what>` | a silent nudge (recurring: `every <d>`) |
| `/settings` | rich menu: model, harness, workspace, internals, MCP, skills |
| `/ws <name>` | switch workspace |
| `/cancel` | back out of a pending prompt |
| `/help` | the command list |

`mdl:<model>` as a message pins a model for the conversation (`mdl:off` to
return to the default).

## How it feels

- Turns stream into an animated **draft** with a native **Stop** button, a 💭
  line while the model reasons, and collapsible tool calls.
- Tables render as native rich blocks or box-drawn HTML, whichever your client
  supports. There is no scenario where a reply fails to send.
- Pictures and documents land as fluent uploads; the bot tells you when the
  default model can't read them and offers vision-capable ones.
- **Asks** (permission prompts, questions the model asks) arrive as buttons you
  tap; the safe answer is green, the destructive one red.

The full surface, environment variables, and deploy ritual live in
[docs/PROCESSES.md](../PROCESSES.md).
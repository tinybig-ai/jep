# Changelog — the HA app

## 0.3.0

First upstream release, contributed by Alberto Xamin. Images are published as
`ghcr.io/tinybig-ai/{arch}-jep` for amd64 and aarch64. Existing fork installations
can retain their repository URL and persistent data; moving to a different HA
repository is a separate migration.

## 0.2.22

The context ring sits to the right of the model name. Click it and the
breakdown still opens above the message box.

## 0.2.21

A ring under Send shows how full the context window is. Click it for the
breakdown of the last reply: input, cache read, and cache write.

## 0.2.20

Compact uses the conversation's model, including ids with more than one
slash. A provider error (such as a free-tier cap) is shown as that error.
A refusal still means a turn is already running.

## 0.2.19

On a phone the sidebar covers 90% of the screen. Details and Terminal are
separate tabs.

## 0.2.18

A badge on Terminal counts shells the agent still has running. They are
listed in the sidebar. Click one for a read-only log. Shell returns to the
interactive terminal.

## 0.2.17

The terminal sits in the right sidebar, drawn with [xterm.js](https://xtermjs.org/).
Letters, Backspace, and Enter show up immediately. The shell's own screen
replaces that guess as soon as the next frame arrives.

## 0.2.16

The Terminal button is a [wterm](https://github.com/vercel-labs/wterm) screen:
colors, a cursor, and keys that go straight to the shell. Opening a file uses
that conversation's folder, and git changes use the repository root.

## 0.2.15

A Terminal button in the web client opens a tmux shell in the conversation's
folder. On by default in this app. Ingress does not ask for the pairing code
again, because Home Assistant already signed you in.

## 0.2.14

Right-click a conversation in the web client and choose **Download transcript**.
That saves the whole chat as a markdown file.

## 0.2.13

Pictures in the web client load under Home Assistant ingress. Their URL was
`/file`, which left the app and hit Home Assistant. It is now relative to
the ingress path.
## 0.2.12

`/model openrouter/...` works. The picker used to keep only `opencode` and
`opencode-go`, so a free OpenCode model stayed selected and hit the free cap.
OpenRouter models from `opencode models` are accepted. The menu stays short;
type the full id.

## 0.2.11

Preserve the existing fork's prebuilt-image upgrade path. CI checks that the
image registry matches its repository owner. Existing custom gateway ports
continue to start, with a warning when ingress cannot use them. Existing
Telegram conversations retain model choices inherited by earlier versions.

## 0.2.10

Ingress identity is accepted only from the Supervisor. GitHub login is optional
and no longer blocks startup. CI checks out the exact requested source commit;
builds can use an explicit source commit.
Topic creation uses Telegram's API field, /new preserves history, draft IDs stay
unique across topics and restarts, and Stop targets the draft it came from.
Sent files are also available to web and native clients. Permission recovery
polling now cleans up subscriptions and delivers asks to every event consumer.

## 0.2.9

Permission prompts reach Telegram even when OpenCode never puts them on the
event stream. The app checks the pending permission list during a turn and
sends the Allow once / Always / Deny buttons.

## 0.2.8

`jep-send`: when you ask in Telegram, the agent can hand a file back into the
chat. Pictures arrive as photos, anything else as a document. Over 50 MB is
refused. A file you send the bot, including a PDF, was already attached to
the prompt.

## 0.2.7

No GitHub token needed. If `gh` is not logged in yet, the app log prints a
one-time code and `https://github.com/login/device`. Enter the code in a
browser and the start continues. The login is kept in the app data.

## 0.2.6

The image includes the GitHub CLI. A `github_token` option (a personal access
token with the `repo` scope) is logged in at start with `gh auth login` and
`gh auth setup-git`, so `gh` and `git` over https work in the container.

## 0.2.5

0.2.4's image was built from upstream `tinybig-ai/jep`, so the sidebar still
asked for a pairing code. The image now clones the repo CI is building.
A configuration that has not saved `ingress_trust` yet still trusts ingress.

## 0.2.4

The sidebar web client no longer asks for a pairing code. Home Assistant
already signed the user in and stamps `X-Remote-User-Id`; with
`ingress_trust` on (the default) that header is enough. The host port is
unmapped so the header cannot be forged from the LAN. Publish `8099` on the
Network tab only for a phone, and turn `ingress_trust` off first.

## 0.2.3

**Ingress**: the web client is now reachable from Home Assistant itself
(sidebar panel "Jep", or the card's **Open Web UI**) under
`/api/hassio_ingress/…` — through HA's own URL, so reverse proxies or
cloudflared in front of HA cover it with no extra port forwarding. The web
client uses only relative URLs now, so it behaves no matter where HA mounts
it. The direct port stays for native phone clients (`JEP_GW_PORT`).

## 0.2.2

`telegram_forum` option → `JEP_TG_FORUM` (`auto`/`off`): with the bot's
**Threaded mode** on in @BotFather, each conversation lives in its own forum
topic — General messages spawn a topic, /new opens one, renames follow.

## 0.2.1

`openrouter_api_key` option → `OPENROUTER_API_KEY` for opencode, the
`image` key pulling the fork's GHCR images, root `repository.json` (the
Supervisor's validity gate for URL repositories).

## 0.2.0 (first release)

Matches jep 0.2.0. Node 26 base, opencode v1 CLI, gateway + Telegram both
configurable, pod-only workspaces, pasted opencode credentials.

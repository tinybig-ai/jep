# Changelog — the HA app

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

# Changelog — the HA app

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

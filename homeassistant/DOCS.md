# Jep — Home Assistant app

One interface for every coding agent, inside Home Assistant. Runs the jep
daemon (`src/app/tg.ts`) in the app's own container with **Telegram** and the
**gateway web/app client** both configurable in the app settings, either one
on its own or both together. Agents run on **opencode**.

The daemon keeps its architecture here: Telegram on one side, the gateway on
the other, the same `HarnessAdapter` underneath. Nothing about jep changes —
this folder only packages it and maps Home Assistant's surfaces onto the
daemon's environment.

## Install

Point the app store at this repository:

1. **Settings → Apps → App Store → ⋮ → Repositories** (in older HA,
   Supervisor → Add-on Store), paste
   `https://github.com/<your-fork-or-tinybig-ai>/jep` as the repository URL.
   The Supervisor finds the app by its `config.json`.
2. Install **Jep**, set the options in the **Configuration** tab (below), then
   **Start**.
3. Open **Jep** in the sidebar. The web client is already signed in. A phone
   on a published port still needs the pairing code from the app's **Log**.

The repo is a valid repository URL thanks to the root `repository.json`
(required by the Supervisor) — the app itself lives in the `homeassistant/`
folder, which the Supervisor finds by its `config.json` at any depth.
   * Telegram prints `pairing code: XXXX-XXXX` until the first `/pair`.
   * The gateway prints its own pairing code once at boot (phones only).

First start pulls the prebuilt image (your fork's GHCR packages); expect a
short download, faster than building on a Pi. If the `image` key is removed,
the same Dockerfile is built on the device at install time instead. Later
starts are instant in both cases.

### Where the web client lives

The gateway listens on `8099` inside the container. Nothing is published on
the host until you ask.

1. **Ingress (no pairing, recommended).** `ingress: true` and `ingress_port:
   8099`. Open the sidebar panel **Jep**. The browser URL is HA's own, e.g.
   `https://<your-ha>/api/hassio_ingress/<token>/…`, so anything already in
   front of HA (Nginx proxy add-on, Caddy, **cloudflared**) covers it with no
   port forwarding and no extra TLS. The web client uses only *relative*
   URLs, because ingress mounts it under `/api/hassio_ingress/…` and never
   rewrites paths. Home Assistant already authenticated the user and stamps
   `X-Remote-User-Id` on the proxied request, so the page pairs itself
   (`ingress_trust`, on by default). No code to type.
2. **A phone, or a browser on the raw port.** On the app's **Network** tab,
   set host port `8099`. Turn **Trust Home Assistant ingress** off first: with
   the port published, anyone who can open it can send that header and skip
   the pairing code. Then pair with the code from the log. This path needs
   its own forwarding and TLS if it leaves the LAN. `gateway_port` must stay
   `8099` or ingress stops matching `ingress_port`.

### Updating

CI (`.github/workflows/ha-app.yml`) builds and pushes the images for both
architectures on every push that touches the app or its sources, tagged with
`config.json`'s `version` and `latest` — so an update is: bump `version`,
push, wait for CI, then reinstall/update the app in HA. The image clones
the repo CI is building (`JEP_REPO`, default upstream) at `JEP_REF`, busting
that layer with `JEP_SHA`, so a fork's image contains the fork's source.

The app points at the fork's images by default (`image`:
`ghcr.io/albertoxamin/{arch}-jep`, which must be public — see the package
settings on github.com). Remove the `image` key to have the Supervisor build
the same Dockerfile on your device instead; the workflow file comes with the
fork either way.

## Options

| Option | Type / default | Meaning |
|---|---|---|
| `telegram_token` | password, empty | token from [@BotFather](https://t.me/BotFather). Empty = Telegram bot off. |
| `telegram_forum` | list (`auto`/`off`), `auto` | with Threaded mode enabled for the bot in @BotFather, every conversation runs as its own **forum topic**: a message typed in General spawns a topic titled with the prompt, /new opens one, deleting the conversation deletes the topic. `auto` probes `createForumTopic` once and falls back to plain chat for 10 minutes when Telegram refuses. |
| `gateway_enabled` | bool, `true` | run the gateway (web client, Android app client) |
| `gateway_port` | port, `8099` | port inside the app. Ingress is fixed to this. The host port stays unmapped until the Network tab sets one |
| `gateway_bind` | str, empty | what to bind: empty = all interfaces (default), `127.0.0.1` = container-local |
| `gateway_pair_code` | str, empty | pin the gateway pairing code instead of a fresh one per boot |
| `ingress_trust` | bool, `true` | sidebar web client skips pairing (`JEP_GW_INGRESS_TRUST=1`). Turn off before publishing the host port |
| `workspace_dir` | str, `/data/jep/workspace` | the one served workspace every conversation starts from. Throwaway pods (`Add project → pod` in the client) live under the data home, so no folders to manage |
| `browse_root` | str, `/data` | browser root when adding a folder from a client |
| `model` | str, empty | default model, e.g. `openrouter/anthropic/claude-sonnet-4` |
| `openrouter_api_key` | password, empty | your OpenRouter key; exported as `OPENROUTER_API_KEY`, which is all opencode needs to list and run OpenRouter models |
| `github_token` | password, empty | optional personal access token with the `repo` scope. Empty: on start the log prints a one-time code and `https://github.com/login/device`. Enter the code there and the app continues, logged in. A token skips that and runs `gh auth login --with-token` |
| `opencode_auth` | password, empty | paste the contents of `~/.local/share/opencode/auth.json` from a machine where you ran `opencode auth login`. Empty + no free models = no pickable models |
| `opencode_config` | password, empty | paste the contents of `~/.config/opencode/opencode.json` (providers, MCP servers…) |
| `transcribe_cmd` | str, empty | command printed-transcript replacement for whisper; voice notes need this or a whisper venv |
| `transcribe_timeout` | int, `300` | seconds a transcription may take |
| `whisper_dir` | str, empty | path to a ready whisper `.venv` (e.g. put it under the `addon_configs` share) |
| `whisper_model` | str, empty | whisper model (`medium` when unset) |
| `fcm_key` | password, empty | service-account key JSON for Android push |
| `apns_*` | str/bool, empty | iOS push: `apns_key` is the **path** to the `.p8` file (see the config share below), plus key id / team id / topic / sandbox |

Options not listed here (pairing windows, recycle rules, tmux sizes…) keep
jep's defaults; the daemon exposes them as `JEP_*` env vars, see
`docs/PROCESSES.md` § operator's manual.

## Where files live

| In the container | On the host | What |
|---|---|---|
| `/config/opencode/opencode.json` | the app's **Configuration** share (Settings → Apps → Jep → three-dot menu → *gears*; also /addon_configs/jep via Samba) | opencode config; users can drop `auth.json` here too |
| `/data/jep` — sessions, pairing, pods, gateway tokens | app data, private (included in HA backups) | everything jep owns |
| `/share` | shared folder | pick as `workspace_dir` or `browse_root` for repos you edit in HA too |

Secrets (`opencode_auth`, `opencode_config`, `telegram_token`, `github_token`, `fcm_key`) are
stored in Home Assistant's own app options and only ever written into the
app's private storage or the container filesystem.

## Notes and limits

* **Both clients off** refuses to start; one always serves.
* Sessions live in the container's own data home, so nothing touches the HA
  configuration; restart-spawned workspaces survive via jep's own store.
* Voice transcription ships with `ffmpeg` + `python3` but not whisper — the
  model is hundreds of MB, so bring your own venv under `whisper_dir`.
* The image realizes **opencode v1** (the official installer line; the
  installer deliberately refuses to downgrade-mix versions). If your jep copy
  tracks opencode v2, swap the installer URL in the Dockerfile to
  `https://opencode.ai/v2/install`.
* AppArmor is off (default): the container regularly spawns harness, git and
  tmux children. If a future HA release tightens the default Docker profile,
  move execs into an `apparmor.txt` here and flip the config key.
* Logs are in UTC (no timezone mapping — the daemon deals in text, not time).
* `homeassistant/` is the app folder chosen so the upstream repo URL works
  directly as a repository URL: the Supervisor scans folders at any depth
  for app config files.

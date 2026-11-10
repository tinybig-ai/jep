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
   `https://github.com/tinybig-ai/jep` as the repository URL.
   The Supervisor finds the app by its `config.json`.
2. Install **Jep**. In **Configuration**, enter an `openrouter_api_key` or
   paste existing OpenCode credentials into `opencode_auth`, then **Start**.
   No GitHub token, Telegram bot or host port is needed for the sidebar.
3. Open **Jep** in the sidebar. The web client is already signed in. A phone
   on a published port still needs the pairing code from the app's **Log**.

The repo is a valid repository URL thanks to the root `repository.json`
(required by the Supervisor) — the app itself lives in the `homeassistant/`
folder, which the Supervisor finds by its `config.json` at any depth.
   * Telegram prints `pairing code: XXXX-XXXX` until the first `/pair`.
   * The gateway prints its own pairing code once at boot (phones only).

Installation pulls the upstream prebuilt image. Later starts reuse that image.
Existing fork users can keep their repository URL and image source; switching
repository URLs creates a different HA app identity and needs an explicit data
migration or backup restore.

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
   `X-Remote-User-Id` on the proxied request. Jep accepts that identity only
   from the Supervisor's socket address, `172.30.32.2`, with `ingress_trust`
   enabled. Other containers and direct clients must use a pairing code.
2. **A phone, or a browser on the raw port.** On the app's **Network** tab,
   set host port `8099`. Pair with the code from the log. Direct clients
   cannot authenticate by sending an ingress identity header. This path needs
   its own forwarding and TLS if it leaves the LAN. `gateway_port` must stay
   `8099` or ingress stops matching `ingress_port`.

### Updating

CI (`.github/workflows/ha-app.yml`) builds and pushes the images for both
architectures on every push that touches the app or its sources, tagged with
`config.json`'s `version` and `latest` — so an update is: bump `version`,
push, wait for CI, then reinstall/update the app in HA. CI builds the exact
`JEP_SHA` commit from `JEP_REPO`, so a branch moving during the build cannot
silently change the source. Local builds use `JEP_REF` when no SHA is supplied.

The upstream image prefix is `ghcr.io/tinybig-ai/{arch}-jep`. Both architecture
packages must be public. Fork releases use their own owner in `image` and the
root repository metadata; CI rejects a registry owner that does not match the
publishing repository. Keep the app version and registry tags in step.

Maintainers: if GitHub says visibility is disabled by organization administrators,
an organization owner must first enable **Public** under **Package Creation** in
the [organization package settings](https://github.com/organizations/tinybig-ai/settings/packages).
Then set both `amd64-jep` and `aarch64-jep` to public in their package settings.
Installing Jep never requires a GHCR account or token.

Both architecture images are booted in CI before being pushed. The check starts
OpenCode and the gateway with default options, creates a conversation, loads web
assets, and confirms that a restart retains the conversation and workspace files.

Local builds are opt-in: remove `image` and set the Dockerfile's `JEP_REPO` to
the source repository you intend to install. Its default is upstream, so a fork
must change it before switching its users to local builds.

## Options

| Option | Type / default | Meaning |
|---|---|---|
| `telegram_token` | password, empty | token from [@BotFather](https://t.me/BotFather). Empty = Telegram bot off. |
| `telegram_forum` | list (`auto`/`off`), `auto` | with Threaded mode enabled for the bot in @BotFather, every conversation runs as its own **forum topic**: a message typed in General spawns a topic titled with the prompt, /new opens one, deleting the conversation deletes the topic. `auto` probes `createForumTopic` once and falls back to plain chat for 10 minutes when Telegram refuses. |
| `gateway_enabled` | bool, `true` | run the gateway (web client, Android app client) |
| `gateway_port` | port, `8099` | port inside the app. Ingress is fixed to this. The host port stays unmapped until the Network tab sets one |
| `gateway_bind` | str, empty | what to bind: empty = all interfaces (default), `127.0.0.1` = container-local |
| `gateway_pair_code` | str, empty | pin the gateway pairing code instead of a fresh one per boot |
| `ingress_trust` | bool, `true` | trust the HA user header only from the Supervisor at `172.30.32.2`; direct connections still require pairing |
| `workspace_dir` | str, `/data/jep/workspace` | the one served workspace every conversation starts from. Throwaway pods (`Add project → pod` in the client) live under the data home, so no folders to manage |
| `browse_root` | str, `/data` | browser root when adding a folder from a client |
| `model` | str, empty | default model, e.g. `openrouter/anthropic/claude-sonnet-4` |
| `openrouter_api_key` | password, empty | your OpenRouter key; exported as `OPENROUTER_API_KEY`, which is all opencode needs to list and run OpenRouter models |
| `github_token` | password, empty | optional GitHub token, supplied through `GH_TOKEN`. GitHub login never blocks startup. For interactive login later, run `gh auth login --web` from the app's shell or an agent when requested |
| `terminal_enabled` | bool, `true` | tmux shell in the web client (`JEP_TERMINAL=1`). The Terminal button opens it for the current conversation. Ingress does not ask for the pairing code again |
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

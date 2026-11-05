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
3. Open the app's **Log** to find your pairing info:
   * Telegram prints `pairing code: XXXX-XXXX` until the first `/pair`.
   * The gateway prints its own pairing code once at boot.

First start builds the container on your machine (Node 26 base + opencode +
jep's sources); expect a few minutes on a Pi, under a minute on x86. Later
starts are instant.

### Updating

The Supervisor rebuilds when `config.json`'s `version` changes, and **the
image clones this repo at build time** (`JEP_REF`, default `main`). So to
follow the fork actively: bump `version` (any change works), restart the app,
and the latest sources are re-cloned. To pin or switch branches, edit
`JEP_REF` in `homeassistant/Dockerfile` in your fork.

CI (`.github/workflows/ha-app.yml`) can also publish ready images; if you
prefer pulls over builds, add an `image` key:

```json
"image": "ghcr.io/<owner>/{arch}-jep"
```

## Options

| Option | Type / default | Meaning |
|---|---|---|
| `telegram_token` | password, empty | token from [@BotFather](https://t.me/BotFather). Empty = Telegram bot off. |
| `gateway_enabled` | bool, `true` | run the gateway (web client, Android app client) |
| `gateway_port` | port, `8099` | gateway port; exposed as an HA port |
| `gateway_bind` | str, empty | what to bind: empty = all interfaces (default), `127.0.0.1` = container-local |
| `gateway_pair_code` | str, empty | pin the gateway pairing code instead of a fresh one per boot |
| `workspace_dir` | str, `/data/jep/workspace` | the one served workspace every conversation starts from. Throwaway pods (`Add project → pod` in the client) live under the data home, so no folders to manage |
| `browse_root` | str, `/data` | browser root when adding a folder from a client |
| `model` | str, empty | default model, e.g. `openai/gpt-5-mini` |
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

Secrets (`opencode_auth`, `opencode_config`, `telegram_token`, `fcm_key`) are
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

# Security

jep runs coding agents on your machine and puts a control surface in front of
them — Telegram, the [gateway](docs/GATEWAY.md), the Android app. That shape
makes security reports genuinely welcome, and it also means a few trade-offs are
**by design**, not bugs. This file says which is which.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting
(**Security** tab → **Report a vulnerability**), or email **cemre@tinybig.ai**.

Include what you can: affected commit/version, impact, and a reproduction.
We'll acknowledge within a few days and keep you updated as we work on it. If
the report is valid we'll credit you unless you'd rather stay anonymous.

## Supported versions

`0.1.x` on `main`. Fixes land on `main`; there are no long-lived release
branches yet.

## What's in scope

- The daemon (`src/`): the hexagonal core, harness adapters, and the clients.
- The gateway: authentication, session/workspace scoping, attachment handling.
- Pairing and ownership (`pairing.json`, the owner lock).
- How secrets are read, stored, and logged — and where they never are.
- The isolated data home (`JEP_DATA_HOME`) and credential mirroring.

## Known design trade-offs (please don't report these as bugs)

- **The gateway has no TLS of its own.** It is meant to ride an encrypted
  network you already trust — WireGuard/Tailscale, or your LAN. Do not expose it
  to the open internet. This is stated in the README and
  [docs/GATEWAY.md](docs/GATEWAY.md).
- **A paired bot is a shell on your machine.** The owner's messages are turned
  into agent prompts, and harnesses may run with elevated autonomy depending on
  how they're configured. Treat the Telegram bot token and the pairing code as
  credentials: anyone who has them can drive your agents.
- **Sessions are isolated, credentials are shared.** jep runs harnesses against
  its own `XDG_DATA_HOME` so your CLI's store is untouched, but it mirrors your
  `auth.json` in so the models you picked can actually run. The mirror is a
  copy, read-only in spirit, refreshed at boot.
- **Telegram polling.** Nothing is exposed for the Telegram client: the daemon
  polls out. The Android/gateway clients are the ones that dial *in*, which is
  why they need the network path above.

## How jep handles secrets

- No token, key, or credential belongs in the repository or in a log line.
  Secrets live in the environment (or the launchd plist) and the isolated data
  home only.
- If you find a secret committed anywhere in history, treat it as leaked and
  report it privately — rotating it is the fix, and removing the commit is not
  enough on its own.

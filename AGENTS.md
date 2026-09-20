# jep

Telegram remote control for local coding-agent harnesses (opencode, codex,
claude). Architecture and rituals: `docs/PROCESSES.md`.

## Deploying the daemon — read before any restart

Two agents work in this repo at once (the desktop session and the
self-development session over Telegram), and both used to restart the daemon
on their own — that is how four daemons ended up fighting over Telegram
long-poll (409 "terminated by other getUpdates request") and updates vanished.

The rules, in `docs/PROCESSES.md` § launchd:

- `launchctl kickstart -k gui/$(id -u)/com.jep.tg` for **code-only** changes.
- `launchctl bootout` + `bootstrap` when the **plist changed** — kickstart
  reruns the old definition, so env-var/ProgramArguments edits silently don't
  apply.
- Never `pkill` + `nohup` a manual copy next to launchd; if one exists, kill
  it and let launchd own the single instance. Verify with exactly one
  `pgrep -f src/tg.ts` and a fresh banner in `~/Library/Logs/jep-tg.log`.
- Serialize: if another agent (or the user) is mid-deploy or mid-turn on the
  daemon, do not restart concurrently — announce, wait, or defer.

# jep

Telegram remote control for local coding-agent harnesses (opencode, codex,
claude). Architecture and rituals: `docs/PROCESSES.md`.

## Deploying the daemon (read before any restart)

Two agents work in this repo at once (the desktop session and the
self-development session over Telegram), and both used to restart the daemon
on their own. That is how four daemons ended up fighting over Telegram
long-poll (409 "terminated by other getUpdates request") and updates vanished.

The rules, in `docs/PROCESSES.md` § launchd:

- `launchctl kickstart -k gui/$(id -u)/com.jep.tg` for **code-only** changes.
  Prefer a graceful `kill -TERM <pid>` when you can (launchd `KeepAlive` still
  restarts it): the daemon's SIGTERM handler closes the gateway and every
  harness child, while `kickstart -k` can orphan one `opencode serve` per active
  workspace.
- If `scripts/jep-daemon.sh` changed, refresh the copy the plist actually runs
  (`cp scripts/jep-daemon.sh ~/.local/share/jep-tg/jep-daemon.sh`), or a restart
  execs a stale path and crash-loops. `scripts/install.sh` does this for you.
- `launchctl bootout` + `bootstrap` when the **plist changed**: kickstart
  reruns the old definition, so env-var/ProgramArguments edits silently don't
  apply.
- Never `pkill` + `nohup` a manual copy next to launchd; if one exists, kill
  it and let launchd own the single instance. Verify with exactly one
  `pgrep -f src/app/tg.ts` and a fresh banner in `~/Library/Logs/jep-tg.log`.
- When running any launchctl command, wrap it in a 60s hard bound
  (`perl -e 'alarm shift; exec @ARGV' 60 launchctl …`). A wedged launchctl
  subprocess has hung harness bash tools for 20+ minutes (twice).
- Serialize: if another agent (or the user) is mid-deploy or mid-turn on the
  daemon, do not restart concurrently. Announce, wait, or defer.

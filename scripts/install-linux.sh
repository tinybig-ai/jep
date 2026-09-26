#!/bin/sh
# Installs jep as a systemd user service on Linux: the counterpart of
# install.sh's launchd agent, so a Linux machine gets the same daemon that comes
# back after a crash and after a reboot.
#
# The unit runs node on this checkout directly. systemd owns the whole process
# group, so stopping or restarting the service also stops every harness child
# (opencode serve, codex, claude) — none can be orphaned the way a hard restart
# orphans them under launchd.
#
# Re-running is safe: it reuses the token already saved and restarts the unit.
# JEP_DRY_RUN=1 prints the unit and the environment file instead of installing.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
unit=jep-tg.service
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
node="${JEP_NODE:-$(command -v node || true)}"
data_home="${JEP_DATA_HOME:-$HOME/.local/share/jep-tg}"
env_file="$data_home/jep-tg.env"
workspaces="${JEP_WORKSPACES:-$root}"
token="${JEP_TG_TOKEN:-}"
dry="${JEP_DRY_RUN:-}"

say() { printf '%s\n' "$*"; }
die() { printf 'install-linux: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || [ -n "$dry" ] || die "this is the systemd installer; on macOS run scripts/install.sh"
[ -n "$node" ] || die "no node on PATH — set JEP_NODE=/path/to/node"
case $("$node" -p 'process.versions.node.split(".")[0]') in
  1[0-9]|2[01]) die "node $("$node" -p 'process.versions.node') is too old for --experimental-strip-types (need 22+)" ;;
esac
[ -n "$dry" ] || command -v systemctl >/dev/null || die "no systemctl: run src/app/tg.ts under your own supervisor"

# the token is the one thing this script cannot work out; a re-run finds it
if [ -z "$token" ] && [ -f "$env_file" ]; then
  token=$(sed -n 's/^JEP_TG_TOKEN=//p' "$env_file" | head -n 1)
fi
if [ -z "$token" ]; then
  [ -t 0 ] || die "no token: set JEP_TG_TOKEN (from @BotFather) and re-run"
  printf 'Telegram bot token (from @BotFather): '
  read -r token
  [ -n "$token" ] || die "no token given"
fi

# where the harness CLIs usually live, ahead of the system's own
path="$HOME/.local/bin:$HOME/.opencode/bin:$(dirname "$node"):/usr/local/bin:/usr/bin:/bin"

env_body="JEP_TG_TOKEN=$token
JEP_DATA_HOME=$data_home
JEP_WORKSPACES=$workspaces
XDG_DATA_HOME=$HOME/.local/share
PATH=$path"

unit_body="[Unit]
Description=jep: Telegram and gateway remote control for coding agents
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$data_home
EnvironmentFile=$env_file
ExecStart=$node --experimental-strip-types $root/src/app/tg.ts
# SIGTERM runs the daemon's own shutdown (closes the gateway and every harness
# child); whatever is left after the timeout goes with the control group
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=20
Restart=always
RestartSec=5

[Install]
WantedBy=default.target"

if [ -n "$dry" ]; then
  say "# $unit_dir/$unit"
  say "$unit_body"
  say ""
  say "# $env_file (mode 600)"
  say "$env_body" | sed 's/^JEP_TG_TOKEN=.*/JEP_TG_TOKEN=<redacted>/'
  exit 0
fi

mkdir -p "$unit_dir" "$data_home"
umask 077
printf '%s\n' "$env_body" > "$env_file"
chmod 600 "$env_file"
printf '%s\n' "$unit_body" > "$unit_dir/$unit"

systemctl --user daemon-reload
systemctl --user enable "$unit" >/dev/null
systemctl --user restart "$unit"

# without lingering, a user service stops at logout and does not start at boot
if ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q yes; then
  say "note: for jep to run without you logged in (and after a reboot), allow it once:"
  say "  sudo loginctl enable-linger $(id -un)"
fi

sleep 2
if systemctl --user is-active --quiet "$unit"; then
  say "jep is running. Logs: journalctl --user -u $unit -f"
else
  die "the service did not stay up — see: journalctl --user -u $unit -n 50"
fi

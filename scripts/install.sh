#!/bin/sh
# Installs jep as a launchd agent, and refuses to do so until it has proved the
# daemon will actually be able to read this checkout.
#
# That proof is the whole point. macOS grants file access per binary, and a
# launchd job inherits none of yours: a tree under ~/Documents that your shell
# reads instantly can block a launchd-spawned node forever, with no prompt and
# no error. Checking from here would prove nothing, so the check is run by a
# throwaway launchd job using the same node binary — the only context whose
# answer means anything.
#
# Re-running is safe: it reuses the token already in the plist and reloads the
# job in place.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
uid=$(id -u)
label=com.jep.tg
plist="$HOME/Library/LaunchAgents/$label.plist"
probe_label=com.jep.tccprobe

node="${JEP_NODE:-$(command -v node || true)}"
data_home="${JEP_DATA_HOME:-$HOME/.local/share/jep-tg}"
log="${JEP_LOG:-$HOME/Library/Logs/jep-tg.log}"
workspaces="${JEP_WORKSPACES:-$root}"
token="${JEP_TG_TOKEN:-}"

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "launchd is macOS-only; run src/app/tg.ts under your own supervisor instead"
[ -n "$node" ] || die "no node on PATH — set JEP_NODE=/path/to/node"
case $("$node" -p 'process.versions.node.split(".")[0]') in
  1[0-9]|2[01]) die "node $("$node" -p 'process.versions.node') is too old for --experimental-strip-types (need 22+)" ;;
esac

# The token is the one thing this script cannot work out. An existing install
# already has it, so a re-run never asks again.
if [ -z "$token" ] && [ -f "$plist" ]; then
  token=$(plutil -extract EnvironmentVariables.JEP_TG_TOKEN raw -o - "$plist" 2>/dev/null || true)
fi
if [ -z "$token" ]; then
  [ -t 0 ] || die "no token: set JEP_TG_TOKEN (from @BotFather) and re-run"
  printf 'Telegram bot token (from @BotFather, not echoed): '
  stty -echo 2>/dev/null || true
  read -r token
  stty echo 2>/dev/null || true
  printf '\n'
fi
[ -n "$token" ] || die "empty token"

mkdir -p "$data_home" "$(dirname "$log")" "$HOME/Library/LaunchAgents"

# ---------------------------------------------------------------- TCC preflight
# A heads-up first, because the fix is cheapest before anything is installed.
case "$root/" in
  "$HOME/Documents/"*|"$HOME/Desktop/"*|"$HOME/Downloads/"*|"$HOME/Library/Mobile Documents/"*|/Volumes/*)
    say "note: $root is inside a folder macOS protects."
    say "      The daemon needs Full Disk Access for $node, or a checkout"
    say "      somewhere unprotected. Checking which applies…"
    ;;
esac

probe_out="$data_home/tcc-probe.out"
probe_plist="$data_home/$probe_label.plist"
rm -f "$probe_out"
# Same binary, same path, spawned the same way as the daemon will be: anything
# less answers a different question than the one being asked.
cat > "$probe_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$probe_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>-e</string>
    <string>const fs=require("fs");fs.readFileSync("$root/package.json");fs.writeFileSync("$probe_out","ok")</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
launchctl bootout "gui/$uid/$probe_label" 2>/dev/null || true
launchctl bootstrap "gui/$uid" "$probe_plist" 2>/dev/null || die "could not run the access probe (launchctl bootstrap failed)"
n=0
while [ ! -f "$probe_out" ] && [ "$n" -lt 8 ]; do sleep 1; n=$((n + 1)); done
launchctl bootout "gui/$uid/$probe_label" 2>/dev/null || true
rm -f "$probe_plist"

if [ ! -f "$probe_out" ]; then
  rm -f "$probe_out"
  cat >&2 <<EOF
install: a launchd job cannot read $root

  It did not fail — it hung, which is what macOS file protection looks like
  from inside launchd: no prompt, no error, no log. Installed as-is, the bot
  would sit there doing nothing after every restart.

  Two fixes, either is enough:
    · System Settings → Privacy & Security → Full Disk Access → + →
      $node        (⌘⇧G pastes a path)
    · or move this checkout out of the protected folder (~/code works) and
      re-run this script.

  Nothing was installed. Re-run when you have done one of them.
EOF
  exit 78
fi
rm -f "$probe_out"
say "access check: a launchd job can read $root ✓"

# --------------------------------------------------------------------- install
# The wrapper is copied out of the tree it guards: it has to stay readable in
# exactly the case where the tree is not.
cp "$root/scripts/jep-daemon.sh" "$data_home/jep-daemon.sh"
chmod +x "$data_home/jep-daemon.sh"

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$data_home/jep-daemon.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JEP_ROOT</key><string>$root</string>
    <key>JEP_NODE</key><string>$node</string>
    <key>JEP_TG_TOKEN</key><string>$token</string>
    <key>JEP_DATA_HOME</key><string>$data_home</string>
    <key>JEP_WORKSPACES</key><string>$workspaces</string>
    <key>XDG_DATA_HOME</key><string>$HOME/.local/share</string>
    <key>PATH</key><string>$HOME/.local/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>$data_home</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
# the token lives in here
chmod 600 "$plist"
plutil -lint "$plist" >/dev/null || die "generated a malformed plist ($plist)"

before=$(wc -c < "$log" 2>/dev/null || echo 0)
# bootout returns before the job is gone, and bootstrapping over a job that is
# still on its way out fails with a bare "Input/output error"
launchctl bootout "gui/$uid/$label" 2>/dev/null || true
n=0
while launchctl print "gui/$uid/$label" >/dev/null 2>&1 && [ "$n" -lt 10 ]; do sleep 1; n=$((n + 1)); done
n=0
while ! launchctl bootstrap "gui/$uid" "$plist" 2>/dev/null; do
  n=$((n + 1))
  [ "$n" -lt 5 ] || die "launchctl bootstrap failed for $plist"
  sleep 1
done

n=0
while [ "$(wc -c < "$log" 2>/dev/null || echo 0)" -le "$before" ] && [ "$n" -lt 20 ]; do sleep 1; n=$((n + 1)); done
say ""
tail -n 6 "$log" 2>/dev/null || true
say ""
if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
  say "installed: $label is loaded (log: $log)"
  say "reload after a code change:  pkill -9 -f 'src/app/tg.ts'"
else
  die "the job did not stay loaded — see $log"
fi

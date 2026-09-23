#!/bin/sh
# The daemon's entry point, and the reason the plist does not name node
# directly: it checks that the source tree can actually be read before handing
# over to it.
#
# macOS gates ~/Documents, ~/Desktop, ~/Downloads and iCloud Drive behind TCC,
# and a launchd-spawned process holds none of those grants by default. The
# denial is not an error — the open() blocks, forever, with no prompt. node
# hits it while resolving modules, before a line of jep runs, so the daemon
# cannot report it: the process sits there at 0% CPU with an empty log, which
# reads like a hang in our own code.
#
# Two things make this script able to say so. It lives outside the tree it
# guards (install.sh copies it into the data home), so it is still readable in
# exactly the case where the tree is not. And it probes with *node* rather than
# with its own shell: a grant belongs to one binary, so /bin/cat succeeding or
# failing says nothing about what node is allowed to do.
set -eu

root="${JEP_ROOT:?JEP_ROOT is not set — re-run scripts/install.sh}"
node="${JEP_NODE:-node}"
# a readable tree answers instantly; this is a deadline, not a wait
probe_timeout="${JEP_PROBE_TIMEOUT:-5}"
# launchd restarts us every ThrottleInterval, so a diagnosis that exited at
# once would repeat a dozen times a minute. One line every few minutes is
# plenty to find in a log.
hold="${JEP_PROBE_BACKOFF:-300}"

# the read that node itself would do first, in a process we are free to kill
"$node" -e 'require("fs").readFileSync(process.argv[1] + "/package.json")' "$root" >/dev/null 2>&1 &
probe=$!
( sleep "$probe_timeout"; kill -9 "$probe" 2>/dev/null ) >/dev/null 2>&1 &
watchdog=$!

if wait "$probe" 2>/dev/null; then
  kill "$watchdog" 2>/dev/null || true
  exec "$node" --experimental-strip-types "$root/src/app/tg.ts"
fi

cat >&2 <<EOF
jep: node cannot read $root
     A launchd job gets no access to ~/Documents, ~/Desktop, ~/Downloads or
     iCloud Drive unless the binary running it has Full Disk Access, and the
     read above did not fail — it hung, which is what that block looks like.
     Fix it either way:
       · System Settings → Privacy & Security → Full Disk Access → add
         $node
       · or move the checkout somewhere unprotected (~/code, say) and re-run
         scripts/install.sh
     Details: docs/PROCESSES.md, "the relaunch hangs with an empty log".
     Holding ${hold}s before exiting so this does not spin.
EOF
sleep "$hold"
exit 78

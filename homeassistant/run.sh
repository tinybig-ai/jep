#!/usr/bin/env bash
# The app's entry point: turns /data/options.json into the daemon's
# environment (the same surface scripts/install-linux.sh writes as a systemd
# EnvironmentFile), then execs node. Signals land on the daemon itself, whose
# own handler closes the gateway and every harness child.
#
# Both clients are options, never hard requirements: a Telegram token turns
# the bot on, the gateway switch turns the web app on, in any combination
# (the daemon already runs gateway-only when no token is set). One client
# must be on — with both off the process would sit idle with nothing to serve.
#
# JEP_HA_DRY_RUN=1 prints the decisions (env, files, paths) and exits — used
# by the local checks, never execs the daemon. All paths are parameterized
# for the same reason; in the container none of the overrides are set.
set -euo pipefail
umask 077

options_file="${JEP_OPTIONS_FILE:-/data/options.json}"
jep_data="${JEP_DATA_DIR:-/data/jep}"
app_config="${JEP_APP_CONFIG:-/config}"            # app_config map, /config
src_dir="${JEP_SRC_DIR:-/app/jep}"
dry="${JEP_HA_DRY_RUN:-}"

say() { printf '%s\n' "$*" >&2; }
die() { say "jep-app: $*"; exit 78; }

[ -f "$options_file" ] || die "no $options_file — install via the Home Assistant app UI"
[ -f "$src_dir/src/app/tg.ts" ] || die "jep source missing at $src_dir"

# the app_config folder is writable user space (exposed as addon_configs/jep
# on the host); xdg and home stay inside the app's own /data
mkdir -p "$jep_data/xdg/opencode" "$jep_data/home" "$app_config/opencode"

# one python heredoc does everything JSON-shaped:
#   · options → environment exports (shlex-quoted, written to opts.env)
#   · pasted opencode auth/config validated and written as files
# A pasted opencode_auth is the contents of ~/.local/share/opencode/auth.json;
# opencode_config is ~/.config/opencode/opencode.json. Files placed directly
# in $app_config/opencode (via the addon_configs share) work without any
# paste: XDG_CONFIG_HOME points there, and jep copies XDG_DATA_HOME's
# auth.json into its isolated store at boot (syncOpenCodeAuth). A paste wins
# over a file, so the app UI stays the single place to edit.
env_file="$jep_data/opts.env"
python3 - "$options_file" "$env_file" "$app_config" "$jep_data/xdg" <<'PY'
import json, os, shlex, shutil, sys

options_file, env_file, app_config, xdg_dir = sys.argv[1:5]
try:
    o = json.load(open(options_file))
except json.JSONDecodeError as err:
    sys.exit("%s is not valid JSON: %s" % (options_file, err))

def paste(name, value, path):
    """write one pasted file after checking it is the JSON it claims to be"""
    try:
        json.loads(value)
    except ValueError as err:
        sys.exit("%s is not valid JSON: %s" % (name, err))
    if not value.endswith("\n"):
        value += "\n"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(value)

def group(name):
    value = o.get(name)
    return value if isinstance(value, dict) else {}

def pick(g, key, flat, default=None):
    """a grouped value wins when it is set; a pre-group flat key still works"""
    nested = group(g).get(key, None)
    if nested not in (None, ""):
        return nested
    if flat in o and o.get(flat) not in (None, ""):
        return o.get(flat)
    if nested is not None:
        return nested
    if flat in o:
        return o.get(flat)
    return default

auth = str(pick("harnesses", "opencode_auth", "opencode_auth") or "").strip()
if auth:
    paste("opencode_auth", auth, os.path.join(xdg_dir, "opencode", "auth.json"))
elif os.path.isfile(os.path.join(app_config, "opencode", "auth.json")):
    shutil.copyfile(os.path.join(app_config, "opencode", "auth.json"), os.path.join(xdg_dir, "opencode", "auth.json"))
ocfg = str(pick("harnesses", "opencode_config", "opencode_config") or "").strip()
if ocfg:
    paste("opencode_config", ocfg, os.path.join(app_config, "opencode", "opencode.json"))

order = ["opencode", "codex", "claude", "pi", "goose"]
if "harnesses" in o:
    chosen = group("harnesses")
    enabled = [name for name in order if chosen.get(name, True)]
    default = chosen.get("default") or "opencode"
    if default not in enabled:
        default = enabled[0] if enabled else ""
else:
    enabled = order
    default = "opencode"
if not enabled:
    sys.exit("no harness is switched on — enable opencode, codex, claude, pi, or goose")

gateway_on = pick("gateway", "enabled", "gateway_enabled", True)
pairs = [
    ("JEP_TG_TOKEN", pick("telegram", "token", "telegram_token")),
    ("JEP_TG_FORUM", pick("telegram", "forum", "telegram_forum")),
    ("JEP_GW_PORT", str(int(pick("gateway", "port", "gateway_port", 8099))) if gateway_on else ""),
    ("JEP_GW_BIND", pick("gateway", "bind", "gateway_bind")),
    ("JEP_GW_PAIR_CODE", pick("gateway", "pair_code", "gateway_pair_code")),
    # missing key (an update that has not rewritten options.json yet) stays on
    ("JEP_GW_INGRESS_TRUST", "1" if pick("gateway", "ingress_trust", "ingress_trust", True) else ""),
    ("JEP_WORKSPACES", pick("workspace", "dir", "workspace_dir")),
    ("JEP_BROWSE_ROOT", pick("workspace", "browse_root", "browse_root")),
    ("JEP_MODEL", pick("model", "id", "model")),
    ("OPENROUTER_API_KEY", pick("model", "openrouter_api_key", "openrouter_api_key")),
    ("GH_TOKEN", pick("github", "token", "github_token")),
    ("JEP_TERMINAL", "1" if pick("gateway", "terminal", "terminal_enabled", True) else ""),
    ("JEP_HARNESS", default),
    ("JEP_HARNESSES", ",".join(enabled)),
    ("JEP_TRANSCRIBE_CMD", pick("voice", "command", "transcribe_cmd")),
    ("JEP_TRANSCRIBE_TIMEOUT", str(int(pick("voice", "timeout", "transcribe_timeout") or 0)) if pick("voice", "timeout", "transcribe_timeout") else ""),
    ("JEP_WHISPER_DIR", pick("voice", "whisper_dir", "whisper_dir")),
    ("JEP_WHISPER_MODEL", pick("voice", "whisper_model", "whisper_model")),
    ("JEP_FCM_KEY", pick("push", "fcm_key", "fcm_key")),
    ("JEP_APNS_KEY", pick("push", "apns_key", "apns_key")),
    ("JEP_APNS_KEY_ID", pick("push", "apns_key_id", "apns_key_id")),
    ("JEP_APNS_TEAM_ID", pick("push", "apns_team_id", "apns_team_id")),
    ("JEP_APNS_TOPIC", pick("push", "apns_topic", "apns_topic")),
    ("JEP_APNS_SANDBOX", "1" if pick("push", "apns_sandbox", "apns_sandbox") else ""),
]
with open(env_file, "w") as f:
    f.write("# generated from options.json by run.sh\n")
    for key, value in pairs:
        if value in (None, ""):
            continue
        f.write("export %s=%s\n" % (key, shlex.quote(str(value))))
PY
# shellcheck disable=SC1090
source "$env_file"

if [ -n "${JEP_GW_PORT:-}" ] && [ "$JEP_GW_PORT" != 8099 ]; then
  say "gateway_port is $JEP_GW_PORT; Home Assistant ingress requires 8099, so the sidebar will be unavailable. Direct clients can still use the configured port."
fi

# chat needs at least one served workspace even in pod mode: /new-conversation
# pods live under $JEP_DATA_HOME/pods, but the boot itself throws with zero
# workspaces (src/app/tg.ts). The class of failure the daemon reports as
# "no workspace could be started" starts here, so create the dirs early.
for dir in "${JEP_WORKSPACES:-}" "${JEP_BROWSE_ROOT:-}"; do
  [ -n "$dir" ] && mkdir -p "$dir"
done

# one client must serve or nothing is reachable: with no token and no gateway
# the daemon does start, then idles forever — a wedged app whose log never
# explains why no client ever connects. Fail loudly here, in the UI.
[ -n "${JEP_TG_TOKEN:-}" ] || [ -n "${JEP_GW_PORT:-}" ] \
  || die "nothing to serve — set a Telegram token, or switch the gateway on"

export JEP_DATA_HOME="$jep_data"
export XDG_DATA_HOME="$jep_data/xdg"
export XDG_CONFIG_HOME="$app_config"
export HOME="$jep_data/home"

# GH_TOKEN is gh's supported non-interactive auth path. GitHub is optional:
# without credentials the daemon still starts, and login can happen later.
if [ -z "$dry" ] && command -v gh >/dev/null; then
  if [ -n "${GH_TOKEN:-}" ]; then
    gh auth setup-git || die "gh auth setup-git failed"
    say "gh: using configured token"
  elif gh auth status --hostname github.com >/dev/null 2>&1; then
    gh auth setup-git >/dev/null 2>&1 || true
    say "gh: already logged in"
  else
    say "gh: optional GitHub login is not configured; use gh auth login --web when needed"
  fi
fi

if [ -n "$dry" ]; then
  say "--- dry run: not starting the daemon"
  env | grep -E '^(JEP_|GH_TOKEN=)' \
    | sed -e 's/^JEP_TG_TOKEN=.*/JEP_TG_TOKEN=<redacted>/' -e 's/^GH_TOKEN=.*/GH_TOKEN=<redacted>/' -e 's/^JEP_FCM_KEY=.*/JEP_FCM_KEY=<redacted>/' -e 's/^JEP_GW_PAIR_CODE=.*/JEP_GW_PAIR_CODE=<redacted>/' || true
  say "--- XDG_DATA_HOME=$XDG_DATA_HOME  XDG_CONFIG_HOME=$XDG_CONFIG_HOME  HOME=$HOME"
  say "--- auth.json: $([ -f "$XDG_DATA_HOME/opencode/auth.json" ] && echo written || echo none)"
  say "--- opencode.json: $([ -f "$XDG_CONFIG_HOME/opencode/opencode.json" ] && echo written || echo none)"
  exit 0
fi

cd "$jep_data"
exec node --experimental-strip-types "$src_dir/src/app/tg.ts"

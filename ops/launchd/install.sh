#!/bin/bash
set -euo pipefail
umask 077

[[ "$(uname -s)" = Darwin ]] || { printf 'macos_required\n' >&2; exit 1; }
[[ ( $# -eq 2 || $# -eq 3 || $# -eq 4 ) && "$1" = /* && "$2" =~ ^(enable|preserve)$ ]] || { printf 'usage_error\n' >&2; exit 1; }
launchd_mode="${2:-enable}"
[[ "$launchd_mode" = enable || "$launchd_mode" = preserve ]] || { printf 'usage_error\n' >&2; exit 1; }
allow_x_unavailable=false
[[ "${4:-}" = "--allow-x-unavailable" ]] && allow_x_unavailable=true
[[ -z "${4:-}" || "$allow_x_unavailable" = true ]] || { printf 'usage_error\n' >&2; exit 1; }
release_root="$(realpath "$1")"
case "$release_root" in
  "$HOME/Library/Application Support/AceHunter/releases/"*) ;;
  *) printf 'invalid_release_root\n' >&2; exit 1 ;;
esac
[[ -x "${release_root}/scripts/run-scheduled-x.sh" ]] || { printf 'release_incomplete\n' >&2; exit 1; }
[[ -x "${release_root}/scripts/run-local-worker.sh" ]] || { printf 'release_incomplete\n' >&2; exit 1; }
runtime_env="${3:-${HOME}/Library/Application Support/AceHunter/runtime.env}"
file_owner() { [[ "$(uname -s)" = Darwin ]] && stat -f '%u' "$1" || stat -c '%u' "$1"; }
file_mode() { [[ "$(uname -s)" = Darwin ]] && stat -f '%Lp' "$1" || stat -c '%a' "$1"; }
[[ "$runtime_env" = /* && -f "$runtime_env" && ! -L "$runtime_env" && "$(file_owner "$runtime_env")" = "$(id -u)" && "$(file_mode "$runtime_env")" = 600 ]] || { printf 'runtime_env_invalid\n' >&2; exit 1; }

verify_binary() {
  local resolved owner mode
  resolved="$(realpath "$1")"
  [[ -f "$resolved" && -x "$resolved" && ! -L "$resolved" ]] || return 1
  owner="$(stat -f '%u' "$resolved")"
  mode="$(stat -f '%Lp' "$resolved")"
  [[ "$owner" = 0 || "$owner" = "$(id -u)" ]] || return 1
  (( (8#$mode & 8#022) == 0 )) || return 1
  printf '%s' "$resolved"
}
node_persistent_path="$("${release_root}/scripts/resolve-node22.sh")"
node_path="$(verify_binary "$node_persistent_path")" || { printf 'unsafe_node_binary\n' >&2; exit 1; }
twitter_path="$(verify_binary "$(command -v twitter)")" || { printf 'unsafe_twitter_binary\n' >&2; exit 1; }
"$node_path" --version >/dev/null
if ! "$node_path" "${release_root}/dist/scripts/assert-twitter-preflight.js" --env-file "$runtime_env"; then
  [[ "$allow_x_unavailable" = true ]] || { printf 'x_preflight_required\n' >&2; exit 1; }
fi
# X is an auxiliary source.  Its remote availability must not prevent the
# GitHub-facing Skill and its owner-only runtime configuration from installing.
# The scheduled X job performs this preflight when it actually runs.

app_dir="${HOME}/Library/Application Support/AceHunter"
bin_dir="${app_dir}/bin"
log_dir="${app_dir}/logs"
mkdir -p "$bin_dir" "$log_dir"
chmod 700 "$app_dir" "$bin_dir" "$log_dir"
agent_dir="${HOME}/Library/LaunchAgents"
agent="${agent_dir}/com.kevinyoung.ace-hunter.collect-x.plist"
mkdir -p "$agent_dir"
transaction="$(mktemp -d "${app_dir}/.install.XXXXXX")"
for item in config agent; do printf 'absent\n' >"${transaction}/${item}.state"; done
if [[ -f "${app_dir}/scheduler.conf" && ! -L "${app_dir}/scheduler.conf" ]]; then cp -p "${app_dir}/scheduler.conf" "${transaction}/config"; printf 'file\n' >"${transaction}/config.state"; fi
if [[ -f "$agent" && ! -L "$agent" ]]; then cp -p "$agent" "${transaction}/agent"; printf 'file\n' >"${transaction}/agent.state"; fi
domain="gui/$(id -u)"
rollback() {
  trap - ERR HUP INT TERM
  launchctl bootout "$domain" "$agent" >/dev/null 2>&1 || true
  rm -f "${app_dir}/scheduler.conf" "$agent"
  [[ "$(cat "${transaction}/config.state")" = file ]] && cp -p "${transaction}/config" "${app_dir}/scheduler.conf"
  if [[ "$(cat "${transaction}/agent.state")" = file ]]; then
    cp -p "${transaction}/agent" "$agent"
    launchctl bootstrap "$domain" "$agent" >/dev/null 2>&1 || true
  fi
  rm -rf "$transaction"
}
trap 'rollback' ERR
trap 'rollback; exit 129' HUP
trap 'rollback; exit 130' INT
trap 'rollback; exit 143' TERM
config_tmp="${app_dir}/.scheduler.conf.$$"
quoted() { printf '%q' "$1"; }
proxy_names=(HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY http_proxy https_proxy no_proxy all_proxy SSL_CERT_FILE SSL_CERT_DIR)
{
  printf 'NODE_PATH=%s\n' "$(quoted "$node_persistent_path")"
  printf 'TWITTER_CLI_PATH=%s\n' "$(quoted "$twitter_path")"
  printf 'RUNTIME_ENV_FILE=%s\n' "$(quoted "$runtime_env")"
  printf 'RELEASE_ROOT=%s\n' "$(quoted "$release_root")"
  for name in "${proxy_names[@]}"; do
    [[ -n "${!name:-}" ]] && printf '%s=%s\n' "$name" "$(quoted "${!name}")"
  done
} >"$config_tmp"
chmod 600 "$config_tmp"
mv -f "$config_tmp" "${app_dir}/scheduler.conf"

cp "${release_root}/ops/launchd/com.kevinyoung.ace-hunter.collect-x.plist" "${agent}.tmp"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 ${release_root}/scripts/run-local-worker.sh" "${agent}.tmp"
/usr/libexec/PlistBuddy -c "Set :StandardOutPath ${log_dir}/collect-x.log" "${agent}.tmp"
/usr/libexec/PlistBuddy -c "Set :StandardErrorPath ${log_dir}/collect-x.error.log" "${agent}.tmp"
plutil -lint "${agent}.tmp" >/dev/null
chmod 600 "${agent}.tmp"
mv -f "${agent}.tmp" "$agent"
launchctl bootout "$domain" "$agent" >/dev/null 2>&1 || true
"${release_root}/scripts/activate-launch-agent.sh" "$launchd_mode" "$domain" "$agent" \
  "${domain}/com.kevinyoung.ace-hunter.collect-x"
trap - ERR HUP INT TERM
rm -rf "$transaction"
printf 'launchd_installed\n'

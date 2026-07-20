#!/bin/bash
set -euo pipefail
umask 077

[[ "$(uname -s)" = Darwin ]] || { printf 'macos_required\n' >&2; exit 1; }
[[ ( $# -eq 1 || $# -eq 2 ) && "$1" = /* ]] || { printf 'usage_error\n' >&2; exit 1; }
launchd_mode="${2:-enable}"
[[ "$launchd_mode" = enable || "$launchd_mode" = preserve ]] || { printf 'usage_error\n' >&2; exit 1; }
release_root="$(realpath "$1")"
case "$release_root" in
  "$HOME/Library/Application Support/AceHunter/releases/"*) ;;
  *) printf 'invalid_release_root\n' >&2; exit 1 ;;
esac
[[ -x "${release_root}/scripts/run-scheduled-x.sh" ]] || { printf 'release_incomplete\n' >&2; exit 1; }

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
"$node_path" "${release_root}/dist/scripts/assert-twitter-preflight.js" --twitter-cli-path "$twitter_path" >/dev/null

app_dir="${HOME}/Library/Application Support/AceHunter"
bin_dir="${app_dir}/bin"
log_dir="${app_dir}/logs"
mkdir -p "$bin_dir" "$log_dir"
chmod 700 "$app_dir" "$bin_dir" "$log_dir"
agent_dir="${HOME}/Library/LaunchAgents"
agent="${agent_dir}/com.kevinyoung.ace-hunter.collect-x.plist"
mkdir -p "$agent_dir"
transaction="$(mktemp -d "${app_dir}/.install.XXXXXX")"
for item in helper config agent; do printf 'absent\n' >"${transaction}/${item}.state"; done
if [[ -f "${bin_dir}/keychain-secret" && ! -L "${bin_dir}/keychain-secret" ]]; then cp -p "${bin_dir}/keychain-secret" "${transaction}/helper"; printf 'file\n' >"${transaction}/helper.state"; fi
if [[ -f "${app_dir}/scheduler.conf" && ! -L "${app_dir}/scheduler.conf" ]]; then cp -p "${app_dir}/scheduler.conf" "${transaction}/config"; printf 'file\n' >"${transaction}/config.state"; fi
if [[ -f "$agent" && ! -L "$agent" ]]; then cp -p "$agent" "${transaction}/agent"; printf 'file\n' >"${transaction}/agent.state"; fi
domain="gui/$(id -u)"
helper_build_dir=""
rollback() {
  trap - ERR HUP INT TERM
  launchctl bootout "$domain" "$agent" >/dev/null 2>&1 || true
  rm -f "${bin_dir}/keychain-secret" "${app_dir}/scheduler.conf" "$agent"
  [[ "$(cat "${transaction}/helper.state")" = file ]] && cp -p "${transaction}/helper" "${bin_dir}/keychain-secret"
  [[ "$(cat "${transaction}/config.state")" = file ]] && cp -p "${transaction}/config" "${app_dir}/scheduler.conf"
  if [[ "$(cat "${transaction}/agent.state")" = file ]]; then
    cp -p "${transaction}/agent" "$agent"
    launchctl bootstrap "$domain" "$agent" >/dev/null 2>&1 || true
  fi
  case "$helper_build_dir" in "${bin_dir}"/keychain-build.*) rm -rf "$helper_build_dir";; esac
  rm -rf "$transaction"
}
trap 'rollback' ERR
trap 'rollback; exit 129' HUP
trap 'rollback; exit 130' INT
trap 'rollback; exit 143' TERM
helper_build_dir="$(mktemp -d "${bin_dir}/keychain-build.XXXXXX")"
helper_tmp="${helper_build_dir}/keychain-secret"
xcrun swiftc -module-name AceHunterKeychain -framework Security "${release_root}/ops/launchd/keychain-secret.swift" -o "$helper_tmp"
chmod 700 "$helper_tmp"
if [[ -e "${bin_dir}/keychain-secret" ]]; then
  cmp -s "$helper_tmp" "${bin_dir}/keychain-secret" || { printf 'keychain_helper_upgrade_requires_migration\n' >&2; exit 1; }
  rm -f "$helper_tmp"
else
  mv -f "$helper_tmp" "${bin_dir}/keychain-secret"
fi
rmdir "$helper_build_dir"
helper_build_dir=""

config_tmp="${app_dir}/.scheduler.conf.$$"
quoted() { printf '%q' "$1"; }
proxy_names=(HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY http_proxy https_proxy no_proxy all_proxy SSL_CERT_FILE SSL_CERT_DIR)
{
  printf 'NODE_PATH=%s\n' "$(quoted "$node_persistent_path")"
  printf 'TWITTER_CLI_PATH=%s\n' "$(quoted "$twitter_path")"
  printf 'KEYCHAIN_HELPER=%s\n' "$(quoted "${bin_dir}/keychain-secret")"
  printf 'RELEASE_ROOT=%s\n' "$(quoted "$release_root")"
  for name in "${proxy_names[@]}"; do
    [[ -n "${!name:-}" ]] && printf '%s=%s\n' "$name" "$(quoted "${!name}")"
  done
} >"$config_tmp"
chmod 600 "$config_tmp"
mv -f "$config_tmp" "${app_dir}/scheduler.conf"

cp "${release_root}/ops/launchd/com.kevinyoung.ace-hunter.collect-x.plist" "${agent}.tmp"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 ${release_root}/scripts/run-scheduled-x.sh" "${agent}.tmp"
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

#!/bin/bash
set -euo pipefail
umask 077
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
release_root="$(cd "${script_dir}/.." && pwd -P)"
app_dir="${HOME}/Library/Application Support/AceHunter"
file_owner() { [[ "$(uname -s)" = Darwin ]] && stat -f '%u' "$1" || stat -c '%u' "$1"; }
file_mode() { [[ "$(uname -s)" = Darwin ]] && stat -f '%Lp' "$1" || stat -c '%a' "$1"; }
if [[ -n "${ACE_HUNTER_ENV_FILE:-}" ]]; then
  [[ "$ACE_HUNTER_ENV_FILE" = /* && -f "$ACE_HUNTER_ENV_FILE" && ! -L "$ACE_HUNTER_ENV_FILE" ]] || exit 1
  node_path="$("${release_root}/scripts/resolve-node22.sh" --fallback ${NODE_PATH:+"$NODE_PATH"})"
  exec "$node_path" "${release_root}/dist/src/cli/index.js" "$@"
fi
# shellcheck disable=SC1090
source "${app_dir}/scheduler.conf"
NODE_PATH="$("${release_root}/scripts/resolve-node22.sh" --fallback "$NODE_PATH")"
[[ -n "${RUNTIME_ENV_FILE:-}" && "$RUNTIME_ENV_FILE" = /* && -f "$RUNTIME_ENV_FILE" && ! -L "$RUNTIME_ENV_FILE" &&
  "$(file_owner "$RUNTIME_ENV_FILE")" = "$(id -u)" && "$(file_mode "$RUNTIME_ENV_FILE")" = 600 ]] || exit 1
set +e
ACE_HUNTER_ENV_FILE="$RUNTIME_ENV_FILE" TWITTER_CLI_PATH="$TWITTER_CLI_PATH" "$NODE_PATH" "${release_root}/dist/src/cli/index.js" "$@"
status=$?
set -e
exit "$status"

#!/bin/bash
set -euo pipefail
umask 077
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
release_root="$(cd "${script_dir}/.." && pwd -P)"
app_dir="${HOME}/Library/Application Support/AceHunter"
if [[ -n "${ACE_HUNTER_ENV_FILE:-}" ]]; then
  [[ "$ACE_HUNTER_ENV_FILE" = /* && -f "$ACE_HUNTER_ENV_FILE" && ! -L "$ACE_HUNTER_ENV_FILE" ]] || exit 1
  node_path="$("${release_root}/scripts/resolve-node22.sh" --fallback ${NODE_PATH:+"$NODE_PATH"})"
  exec "$node_path" "${release_root}/dist/src/cli/index.js" "$@"
fi
# shellcheck disable=SC1090
source "${app_dir}/scheduler.conf"
NODE_PATH="$("${release_root}/scripts/resolve-node22.sh" --fallback "$NODE_PATH")"
runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/ace-hunter-user.XXXXXX")"
trap 'rm -rf "$runtime_dir"' EXIT INT TERM
env_file="${runtime_dir}/runtime.env"
touch "$env_file" && chmod 600 "$env_file"
"$NODE_PATH" "${release_root}/dist/scripts/pipe-env-value.js" ACE_HUNTER_RUNTIME_DATABASE_URL < <("$KEYCHAIN_HELPER" get runtime-database-url) >>"$env_file"
case "${1:-}" in
  potential|trending) ;;
  *)
    "$NODE_PATH" "${release_root}/dist/scripts/pipe-env-value.js" ACE_HUNTER_GITHUB_TOKEN < <("$KEYCHAIN_HELPER" get github-token) >>"$env_file"
    "$NODE_PATH" "${release_root}/dist/scripts/pipe-env-value.js" ACE_HUNTER_USER_ID < <("$KEYCHAIN_HELPER" get user-id) >>"$env_file"
    "$NODE_PATH" "${release_root}/dist/scripts/pipe-env-value.js" ACE_HUNTER_DEEPSEEK_API_KEY < <("$KEYCHAIN_HELPER" get deepseek-api-key) >>"$env_file"
    ;;
esac
set +e
ACE_HUNTER_ENV_FILE="$env_file" TWITTER_CLI_PATH="$TWITTER_CLI_PATH" "$NODE_PATH" "${release_root}/dist/src/cli/index.js" "$@"
status=$?
set -e
rm -rf "$runtime_dir"
trap - EXIT INT TERM
exit "$status"

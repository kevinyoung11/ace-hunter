#!/bin/bash
set -euo pipefail
umask 077

app_dir="${HOME}/Library/Application Support/AceHunter"
config="${app_dir}/scheduler.conf"
lock_dir="${app_dir}/run/x-worker.lock"
owner_file="${lock_dir}/owner"
[[ -f "$config" && ! -L "$config" ]] || { printf 'worker_config_missing\n' >&2; exit 1; }
file_owner() { [[ "$(uname -s)" = Darwin ]] && stat -f '%u' "$1" || stat -c '%u' "$1"; }
file_mode() { [[ "$(uname -s)" = Darwin ]] && stat -f '%Lp' "$1" || stat -c '%a' "$1"; }
[[ "$(file_owner "$config")" = "$(id -u)" && "$(file_mode "$config")" = 600 ]] || { printf 'worker_config_invalid\n' >&2; exit 1; }
# shellcheck disable=SC1090
source "$config"
node_path="${NODE_PATH:-}"
release_root="${RELEASE_ROOT:-}"
[[ -x "$node_path" && ! -L "$node_path" && -d "$release_root" && ! -L "$release_root" ]] || { printf 'worker_runtime_invalid\n' >&2; exit 1; }
mkdir -p "${app_dir}/run"
if ! mkdir "$lock_dir" 2>/dev/null; then
  if [[ -f "$owner_file" ]]; then
    owner_pid="$(sed -n '1p' "$owner_file" || true)"
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
      exit 0
    fi
  else
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 0.05
      [[ -f "$owner_file" ]] && break
    done
    if [[ -f "$owner_file" ]]; then exit 0; fi
  fi
  rm -rf "$lock_dir"
  mkdir "$lock_dir"
fi
printf '%s\n%s\n' "$$" "$release_root/scripts/run-local-worker.sh" >"$owner_file"
cleanup() { rm -rf "$lock_dir"; }
stop() { cleanup; trap - EXIT; exit 143; }
trap cleanup EXIT
trap stop HUP INT TERM

worker_id="${ACE_HUNTER_WORKER_ID:-mac-${HOSTNAME:-local}-$$}"
worker_args=("$node_path" "$release_root/dist/src/cli/index.js" worker x)
[[ "${1:-}" = "--once" ]] && worker_args+=("--once")
worker_args+=(--worker-id "$worker_id" --poll-seconds "${ACE_HUNTER_WORKER_POLL_SECONDS:-30}")
"${worker_args[@]}"

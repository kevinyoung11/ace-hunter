#!/bin/bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
script_realpath="${script_dir}/$(basename "$0")"
app_dir="${HOME}/Library/Application Support/AceHunter"
config_file="${app_dir}/scheduler.conf"
lock_dir="${app_dir}/run/collect-x.lock"

fail() { printf '%s\n' "$1" >&2; exit 1; }
file_owner() { [[ "$(uname -s)" = Darwin ]] && stat -f '%u' "$1" || stat -c '%u' "$1"; }
file_mode() { [[ "$(uname -s)" = Darwin ]] && stat -f '%Lp' "$1" || stat -c '%a' "$1"; }
[[ -f "$config_file" && ! -L "$config_file" ]] || fail configuration_error
# shellcheck disable=SC1090
source "$config_file"
for name in NODE_PATH TWITTER_CLI_PATH RUNTIME_ENV_FILE RELEASE_ROOT; do
  [[ -n "${!name:-}" && "${!name}" = /* ]] || fail configuration_error
done
NODE_PATH="$("${RELEASE_ROOT}/scripts/resolve-node22.sh" --fallback "$NODE_PATH")"
[[ -f "$RUNTIME_ENV_FILE" && ! -L "$RUNTIME_ENV_FILE" && "$(file_owner "$RUNTIME_ENV_FILE")" = "$(id -u)" && "$(file_mode "$RUNTIME_ENV_FILE")" = 600 ]] || fail runtime_environment_error
for name in HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY http_proxy https_proxy no_proxy all_proxy SSL_CERT_FILE SSL_CERT_DIR; do
  [[ -n "${!name:-}" ]] && export "$name"
done

mkdir -p "${app_dir}/run"
acquire_lock() {
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n%s\n' "$$" "$script_realpath" >"${lock_dir}/owner.$$"
    mv "${lock_dir}/owner.$$" "${lock_dir}/owner"
    return 0
  fi
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    [[ -f "${lock_dir}/owner" && ! -L "${lock_dir}/owner" ]] && break
    sleep 0.05
  done
  # A fresh ownerless lock may still be initializing. A lock older than the
  # bounded initialization window is crash residue and is safe to recover.
  if [[ ! -f "${lock_dir}/owner" || -L "${lock_dir}/owner" ]]; then
    local modified now_seconds
    case "$(uname -s)" in
      Darwin) modified="$(stat -f '%m' "$lock_dir" 2>/dev/null || true)" ;;
      *) modified="$(stat -c '%Y' "$lock_dir" 2>/dev/null || true)" ;;
    esac
    now_seconds="$(date '+%s')"
    [[ "$modified" =~ ^[0-9]+$ && "$now_seconds" =~ ^[0-9]+$ ]] || return 2
    (( now_seconds - modified >= 60 )) && return 1
    return 2
  fi
  local pid recorded actual uid
  { IFS= read -r pid; IFS= read -r recorded; } <"${lock_dir}/owner" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$recorded" = "$script_realpath" ]] || return 1
  actual="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  uid="$(ps -p "$pid" -o uid= 2>/dev/null | tr -d ' ' || true)"
  [[ "$uid" = "$(id -u)" && "$actual" = *"$script_realpath"* ]] && return 2
  return 1
}

set +e
acquire_lock
status=$?
set -e
if [[ "$status" -ne 0 ]]; then
  [[ "$status" -eq 2 ]] && exit 0
  rm -rf "$lock_dir"
  acquire_lock || fail scheduler_lock_error
fi
cleanup_lock() {
  if [[ -f "${lock_dir}/owner" ]] && [[ "$(head -n 1 "${lock_dir}/owner" 2>/dev/null || true)" = "$$" ]]; then
    rm -rf "$lock_dir"
  fi
}
cleanup() { cleanup_lock; }
active_pid=""
terminate_active() {
  if [[ -n "$active_pid" ]] && kill -0 "$active_pid" 2>/dev/null; then
    pkill -TERM -P "$active_pid" 2>/dev/null || true
    kill -TERM "$active_pid" 2>/dev/null || true
    wait "$active_pid" 2>/dev/null || true
  fi
  active_pid=""
}
run_child() {
  "$@" &
  active_pid=$!
  set +e
  wait "$active_pid"
  local child_status=$?
  set -e
  active_pid=""
  return "$child_status"
}
trap cleanup EXIT
trap 'terminate_active; cleanup; trap - EXIT; exit 130' INT
trap 'terminate_active; cleanup; trap - EXIT; exit 143' TERM
TWITTER_CLI_PATH="$TWITTER_CLI_PATH" run_child "$NODE_PATH" "${RELEASE_ROOT}/dist/scripts/assert-twitter-preflight.js" --env-file "$RUNTIME_ENV_FILE"
run_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
scheduled_for="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
for job in collect_x_posts analyze_x_posts collect_x_comments; do
  ACE_HUNTER_ENV_FILE="$RUNTIME_ENV_FILE" TWITTER_CLI_PATH="$TWITTER_CLI_PATH" run_child "$NODE_PATH" "${RELEASE_ROOT}/dist/src/cli/index.js" job "$job" \
    --scheduled-for "$scheduled_for" --scheduler launchd --scheduler-run-id "$run_id"
done

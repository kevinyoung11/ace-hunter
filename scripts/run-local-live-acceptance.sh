#!/bin/bash
set -euo pipefail
umask 077

[[ $# -eq 2 && "$1" = /* && "$2" = --bootstrap-if-missing ]] || { printf 'usage_error\n' >&2; exit 1; }
source_env="$1"
repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$repo_root"
app_dir="${HOME}/Library/Application Support/AceHunter"
mkdir -p "$app_dir" && chmod 700 "$app_dir"
credential_store="${app_dir}/runtime-credentials.env"

prepare() {
  node --import tsx scripts/prepare-live-env.ts --mode "$1" --source "$source_env" --credential-store "$credential_store"
}
set +e
live_env="$(prepare local 2>/dev/null)"
prepare_status=$?
set -e
if [[ "$prepare_status" -ne 0 ]]; then live_env="$(prepare bootstrap)"; fi

validate_live_env() {
  local resolved directory owner dir_mode file_mode
  local temp_base="${TMPDIR:-/tmp}"
  temp_base="$(realpath "${temp_base%/}")"
  resolved="$(realpath "$live_env")"
  directory="$(dirname "$resolved")"
  case "$resolved" in "${temp_base}"/ace-hunter-live-*/runtime.env) ;; *) return 1;; esac
  owner="$(stat -f '%u' "$resolved" 2>/dev/null || stat -c '%u' "$resolved")"
  dir_mode="$(stat -f '%Lp' "$directory" 2>/dev/null || stat -c '%a' "$directory")"
  file_mode="$(stat -f '%Lp' "$resolved" 2>/dev/null || stat -c '%a' "$resolved")"
  [[ "$owner" = "$(id -u)" && "$dir_mode" = 700 && "$file_mode" = 600 ]] || return 1
  live_env="$resolved"
}
validate_live_env || { printf 'invalid_live_env_artifact\n' >&2; exit 1; }
cleanup() {
  if validate_live_env; then rm -rf "$(dirname "$live_env")"; fi
}
trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 130' INT
trap 'cleanup; trap - EXIT; exit 143' TERM

export ACE_E2E_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
ACE_HUNTER_ENV_FILE="$live_env" npm run db:migrate
fingerprint_file="$(node --input-type=module -e 'import{readFileSync}from"node:fs";import{parse}from"dotenv";const v=parse(readFileSync(process.argv[1],"utf8")).ACE_HUNTER_ADMIN_FINGERPRINT_FILE;if(!v||!v.startsWith("/"))process.exit(1);process.stdout.write(v)' "$live_env")"
ACE_HUNTER_ENV_FILE="$live_env" npm run safety:schema -- verify "$fingerprint_file"
ACE_HUNTER_ENV_FILE="$live_env" npm run safety:runtime
ACE_HUNTER_ENV_FILE="$live_env" npm run smoke:github -- --max-new 3
ACE_HUNTER_ENV_FILE="$live_env" npm run smoke:x
ACE_HUNTER_ENV_FILE="$live_env" npm run e2e:live -- --max-new 3
ACE_HUNTER_ENV_FILE="$live_env" RUN_LIVE_E2E=1 npm test -- --run tests/e2e/live-system.test.ts
cleanup
trap - EXIT INT TERM
printf 'local_live_acceptance_passed\n'

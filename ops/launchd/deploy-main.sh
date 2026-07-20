#!/bin/bash
set -euo pipefail
umask 077

[[ $# -eq 3 && "$1" =~ ^[0-9a-f]{40}$ && "$2" = /* && "$3" = /* ]] || { printf 'usage_error\n' >&2; exit 1; }
main_sha="$1"
live_env="$2"
transaction="$3"
[[ -f "$live_env" && ! -L "$live_env" ]] || { printf 'invalid_live_env\n' >&2; exit 1; }
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
repo_root="$(cd "${script_dir}/../.." && pwd -P)"
transaction_helper="${repo_root}/scripts/release-transaction.mjs"
integrity_helper="${repo_root}/scripts/release-integrity.mjs"
git fetch --quiet origin main
remote_main="$(git rev-parse origin/main)"
[[ "$main_sha" = "$remote_main" ]] || { printf 'sha_not_remote_main\n' >&2; exit 1; }
git cat-file -e "${main_sha}^{commit}"

node_path="$(command -v node)"
node_path="$(realpath "$node_path")"
"$node_path" "$transaction_helper" verify "$transaction" >/dev/null
rollback_exit() {
  local status="$1"
  trap - ERR HUP INT TERM
  "$node_path" "$transaction_helper" rollback "$transaction" >/dev/null || status=1
  exit "$status"
}
trap 'rollback_exit $?' ERR
trap 'rollback_exit 129' HUP
trap 'rollback_exit 130' INT
trap 'rollback_exit 143' TERM

app_dir="${HOME}/Library/Application Support/AceHunter"
releases_dir="${app_dir}/releases"
candidate="${releases_dir}/${main_sha}"
case "$candidate" in *'.config/superpowers/worktrees'*) printf 'worktree_release_rejected\n' >&2; exit 1;; esac
mkdir -p "$releases_dir" "${app_dir}/bin"
chmod 700 "$app_dir" "$releases_dir" "${app_dir}/bin"
if [[ -e "$candidate" || -L "$candidate" ]]; then
  [[ -d "$candidate" && ! -L "$candidate" ]] || { printf 'release_path_invalid\n' >&2; exit 1; }
  "$node_path" "$integrity_helper" verify "$candidate" "$main_sha" >/dev/null
else
  candidate_tmp="${releases_dir}/.${main_sha}.$$"
  mkdir "$candidate_tmp"
  git archive "$main_sha" | tar -x -C "$candidate_tmp"
  (cd "$candidate_tmp" && npm ci && npm run build && npm run skill:validate)
  "$node_path" "$integrity_helper" seal "$candidate_tmp" "$main_sha" >/dev/null
  "$node_path" "$integrity_helper" verify "$candidate_tmp" "$main_sha" >/dev/null
  mv "$candidate_tmp" "$candidate"
fi
"$node_path" "$integrity_helper" verify "$candidate" "$main_sha" >/dev/null
ACE_HUNTER_ENV_FILE="$live_env" "$node_path" "${candidate}/dist/src/cli/index.js" list >/dev/null
"$node_path" "${candidate}/scripts/validate-skill.mjs" "${candidate}/skills/ace-hunter" >/dev/null

readonly_env="${transaction}/readonly.env"
readonly_tmp="${readonly_env}.new.$$"
"$node_path" "${candidate}/dist/scripts/pipe-env-value.js" "$live_env" ACE_HUNTER_RUNTIME_DATABASE_URL |
  "$node_path" "${candidate}/dist/scripts/pipe-env-value.js" ACE_HUNTER_RUNTIME_DATABASE_URL >"$readonly_tmp"
chmod 600 "$readonly_tmp"
mv "$readonly_tmp" "$readonly_env"
smoke_dir="${transaction}/deploy-smoke"
mkdir "$smoke_dir"
chmod 700 "$smoke_dir"

current="${app_dir}/current"
wrapper="${app_dir}/bin/ace-hunter"
codex_home="${CODEX_HOME:-$HOME/.codex}"
skill_link="${codex_home}/skills/ace-hunter"
mkdir -p "${codex_home}/skills"
if [[ -e "$current" && ! -L "$current" ]]; then printf 'current_conflict\n' >&2; exit 1; fi
if [[ -e "$wrapper" && ( ! -f "$wrapper" || -L "$wrapper" ) ]]; then printf 'wrapper_conflict\n' >&2; exit 1; fi
if [[ -e "$skill_link" || -L "$skill_link" ]]; then
  [[ -L "$skill_link" ]] || { printf 'skill_conflict\n' >&2; exit 1; }
  skill_target="$(readlink "$skill_link")"
  case "$skill_target" in "$app_dir"/*) ;; *) printf 'skill_conflict\n' >&2; exit 1;; esac
fi
atomic_replace() {
  "$node_path" -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' "$1" "$2"
}
ln -s "$candidate" "${current}.new.$$"
atomic_replace "${current}.new.$$" "$current"
wrapper_tmp="${wrapper}.new.$$"
{
  printf '#!/bin/bash\n'
  printf 'NODE_PATH=%q exec %q "$@"\n' "$node_path" "${current}/scripts/run-user-command.sh"
} >"$wrapper_tmp"
chmod 755 "$wrapper_tmp"
atomic_replace "$wrapper_tmp" "$wrapper"
ln -s "${current}/skills/ace-hunter" "${skill_link}.new.$$"
atomic_replace "${skill_link}.new.$$" "$skill_link"
ACE_HUNTER_ENV_FILE="$live_env" "$wrapper" list >/dev/null
env -i HOME="$HOME" PATH="/usr/bin:/bin" NODE_PATH="$node_path" \
  ACE_HUNTER_ENV_FILE="$readonly_env" "$wrapper" potential --format json >"${smoke_dir}/potential.json"
env -i HOME="$HOME" PATH="/usr/bin:/bin" NODE_PATH="$node_path" \
  ACE_HUNTER_ENV_FILE="$readonly_env" "$wrapper" trending daily --format json >"${smoke_dir}/daily.json"
env -i HOME="$HOME" PATH="/usr/bin:/bin" NODE_PATH="$node_path" \
  ACE_HUNTER_ENV_FILE="$readonly_env" "$wrapper" trending weekly --format json >"${smoke_dir}/weekly.json"
env -i HOME="$HOME" PATH="/usr/bin:/bin" NODE_PATH="$node_path" \
  ACE_HUNTER_ENV_FILE="$readonly_env" "$wrapper" trending monthly --format json >"${smoke_dir}/monthly.json"
env -i HOME="$HOME" PATH="/usr/bin:/bin" NODE_PATH="$node_path" \
  ACE_HUNTER_ENV_FILE="$readonly_env" "$wrapper" trending all --format json >"${smoke_dir}/all.json"
chmod 600 "${smoke_dir}"/*.json
"$node_path" "${candidate}/dist/scripts/validate-signal-release.js" allow-empty \
  "${smoke_dir}/potential.json" "${smoke_dir}/daily.json" "${smoke_dir}/weekly.json" \
  "${smoke_dir}/monthly.json" "${smoke_dir}/all.json" >/dev/null
"$node_path" "${current}/scripts/validate-skill.mjs" "$skill_link" >/dev/null
trap - ERR HUP INT TERM
printf 'deployed %s\n' "$main_sha"

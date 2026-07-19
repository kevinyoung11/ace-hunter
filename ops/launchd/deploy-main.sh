#!/bin/bash
set -euo pipefail
umask 077

[[ $# -eq 2 && "$1" =~ ^[0-9a-f]{40}$ && "$2" = /* ]] || { printf 'usage_error\n' >&2; exit 1; }
main_sha="$1"
live_env="$2"
[[ -f "$live_env" && ! -L "$live_env" ]] || { printf 'invalid_live_env\n' >&2; exit 1; }
git fetch --quiet origin main
remote_main="$(git rev-parse origin/main)"
[[ "$main_sha" = "$remote_main" ]] || { printf 'sha_not_remote_main\n' >&2; exit 1; }
git cat-file -e "${main_sha}^{commit}"

app_dir="${HOME}/Library/Application Support/AceHunter"
releases_dir="${app_dir}/releases"
candidate="${releases_dir}/${main_sha}"
case "$candidate" in *'.config/superpowers/worktrees'*) printf 'worktree_release_rejected\n' >&2; exit 1;; esac
mkdir -p "$releases_dir" "${app_dir}/bin"
chmod 700 "$app_dir" "$releases_dir" "${app_dir}/bin"
if [[ ! -d "$candidate" ]]; then
  candidate_tmp="${releases_dir}/.${main_sha}.$$"
  mkdir "$candidate_tmp"
  git archive "$main_sha" | tar -x -C "$candidate_tmp"
  (cd "$candidate_tmp" && npm ci && npm run build && npm run skill:validate)
  printf '{"sha":"%s","created_at":"%s"}\n' "$main_sha" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >"${candidate_tmp}/release-manifest.json"
  mv "$candidate_tmp" "$candidate"
fi
node_path="$(command -v node)"
node_path="$(realpath "$node_path")"
ACE_HUNTER_ENV_FILE="$live_env" "$node_path" "${candidate}/dist/src/cli/index.js" list --format json >/dev/null
"$node_path" "${candidate}/scripts/validate-skill.mjs" "${candidate}/skills/ace-hunter" >/dev/null

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

transaction="$(mktemp -d "${app_dir}/.deploy.XXXXXX")"
cleanup_transaction() { rm -rf "$transaction"; }
trap cleanup_transaction EXIT
for artifact in current wrapper skill; do printf 'absent\n' >"${transaction}/${artifact}.state"; done
if [[ -L "$current" ]]; then readlink "$current" >"${transaction}/current.target"; printf 'link\n' >"${transaction}/current.state"; fi
if [[ -f "$wrapper" && ! -L "$wrapper" ]]; then cp -p "$wrapper" "${transaction}/wrapper.bytes"; printf 'file\n' >"${transaction}/wrapper.state"; fi
if [[ -L "$skill_link" ]]; then readlink "$skill_link" >"${transaction}/skill.target"; printf 'link\n' >"${transaction}/skill.state"; fi
rollback() {
  trap - ERR HUP INT TERM
  rm -f "$current" "$wrapper" "$skill_link"
  if [[ "$(cat "${transaction}/current.state")" = link ]]; then ln -s "$(cat "${transaction}/current.target")" "${current}.rollback.$$"; atomic_replace "${current}.rollback.$$" "$current"; fi
  if [[ "$(cat "${transaction}/wrapper.state")" = file ]]; then cp -p "${transaction}/wrapper.bytes" "${wrapper}.rollback.$$"; atomic_replace "${wrapper}.rollback.$$" "$wrapper"; fi
  if [[ "$(cat "${transaction}/skill.state")" = link ]]; then ln -s "$(cat "${transaction}/skill.target")" "${skill_link}.rollback.$$"; atomic_replace "${skill_link}.rollback.$$" "$skill_link"; fi
}
atomic_replace() {
  "$node_path" -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' "$1" "$2"
}
rollback_exit() {
  local status="$1"
  rollback
  cleanup_transaction
  trap - EXIT
  exit "$status"
}
trap 'rollback_exit $?' ERR
trap 'rollback_exit 129' HUP
trap 'rollback_exit 130' INT
trap 'rollback_exit 143' TERM
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
ACE_HUNTER_ENV_FILE="$live_env" "$wrapper" list --format json >/dev/null
"$node_path" "${current}/scripts/validate-skill.mjs" "$skill_link" >/dev/null
trap - ERR HUP INT TERM
trap cleanup_transaction EXIT
printf 'deployed %s\n' "$main_sha"

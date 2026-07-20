#!/bin/bash
set -euo pipefail
umask 077
: "${SOURCE_ENV:?SOURCE_ENV is required}"
: "${GH_REPO:?GH_REPO owner/name is required}"
: "${ACE_E2E_REPOSITORY:?ACE_E2E_REPOSITORY is required}"
[[ "$SOURCE_ENV" = /* ]] || { printf 'source_env_must_be_absolute\n' >&2; exit 1; }

repo_root="$(git rev-parse --show-toplevel)"
old_worktree="$(pwd -P)"
export ACCEPTANCE_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
pr_json="$(gh pr view --json number,state,headRefOid)"
pr_number="$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.number))' "$pr_json")"
pr_head="$(node -e 'const x=JSON.parse(process.argv[1]);if(!/^[a-f0-9]{40}$/.test(x.headRefOid))process.exit(1);process.stdout.write(x.headRefOid)' "$pr_json")"
pr_state="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).state)' "$pr_json")"
if [[ "$pr_state" = OPEN ]]; then gh pr merge "$pr_number" --merge --delete-branch=false; fi
git fetch --quiet origin main
main_sha="$(git rev-parse origin/main)"
git merge-base --is-ancestor "$pr_head" "$main_sha"

app_dir="${HOME}/Library/Application Support/AceHunter"
helper="${app_dir}/bin/keychain-secret"
[[ -x "$helper" ]] || { printf 'keychain_helper_missing\n' >&2; exit 1; }
live_env="$(node --import tsx scripts/prepare-live-env.ts --mode release --source "$SOURCE_ENV" --keychain-helper "$helper")"
live_env="$(realpath "$live_env")"
live_dir="$(dirname "$live_env")"
temp_base="${TMPDIR:-/tmp}"; temp_base="$(realpath "${temp_base%/}")"
case "$live_env" in "${temp_base}"/ace-hunter-live-*/runtime.env) ;; *) exit 1;; esac
[[ "$(stat -f '%u' "$live_env")" = "$(id -u)" && "$(stat -f '%Lp' "$live_dir")" = 700 && "$(stat -f '%Lp' "$live_env")" = 600 ]] || exit 1

rollback_dir="${live_dir}/keychain-rollback"
mkdir "$rollback_dir" && chmod 700 "$rollback_dir"
transaction_helper="${live_dir}/release-transaction.mjs"
cp scripts/release-transaction.mjs "$transaction_helper"
chmod 600 "$transaction_helper"
release_transaction="${live_dir}/release-rollback"
transaction_started=0
transaction_committed=0
snapshot_complete=0
cleanup() {
  trap - EXIT
  local restore_failed=0
  if [[ "$transaction_started" -eq 1 ]]; then
    if [[ "$transaction_committed" -eq 1 ]]; then
      if ! node "$transaction_helper" commit "$release_transaction" >/dev/null; then
        transaction_committed=0
        restore_failed=1
        node "$transaction_helper" rollback "$release_transaction" >/dev/null || restore_failed=1
      fi
    else
      node "$transaction_helper" rollback "$release_transaction" >/dev/null || restore_failed=1
    fi
  fi
  if [[ "$transaction_committed" -eq 0 && "$snapshot_complete" -eq 1 ]]; then
    for account in runtime-database-url github-token user-id deepseek-api-key; do
      if [[ -f "${rollback_dir}/${account}" ]]; then "$helper" set "$account" <"${rollback_dir}/${account}" || restore_failed=1
      elif [[ -f "${rollback_dir}/${account}.absent" ]]; then "$helper" delete "$account" >/dev/null 2>&1 || restore_failed=1; fi
    done
  fi
  if [[ "$restore_failed" -ne 0 ]]; then
    printf 'release_rollback_failed artifact=%s\n' "$live_dir" >&2
    return 1
  fi
  case "$live_dir" in "${temp_base}"/ace-hunter-live-*) rm -rf "$live_dir";; esac
}
on_exit() { local exit_code=$?; cleanup || exit 1; exit "$exit_code"; }
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for account in runtime-database-url github-token user-id deepseek-api-key; do
  error_file="${rollback_dir}/${account}.error"
  if "$helper" get "$account" >"${rollback_dir}/${account}" 2>"$error_file"; then
    chmod 600 "${rollback_dir}/${account}"
  elif [[ "$(cat "$error_file")" = secret_unavailable ]]; then
    rm -f "${rollback_dir}/${account}" "$error_file"
    : >"${rollback_dir}/${account}.absent"
  else
    printf 'keychain_snapshot_failed\n' >&2
    exit 1
  fi
done
snapshot_complete=1
node "$transaction_helper" begin "$release_transaction" "$app_dir" "${CODEX_HOME:-$HOME/.codex}" >/dev/null
transaction_started=1

node --import tsx scripts/pipe-env-value.ts "$live_env" ACE_HUNTER_RUNTIME_DATABASE_URL | "$helper" set runtime-database-url
node --import tsx scripts/pipe-env-value.ts "$live_env" ACE_HUNTER_GITHUB_TOKEN | "$helper" set github-token
node --import tsx scripts/pipe-env-value.ts "$live_env" ACE_HUNTER_USER_ID | "$helper" set user-id
node --import tsx scripts/pipe-env-value.ts "$live_env" ACE_HUNTER_DEEPSEEK_API_KEY | "$helper" set deepseek-api-key

gh api --method PUT "repos/${GH_REPO}/environments/ace-hunter-production" \
  --input - <<'JSON' >/dev/null
{"wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
policies="$(gh api "repos/${GH_REPO}/environments/ace-hunter-production/deployment-branch-policies" 2>/dev/null || printf '{"branch_policies":[]}')"
node -e 'for(const p of JSON.parse(process.argv[1]).branch_policies??[])if(p.name!=="main")process.stdout.write(String(p.id)+"\n")' "$policies" |
  while IFS= read -r policy_id; do gh api --method DELETE "repos/${GH_REPO}/environments/ace-hunter-production/deployment-branch-policies/${policy_id}" >/dev/null; done
if ! node -e 'process.exit((JSON.parse(process.argv[1]).branch_policies??[]).some(p=>p.name==="main")?0:1)' "$policies"; then
  gh api --method POST "repos/${GH_REPO}/environments/ace-hunter-production/deployment-branch-policies" -f name=main -f type=branch >/dev/null
fi
for key in ACE_HUNTER_RUNTIME_DATABASE_URL ACE_HUNTER_GITHUB_TOKEN ACE_HUNTER_USER_ID ACE_HUNTER_DEEPSEEK_API_KEY; do
  node --import tsx scripts/pipe-env-value.ts "$live_env" "$key" | gh secret set "$key" --repo "$GH_REPO" --env ace-hunter-production
done
actual_names="$(gh secret list --repo "$GH_REPO" --env ace-hunter-production --json name --jq 'map(.name)|sort|join(",")')"
[[ "$actual_names" = 'ACE_HUNTER_DEEPSEEK_API_KEY,ACE_HUNTER_GITHUB_TOKEN,ACE_HUNTER_RUNTIME_DATABASE_URL,ACE_HUNTER_USER_ID' ]] || exit 1

ops/launchd/deploy-main.sh "$main_sha" "$live_env" "$release_transaction"
release="${app_dir}/releases/${main_sha}"
cd "$release"
"${release}/scripts/continue-post-merge-release.sh" \
  "$live_env" "$old_worktree" "$pr_head" "$main_sha" "$repo_root" "$release_transaction"
transaction_committed=1
cleanup
trap - EXIT HUP INT TERM

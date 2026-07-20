#!/bin/bash
set -euo pipefail
umask 077
[[ $# -eq 6 ]] || { printf 'usage_error\n' >&2; exit 1; }
live_env="$(realpath "$1")"
old_worktree="$(realpath "$2")"
pr_head="$3"
main_sha="$4"
repo_root="$(realpath "$5")"
release_transaction="$(realpath "$6")"
temp_base="${TMPDIR:-/tmp}"; temp_base="$(realpath "${temp_base%/}")"
case "$live_env" in "${temp_base}"/ace-hunter-live-*/runtime.env) ;; *) exit 1;; esac
live_dir="$(dirname "$live_env")"
[[ "$(stat -f '%u' "$live_env")" = "$(id -u)" && "$(stat -f '%Lp' "$live_dir")" = 700 && "$(stat -f '%Lp' "$live_env")" = 600 ]] || exit 1
release="${HOME}/Library/Application Support/AceHunter/releases/${main_sha}"
node_path="$("${release}/scripts/resolve-node22.sh")"
transaction_helper="${release}/scripts/release-transaction.mjs"
"$node_path" "$transaction_helper" verify "$release_transaction" >/dev/null
readonly_env="${release_transaction}/readonly.env"
[[ -f "$readonly_env" && ! -L "$readonly_env" && "$(stat -f '%u' "$readonly_env")" = "$(id -u)" &&
  "$(stat -f '%Lp' "$readonly_env")" = 600 ]] || { printf 'readonly_env_invalid\n' >&2; exit 1; }
[[ "$(pwd -P)" != "$old_worktree" ]] || cd "$release"
cd "$release"
continuation_complete=0
rollback_on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$continuation_complete" -eq 0 ]]; then
    "$node_path" "$transaction_helper" rollback "$release_transaction" >/dev/null || status=1
  fi
  exit "$status"
}
trap rollback_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

registered="$(git -C "$repo_root" worktree list --porcelain)"
printf '%s\n' "$registered" | grep -Fqx "worktree ${old_worktree}"
[[ "$(git -C "$old_worktree" rev-parse HEAD)" = "$pr_head" ]]
git -C "$old_worktree" diff --quiet && git -C "$old_worktree" diff --cached --quiet
git -C "$repo_root" merge-base --is-ancestor "$pr_head" "$main_sha"
git -C "$repo_root" worktree remove "$old_worktree"

: "${GH_REPO:?GH_REPO is required}"
: "${ACE_E2E_REPOSITORY:?ACE_E2E_REPOSITORY is required}"
ci_id=""
for attempt in $(seq 1 60); do
  ci_id="$(gh run list --repo "$GH_REPO" --workflow ci.yml --branch main --limit 100 --json databaseId,headSha --jq "map(select(.headSha==\"$main_sha\"))|max_by(.databaseId)|.databaseId // empty")"
  [[ -n "$ci_id" ]] && break
  sleep 5
done
[[ -n "$ci_id" ]] || { printf 'main_ci_missing\n' >&2; exit 1; }
gh run watch "$ci_id" --repo "$GH_REPO" --exit-status

records="${live_dir}/acceptance-runs.ndjson"
: >"$records" && chmod 600 "$records"
dispatch_and_watch() {
  local workflow="$1" before dispatched run_id attempt
  before="$(gh run list --repo "$GH_REPO" --workflow "$workflow" --branch main --event workflow_dispatch --limit 100 --json databaseId --jq 'map(.databaseId)|max // 0')"
  dispatched="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  gh workflow run "$workflow" --repo "$GH_REPO" --ref main
  run_id=""
  for poll in $(seq 1 60); do
    run_id="$(gh run list --repo "$GH_REPO" --workflow "$workflow" --branch main --event workflow_dispatch --limit 100 --json databaseId,headSha,createdAt --jq "map(select(.headSha==\"$main_sha\" and .createdAt>=\"$dispatched\" and .databaseId>$before))|max_by(.databaseId)|.databaseId // empty")"
    [[ -n "$run_id" ]] && break
    sleep 5
  done
  [[ -n "$run_id" ]] || return 1
  gh run watch "$run_id" --repo "$GH_REPO" --exit-status
  attempt="$(gh run view "$run_id" --repo "$GH_REPO" --json attempt --jq .attempt)"
  printf '{"workflow":"%s","databaseId":%s,"runAttempt":%s}\n' "$workflow" "$run_id" "$attempt" >>"$records"
}

runner_record="$(GH_REPO="$GH_REPO" ops/self-hosted-runner/launch-ephemeral.sh "$main_sha")"
printf '%s\n' "$runner_record" >>"$records"
for workflow in discover.yml trending.yml refresh-metrics.yml daily-report.yml retention.yml evaluate-success.yml; do
  dispatch_and_watch "$workflow"
done
acceptance_json="${live_dir}/acceptance-runs.json"
"$node_path" -e 'const fs=require("node:fs");const rows=fs.readFileSync(process.argv[1],"utf8").trim().split(/\n+/).filter(Boolean).map(JSON.parse);fs.writeFileSync(process.argv[2],JSON.stringify(rows),{mode:0o600,flag:"wx"})' "$records" "$acceptance_json"

launchd_mode="$("$node_path" "$transaction_helper" launchd-mode "$release_transaction")"
ops/launchd/install.sh "$release" "$launchd_mode" "${HOME}/Library/Application Support/AceHunter/runtime.env"
kickstart_boundary="$(ACE_HUNTER_ENV_FILE="$live_env" "$node_path" --import tsx -e 'import{Pool}from"pg";import{loadRuntimeConfig}from"./src/config/load-config.ts";const p=new Pool({connectionString:loadRuntimeConfig(process.env).runtimeDatabaseUrl});const r=await p.query("select clock_timestamp() now");await p.end();process.stdout.write(r.rows[0].now.toISOString())')"
lock_dir="${HOME}/Library/Application Support/AceHunter/run/collect-x.lock"
mkdir -p "$lock_dir"
printf '999999\n%s\n' "${release}/scripts/run-scheduled-x.sh" >"${lock_dir}/owner"
launchctl kickstart -k "gui/$(id -u)/com.kevinyoung.ace-hunter.collect-x"
durable_ready=0
for poll in $(seq 1 120); do
  sleep 5
  if ACE_HUNTER_ENV_FILE="$live_env" KICKSTART_BOUNDARY="$kickstart_boundary" "$node_path" --import tsx -e 'import{Pool}from"pg";import{loadRuntimeConfig}from"./src/config/load-config.ts";const p=new Pool({connectionString:loadRuntimeConfig(process.env).runtimeDatabaseUrl});const r=await p.query("select count(distinct job_name)::int n from ace_hunter.job_runs where created_at>$1 and parent_run_id is null and parameters->>$2=$3 and status in ($4,$5) and job_name=any($6::text[])",[process.env.KICKSTART_BOUNDARY,"scheduler","launchd","success","partial",["collect_x_posts","analyze_x_posts","collect_x_comments"]]);await p.end();process.exit(r.rows[0].n===3?0:1)' 2>/dev/null; then durable_ready=1; break; fi
done
# X is supplementary evidence. GitHub Trending and potential-project delivery
# must remain available when the external X source is temporarily unavailable.
[[ "$durable_ready" -eq 1 ]] || printf 'durable_x_unavailable_nonblocking\n' >&2

smoke_dir="${release_transaction}/continuation-smoke"
mkdir "$smoke_dir"
chmod 700 "$smoke_dir"
env -i HOME="$HOME" PATH="/usr/bin:/bin" ACE_HUNTER_ENV_FILE="$readonly_env" "$node_path" "${release}/dist/src/cli/index.js" potential --format json >"${smoke_dir}/potential.json"
env -i HOME="$HOME" PATH="/usr/bin:/bin" ACE_HUNTER_ENV_FILE="$readonly_env" "$node_path" "${release}/dist/src/cli/index.js" trending daily --format json >"${smoke_dir}/daily.json"
env -i HOME="$HOME" PATH="/usr/bin:/bin" ACE_HUNTER_ENV_FILE="$readonly_env" "$node_path" "${release}/dist/src/cli/index.js" trending weekly --format json >"${smoke_dir}/weekly.json"
env -i HOME="$HOME" PATH="/usr/bin:/bin" ACE_HUNTER_ENV_FILE="$readonly_env" "$node_path" "${release}/dist/src/cli/index.js" trending monthly --format json >"${smoke_dir}/monthly.json"
env -i HOME="$HOME" PATH="/usr/bin:/bin" ACE_HUNTER_ENV_FILE="$readonly_env" "$node_path" "${release}/dist/src/cli/index.js" trending all --format json >"${smoke_dir}/all.json"
chmod 600 "${smoke_dir}"/*.json
wrapper="${HOME}/Library/Application Support/AceHunter/bin/ace-hunter"
"$wrapper" list >"${smoke_dir}/direct-list.json"
"$wrapper" observe "$ACE_E2E_REPOSITORY" --format json >/dev/null
codex_binary="$("$node_path" "${release}/scripts/resolve-codex-binary.mjs")"
codex_smoke="${release}/scripts/run-codex-skill-smoke.sh"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}" "$codex_smoke" "$codex_binary" list \
  'Use $ace-hunter to run ace-hunter list. Return only the exact JSON tool result.' \
  >"${smoke_dir}/skill-list.json"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}" "$codex_smoke" "$codex_binary" observe \
  "Use \$ace-hunter to run ace-hunter observe ${ACE_E2E_REPOSITORY} --format json. Return only the exact JSON tool result." \
  >"${smoke_dir}/skill-observe.json"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}" "$codex_smoke" "$codex_binary" weekly \
  'Use $ace-hunter to run ace-hunter trending weekly --format json. Return only the exact JSON tool result.' \
  >"${smoke_dir}/skill-weekly.json"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}" "$codex_smoke" "$codex_binary" potential \
  'Use $ace-hunter to run ace-hunter potential --format json. Return only the exact JSON tool result.' \
  >"${smoke_dir}/skill-potential.json"
chmod 600 "${smoke_dir}/direct-list.json" "${smoke_dir}/skill-list.json" \
  "${smoke_dir}/skill-observe.json" "${smoke_dir}/skill-weekly.json" "${smoke_dir}/skill-potential.json"
"$node_path" "${release}/dist/scripts/validate-codex-skill-output.js" \
  "${smoke_dir}/direct-list.json" "${smoke_dir}/skill-list.json" \
  "${smoke_dir}/skill-observe.json" >/dev/null
"$node_path" "${release}/dist/scripts/validate-signal-release.js" require-fresh \
  "${smoke_dir}/potential.json" "${smoke_dir}/daily.json" "${smoke_dir}/weekly.json" \
  "${smoke_dir}/monthly.json" "${smoke_dir}/all.json" "${smoke_dir}/skill-weekly.json" \
  "${smoke_dir}/skill-potential.json" >/dev/null

: "${ACCEPTANCE_STARTED_AT:?ACCEPTANCE_STARTED_AT is required}"
export KICKSTART_BOUNDARY="$kickstart_boundary" ACCEPTANCE_RUN_IDS_FILE="$acceptance_json" \
  MAIN_SHA="$main_sha" SIGNAL_SMOKE_DIR="$smoke_dir"
ACE_HUNTER_ENV_FILE="$live_env" "$node_path" --import tsx scripts/post-merge-acceptance.ts
git -C "$repo_root" fetch --quiet origin main
[[ "$(git -C "$repo_root" rev-parse origin/main)" = "$main_sha" ]]
continuation_complete=1
trap - EXIT HUP INT TERM
printf 'post_merge_release_passed\n'

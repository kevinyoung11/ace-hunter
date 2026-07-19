#!/bin/bash
set -euo pipefail

: "${GH_REPO:?GH_REPO owner/name is required}"
: "${1:?main sha is required}"
main_sha=$1

if ! [[ "$GH_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "GH_REPO must be an owner/name pair" >&2
  exit 64
fi
if test "${#main_sha}" -ne 40 || [[ "$main_sha" == *[!0-9a-f]* ]]; then
  echo "main sha must be 40 lowercase hexadecimal characters" >&2
  exit 64
fi

for required_command in curl gh mktemp node realpath sed shasum tar; do
  command -v "$required_command" >/dev/null || {
    echo "required command unavailable: $required_command" >&2
    exit 69
  }
done

script_dir=$(cd "$(dirname "$0")" && pwd -P)
repo_root=$(cd "$script_dir/../.." && pwd -P)
manifest="$repo_root/release-manifest.json"
test -f "$manifest" && test ! -L "$manifest" || { echo "release manifest missing" >&2; exit 65; }
manifest_sha=$(node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(typeof value.sha!=="string")process.exit(1);process.stdout.write(value.sha)' "$manifest") || {
  echo "release manifest is malformed" >&2
  exit 65
}
test "$manifest_sha" = "$main_sha" || { echo "release manifest SHA mismatch" >&2; exit 65; }
lock_file="$repo_root/ops/self-hosted-runner/actions-runner.lock"
test -f "$lock_file" || { echo "runner lock missing" >&2; exit 65; }
test "$(awk 'END { print NR }' "$lock_file")" = "2" || {
  echo "runner lock must contain exactly two lines" >&2
  exit 65
}
version_line=$(sed -n '1p' "$lock_file")
sha_line=$(sed -n '2p' "$lock_file")
runner_version=${version_line#version=}
runner_sha256=${sha_line#osx_arm64_sha256=}
if test "$version_line" = "$runner_version" || ! [[ "$runner_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "runner lock version is malformed" >&2
  exit 65
fi
if test "$sha_line" = "$runner_sha256" || test "${#runner_sha256}" -ne 64 || [[ "$runner_sha256" == *[!0-9a-f]* ]]; then
  echo "runner lock SHA-256 is malformed" >&2
  exit 65
fi

temp_base=${TMPDIR:-/tmp}
temp_base=${temp_base%/}
runner_dir=$(mktemp -d "$temp_base/ace-hunter-runner.XXXXXX")
runner_name="ace-hunter-ephemeral-$(date -u +%Y%m%dT%H%M%SZ)-$$"
runner_pid=""
runner_id=""

cleanup() {
  cleanup_status=$?
  if test -n "$runner_pid" && kill -0 "$runner_pid" 2>/dev/null; then
    kill "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
  fi
  if test -n "$runner_id"; then
    gh api --method DELETE "repos/$GH_REPO/actions/runners/$runner_id" >/dev/null 2>&1 || true
  fi
  if test -n "$runner_dir" && [[ "$runner_dir" == "$temp_base"/ace-hunter-runner.* ]]; then
    rm -rf -- "$runner_dir"
  fi
  return "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

archive="$runner_dir/actions-runner-osx-arm64-${runner_version}.tar.gz"
archive_url="https://github.com/actions/runner/releases/download/v${runner_version}/actions-runner-osx-arm64-${runner_version}.tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error "$archive_url" --output "$archive"
printf '%s  %s\n' "$runner_sha256" "$archive" | shasum -a 256 -c - >&2
tar -xzf "$archive" -C "$runner_dir"

preflight="$repo_root/dist/scripts/assert-twitter-preflight.js"
test -f "$preflight" || { echo "built Twitter preflight helper missing" >&2; exit 66; }
twitter_path=$(command -v twitter)
test -n "$twitter_path" || { echo "twitter CLI missing" >&2; exit 66; }
twitter_path=$(realpath "$twitter_path")
node "$preflight" --twitter-cli-path "$twitter_path" >&2

registration_token=$(gh api --method POST "repos/$GH_REPO/actions/runners/registration-token" --jq .token)
test -n "$registration_token" || { echo "runner registration token unavailable" >&2; exit 67; }
(
  cd "$runner_dir"
  ./config.sh \
    --url "https://github.com/$GH_REPO" \
    --token "$registration_token" \
    --name "$runner_name" \
    --labels ace-hunter \
    --ephemeral \
    --unattended
) >&2
registration_token=""

(
  cd "$runner_dir"
  ./run.sh >&2
) &
runner_pid=$!

runner_status=""
for _attempt in $(seq 1 60); do
  runner_record=$(gh api "repos/$GH_REPO/actions/runners" --jq ".runners[] | select(.name == \"$runner_name\") | [.id,.status] | @tsv")
  if test -n "$runner_record"; then
    runner_id=${runner_record%%$'\t'*}
    runner_status=${runner_record#*$'\t'}
    if ! [[ "$runner_id" =~ ^[0-9]+$ ]]; then
      echo "GitHub returned an invalid runner ID" >&2
      exit 67
    fi
    test "$runner_status" = "online" && break
  fi
  sleep 5
done
test "$runner_status" = "online" || { echo "runner did not become online" >&2; exit 70; }

max_before=$(gh run list \
  --repo "$GH_REPO" \
  --workflow collect-x.yml \
  --branch main \
  --event workflow_dispatch \
  --limit 100 \
  --json databaseId \
  --jq 'map(.databaseId) | max // 0')
[[ "$max_before" =~ ^[0-9]+$ ]] || { echo "invalid prior workflow database ID" >&2; exit 67; }
dispatch_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run collect-x.yml --repo "$GH_REPO" --ref main >&2

run_id=""
for _attempt in $(seq 1 60); do
  run_id=$(gh run list \
    --repo "$GH_REPO" \
    --workflow collect-x.yml \
    --branch main \
    --event workflow_dispatch \
    --limit 100 \
    --json databaseId,headSha,createdAt \
    --jq "map(select(.headSha == \"$main_sha\" and .createdAt >= \"$dispatch_at\" and .databaseId > $max_before)) | max_by(.databaseId) | .databaseId // empty")
  test -n "$run_id" && break
  sleep 5
done
[[ "$run_id" =~ ^[0-9]+$ ]] || { echo "dispatched workflow run was not found" >&2; exit 70; }

watch_status=0
gh run watch "$run_id" --repo "$GH_REPO" --exit-status >&2 || watch_status=$?

runner_wait_attempts=0
while kill -0 "$runner_pid" 2>/dev/null; do
  runner_wait_attempts=$((runner_wait_attempts + 1))
  if test "$runner_wait_attempts" -ge 120; then
    echo "ephemeral runner did not stop after its job" >&2
    exit 70
  fi
  sleep 5
done
runner_process_status=0
wait "$runner_pid" || runner_process_status=$?
runner_pid=""

deregistered=""
for _attempt in $(seq 1 24); do
  registered_name=$(gh api "repos/$GH_REPO/actions/runners" --jq ".runners[] | select(.id == $runner_id) | .name")
  if test -z "$registered_name"; then
    deregistered="yes"
    break
  fi
  sleep 5
done
test "$deregistered" = "yes" || { echo "ephemeral runner remained registered" >&2; exit 70; }
runner_id=""

test "$runner_process_status" -eq 0 || { echo "runner process failed" >&2; exit "$runner_process_status"; }
test "$watch_status" -eq 0 || exit "$watch_status"
run_attempt=$(gh api "repos/$GH_REPO/actions/runs/$run_id" --jq .run_attempt)
[[ "$run_attempt" =~ ^[1-9][0-9]*$ ]] || { echo "invalid workflow run attempt" >&2; exit 67; }
printf '{"workflow":"collect-x.yml","databaseId":%s,"runAttempt":%s}\n' "$run_id" "$run_attempt"

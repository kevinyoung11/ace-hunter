#!/bin/bash
set -euo pipefail
umask 077
[[ $# -eq 3 ]] || { printf 'codex_skill_smoke_usage_error\n' >&2; exit 1; }
codex_binary="$1"
label="$2"
prompt="$3"
[[ "$codex_binary" = /* && -x "$codex_binary" ]] || {
  printf 'codex_skill_smoke_binary_invalid label=%s\n' "$label" >&2
  exit 1
}
error_log="$(mktemp "${TMPDIR:-/tmp}/ace-codex-smoke.XXXXXX")"
cleanup() { rm -f "$error_log"; }
trap cleanup EXIT HUP INT TERM
if "$codex_binary" exec --skip-git-repo-check "$prompt" 2>"$error_log"; then
  exit 0
else
  status=$?
  printf 'codex_skill_smoke_failed label=%s exit_status=%s\n' "$label" "$status" >&2
  exit "$status"
fi

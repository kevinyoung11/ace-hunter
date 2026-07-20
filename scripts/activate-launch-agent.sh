#!/bin/bash
set -euo pipefail

[[ $# -eq 4 ]] || { printf 'usage_error\n' >&2; exit 1; }
launchd_mode="$1"
domain="$2"
agent="$3"
service="$4"
[[ "$launchd_mode" = enable || "$launchd_mode" = preserve ]] || { printf 'usage_error\n' >&2; exit 1; }
[[ "$domain" == gui/* && "$agent" = /* && "$service" == "${domain}/"* ]] || {
  printf 'usage_error\n' >&2
  exit 1
}

if [[ "$launchd_mode" = enable ]]; then
  launchctl enable "$service"
fi
launchctl bootstrap "$domain" "$agent"

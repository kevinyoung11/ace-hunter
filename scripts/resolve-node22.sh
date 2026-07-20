#!/bin/bash
set -euo pipefail

fallback=false
if [[ "${1:-}" = --fallback ]]; then
  fallback=true
  shift
fi
candidates=("$@")
if [[ "${#candidates[@]}" -eq 0 || "$fallback" = true ]]; then
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && candidates+=("$candidate")
  done < <(type -a -p node 2>/dev/null || true)
  candidates+=(
    /opt/homebrew/opt/node@22/bin/node
    /usr/local/opt/node@22/bin/node
  )
fi

for candidate in "${candidates[@]}"; do
  [[ "$candidate" = /* && -f "$candidate" && -x "$candidate" ]] || continue
  resolved="$(realpath "$candidate" 2>/dev/null)" || continue
  version="$("$resolved" --version 2>/dev/null)" || continue
  if [[ "$version" =~ ^v?22\.[0-9]+\.[0-9]+$ ]]; then
    selected="$candidate"
    for stable in /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node; do
      if [[ "$resolved" == */Cellar/node@22/*/bin/node && -e "$stable" ]] &&
        [[ "$(realpath "$stable" 2>/dev/null || true)" = "$resolved" ]]; then
        selected="$stable"
        break
      fi
    done
    printf '%s\n' "$selected"
    exit 0
  fi
done

printf 'node22_runtime_not_found\n' >&2
exit 1

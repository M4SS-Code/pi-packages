#!/usr/bin/env sh
# The web helpers are intentionally duplicated across packages: each package
# installs standalone via `pi install ./packages/<name>`, so they cannot share
# a workspace dependency. This check enforces the "keep the copies in sync by
# hand" policy by requiring the copies to be byte-identical.
set -eu

fail=0

# Print a top-level declaration from its "export ..." line to the first
# closing brace in column zero.
extract_block() { # file start-line-regex
  awk -v start="$2" '
    $0 ~ start { found = 1 }
    found { print }
    found && /^}/ { exit }
  ' "$1"
}

check_block() { # name start-regex file...
  name="$1"
  re="$2"
  shift 2
  first="$1"
  ref="$(extract_block "$first" "$re")"
  if [ -z "$ref" ]; then
    echo "MISSING: $name not found in $first" >&2
    fail=1
    return
  fi
  for f in "$@"; do
    if [ "$(extract_block "$f" "$re")" != "$ref" ]; then
      echo "DRIFT: $name differs between $first and $f" >&2
      fail=1
    fi
  done
}

check_line() { # name line-regex file...
  name="$1"
  re="$2"
  shift 2
  first="$1"
  ref="$(grep "$re" "$first" || true)"
  if [ -z "$ref" ]; then
    echo "MISSING: $name not found in $first" >&2
    fail=1
    return
  fi
  for f in "$@"; do
    if [ "$(grep "$re" "$f" || true)" != "$ref" ]; then
      echo "DRIFT: $name differs between $first and $f" >&2
      fail=1
    fi
  done
}

LLMS=packages/llms-txt/src/utils.ts
STAAN=packages/staan-search/src/utils.ts
WEB=packages/web-fetch/src/utils.ts
DELEGATOR=packages/search-delegator/src/utils.ts

check_block readBodyBounded '^export async function readBodyBounded' "$LLMS" "$STAAN"
check_block timeoutSignal '^export function timeoutSignal' "$LLMS" "$STAAN" "$WEB"
check_block atomicFileWrite '^export function atomicFileWrite' "$LLMS" "$DELEGATOR"
check_block compactText '^export function compactText' "$STAAN" "$WEB"
check_line USER_AGENT '^export const USER_AGENT' "$LLMS" "$STAAN" "$WEB"

# Every package ships the same MIT license; npm strips symlinks from tarballs,
# so the copies must be real files — enforce that they match the root LICENSE.
for license in packages/*/LICENSE; do
  if ! cmp -s LICENSE "$license"; then
    echo "DRIFT: $license differs from the root LICENSE" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "duplicated helpers are in sync"

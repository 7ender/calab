#!/usr/bin/env bash
# Print the body of one version's section from CHANGELOG.md (Keep a Changelog format).
#   infra/ci/changelog-section.sh 0.1.1 [CHANGELOG.md]
# Prints everything between "## [<version>]" and the next "## [" heading (or the link
# reference block at the end), without the heading itself and trimmed of blank edges.
# Exit 1 if the section is missing or empty — callers fall back to auto-generated notes.
set -euo pipefail

version="${1:?usage: changelog-section.sh <version> [changelog]}"
version="${version#v}"
file="${2:-CHANGELOG.md}"
[[ -f "$file" ]] || { echo "changelog-section: $file not found" >&2; exit 1; }

body=$(awk -v ver="$version" '
  BEGIN { head = "## [" ver "]" }
  { sub(/\r$/, "") }                         # CRLF checkouts: never leak \r into the release body
  /^## \[/ { if (in_sec) exit; if (index($0, head) == 1) { in_sec = 1; next } }
  in_sec && /^\[[^]]+\]: / { exit }          # link references at the end of the file
  in_sec { lines[++n] = $0 }
  END {
    s = 1; while (s <= n && lines[s] ~ /^[[:space:]]*$/) s++
    e = n; while (e >= s && lines[e] ~ /^[[:space:]]*$/) e--
    for (i = s; i <= e; i++) print lines[i]
  }
' "$file")

[[ -n "$body" ]] || { echo "changelog-section: no section for $version in $file" >&2; exit 1; }
printf '%s\n' "$body"

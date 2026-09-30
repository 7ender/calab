#!/usr/bin/env bash
# macOS auto-update smoke: the first real update through the feed (TESTING.md 2.10, U.7).
#
# Installs the OLD release (default 0.1.0) into a throw-away folder under $TMPDIR — never
# /Applications — checks its signature and notarization, starts it with a separate profile
# (CALABA_USER_DATA, so the real profile, settings and session are untouched), waits until
# electron-updater has found and downloaded the NEW version from the feed, quits the app so
# Squirrel.Mac installs the update on quit (src/main/updateFlow.ts: builds up to 1.5.0 staged it
# at download time; newer ones stage the newest download while the quit is held, ≤ 20 s), then
# relaunches it and checks that the bundle and the running app are the NEW version.
#
#   apps/desktop/scripts/update-smoke.sh                 # 0.1.0 → 0.1.1 from https://releases.calab.ru/
#   OLD=0.1.0 NEW=0.1.1 FEED=https://releases.calab.ru/ TIMEOUT=90 KEEP=1 apps/desktop/scripts/update-smoke.sh
#
# Env: OLD, NEW (versions), FEED (update feed; the app itself uses the feed baked in at build time,
# this one is only used to download the old DMG and to check latest-mac.yml), OLD_URL (explicit
# DMG URL), ARCH (arm64|x64, default: this Mac), TIMEOUT (seconds to wait for the download,
# default 90), KEEP=1 (keep the work folder for inspection).
# Prints PASS/FAIL per step; exit 0 only if every step passed.
set -uo pipefail

OLD="${OLD:-0.1.0}"
NEW="${NEW:-0.1.1}"
FEED="${FEED:-https://releases.calab.ru/}"
FEED="${FEED%/}/"
TIMEOUT="${TIMEOUT:-90}"
case "${ARCH:-$(uname -m)}" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | x64) ARCH=x64 ;;
  *) echo "unsupported arch: ${ARCH:-}" >&2; exit 2 ;;
esac
# electron-builder.yml, mac.artifactName: Calab-${version}-${arch}.${ext}
DMG_NAME="Calab-${OLD}-${ARCH}.dmg"
# The feed keeps every release under releases/<version>/ (infra/docker, release.yml).
OLD_URL="${OLD_URL:-${FEED}releases/${OLD}/${DMG_NAME}}"

[[ "$(uname -s)" == Darwin ]] || { echo "macOS only" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/calab-update-smoke.XXXXXX")"
MNT="$WORK/mnt"
APP="$WORK/Calab.app"
PROFILE="$WORK/profile"
LOG="$PROFILE/logs/main.log"
PID=""
FAILED=0

pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILED=1; }
info() { printf '      %s\n' "$*"; }

# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then kill -TERM "$PID" 2>/dev/null; sleep 2; kill -KILL "$PID" 2>/dev/null; fi
  [[ -d "$MNT" ]] && hdiutil detach -quiet "$MNT" 2>/dev/null
  if [[ "${KEEP:-0}" == 1 ]]; then echo "work folder kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

plist_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null; }

# Starts the app from the temp folder with its own profile; the single-instance lock is off, so a
# Calab the user has open keeps running untouched.
launch() {
  CALABA_USER_DATA="$PROFILE" CALABA_MULTI_INSTANCE=1 "$APP/Contents/MacOS/Calab" >>"$WORK/stdout.log" 2>&1 &
  PID=$!
}

# Graceful quit of OUR process only (by pid, not by bundle id — the user's own Calab has the same
# id). Electron turns SIGTERM into a normal quit (verified with Electron 44: before-quit →
# will-quit → quit, like ⌘Q), so Squirrel.Mac installs a staged update on the way out.
quit_app() {
  [[ -n "$PID" ]] || return 0
  kill -TERM "$PID" 2>/dev/null
  for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
  if kill -0 "$PID" 2>/dev/null; then kill -KILL "$PID" 2>/dev/null; info "had to SIGKILL pid $PID"; fi
  PID=""
}

wait_log() { # pattern seconds
  local pattern="$1" secs="$2"
  for _ in $(seq 1 "$secs"); do
    grep -qE "$pattern" "$LOG" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

echo "Calab update smoke: $OLD → $NEW ($ARCH), feed $FEED"
echo "work: $WORK"

# 1. The feed already announces the new version.
if curl -fsSL "${FEED}latest-mac.yml" -o "$WORK/latest-mac.yml" && grep -qE "^version: *${NEW//./\\.}\$" "$WORK/latest-mac.yml"; then
  pass "feed: latest-mac.yml announces $NEW"
else
  fail "feed: latest-mac.yml at $FEED does not announce $NEW"
  info "$(head -3 "$WORK/latest-mac.yml" 2>/dev/null | tr '\n' ' ')"
  exit 1
fi

# 2. Download and mount the old DMG, copy the app out (never into /Applications).
if curl -fsSL "$OLD_URL" -o "$WORK/$DMG_NAME"; then pass "download: $OLD_URL"; else fail "download: $OLD_URL"; exit 1; fi
mkdir -p "$MNT"
if hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MNT" "$WORK/$DMG_NAME" && ditto "$MNT/Calab.app" "$APP"; then
  pass "install: copied Calab.app to $APP"
else
  fail "install: could not mount $DMG_NAME or copy Calab.app"; exit 1
fi
hdiutil detach -quiet "$MNT" 2>/dev/null
v="$(plist_version)"
if [[ "$v" == "$OLD" ]]; then pass "version before: $v"; else fail "version before: expected $OLD, got ${v:-?}"; exit 1; fi

# 3. Signed with Developer ID and notarized (Squirrel.Mac refuses to update an unsigned app).
sig="$(codesign -dv --verbose=2 "$APP" 2>&1)"
if grep -q '^Authority=Developer ID Application' <<<"$sig"; then
  pass "codesign: $(grep -m1 '^Authority=Developer ID Application' <<<"$sig" | cut -d= -f2-)"
else
  fail "codesign: not signed with a Developer ID"; info "$(grep -E '^(Authority|Signature)' <<<"$sig" | head -3 | tr '\n' ' ')"
fi
gk="$(spctl -a -vv -t exec "$APP" 2>&1)"
if grep -q 'accepted' <<<"$gk" && grep -q 'Notarized Developer ID' <<<"$gk"; then
  pass "gatekeeper: accepted, notarized"
else
  fail "gatekeeper: $(tr '\n' ' ' <<<"$gk")"
fi
[[ "$FAILED" == 0 ]] || { info "an unsigned/unnotarized build cannot auto-update on macOS (docs: README «Updates»)"; exit 1; }

# 4. Start the old version with a separate profile; the first check runs ~10 s after start.
mkdir -p "$PROFILE"
launch
if wait_log "Calab $OLD starting" 20; then pass "started $OLD (pid $PID, profile $PROFILE)"; else fail "app did not start (see $LOG, $WORK/stdout.log)"; exit 1; fi

# 5. electron-updater finds and downloads the new version (lines from electron-updater and
#    src/main/updateFlow.ts: «Found version», «[update] downloaded»).
if wait_log "Found version ${NEW//./\\.}" 40; then pass "found $NEW in the feed"; else fail "no «Found version $NEW» within 40 s"; info "$(grep -E '\[update\]|Checking for update|Update for version|error' "$LOG" 2>/dev/null | tail -5 | tr '\n' ' ')"; exit 1; fi
if wait_log "\[update\] downloaded ${NEW//./\\.}|New version ${NEW//./\\.} has been downloaded" "$TIMEOUT"; then
  pass "downloaded $NEW (ready to install on quit)"
else
  fail "download not finished within ${TIMEOUT}s"; info "$(grep -E '\[update\]|Download|error' "$LOG" 2>/dev/null | tail -5 | tr '\n' ' ')"; exit 1
fi

# 5b. OLD builds up to 1.5.0 had Squirrel.Mac fetch the update from electron-updater's local
#     proxy right after «downloaded» (autoInstallOnAppQuit): wait for Squirrel's own
#     «update-downloaded» (a debug line; the electron-log file transport logs from «silly» up)
#     so the quit does not cut it off. Newer builds stage nothing now — only in the held quit.
if wait_log "nativeUpdater\.update-downloaded" 15; then
  pass "Squirrel.Mac staged $NEW at download time (OLD build up to 1.5.0)"
else
  info "nothing staged at download time — the quit stages it (builds after 1.5.0)"
fi

# 6. Quit: the app stages the newest download if it has not yet (the quit is held ≤ 20 s), then
#    Squirrel.Mac (ShipIt) replaces the bundle after the app exits.
quit_app
if grep -qE "nativeUpdater\.update-downloaded" "$LOG" 2>/dev/null; then
  pass "Squirrel.Mac staged $NEW"
else
  fail "Squirrel.Mac never staged the update"; info "$(grep -E '\[update\]|nativeUpdater|Squirrel|error' "$LOG" 2>/dev/null | tail -5 | tr '\n' ' ')"
fi
installed=""
for _ in $(seq 1 60); do
  [[ "$(plist_version)" == "$NEW" ]] && { installed=1; break; }
  sleep 1
done
if [[ -n "$installed" ]]; then pass "installed on quit: Info.plist is $NEW"; else fail "bundle still $(plist_version) 60 s after quit"; info "ShipIt log: ~/Library/Caches/app.calaba.desktop.ShipIt/ShipIt_stderr.log"; fi

# 7. Relaunch: the running app is the new version, the update is not offered again.
launch
if wait_log "Calab ${NEW//./\\.} starting" 30; then pass "relaunched: running $NEW"; else fail "relaunch did not report «Calab $NEW starting»"; fi
if wait_log "update-not-available|Update for version ${NEW//./\\.} is not available" 40; then pass "feed check after update: nothing newer"; else info "no «not available» line within 40 s (informational)"; fi
quit_app

echo
if [[ "$FAILED" == 0 ]]; then echo "RESULT: PASS ($OLD → $NEW)"; exit 0; fi
echo "RESULT: FAIL — log: $LOG (run with KEEP=1 to keep it)"
exit 1

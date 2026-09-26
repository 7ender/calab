#!/usr/bin/env bash
# Build Calaba desktop releases for macOS (arm64 + x64), Linux and Windows from this Mac (docs/06, "Релизы десктопа: сборка").
#
#   apps/desktop/scripts/build-release.sh [mac] [linux] [win]    # default: all three
#
# Env:
#   SRC_REF=HEAD        git ref to build (a clean `git archive` export — uncommitted changes are NOT built)
#   VERSION=1.2.3       override apps/desktop/package.json version (applied to the export only)
#   UPDATE_URL=…        electron-updater generic feed baked into app-update.yml / latest*.yml
#                       (default https://colaba.gptunnel.ai/download/)
#   HOMEPAGE=…          package homepage (deb metadata; default: UPDATE_URL without /download/)
#   WORK_DIR=…          scratch dir (default $TMPDIR/calaba-release; removed on exit unless KEEP_WORK=1)
#   SMOKE=0             skip the Linux smoke start (AppImage under Xvfb, inside the build container)
#   BUILD_DOCKER_HOST=ssh://user@host  x86_64 Linux Docker host for the Linux/Windows builds (recommended on
#                       Apple Silicon: no amd64 emulation; required for Windows — NSIS needs 32-bit wine,
#                       which Docker's qemu cannot run). WIN_DOCKER_HOST: same, Windows only.
#                       REMOTE_CPUS/REMOTE_MEMORY (default 4 / 6g) cap the container on a shared host.
#
# Output: apps/desktop/dist-release/ — versioned installers + latest-mac.yml / latest-linux.yml / latest.yml
# (+ .blockmap). Publish with infra/docker/sync.sh (copies them to <domain>/download/, never deletes).
#
# Native module: uiohook-napi. Our patch (patches/uiohook-napi@1.5.5.patch) changes only the macOS hook,
# and electron-builder.yml excludes the upstream prebuilds (buildDependenciesFromSource): the module is
# compiled from the patched source for every target — macOS per arch, Linux inside the container.
# Windows cannot be compiled outside Windows: the win build ships the upstream win32-x64 N-API prebuild
# (identical code on Windows — the patch is darwin-only); a native Windows build (CI) compiles it instead.
# Nothing is signed: macOS identity=null, Windows unsigned (see docs/06 for what signing needs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/apps/desktop/dist-release"
SRC_REF="${SRC_REF:-HEAD}"
UPDATE_URL="${UPDATE_URL:-https://colaba.gptunnel.ai/download/}"
HOMEPAGE="${HOMEPAGE:-${UPDATE_URL%/download/}}"
WORK="${WORK_DIR:-${TMPDIR:-/tmp}/calaba-release}"
SRC="$WORK/src"
# The scratch dir (source export, node_modules, per-OS build dirs) is removed on exit; only
# dist-release/ stays. KEEP_WORK=1 keeps it for debugging.
cleanup() { [[ "${KEEP_WORK:-0}" == 1 ]] || rm -rf "${WORK:?}"; }
trap cleanup EXIT
# electronuserland/builder:wine (Ubuntu, Node, wine + mono for NSIS), pinned by digest.
BUILDER_IMAGE="${BUILDER_IMAGE:-electronuserland/builder:wine@sha256:41ae540902461b6cbc988987db79547fcc10cda04d2a6c6367504f59d4b37c64}"
PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$ROOT/package.json")"

platforms=("$@"); [[ ${#platforms[@]} -eq 0 ]] && platforms=(mac linux win)
log() { printf '\n==> %s\n' "$*"; }
TIMES=""   # "platform=seconds" pairs (macOS ships bash 3.2: no associative arrays)

# Common electron-builder overrides: file names without spaces, always with the version
# (/download/ caches installers as immutable), and a generic publish feed so latest*.yml is written.
EB_COMMON=(
  --publish never
  -c.publish.provider=generic "-c.publish.url=$UPDATE_URL"
  "-c.mac.artifactName=Calaba-\${version}-\${arch}.\${ext}"
  "-c.nsis.artifactName=Calaba-Setup-\${version}-\${arch}.\${ext}"
  "-c.appImage.artifactName=Calaba-\${version}-\${arch}.\${ext}"
  "-c.deb.artifactName=calaba_\${version}_\${arch}.\${ext}"
  # The npm name "@calaba/desktop" is not a valid Linux binary / dpkg package name.
  -c.linux.executableName=calaba -c.deb.packageName=calaba
  "-c.extraMetadata.homepage=$HOMEPAGE"   # required by the deb target
)

# --- 1. clean source export -----------------------------------------------------------------------
log "export $SRC_REF → $SRC"
rm -rf "$SRC"; mkdir -p "$SRC" "$OUT"
git -C "$ROOT" archive "$SRC_REF" | tar -x -C "$SRC"
COMMIT="$(git -C "$ROOT" rev-parse --short "$SRC_REF")"
if [[ -n "${VERSION:-}" ]]; then
  (cd "$SRC/apps/desktop" && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)
fi
APP_VERSION="$(node -p "require('$SRC/apps/desktop/package.json').version")"
log "version $APP_VERSION (commit $COMMIT)"

# --- 2. macOS (native, arm64 + x64) --------------------------------------------------------------
build_mac() {
  local t0=$SECONDS
  log "macOS: pnpm install (compiles patched uiohook-napi for the host arch)"
  (cd "$SRC" && pnpm install --frozen-lockfile)
  (cd "$SRC/apps/desktop" && pnpm build:app)
  # The patched module is compiled per arch into build/Release by electron-builder (node-gyp-build loads
  # that first). Drop the postinstall copy in bin/ (host arch only — it would land in the x64 app too)
  # and the unpatched upstream prebuilds.
  grep -q VC_CAPS_LOCK_STATE "$SRC/node_modules/uiohook-napi/libuiohook/include/uiohook.h" \
    || { echo "uiohook-napi patch is NOT applied" >&2; exit 1; }
  rm -rf "$SRC/node_modules/uiohook-napi/bin" "$SRC/node_modules/uiohook-napi/prebuilds"
  log "macOS: electron-builder --mac (arm64 + x64 per electron-builder.yml; uiohook compiled from source per arch)"
  (cd "$SRC/apps/desktop" && CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac \
    "${EB_COMMON[@]}" -c.directories.output=dist-release-mac)
  # each app must carry the patched module compiled for its own arch
  local app arch want
  for app in "$SRC"/apps/desktop/dist-release-mac/mac*/Calaba.app; do
    case "$app" in *mac-arm64*) want=arm64 ;; *) want=x86_64 ;; esac
    arch="$(lipo -archs "$(find "$app" -name uiohook_napi.node | head -1)" 2>/dev/null || echo missing)"
    echo "uiohook native in $(basename "$(dirname "$app")"): $arch"
    [[ "$arch" == "$want" ]] || { echo "wrong/missing uiohook_napi.node in $app (want $want)" >&2; exit 1; }
  done
  cp "$SRC/apps/desktop/dist-release-mac"/{*.dmg,*.zip,*.blockmap,latest-mac.yml} "$OUT"/
  TIMES+="mac=$((SECONDS - t0)) "
}

# --- 3. Linux + Windows in Docker (local, or a remote x86_64 host) ------------------------------------
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30)
retry() { local n; for n in 1 2 3; do "$@" && return 0; echo "retry $n/3: $*" >&2; sleep $((n * 5)); done; return 1; }

# The in-container build script (runs as `bash -euo pipefail -s` with PLATFORM/EB_ARGS/... from an env file).
write_container_script() {
  cat > "$WORK/container.sh" <<'CONTAINER'
      export DEBIAN_FRONTEND=noninteractive
      # work on the container filesystem (bind mounts from macOS are slow for node_modules)
      mkdir -p /build && tar -C /src --exclude=node_modules --exclude="dist-release*" --exclude=out --exclude=dist -cf - . | tar -C /build -xf - && cd /build
      corepack enable >/dev/null 2>&1 || npm i -g corepack >/dev/null
      corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null
      # --ignore-scripts: no electron postinstall download (electron-builder fetches the Electron dist
      # itself); esbuild uses its optional platform package; uiohook is compiled by electron-builder.
      pnpm install --frozen-lockfile --ignore-scripts
      grep -q VC_CAPS_LOCK_STATE node_modules/uiohook-napi/libuiohook/include/uiohook.h || { echo "uiohook patch NOT applied"; exit 1; }
      cd apps/desktop && pnpm build:app
      # electron-builder.yml ships only our patched uiohook build (upstream prebuilds excluded,
      # buildDependenciesFromSource). Linux: compile it here (X11 headers). Windows: node-gyp cannot
      # cross-compile for win32, so there is no module — the check below fails the build.
      rebuild=false
      if [[ "$PLATFORM" == win ]]; then
        cat > electron-builder.win.yml <<'YML'
extends: ./electron-builder.yml
win:
  files:
    - from: .
      filter:
        # the directory itself too: the global `prebuilds/**` exclusion also matches it
        - "**/node_modules/uiohook-napi/prebuilds"
        - "**/node_modules/uiohook-napi/prebuilds/win32-x64/**"
YML
      fi
      if [[ "$PLATFORM" == linux ]]; then
        apt-get update -qq >/dev/null
        apt-get install -y -qq libx11-dev libxtst-dev libxt-dev libxinerama-dev libx11-xcb-dev \
          libxkbcommon-dev libxkbcommon-x11-dev libxkbfile-dev libxrandr-dev >/dev/null
        rebuild=true
      fi
      eval "pnpm exec electron-builder $EB_ARGS --x64 -c.npmRebuild=$rebuild -c.directories.output=/build/rel"
      # a missing native module crashes main at startup (static import in ptt.ts): never ship that
      n=$(find /build/rel/*-unpacked -path "*uiohook*" -name "*.node" | head -1)
      if [[ -z "$n" ]]; then echo "ERROR: no uiohook .node in the $PLATFORM package — not publishing it" >&2; exit 3; fi
      echo "packaged native: ${n#/build/rel/} ($(od -An -tx1 -N5 "$n" | tr -d ' \n'))"
      if [[ "$PLATFORM" == linux && "$SMOKE" != 0 ]]; then
        echo "--- smoke: AppImage under Xvfb"
        apt-get install -y -qq xvfb x11-utils squashfs-tools libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libnotify4 libsecret-1-0 >/dev/null
        cd /tmp && app=$(ls /build/rel/*.AppImage | head -1)
        # extract the embedded squashfs (portable: also works where the AppImage runtime cannot exec,
        # e.g. under Rosetta/qemu on Apple Silicon, which reject its marked ELF header)
        off=$(python3 -c "import struct;h=open('$app','rb').read(64);o,=struct.unpack_from('<Q',h,40);e,c=struct.unpack_from('<HH',h,58);print(o+e*c)")
        unsquashfs -q -o "$off" -d sq "$app" >/dev/null
        export DISPLAY=:99; Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 & sleep 2
        ./sq/calaba --no-sandbox --disable-gpu > run.log 2>&1 & pid=$!
        sleep 20
        kill -0 $pid 2>/dev/null && echo "smoke: process alive after 20 s" || { echo "smoke: process EXITED"; tail -20 run.log; exit 4; }
        w=$(xwininfo -root -tree | grep -c '"Calaba"' || true); echo "smoke: X windows titled Calaba: $w"
        grep -iE "uiohook|error" ~/.config/Calaba/logs/main.log 2>/dev/null | head -5 || true
        kill $pid 2>/dev/null || true; [[ "$w" -ge 1 ]] || exit 4
      fi
      cd /build/rel
      cp -v *.AppImage *.deb latest-linux.yml /out/ 2>/dev/null || true
      cp -v *.exe *.exe.blockmap latest.yml /out/ 2>/dev/null || true
CONTAINER
}

build_docker() { # $1 = linux | win
  local t0=$SECONDS platform="$1" args host rc=0 limits=()
  case "$platform" in
    linux) args="--linux AppImage deb"; host="${BUILD_DOCKER_HOST:-}" ;;
    # Windows (decision 2026-09-26, option b): node-gyp cannot compile for win32 outside Windows, so the
    # upstream N-API prebuild prebuilds/win32-x64 is re-included for the win target only. Our patch touches
    # only libuiohook's darwin code (+ a define used there), so on Windows it is the same module.
    # macOS/Linux keep the strict "patched build from source" policy of electron-builder.yml.
    # electron-builder takes only `!exclusions` from plain `files` strings for node_modules; an inclusion
    # must be a FileSet {from: ".", filter: [...]}, which the CLI cannot express — hence a generated
    # config (electron-builder.win.yml, extends electron-builder.yml) inside the build copy only.
    win)   args="--win nsis --config electron-builder.win.yml"
           host="${WIN_DOCKER_HOST:-${BUILD_DOCKER_HOST:-}}" ;;
  esac
  write_container_script
  # env-file values are taken literally; EB_ARGS is re-parsed by `eval` inside the container
  printf '%s\n' "PNPM_VERSION=$PNPM_VERSION" CI=true "PLATFORM=$platform" "SMOKE=${SMOKE:-1}" \
    "EB_ARGS=$args $(printf '%q ' "${EB_COMMON[@]}")" > "$WORK/container.env"
  local run=(docker run --rm -i --platform linux/amd64 --env-file ENVFILE
    -v SRC:/src:ro -v OUT:/out
    -v calaba-release-pnpm-store:/root/.local/share/pnpm/store -v calaba-release-electron-cache:/root/.cache)
  if [[ -n "$host" ]]; then
    # One plain ssh session per step (DOCKER_HOST=ssh:// opens many and trips sshd's MaxStartups).
    local r="${host#ssh://}" rdir="/tmp/calaba-release-$$-$platform"
    log "Docker ($platform) on $r"
    retry ssh "${SSH_OPTS[@]}" "$r" "rm -rf $rdir && mkdir -p $rdir/src $rdir/out" || return 1
    retry rsync -az --exclude node_modules --exclude 'dist*' --exclude out -e "ssh ${SSH_OPTS[*]}" "$SRC/" "$r:$rdir/src/" || return 1
    retry rsync -az -e "ssh ${SSH_OPTS[*]}" "$WORK/container.sh" "$WORK/container.env" "$r:$rdir/" || return 1
    # shared host: hard caps + lowest CPU/IO priority (docker equivalents of nice/ionice)
    limits=(--cpus "${REMOTE_CPUS:-4}" --memory "${REMOTE_MEMORY:-6g}" --cpu-shares 128 --blkio-weight 10)
    local cmd="${run[*]} ${limits[*]} $BUILDER_IMAGE bash -euo pipefail -s < $rdir/container.sh"
    cmd="${cmd//ENVFILE/$rdir/container.env}"; cmd="${cmd//SRC:/$rdir/src:}"; cmd="${cmd//OUT:/$rdir/out:}"
    ssh "${SSH_OPTS[@]}" "$r" "$cmd" || rc=$?
    [[ $rc -eq 0 ]] && { retry rsync -az -e "ssh ${SSH_OPTS[*]}" "$r:$rdir/out/" "$OUT/" || rc=$?; }
    retry ssh "${SSH_OPTS[@]}" "$r" "rm -rf $rdir" || echo "WARNING: could not remove $r:$rdir" >&2
  else
    log "Docker ($platform, local): $BUILDER_IMAGE"
    run=("${run[@]/ENVFILE/$WORK/container.env}"); run=("${run[@]/#SRC:/$SRC:}"); run=("${run[@]/#OUT:/$OUT:}")
    "${run[@]}" "$BUILDER_IMAGE" bash -euo pipefail -s < "$WORK/container.sh" || rc=$?
  fi
  TIMES+="$platform=$((SECONDS - t0)) "
  return $rc
}

FAILED=""
for p in "${platforms[@]}"; do [[ "$p" == mac ]] && build_mac; done
for p in "${platforms[@]}"; do
  case "$p" in
    linux) build_docker linux || FAILED+="linux " ;;
    win)
      if [[ "$(uname -m)" == arm64 && -z "${WIN_DOCKER_HOST:-${BUILD_DOCKER_HOST:-}}" ]]; then
        echo "WARNING: Windows NSIS cannot be built on Apple Silicon Docker (32-bit wine under qemu crashes);" >&2
        echo "         set BUILD_DOCKER_HOST=ssh://user@x86_64-linux-host." >&2
        FAILED+="win "
      else
        build_docker win || FAILED+="win "
      fi ;;
  esac
done

log "artifacts in $OUT"
ls -lh "$OUT" | awk 'NR>1 {print $5, $9}'
for kv in $TIMES; do t=${kv#*=}; echo "time[${kv%%=*}]: $((t / 60))m$((t % 60))s"; done
[[ -z "$FAILED" ]] || { echo "FAILED: $FAILED" >&2; exit 2; }

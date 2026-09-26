#!/usr/bin/env bash
# Build Calaba desktop releases for macOS, Linux and Windows from this Mac (docs/06, "Релизы десктопа: сборка").
#
#   apps/desktop/scripts/build-release.sh [mac] [linux] [win]    # default: all three
#   apps/desktop/scripts/build-release.sh smoke                  # only re-run the Linux smoke on dist-release
#
# Env:
#   SRC_REF=HEAD        git ref to build (a clean `git archive` export — uncommitted changes are NOT built)
#   VERSION=1.2.3       override apps/desktop/package.json version (applied to the export only)
#   UPDATE_URL=…        electron-updater generic feed baked into app-update.yml / latest*.yml
#                       (default https://colaba.gptunnel.ai/download/)
#   HOMEPAGE=…          package homepage (deb metadata; default: UPDATE_URL without /download/)
#   WORK_DIR=…          scratch dir (default $TMPDIR/calaba-release)
#   SMOKE=0             skip the Linux AppImage smoke start in Docker
#   WIN_DOCKER_HOST=ssh://user@host  x86_64 Linux Docker host for the Windows build (required on Apple
#                       Silicon: NSIS needs 32-bit wine, which Docker's qemu cannot run). REMOTE_CPUS/REMOTE_MEMORY limit it.
#
# Output: apps/desktop/dist-release/ — versioned installers + latest-mac.yml / latest-linux.yml / latest.yml
# (+ .blockmap). Publish with infra/docker/sync.sh (copies them to <domain>/download/, never deletes).
#
# Native module: uiohook-napi. Our patch (patches/uiohook-napi@1.5.5.patch) changes only the macOS hook,
# so macOS compiles it from source (arm64 + x64 → universal), while Linux/Windows use the N-API
# prebuilds shipped in the package (native code cannot be cross-compiled for Windows from Linux).
# Nothing is signed: macOS identity=null, Windows unsigned (see docs/06 for what signing needs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/apps/desktop/dist-release"
SRC_REF="${SRC_REF:-HEAD}"
UPDATE_URL="${UPDATE_URL:-https://colaba.gptunnel.ai/download/}"
HOMEPAGE="${HOMEPAGE:-${UPDATE_URL%/download/}}"
WORK="${WORK_DIR:-${TMPDIR:-/tmp}/calaba-release}"
SRC="$WORK/src"
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

# --- 2. macOS (native, universal) ---------------------------------------------------------------
build_mac() {
  local t0=$SECONDS
  log "macOS: pnpm install (compiles patched uiohook-napi for the host arch)"
  (cd "$SRC" && pnpm install --frozen-lockfile)
  (cd "$SRC/apps/desktop" && pnpm exec electron-vite build)
  # The patched module is compiled per arch into build/Release by electron-builder (node-gyp-build loads
  # that first). Drop the postinstall copy in bin/ (host arch only — identical in both halves, which
  # @electron/universal rejects) and the unpatched prebuilds for other platforms.
  grep -q VC_CAPS_LOCK_STATE "$SRC/node_modules/uiohook-napi/libuiohook/include/uiohook.h" \
    || { echo "uiohook-napi patch is NOT applied" >&2; exit 1; }
  rm -rf "$SRC/node_modules/uiohook-napi/bin" "$SRC/node_modules/uiohook-napi/prebuilds"
  log "macOS: electron-builder --mac --universal (rebuilds uiohook-napi from source for arm64 and x64)"
  (cd "$SRC/apps/desktop" && CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --universal \
    "${EB_COMMON[@]}" -c.directories.output=dist-release-mac)
  # verify the universal binary really carries both slices of the native module
  local node; node="$(find "$SRC/apps/desktop/dist-release-mac/mac-universal" -name 'uiohook_napi.node' | head -1)"
  echo "uiohook native in universal app: $(lipo -archs "$node")"
  [[ "$(lipo -archs "$node")" == *x86_64*arm64* || "$(lipo -archs "$node")" == *arm64*x86_64* ]] \
    || { echo "universal app lacks a slice of uiohook_napi.node" >&2; exit 1; }
  cp "$SRC/apps/desktop/dist-release-mac"/{*.dmg,*.zip,*.blockmap,latest-mac.yml} "$OUT"/
  TIMES+="mac=$((SECONDS - t0)) "
}

# --- 3. Linux + Windows in Docker ---------------------------------------------------------------
build_docker() { # $1 = linux | win
  local t0=$SECONDS platform="$1" args host="" src_m="$SRC" out_m="$OUT" limits=()
  case "$platform" in
    linux) args="--linux AppImage deb" ;;
    win)   args="--win nsis"; host="${WIN_DOCKER_HOST:-}" ;;
  esac
  if [[ -n "$host" ]]; then
    # Remote x86_64 Docker host (NSIS needs 32-bit wine, which qemu on Apple Silicon cannot run).
    local r="${host#ssh://}" rdir="/tmp/calaba-release-$$"
    log "Docker ($platform) on $host"
    ssh -o BatchMode=yes "$r" "rm -rf $rdir && mkdir -p $rdir/src $rdir/out"
    rsync -az --exclude node_modules --exclude 'dist*' --exclude out -e "ssh -o BatchMode=yes" "$SRC/" "$r:$rdir/src/"
    src_m="$rdir/src"; out_m="$rdir/out"
    limits=(--cpus "${REMOTE_CPUS:-4}" --memory "${REMOTE_MEMORY:-6g}")   # shared host: stay small
  else
    log "Docker ($platform): $BUILDER_IMAGE"
  fi
  DOCKER_HOST="${host:-${DOCKER_HOST:-}}" docker run --rm --platform linux/amd64 ${limits[@]+"${limits[@]}"} \
    -v "$src_m:/src:ro" -v "$out_m:/out" \
    -v calaba-release-pnpm-store:/root/.local/share/pnpm/store \
    -v calaba-release-electron-cache:/root/.cache \
    -e PNPM_VERSION="$PNPM_VERSION" -e CI=true \
    "$BUILDER_IMAGE" bash -euo pipefail -c '
      # work on the container filesystem (bind mounts from macOS are slow for node_modules)
      mkdir -p /build && tar -C /src --exclude=node_modules --exclude="dist-release*" --exclude=out --exclude=dist -cf - . | tar -C /build -xf - && cd /build
      corepack enable >/dev/null 2>&1 || npm i -g corepack >/dev/null
      corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null
      # --ignore-scripts: no uiohook compile (prebuilds are used), no electron postinstall download
      # (electron-builder fetches the Electron dist itself); esbuild uses its optional platform package.
      pnpm install --frozen-lockfile --ignore-scripts
      cd apps/desktop && pnpm exec electron-vite build
      # ship only the prebuild for the target (node-gyp-build picks prebuilds/<platform>-<arch>)
      for d in ../../node_modules/uiohook-napi node_modules/uiohook-napi; do
        [[ -d "$d" ]] || continue
        rm -rf "$d/build" "$d/bin"
        find "$d/prebuilds" -mindepth 1 -maxdepth 1 ! -name "'"$([[ $platform == linux ]] && echo linux-x64 || echo win32-x64)"'" -exec rm -rf {} +
      done
      pnpm exec electron-builder '"$args"' --x64 '"$(printf "%q " "${EB_COMMON[@]}")"' \
        -c.npmRebuild=false -c.directories.output=/build/dist-release-docker
      cd /build/dist-release-docker
      cp -v *.AppImage *.deb latest-linux.yml /out/ 2>/dev/null || true
      cp -v *.exe *.exe.blockmap latest.yml /out/ 2>/dev/null || true
      # the prebuild that will be loaded at runtime (node-gyp-build: prebuilds/<platform>-<arch>)
      find . -path "*uiohook-napi/prebuilds/*" -name "*.node" | sed "s#^#packaged prebuild: #" | sort -u
    '
  if [[ -n "$host" ]]; then
    rsync -az -e "ssh -o BatchMode=yes" "${host#ssh://}:$out_m/" "$OUT/"
    ssh -o BatchMode=yes "${host#ssh://}" "rm -rf ${out_m%/out}"
  fi
  TIMES+="$platform=$((SECONDS - t0)) "
}

# --- 4. Linux smoke: start the AppImage headless ----------------------------------------------------
smoke_linux() {
  local app; app="$(ls -1 "$OUT"/Calaba-"$APP_VERSION"-x86_64.AppImage 2>/dev/null | head -1)"
  [[ -f "$app" ]] || { echo "no AppImage for smoke test"; return 1; }
  log "Linux smoke: $(basename "$app") under Xvfb"
  docker run --rm --platform linux/amd64 -v "$OUT:/out:ro" "$BUILDER_IMAGE" bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null && apt-get install -y -qq xvfb xauth libgtk-3-0 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 libnotify4 libsecret-1-0 >/dev/null 2>&1 \
      || apt-get install -y -qq xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libnotify4 libsecret-1-0 >/dev/null
    apt-get install -y -qq squashfs-tools >/dev/null
    cd /tmp && cp "/out/'"$(basename "$app")"'" app.AppImage
    # The AppImage runtime marks its ELF header ("AI\x02" in e_ident padding), which Rosetta/qemu binfmt
    # on Apple Silicon refuse to execute, so extract the embedded squashfs at the ELF end instead.
    off=$(python3 -c "import struct;h=open(\"app.AppImage\",\"rb\").read(64);shoff,=struct.unpack_from(\"<Q\",h,40);shentsize,shnum=struct.unpack_from(\"<HH\",h,58);print(shoff+shentsize*shnum)")
    unsquashfs -q -o "$off" -d squashfs-root app.AppImage >/dev/null
    bin=$(find squashfs-root -maxdepth 1 -type f -perm -u+x ! -name "*.so*" ! -name AppRun ! -name chrome-sandbox ! -name chrome_crashpad_handler | head -1)
    echo "binary: $bin"
    apt-get install -y -qq x11-utils >/dev/null
    export ELECTRON_ENABLE_LOGGING=1 DISPLAY=:99
    Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 & sleep 2
    "$bin" --no-sandbox --disable-gpu > run.log 2>&1 & pid=$!
    sleep 20
    kill -0 $pid 2>/dev/null && echo "process: alive after 20 s" || echo "process: EXITED"
    echo "--- X windows"; xwininfo -root -tree | grep -iE "\"Calaba" | sed "s/^ */  /" | head -5
    kill $pid 2>/dev/null || true; sleep 1
    echo "--- stderr (filtered)"; grep -vE "dbus|Gtk-WARNING|libva|Fontconfig|vaapi|power_observer" run.log | head -15
    echo "--- app log (electron-log)"; cat ~/.config/*/logs/main.log 2>/dev/null | cut -c1-200 | head -30
  '
}

if [[ "${platforms[*]}" == smoke ]]; then APP_VERSION="${VERSION:-$(node -p "require('$ROOT/apps/desktop/package.json').version")}"; smoke_linux; exit; fi
for p in "${platforms[@]}"; do [[ "$p" == mac ]] && build_mac; done
for p in "${platforms[@]}"; do
  [[ "$p" == linux ]] && { build_docker linux; [[ "${SMOKE:-1}" != 0 ]] && smoke_linux; }
done
for p in "${platforms[@]}"; do
  if [[ "$p" == win ]]; then
    if [[ "$(uname -m)" == arm64 && -z "${WIN_DOCKER_HOST:-}" ]]; then
      echo "WARNING: Windows NSIS cannot be built on Apple Silicon Docker (32-bit wine under qemu crashes)." >&2
      echo "         Set WIN_DOCKER_HOST=ssh://user@x86_64-linux-host (Docker installed) or use CI." >&2
      WIN_FAILED=1
    else
      build_docker win
    fi
  fi
done

log "artifacts in $OUT"
ls -lh "$OUT" | awk 'NR>1 {print $5, $9}'
for kv in $TIMES; do t=${kv#*=}; echo "time[${kv%%=*}]: $((t / 60))m$((t % 60))s"; done
[[ -n "${WIN_FAILED:-}" ]] && exit 2 || true

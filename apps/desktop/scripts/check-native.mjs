#!/usr/bin/env node
// Verifies that a packaged Calab carries OUR uiohook-napi build (patches/uiohook-napi@*.patch), not
// the upstream prebuilt binary. Fails the release build otherwise (release.yml, build-release.sh).
//
//   node apps/desktop/scripts/check-native.mjs <path>...
//
// <path>: a packaged app dir (dist-release, mac-arm64/Calab.app, linux-unpacked, win-unpacked), a .node
// file, or (macOS) a .dmg — mounted read-only for the check. Every uiohook*.node found must contain the
// marker string the patch compiles into src/lib/addon.c; a macOS (Mach-O) binary must also carry the marker
// of the darwin IOHIDManager keyboard listener (physical Caps Lock, libuiohook darwin/input_hook.c). Exception: prebuilds/win32-* — Windows packages
// built outside Windows ship the upstream N-API prebuild on purpose (the patch has no Windows code; see
// electron-builder.yml `win.files`); it is reported, not failed. Any other prebuilds/* binary fails:
// node-gyp-build would load it whenever build/Release is missing.
//
// Exit: 0 PASS, 1 FAIL, 2 usage error.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';

const MARKER = 'CALABA_UIOHOOK_PATCH_V2';
const HID_MARKER = 'CALABA_HID_CAPS_V1';
const OLD_MARKERS = ['CALABA_UIOHOOK_PATCH_V1'];
// Informational: the patched darwin hook stores keycode VC_CAPS_LOCK_STATE (0x0F3A) + rawcode
// kVK_CapsLock (0x39) as one constant — present in builds of the patch that predate the marker.
const CAPS_STATE_SIG = Buffer.from([0x3a, 0x0f, 0x39, 0x00]);

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.error('usage: check-native.mjs <app dir | .node | .dmg>...');
  process.exit(2);
}

function findNodes(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    // .app bundles are directories; follow no symlinks (Electron Framework is full of them)
    if (e.isDirectory()) findNodes(p, out);
    else if (e.isFile() && e.name.endsWith('.node') && p.includes('uiohook')) out.push(p);
  }
  return out;
}

/** Mach-O (thin 64-bit or universal): the HID listener exists only in darwin builds. */
function isMachO(bin) {
  if (bin.length < 4) return false;
  const le = bin.readUInt32LE(0);
  const be = bin.readUInt32BE(0);
  return le === 0xfeedfacf || le === 0xfeedface || be === 0xcafebabe;
}

function withDmg(dmg, fn) {
  const mnt = mkdtempSync(join(tmpdir(), 'check-native-'));
  execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-noverify', '-mountpoint', mnt, dmg], { stdio: 'ignore' });
  try {
    return fn(mnt);
  } finally {
    execFileSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' });
    rmSync(mnt, { recursive: true, force: true });
  }
}

let failed = false;
let checked = 0;

function check(root) {
  const files = statSync(root).isDirectory() ? findNodes(root) : [root];
  if (files.length === 0) {
    console.log(`FAIL ${root}: no uiohook .node found (a missing module crashes main at startup)`);
    failed = true;
    return;
  }
  for (const f of files) {
    checked++;
    const rel = statSync(root).isDirectory() ? relative(root, f) : basename(f);
    const bin = readFileSync(f);
    const prebuild = f.split(sep).includes('prebuilds');
    if (bin.includes(MARKER)) {
      if (isMachO(bin) && !bin.includes(HID_MARKER)) {
        console.log(`FAIL ${rel}: macOS binary without the HID listener (${HID_MARKER} missing)`);
        failed = true;
      } else {
        console.log(`PASS ${rel}: patched build (${MARKER}${isMachO(bin) ? ` + ${HID_MARKER}` : ''})`);
      }
    } else if (prebuild && /[\\/]prebuilds[\\/]win32-/.test(f)) {
      console.log(`note ${rel}: upstream Windows prebuild (allowed: the patch has no Windows code)`);
    } else {
      const old = OLD_MARKERS.find((m) => bin.includes(m));
      const hint = old
        ? `built from an older patch (${old}) — rebuild the native module`
        : bin.includes(CAPS_STATE_SIG)
          ? 'patched darwin code present, but built before the marker existed'
          : 'upstream/unpatched binary';
      console.log(`FAIL ${rel}: marker ${MARKER} missing — ${hint}`);
      failed = true;
    }
  }
}

for (const a of args) {
  if (a.endsWith('.dmg')) withDmg(a, check);
  else check(a);
}
console.log(failed ? `check-native: FAIL (${checked} binaries)` : `check-native: PASS (${checked} binaries)`);
process.exit(failed ? 1 : 0);

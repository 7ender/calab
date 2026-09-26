import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import log from 'electron-log/main';
import { HID_CAPS_LOCK, HID_F18, parseUserKeyMapping, toHidutilJson, withCapsToF18, type KeyMapping } from '../shared/hidMapping';

/**
 * macOS «Caps Lock doesn't toggle upper case» option for push-to-talk: while Calaba runs,
 * Caps Lock is remapped to F18 with `hidutil` (user session, no sudo — checked on macOS 26/27),
 * so it reports a real press/release and PTT works as hold-to-talk.
 *
 * Safety: the user's own UserKeyMapping is read first and kept; the original list is saved
 * in `<userData>/ptt-remap.json` before we touch anything and restored on unbind / quit.
 * If the app crashed with the remap applied, the next start restores it (recoverCapsRemap).
 */

const run = promisify(execFile);
const HIDUTIL = '/usr/bin/hidutil';

let applied: KeyMapping[] | null = null; // the user's original mapping while ours is active
let recovery: Promise<void> = Promise.resolve();

function markerFile(): string {
  return join(app.getPath('userData'), 'ptt-remap.json');
}

async function getMapping(): Promise<KeyMapping[]> {
  const { stdout } = await run(HIDUTIL, ['property', '--get', 'UserKeyMapping'], { timeout: 5000 });
  return parseUserKeyMapping(stdout);
}

async function setMapping(m: KeyMapping[]): Promise<void> {
  await run(HIDUTIL, ['property', '--set', toHidutilJson(m)], { timeout: 5000 });
}

export function capsRemapSupported(): boolean {
  return process.platform === 'darwin';
}

export function capsRemapActive(): boolean {
  return applied !== null;
}

let ops: Promise<void> = Promise.resolve();

/**
 * Apply (true) or restore (false) the remap. Calls run strictly one after another in call
 * order: interleaved awaits of a fast toggle could leave Caps→F18 applied with no binding
 * until quit (review L4).
 */
export function setCapsRemap(on: boolean): Promise<void> {
  const run = ops.then(() => (on ? applyCapsRemap() : restoreCapsRemap()));
  ops = run.catch(() => undefined);
  return run;
}

async function applyCapsRemap(): Promise<void> {
  if (!capsRemapSupported() || applied) return;
  await recovery;
  // Never save our own mapping as «the user's» (e.g. left over by a crash).
  const original = (await getMapping()).filter((m) => !(m.src === HID_CAPS_LOCK && m.dst === HID_F18));
  writeFileSync(markerFile(), JSON.stringify({ original }));
  // Mark as applied before the set: a quit during it must still restore synchronously.
  applied = original;
  try {
    await setMapping(withCapsToF18(original));
  } catch (e) {
    applied = null;
    rmSync(markerFile(), { force: true });
    throw e;
  }
  log.info('[ptt] Caps Lock → F18 remap applied', { kept: original.length });
}

async function restoreCapsRemap(): Promise<void> {
  if (!applied) return;
  const original = applied;
  applied = null;
  try {
    await setMapping(original);
    rmSync(markerFile(), { force: true });
    log.info('[ptt] Caps Lock remap restored');
  } catch (e) {
    log.error('[ptt] Caps Lock remap restore failed', e);
  }
}

/** Synchronous variant for `will-quit` (the event loop may not run async work to completion). */
export function restoreCapsRemapSync(): void {
  if (!applied) return;
  const original = applied;
  applied = null;
  try {
    execFileSync(HIDUTIL, ['property', '--set', toHidutilJson(original)], { timeout: 3000 });
    rmSync(markerFile(), { force: true });
  } catch (e) {
    log.error('[ptt] Caps Lock remap restore at quit failed', e);
  }
}

/** On start: a leftover marker means we crashed with the remap applied — put the user's mapping back. */
export function recoverCapsRemap(): Promise<void> {
  recovery = recoverOnce();
  return recovery;
}

async function recoverOnce(): Promise<void> {
  if (!capsRemapSupported()) return;
  let original: KeyMapping[];
  try {
    original = (JSON.parse(readFileSync(markerFile(), 'utf8')) as { original: KeyMapping[] }).original;
  } catch {
    return; // no marker
  }
  try {
    await setMapping(original);
    rmSync(markerFile(), { force: true });
    log.warn('[ptt] restored the keyboard mapping left by a previous crash');
  } catch (e) {
    log.error('[ptt] crash recovery of the Caps Lock remap failed', e);
  }
}

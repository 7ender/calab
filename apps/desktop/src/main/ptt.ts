import { systemPreferences, type WebContents } from 'electron';
import log from 'electron-log/main';
import uiohookModule from 'uiohook-napi';
import { IPC, type PttBinding, type PttEvent, type PttStatus } from '../shared/ipc';
import { PttGate } from '../shared/pttGate';
import { KEY, MIN_MOUSE_BUTTON, isToggleOnly, keyName, mouseName } from '../shared/pttKeys';
import { applyCapsRemap, capsRemapActive, capsRemapSupported, restoreCapsRemap, restoreCapsRemapSync } from './capsRemap';

/**
 * Global push-to-talk via uiohook-napi (docs/02-media.md, «Push-to-talk»).
 *
 * Main owns the key: capture (any key incl. F13–F24, lone modifiers, Numpad, Caps Lock,
 * mouse buttons 3+), and the hold/toggle gate. The renderer gets «talking» on/off and
 * applies the release delay next to the audio track.
 *
 * macOS Caps Lock: a hardware Caps Lock only reports lock-state flips (patched libuiohook →
 * KEY.CAPS_LOCK_STATE), i.e. it can only be a toggle. The «don't toggle upper case» option
 * remaps it to F18 (capsRemap.ts) → a real hold key. If the system also delivers Caps Lock
 * press/release (NX_SYSDEFINED path → KEY.CAPS_LOCK), capture detects it and uses hold.
 *
 * The hook starts lazily (first binding / capture) so users who never enable PTT are never
 * asked for Accessibility / Input Monitoring.
 */

const { uIOhook } = uiohookModule;
const OS = process.platform;
/** After a Caps Lock event during capture, wait this long to see whether a real press/release follows. */
const CAPS_PROBE_MS = 350;

let hookRunning = false;
let hookError: string | null = null;
let binding: PttBinding | null = null;
let gate: PttGate | null = null;
const subscribers = new Set<WebContents>();

interface Capture {
  resolve: (b: PttBinding) => void;
  reject: (e: Error) => void;
  /** Caps Lock probe in progress: which Caps Lock signals arrived. */
  caps?: { hold: boolean; timer: NodeJS.Timeout };
}
let capture: Capture | null = null;

function trusted(prompt: boolean): boolean {
  if (OS !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(prompt);
}

function send(talking: boolean): void {
  const ev: PttEvent = { down: talking };
  for (const wc of subscribers) {
    if (wc.isDestroyed()) subscribers.delete(wc);
    else wc.send(IPC.pttEvent, ev);
  }
}

function finishCapture(b: PttBinding): void {
  const c = capture;
  capture = null;
  if (c?.caps) clearTimeout(c.caps.timer);
  log.info('[ptt] captured', b);
  c?.resolve(b);
}

function captureKey(code: number): void {
  if (!capture) return;
  if (code === KEY.ESCAPE) {
    const c = capture;
    capture = null;
    c.reject(new Error('cancelled'));
    return;
  }
  if (code === KEY.CAPS_LOCK || code === KEY.CAPS_LOCK_STATE) {
    // Collect Caps Lock signals briefly: a real press (KEY.CAPS_LOCK) means hold works.
    if (!capture.caps) {
      capture.caps = {
        hold: false,
        timer: setTimeout(() => {
          const hold = capture?.caps?.hold ?? false;
          finishCapture(
            hold
              ? { kind: 'key', code: KEY.CAPS_LOCK, label: keyName(KEY.CAPS_LOCK, OS), mode: 'hold' }
              : { kind: 'key', code: KEY.CAPS_LOCK_STATE, label: keyName(KEY.CAPS_LOCK_STATE, OS), mode: 'toggle' },
          );
        }, CAPS_PROBE_MS),
      };
    }
    if (code === KEY.CAPS_LOCK) capture.caps.hold = true;
    return;
  }
  if (capture.caps) return; // other keys while probing Caps Lock are ignored
  if (code === KEY.F18 && capsRemapActive()) {
    // Caps Lock is currently remapped to F18: the user pressed Caps Lock.
    finishCapture({ kind: 'key', code: KEY.F18, label: keyName(KEY.CAPS_LOCK, OS), mode: 'hold', remap: 'caps-f18' });
    return;
  }
  finishCapture({ kind: 'key', code, label: keyName(code, OS), mode: 'hold' });
}

function onKey(code: number, down: boolean): void {
  if (capture) {
    // The macOS lock-state code arrives as «up» when Caps Lock turns off — still a press.
    if (down || code === KEY.CAPS_LOCK_STATE) captureKey(code);
    return;
  }
  if (binding?.kind === 'key' && binding.code === code) gate?.input(down);
}

function mouseButton(raw: unknown): number {
  return typeof raw === 'number' ? raw : Number(raw);
}

function onMouse(raw: unknown, down: boolean): void {
  const b = mouseButton(raw);
  if (capture && down && b >= MIN_MOUSE_BUTTON && !capture.caps) {
    finishCapture({ kind: 'mouse', code: b, label: mouseName(b), mode: 'hold' });
    return;
  }
  if (binding?.kind === 'mouse' && binding.code === b) gate?.input(down);
}

function ensureHook(): void {
  if (hookRunning) return;
  if (OS === 'linux' && process.env['XDG_SESSION_TYPE'] === 'wayland') {
    hookError = 'wayland';
  }
  // Prompts for Accessibility on first use on macOS; the hook receives nothing until granted.
  if (!trusted(true)) hookError = 'macOS: нет разрешения «Мониторинг ввода» / «Универсальный доступ»';
  try {
    uIOhook.on('keydown', (e) => onKey(e.keycode, true));
    uIOhook.on('keyup', (e) => onKey(e.keycode, false));
    uIOhook.on('mousedown', (e) => onMouse(e.button, true));
    uIOhook.on('mouseup', (e) => onMouse(e.button, false));
    uIOhook.start();
    hookRunning = true;
  } catch (err) {
    uIOhook.removeAllListeners();
    hookError = err instanceof Error ? err.message : String(err);
  }
}

export function pttStatus(): PttStatus {
  return {
    active: hookRunning && binding !== null,
    binding,
    trusted: trusted(false),
    error: hookError,
    capsRemap: !capsRemapSupported() ? 'unsupported' : capsRemapActive() ? 'active' : 'available',
    wayland: OS === 'linux' && process.env['XDG_SESSION_TYPE'] === 'wayland',
  };
}

export async function setBinding(owner: WebContents, next: PttBinding | null): Promise<PttStatus> {
  gate?.reset();
  binding = next;
  if (next && next.kind !== 'dom') {
    const lock = next.kind === 'key' && isToggleOnly(next.code);
    gate = new PttGate(lock ? 'toggle' : (next.mode ?? 'hold'), lock, send);
    subscribers.add(owner);
    ensureHook();
  } else {
    gate = null;
    subscribers.delete(owner);
  }
  // The remap lives exactly as long as a binding that needs it.
  try {
    if (next?.kind === 'key' && next.remap === 'caps-f18') await applyCapsRemap();
    else await restoreCapsRemap();
  } catch (e) {
    log.error('[ptt] Caps Lock remap failed', e);
    hookError = `Не удалось переназначить Caps Lock: ${e instanceof Error ? e.message : String(e)}`;
  }
  return pttStatus();
}

export function captureNext(): Promise<PttBinding> {
  ensureHook();
  if (!hookRunning) return Promise.reject(new Error(hookError ?? 'uiohook is not running'));
  if (capture) {
    if (capture.caps) clearTimeout(capture.caps.timer);
    capture.reject(new Error('superseded'));
  }
  return new Promise((resolve, reject) => {
    capture = { resolve, reject };
  });
}

export function shutdownPtt(): void {
  restoreCapsRemapSync();
  if (!hookRunning) return;
  try {
    uIOhook.stop();
  } catch {
    // Ignore: process is quitting anyway.
  }
  uIOhook.removeAllListeners();
  hookRunning = false;
}

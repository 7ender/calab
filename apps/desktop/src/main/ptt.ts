import { systemPreferences, type WebContents } from 'electron';
import log from 'electron-log/main';
import uiohookModule from 'uiohook-napi';
import { IPC, type PttBinding, type PttEvent, type PttStatus } from '../shared/ipc';
import { PttGate } from '../shared/pttGate';
import { PttCapture, captureWithCapsRemap } from '../shared/pttCapture';
import { isToggleOnly } from '../shared/pttKeys';
import { capsRemapActive, capsRemapSupported, restoreCapsRemapSync, setCapsRemap } from './capsRemap';

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

let hookRunning = false;
let hookError: string | null = null;
let binding: PttBinding | null = null;
let gate: PttGate | null = null;
const subscribers = new Set<WebContents>();

/** Key capture for the binder (shared/pttCapture.ts: cancel + timeout, review H2). */
const capture = new PttCapture({
  os: OS,
  capsRemapActive,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  log: (msg, data) => log.info(msg, data ?? ''),
});

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

function onKey(code: number, down: boolean): void {
  if (capture.onKey(code, down)) return;
  if (binding?.kind === 'key' && binding.code === code) gate?.input(down);
}

function mouseButton(raw: unknown): number {
  return typeof raw === 'number' ? raw : Number(raw);
}

function onMouse(raw: unknown, down: boolean): void {
  const b = mouseButton(raw);
  if (capture.onMouse(b, down)) return;
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

/**
 * Sleep / screen lock: a key-up lost meanwhile (or swallowed by secure input) must not leave
 * PTT transmitting after wake (review M6). A toggle is switched off too — the safe side.
 */
export function resetPttGate(): void {
  gate?.reset();
  // An armed capture must not grab the first key typed after wake / unlock (review N6).
  capture.cancel(undefined, 'suspended');
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
  // The remap lives exactly as long as a binding that needs it (capsRemap serializes the
  // apply/restore calls in call order, so the last setBinding wins — review L4).
  try {
    await setCapsRemap(next?.kind === 'key' && next.remap === 'caps-f18');
  } catch (e) {
    log.error('[ptt] Caps Lock remap failed', e);
    hookError = `Не удалось переназначить Caps Lock: ${e instanceof Error ? e.message : String(e)}`;
  }
  return pttStatus();
}

export function captureNext(id: number): Promise<PttBinding> {
  ensureHook();
  if (!hookRunning) return Promise.reject(new Error(hookError ?? 'uiohook is not running'));
  // The PTT key may be held right now (the user clicked «Assign» mid-talk): stop talking, so a
  // key-up lost to the capture can never leave the gate open (review N5).
  gate?.reset();
  // macOS: Caps Lock → F18 while the capture is armed, or Caps Lock used for layout switching is
  // invisible to the hook (shared/pttCapture.ts, captureWithCapsRemap).
  return captureWithCapsRemap(
    capture,
    { id },
    {
      supported: capsRemapSupported,
      active: capsRemapActive,
      set: setCapsRemap,
      wanted: () => binding?.kind === 'key' && binding.remap === 'caps-f18',
      log: (msg, err) => log.warn(msg, err),
    },
  );
}

/**
 * The binder closed (unmount): an armed capture must not grab the next key (review H2). Only the
 * capture that binder started (`id`) is cancelled, not another binder's (review N6).
 */
export function cancelCapture(id: number): void {
  capture.cancel(id);
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

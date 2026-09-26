import { systemPreferences, type WebContents } from 'electron';
import log from 'electron-log/main';
import uiohookModule, { type CalabaNative, type UiohookKeyboardEvent } from 'uiohook-napi';
import { IPC, type PttBinding, type PttEvent, type PttHidState, type PttRawKey, type PttStatus } from '../shared/ipc';
import { KeySourceMerger, type KeySource, type RawKeyEvent } from '../shared/keySource';
import { PttGate } from '../shared/pttGate';
import { PttCapture, captureWithCapsRemap } from '../shared/pttCapture';
import { KEY, resolveKeyBinding, type ResolvedKeyBinding } from '../shared/pttKeys';
import { capsRemapActive, capsRemapSupported, restoreCapsRemapSync, setCapsRemap } from './capsRemap';

/**
 * Global push-to-talk via uiohook-napi (docs/02-media.md, «Push-to-talk»).
 *
 * Main owns the key: capture (any key incl. F13–F24, lone modifiers, Numpad, Caps Lock,
 * mouse buttons 3+), and the hold/toggle gate. The renderer gets «talking» on/off and
 * applies the release delay next to the audio track.
 *
 * macOS Caps Lock: the patched uiohook also runs an IOHIDManager keyboard listener (source 'hid')
 * that reports the physical Caps Lock press/release — also when Caps Lock switches the input
 * source and the event tap sees nothing. Tap and HID copies of a key are merged by
 * shared/keySource.ts. Without the listener (no Input Monitoring) the older paths remain: the
 * lock-state toggle (KEY.CAPS_LOCK_STATE) and the hidutil Caps → F18 remap (capsRemap.ts).
 *
 * The hook starts lazily (first binding / capture) so users who never enable PTT are never
 * asked for Accessibility / Input Monitoring.
 */

const { uIOhook } = uiohookModule;
// Members are missing on the upstream Windows prebuild (electron-builder.yml win.files).
const native: CalabaNative = uiohookModule.calabaNative;
const OS = process.platform;

let hookRunning = false;
let hookError: string | null = null;
let binding: PttBinding | null = null;
/** What the gate listens to for a key binding (legacy Caps Lock bindings resolve to HID when it runs). */
let resolved: ResolvedKeyBinding | null = null;
/** The HID state `resolved` was computed with. */
let resolvedHid = false;
let gate: PttGate | null = null;
const subscribers = new Set<WebContents>();
const merger = new KeySourceMerger();
/** The binder that armed the capture: gets the raw-key diagnostics line. */
let captureOwner: WebContents | null = null;

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

// ---- macOS HID listener state ----

let hidRetried = false;

function hidState(): PttHidState {
  if (OS !== 'darwin' || !native.hidStatus) return 'unsupported';
  const s = native.hidStatus();
  if (s === 'denied' && native.hidAccess?.() === 'granted') {
    // Input Monitoring granted after the listener was refused: reopen once; if macOS still
    // refuses, it wants the app restarted.
    if (!hidRetried) {
      hidRetried = true;
      native.hidRetry?.();
      return 'starting';
    }
    return 'restart';
  }
  return s;
}

function hidInfo(): Record<string, unknown> {
  return { status: hidState(), access: native.hidAccess?.() ?? 'unsupported', devices: native.hidDevices?.() ?? 0 };
}

/** The listener opens on the hook thread a few ms after start (or after the Input Monitoring prompt). */
async function hidSettled(): Promise<void> {
  for (let i = 0; i < 40 && hidState() === 'starting'; i++) await new Promise((r) => setTimeout(r, 25));
}

/** Re-resolve the binding when the listener came up (or went away) after it was applied. */
function checkHidChange(): void {
  const hid = hidState() === 'running';
  if (hid === resolvedHid) return;
  log.info('[ptt] HID listener changed', hidInfo());
  resolvedHid = hid;
  const b = binding;
  const next = b?.kind === 'key' ? resolveKeyBinding(b, hid) : null;
  // Only a Caps Lock binding resolves differently: don't reset a gate that may be talking otherwise.
  if (JSON.stringify(next) === JSON.stringify(resolved)) return;
  rebuildGate();
  void syncRemap();
}

let hidWatch: NodeJS.Timeout | null = null;

function watchHid(): void {
  if (OS !== 'darwin' || hidWatch) return;
  const started = Date.now();
  let logged = false;
  hidWatch = setInterval(() => {
    const s = hidState();
    if (!logged && s !== 'starting') {
      logged = true;
      log.info('[ptt] HID listener', hidInfo());
    }
    checkHidChange();
    // Settled (or the Input Monitoring prompt was ignored for 2 min): pttStatus() keeps checking.
    if ((s !== 'starting' && s !== 'off') || Date.now() - started > 120_000) {
      if (hidWatch) clearInterval(hidWatch);
      hidWatch = null;
    }
  }, 500);
}

// ---- events ----

function send(talking: boolean): void {
  const ev: PttEvent = { down: talking };
  for (const wc of subscribers) {
    if (wc.isDestroyed()) subscribers.delete(wc);
    else wc.send(IPC.pttEvent, ev);
  }
}

/** While a capture is armed: every raw key event goes to the log and to the binder (diagnostics). */
function diag(e: RawKeyEvent, dropped: boolean): void {
  log.info('[ptt] raw', {
    source: e.source,
    keycode: e.code,
    rawcode: `0x${(e.rawcode ?? 0).toString(16)}`,
    flags: `0x${(e.mask ?? 0).toString(16)}`,
    down: e.down,
    ...(dropped ? { dropped } : {}),
  });
  const wc = captureOwner;
  if (!wc || wc.isDestroyed()) return;
  const raw: PttRawKey = { code: e.code, rawcode: e.rawcode ?? 0, source: e.source, down: e.down, dropped };
  wc.send(IPC.pttRawKey, raw);
}

function onKeyEvent(e: UiohookKeyboardEvent, down: boolean): void {
  const ev: RawKeyEvent = { source: e.source ?? 'tap', code: e.keycode, down, rawcode: e.rawcode ?? 0, mask: e.mask ?? 0 };
  const accepted = merger.accept(ev);
  if (capture.active) diag(ev, !accepted);
  if (accepted) onKey(ev.code, down, ev.source);
}

function onKey(code: number, down: boolean, source: KeySource): void {
  if (capture.onKey(code, down, source)) return;
  if (resolved?.code === code) gate?.input(down);
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
    uIOhook.on('keydown', (e) => onKeyEvent(e, true));
    uIOhook.on('keyup', (e) => onKeyEvent(e, false));
    uIOhook.on('mousedown', (e) => onMouse(e.button, true));
    uIOhook.on('mouseup', (e) => onMouse(e.button, false));
    uIOhook.start();
    hookRunning = true;
    watchHid();
  } catch (err) {
    uIOhook.removeAllListeners();
    hookError = err instanceof Error ? err.message : String(err);
  }
}

// ---- binding ----

function rebuildGate(): void {
  gate?.reset();
  merger.reset();
  const b = binding;
  if (!b || b.kind === 'dom') {
    gate = null;
    resolved = null;
    return;
  }
  resolved = b.kind === 'key' ? resolveKeyBinding(b, resolvedHid) : null;
  gate = new PttGate(resolved?.mode ?? b.mode ?? 'hold', resolved?.lockKey ?? false, send);
}

/**
 * The hidutil remap lives exactly as long as a binding that needs it — only without the HID
 * listener (capsRemap serializes apply/restore in call order, the last call wins — review L4).
 */
async function syncRemap(): Promise<void> {
  try {
    await setCapsRemap(resolved?.remap ?? false);
  } catch (e) {
    log.error('[ptt] Caps Lock remap failed', e);
    hookError = `Не удалось переназначить Caps Lock: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function isCapsBinding(b: PttBinding | null): boolean {
  return b?.kind === 'key' && (b.remap === 'caps-f18' || b.code === KEY.CAPS_LOCK || b.code === KEY.CAPS_LOCK_STATE);
}

export function pttStatus(): PttStatus {
  checkHidChange();
  return {
    active: hookRunning && binding !== null,
    binding,
    trusted: trusted(false),
    error: hookError,
    capsRemap: !capsRemapSupported() ? 'unsupported' : capsRemapActive() ? 'active' : 'available',
    wayland: OS === 'linux' && process.env['XDG_SESSION_TYPE'] === 'wayland',
    hid: hidState(),
  };
}

/**
 * Sleep / screen lock: a key-up lost meanwhile (or swallowed by secure input) must not leave
 * PTT transmitting after wake (review M6). A toggle is switched off too — the safe side.
 */
export function resetPttGate(): void {
  gate?.reset();
  merger.reset();
  // An armed capture must not grab the first key typed after wake / unlock (review N6).
  capture.cancel(undefined, 'suspended');
}

export async function setBinding(owner: WebContents, next: PttBinding | null): Promise<PttStatus> {
  gate?.reset();
  binding = next;
  if (next && next.kind !== 'dom') {
    subscribers.add(owner);
    ensureHook();
  } else {
    subscribers.delete(owner);
  }
  // A saved Caps Lock binding at startup: let the listener open before choosing HID vs hidutil.
  if (isCapsBinding(next)) await hidSettled();
  resolvedHid = hidState() === 'running';
  rebuildGate();
  await syncRemap();
  return pttStatus();
}

export function captureNext(owner: WebContents, id: number): Promise<PttBinding> {
  ensureHook();
  if (!hookRunning) return Promise.reject(new Error(hookError ?? 'uiohook is not running'));
  // The PTT key may be held right now (the user clicked «Assign» mid-talk): stop talking, so a
  // key-up lost to the capture can never leave the gate open (review N5).
  gate?.reset();
  captureOwner = owner;
  const hid = hidState();
  log.info('[ptt] capture armed', hidInfo());
  const done = (p: Promise<PttBinding>): Promise<PttBinding> =>
    p.finally(() => {
      if (captureOwner === owner && !capture.active) captureOwner = null;
    });
  // The HID listener sees the physical Caps Lock: no remap needed.
  if (hid === 'running' || hid === 'starting' || hid === 'unsupported') return done(capture.start({ id }));
  // Fallback (macOS without Input Monitoring): Caps Lock → F18 while the capture is armed, or a
  // Caps Lock used for layout switching is invisible to the tap (shared/pttCapture.ts).
  return done(
    captureWithCapsRemap(
      capture,
      { id },
      {
        supported: capsRemapSupported,
        active: capsRemapActive,
        set: setCapsRemap,
        wanted: () => resolved?.remap ?? false,
        log: (msg, err) => log.warn(msg, err),
      },
    ),
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
  if (hidWatch) clearInterval(hidWatch);
  hidWatch = null;
  if (!hookRunning) return;
  try {
    uIOhook.stop();
  } catch {
    // Ignore: process is quitting anyway.
  }
  uIOhook.removeAllListeners();
  hookRunning = false;
}

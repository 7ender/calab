import { systemPreferences, type WebContents } from 'electron';
import uiohookModule from 'uiohook-napi';
import { IPC, type PttBinding, type PttEvent, type PttStatus } from '../shared/ipc';

/**
 * Global push-to-talk via uiohook-napi (docs/02-media.md, "Push-to-talk").
 * Main only reports raw down/up of the bound key; the release delay and the
 * mute logic live in the renderer next to the audio track.
 *
 * The hook is started lazily (first binding / capture) so users who never
 * enable PTT are never asked for Accessibility / Input Monitoring on macOS.
 */

const { uIOhook, UiohookKey } = uiohookModule;

// uiohook mouse buttons: 1 = left, 2 = right, 3 = middle, 4/5 = side buttons.
// Left/right are never allowed as PTT (they would fire on every click).
const MIN_MOUSE_BUTTON = 3;

const keyNames = new Map<number, string>(Object.entries(UiohookKey).map(([name, code]) => [code, name]));

let hookRunning = false;
let hookError: string | null = null;
let binding: PttBinding | null = null;
let pressed = false;
const subscribers = new Set<WebContents>();
let pendingCapture: { resolve: (b: PttBinding) => void; reject: (e: Error) => void } | null = null;

function trusted(prompt: boolean): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(prompt);
}

function emit(down: boolean): void {
  if (pressed === down) return; // swallow OS key auto-repeat
  pressed = down;
  const ev: PttEvent = { down };
  for (const wc of subscribers) {
    if (wc.isDestroyed()) subscribers.delete(wc);
    else wc.send(IPC.pttEvent, ev);
  }
}

function matches(kind: PttBinding['kind'], code: number): boolean {
  return binding !== null && binding.kind === kind && binding.code === code;
}

function mouseButton(raw: unknown): number {
  return typeof raw === 'number' ? raw : Number(raw);
}

function onKeyDown(e: { keycode: number }): void {
  if (pendingCapture) {
    const p = pendingCapture;
    pendingCapture = null;
    if (e.keycode === UiohookKey.Escape) p.reject(new Error('cancelled'));
    else p.resolve({ kind: 'key', code: e.keycode, label: keyNames.get(e.keycode) ?? `Key ${e.keycode}` });
    return;
  }
  if (matches('key', e.keycode)) emit(true);
}

function onKeyUp(e: { keycode: number }): void {
  if (matches('key', e.keycode)) emit(false);
}

function onMouseDown(e: { button: unknown }): void {
  const b = mouseButton(e.button);
  if (pendingCapture && b >= MIN_MOUSE_BUTTON) {
    const p = pendingCapture;
    pendingCapture = null;
    p.resolve({ kind: 'mouse', code: b, label: `Mouse ${b}` });
    return;
  }
  if (matches('mouse', b)) emit(true);
}

function onMouseUp(e: { button: unknown }): void {
  if (matches('mouse', mouseButton(e.button))) emit(false);
}

function ensureHook(): void {
  if (hookRunning) return;
  // Prompts for Accessibility on first use on macOS; the hook receives
  // nothing until the user grants it (and restarts the app).
  if (!trusted(true)) {
    hookError = 'macOS: нет разрешения Accessibility / Input Monitoring';
  }
  try {
    uIOhook.on('keydown', onKeyDown);
    uIOhook.on('keyup', onKeyUp);
    uIOhook.on('mousedown', onMouseDown);
    uIOhook.on('mouseup', onMouseUp);
    uIOhook.start();
    hookRunning = true;
  } catch (err) {
    uIOhook.removeAllListeners();
    hookError = err instanceof Error ? err.message : String(err);
  }
}

export function pttStatus(): PttStatus {
  return { active: hookRunning && binding !== null, binding, trusted: trusted(false), error: hookError };
}

export function setBinding(owner: WebContents, next: PttBinding | null): PttStatus {
  binding = next;
  pressed = false;
  if (next) {
    subscribers.add(owner);
    ensureHook();
  } else {
    subscribers.delete(owner);
  }
  return pttStatus();
}

export function captureNext(): Promise<PttBinding> {
  ensureHook();
  if (!hookRunning) return Promise.reject(new Error(hookError ?? 'uiohook is not running'));
  pendingCapture?.reject(new Error('superseded'));
  return new Promise((resolve, reject) => {
    pendingCapture = { resolve, reject };
  });
}

export function shutdownPtt(): void {
  if (!hookRunning) return;
  try {
    uIOhook.stop();
  } catch {
    // Ignore: process is quitting anyway.
  }
  uIOhook.removeAllListeners();
  hookRunning = false;
}
